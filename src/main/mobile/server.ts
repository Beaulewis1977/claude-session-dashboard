// The companion server: serves the mobile web app and a small JSON API, and
// pushes live updates over a WebSocket.
//
// It listens on exactly one address (see network.ts), answers only its own
// Host names, and every API call except pairing needs a paired phone's token.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Server } from 'node:net'
import { gzipSync } from 'node:zlib'
import { WebSocketServer, type WebSocket } from 'ws'
import type { MobileEvent, MobileMe, MobileMode } from '@shared/mobile'
import { cleanDeviceName, type DeviceRegistry, type StoredDevice } from './devices'
import { originAllowed } from './network'
import { RateLimiter } from './rate-limit'
import type { RemoteLauncher } from './remote-launch'
import { rpcMethod } from './rpc'

export interface WebAssets {
  /** A file of the web app by URL path, or undefined. */
  file(path: string): Promise<{ body: Buffer; type: string; immutable?: boolean } | undefined>
}

export interface ServerDeps {
  registry: DeviceRegistry
  /** Calls a desktop IPC handler (only channels from rpc.ts reach this). */
  call(channel: string, args: unknown[]): Promise<unknown>
  launcher: RemoteLauncher
  web: WebAssets
  flags(): { readOnly: boolean; confirmOnPc: boolean; mode: MobileMode; appVersion: string }
  /** Host header values to answer. */
  hosts(): Set<string>
  /** Devices or connections changed (for the desktop's settings screen). */
  changed(): void
  /**
   * Terminal access: a phone offers its public SSH key. It's only shown on
   * the PC, which must be waiting for one; nothing is added until the user
   * allows it there.
   */
  proposeKey?(
    deviceName: string,
    key: unknown
  ): Promise<{ ok: boolean; error?: string; fingerprint?: string }>
  /**
   * Web Push (opt-in per phone): the app's public VAPID key, and storing or
   * dropping this phone's subscription. Sending happens in MobileService.
   */
  push?: {
    publicKey(): string
    /** Validates the subscription (only the push services' own hosts). */
    subscribe(deviceId: string, subscription: unknown): { ok: boolean; error?: string }
    unsubscribe(deviceId: string): void
    /** A test push to this phone only; how many were sent. */
    test(deviceId: string): Promise<number>
    /** Does the PC hold this phone's subscription, for this endpoint? */
    state(deviceId: string, endpoint: unknown): { on: boolean; matches: boolean }
  }
  /** The session a tapped push alert means: only for the phone it was sent to, once. */
  resolveLiveRef?(deviceId: string, ref: unknown): string | null
  now?: () => number
}

const MAX_BODY = 64 * 1024
const AUTH_TIMEOUT_MS = 5000
const MAX_SOCKETS_PER_DEVICE = 4

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
}

function csp(host: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' wss://${host} ws://${host}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ].join('; ')
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
  }
}

/** The token from a phone's first WebSocket message ({"type":"auth","token":…}), if any. */
export function authToken(data: unknown): string | undefined {
  let msg: unknown
  try {
    msg = JSON.parse(String(data))
  } catch {
    return undefined
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return undefined
  const m = msg as Record<string, unknown>
  return m.type === 'auth' && typeof m.token === 'string' ? m.token : undefined
}

/** The request's path, or undefined if it can't be parsed (e.g. "//"). */
function pathOf(url: string | undefined): string | undefined {
  try {
    return decodeURIComponent(new URL(url ?? '/', 'http://x').pathname)
  } catch {
    return undefined
  }
}

/**
 * Who is asking, for counting wrong pairing codes. Through `tailscale serve`
 * every request comes from 127.0.0.1, so Tailscale's own headers (set by the
 * proxy, which replaces any a client sends) tell the phones apart.
 */
function clientKey(req: IncomingMessage): string {
  const ts = req.headers['tailscale-user-login']
  const fwd = req.headers['x-forwarded-for']
  const addr = req.socket.remoteAddress ?? '?'
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') {
    const via = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
    return `ts:${typeof ts === 'string' ? ts : ''}:${via ?? 'local'}`
  }
  return addr
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? ''
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large')
    chunks.push(c as Buffer)
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  } catch {
    throw new HttpError(400, 'Bad JSON')
  }
}

export class MobileServer {
  private server: Server | undefined
  private wss: WebSocketServer | undefined
  private sockets = new Map<string, Set<WebSocket>>()
  private heartbeat: NodeJS.Timeout | undefined
  private readonly pairLimiter: RateLimiter
  private readonly apiLimiter: RateLimiter
  private readonly writeLimiter: RateLimiter
  private lastAuthFailLog = 0

  constructor(private readonly deps: ServerDeps) {
    const now = deps.now
    this.pairLimiter = new RateLimiter([{ max: 20, windowMs: 60_000 }], now)
    this.apiLimiter = new RateLimiter([{ max: 600, windowMs: 60_000 }], now)
    this.writeLimiter = new RateLimiter([{ max: 60, windowMs: 60_000 }], now)
  }

  get running(): boolean {
    return !!this.server?.listening
  }

  address(): { host: string; port: number } | undefined {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { host: a.address, port: a.port } : undefined
  }

  async start(opts: {
    host: string
    port: number
    tls?: { cert: string; key: string }
  }): Promise<void> {
    await this.stop()
    const handler = (req: IncomingMessage, res: ServerResponse): void => void this.handle(req, res)
    const server = opts.tls
      ? createHttpsServer(
          { cert: opts.tls.cert, key: opts.tls.key, minVersion: 'TLSv1.2' },
          handler
        )
      : createHttpServer(handler)
    server.headersTimeout = 15_000
    server.requestTimeout = 30_000
    server.keepAliveTimeout = 10_000
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })
    server.on('upgrade', (req, socket, head) => {
      const host = (req.headers.host ?? '').toLowerCase()
      const hosts = this.deps.hosts()
      // Nothing here may throw: this runs outside any request's error handling.
      if (
        !hosts.has(host) ||
        !originAllowed(req.headers.origin, hosts) ||
        pathOf(req.url) !== '/api/ws'
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.port, opts.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.wss = wss
    this.heartbeat = setInterval(() => this.ping(), 30_000)
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate()
    this.sockets.clear()
    this.wss?.close()
    this.wss = undefined
    const s = this.server
    this.server = undefined
    if (s) {
      ;(s as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  }

  // ---------------------------------------------------------- WebSocket

  private onSocket(ws: WebSocket): void {
    let device: StoredDevice | undefined
    const timer = setTimeout(() => ws.close(4401, 'auth timeout'), AUTH_TIMEOUT_MS)
    ;(ws as WebSocket & { alive?: boolean }).alive = true
    ws.on('pong', () => {
      ;(ws as WebSocket & { alive?: boolean }).alive = true
    })
    ws.on('message', (data) => {
      // Anything a client sends must be refused, never thrown: this runs
      // outside any request's error handling, in the app's main process.
      try {
        if (device) return // Phones only listen after signing in.
        clearTimeout(timer)
        const d = this.deps.registry.authenticate(authToken(data))
        if (!d) {
          this.authFailed()
          ws.close(4401, 'not paired')
          return
        }
        device = d
        this.addSocket(d, ws)
      } catch (err) {
        console.warn('mobile websocket message refused', err)
        ws.terminate()
      }
    })
    ws.on('close', () => {
      clearTimeout(timer)
      if (!device) return
      const set = this.sockets.get(device.id)
      set?.delete(ws)
      if (set && !set.size) this.sockets.delete(device.id)
      this.deps.changed()
    })
    ws.on('error', () => ws.terminate())
  }

  private addSocket(d: StoredDevice, ws: WebSocket): void {
    const set = this.sockets.get(d.id) ?? new Set()
    // A phone that reconnects a lot keeps only its newest connections.
    while (set.size >= MAX_SOCKETS_PER_DEVICE) {
      const oldest = set.values().next().value as WebSocket
      set.delete(oldest)
      oldest.terminate()
    }
    set.add(ws)
    this.sockets.set(d.id, set)
    this.send(ws, { type: 'ready' })
    this.deps.changed()
  }

  /**
   * Every 30 seconds: drop dead connections, and those of phones that are no
   * longer paired (expired); a live connection counts as the phone being used.
   */
  private ping(): void {
    for (const id of [...this.sockets.keys()]) {
      if (!this.deps.registry.isActive(id)) {
        this.disconnect(id)
        this.deps.changed()
      } else this.deps.registry.touch(id)
    }
    for (const set of this.sockets.values())
      for (const ws of set) {
        const w = ws as WebSocket & { alive?: boolean }
        if (!w.alive) {
          ws.terminate()
          continue
        }
        w.alive = false
        ws.ping()
      }
  }

  private send(ws: WebSocket, ev: MobileEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev))
  }

  /** Push to every connected phone (or one). */
  broadcast(ev: MobileEvent, deviceId?: string): number {
    let n = 0
    for (const [id, set] of this.sockets) {
      if (deviceId && id !== deviceId) continue
      if (!this.deps.registry.isActive(id)) {
        this.disconnect(id)
        continue
      }
      for (const ws of set) {
        this.send(ws, ev)
        n++
      }
    }
    return n
  }

  isConnected(deviceId: string): boolean {
    return (this.sockets.get(deviceId)?.size ?? 0) > 0
  }

  /** A revoked phone is told so and disconnected at once. */
  disconnect(deviceId: string): void {
    const set = this.sockets.get(deviceId)
    if (!set) return
    for (const ws of set) {
      this.send(ws, { type: 'revoked' })
      ws.close(4403, 'revoked')
    }
    this.sockets.delete(deviceId)
  }

  // ---------------------------------------------------------------- HTTP

  private authFailed(): void {
    const t = (this.deps.now ?? Date.now)()
    if (t - this.lastAuthFailLog < 60_000) return
    this.lastAuthFailLog = t
    this.deps.registry.log({
      action: 'denied',
      detail: 'Refused a request without a valid phone token',
      ok: false
    })
  }

  private reply(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: Buffer | string,
    type: string,
    headers: Record<string, string> = {}
  ): void {
    let data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    const h: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Type': type, ...headers }
    const compressible = /json|javascript|css|html|svg|manifest/.test(type)
    if (
      compressible &&
      data.length > 1024 &&
      /\bgzip\b/.test(String(req.headers['accept-encoding']))
    ) {
      data = gzipSync(data)
      h['Content-Encoding'] = 'gzip'
      h['Vary'] = 'Accept-Encoding'
    }
    h['Content-Length'] = String(data.length)
    res.writeHead(status, h)
    res.end(req.method === 'HEAD' ? undefined : data)
  }

  private json(req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void {
    this.reply(req, res, status, JSON.stringify(value ?? null), 'application/json; charset=utf-8', {
      'Cache-Control': 'no-store'
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase()
    if (!this.deps.hosts().has(host)) {
      this.reply(req, res, 421, 'Unknown host', 'text/plain; charset=utf-8')
      return
    }
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      this.reply(req, res, 400, 'Bad path', 'text/plain; charset=utf-8')
      return
    }
    try {
      if (path.startsWith('/api/')) {
        if (req.method !== 'POST' && !(req.method === 'GET' && path === '/api/me'))
          throw new HttpError(405, 'Method not allowed')
        // Browsers send Origin on POST; a page on another site is refused.
        if (
          req.method === 'POST' &&
          req.headers.origin &&
          !originAllowed(req.headers.origin, this.deps.hosts())
        )
          throw new HttpError(403, 'Wrong origin')
        await this.api(req, res, path)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new HttpError(405, 'Method not allowed')
      const file = await this.deps.web.file(path === '/' ? '/mobile.html' : path)
      if (!file) throw new HttpError(404, 'Not found')
      const isHtml = file.type.startsWith('text/html')
      this.reply(req, res, 200, file.body, file.type, {
        'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(isHtml ? { 'Content-Security-Policy': csp(host) } : {})
      })
    } catch (err) {
      const e =
        err instanceof HttpError ? err : new HttpError(500, 'Something went wrong on the PC')
      if (!(err instanceof HttpError)) console.warn('mobile server error', err)
      if (path.startsWith('/api/')) {
        this.reply(
          req,
          res,
          e.status,
          JSON.stringify({ error: e.message }),
          'application/json; charset=utf-8',
          {
            'Cache-Control': 'no-store',
            ...e.headers
          }
        )
      } else {
        this.reply(req, res, e.status, e.message, 'text/plain; charset=utf-8', e.headers)
      }
    }
  }

  private device(req: IncomingMessage): StoredDevice {
    const d = this.deps.registry.authenticate(bearer(req))
    if (!d) {
      this.authFailed()
      throw new HttpError(401, 'This phone is not paired (or was revoked). Pair it again.')
    }
    if (!this.apiLimiter.take(d.id))
      throw new HttpError(429, 'Too many requests', {
        'Retry-After': String(this.apiLimiter.retryAfter(d.id))
      })
    return d
  }

  private async api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/api/pair') {
      const from = clientKey(req)
      if (!this.pairLimiter.take(from))
        throw new HttpError(429, 'Too many attempts. Wait a minute.')
      const body = (await readJson(req)) as { code?: unknown; name?: unknown }
      const r = this.deps.registry.pair(
        body.code,
        body.name,
        String(req.headers['user-agent'] ?? ''),
        from
      )
      if (!r.ok) throw new HttpError(r.status, r.error)
      this.deps.changed()
      this.json(req, res, 200, {
        token: r.token,
        device: { id: r.device.id, name: r.device.name, createdAt: r.device.createdAt }
      })
      return
    }
    const d = this.device(req)
    const flags = this.deps.flags()
    switch (path) {
      case '/api/me': {
        const me: MobileMe = {
          device: {
            id: d.id,
            name: d.name,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt
          },
          readOnly: flags.readOnly,
          confirmOnPc: flags.confirmOnPc,
          mode: flags.mode,
          appVersion: flags.appVersion,
          push: !!d.push
        }
        this.json(req, res, 200, me)
        return
      }
      case '/api/rpc': {
        const body = (await readJson(req)) as { method?: unknown; args?: unknown }
        // The body may arrive slowly: check the phone and the policy again now.
        if (!this.deps.registry.isActive(d.id))
          throw new HttpError(401, 'This phone is not paired (or was revoked). Pair it again.')
        const m = rpcMethod(body.method)
        if (!m) throw new HttpError(404, 'Not available from a phone')
        const args = Array.isArray(body.args) ? body.args.slice(0, 4) : []
        if (m.kind === 'write') {
          if (this.deps.flags().readOnly)
            throw new HttpError(403, 'Read-only mode is on. Change it on the PC.')
          if (!this.writeLimiter.take(d.id))
            throw new HttpError(429, 'Too many changes. Wait a minute.')
        }
        let callArgs: unknown[]
        try {
          callArgs = m.args(args)
        } catch (err) {
          throw new HttpError(400, (err as Error).message)
        }
        const out = await this.deps.call(m.channel, callArgs)
        if (m.kind === 'write') this.logWrite(d, String(body.method), callArgs)
        this.json(req, res, 200, m.result ? m.result(out) : out)
        return
      }
      case '/api/launch/preview': {
        this.json(req, res, 200, await this.deps.launcher.preview(await readJson(req)))
        return
      }
      case '/api/launch': {
        const r = await this.deps.launcher.launch(d, await readJson(req))
        this.deps.changed()
        this.json(req, res, 200, r)
        return
      }
      case '/api/ssh-key': {
        const body = (await readJson(req)) as { key?: unknown }
        if (!this.deps.registry.isActive(d.id))
          throw new HttpError(401, 'This phone is not paired (or was revoked). Pair it again.')
        if (this.deps.flags().readOnly)
          throw new HttpError(403, 'Read-only mode is on. Change it on the PC.')
        if (!this.writeLimiter.take(d.id))
          throw new HttpError(429, 'Too many changes. Wait a minute.')
        if (!this.deps.proposeKey) throw new HttpError(404, 'Not available')
        const r = await this.deps.proposeKey(d.name, body.key)
        this.deps.registry.log({
          action: 'ssh-key',
          deviceId: d.id,
          device: d.name,
          detail: r.ok
            ? `Sent SSH key ${r.fingerprint} to the PC (waits for Allow there)`
            : `SSH key refused: ${r.error}`,
          ok: r.ok
        })
        this.deps.changed()
        this.json(req, res, 200, r)
        return
      }
      case '/api/push/key':
      case '/api/push/subscribe':
      case '/api/push/unsubscribe':
      case '/api/push/test':
      case '/api/push/check': {
        // Allowed in read-only mode: push alerts change nothing on the PC.
        const push = this.deps.push
        if (!push) throw new HttpError(404, 'Not available')
        const body = (await readJson(req)) as { subscription?: unknown; endpoint?: unknown }
        if (!this.deps.registry.isActive(d.id))
          throw new HttpError(401, 'This phone is not paired (or was revoked). Pair it again.')
        if (path === '/api/push/key') {
          this.json(req, res, 200, { publicKey: push.publicKey() })
          return
        }
        if (path === '/api/push/check') {
          this.json(req, res, 200, push.state(d.id, body.endpoint))
          return
        }
        if (!this.writeLimiter.take(d.id))
          throw new HttpError(429, 'Too many changes. Wait a minute.')
        if (path === '/api/push/subscribe') {
          const r = push.subscribe(d.id, body.subscription)
          if (!r.ok) throw new HttpError(400, r.error ?? 'Bad subscription')
          this.deps.changed()
          this.json(req, res, 200, { ok: true })
        } else if (path === '/api/push/unsubscribe') {
          push.unsubscribe(d.id)
          this.deps.changed()
          this.json(req, res, 200, { ok: true })
        } else {
          this.json(req, res, 200, { sent: await push.test(d.id) })
        }
        return
      }
      case '/api/live/resolve': {
        const body = (await readJson(req)) as { ref?: unknown }
        if (!this.deps.registry.isActive(d.id))
          throw new HttpError(401, 'This phone is not paired (or was revoked). Pair it again.')
        const key = this.deps.resolveLiveRef?.(d.id, body.ref) ?? null
        this.json(req, res, 200, { key })
        return
      }
      case '/api/unpair': {
        this.deps.registry.revoke(d.id, 'phone')
        this.disconnect(d.id)
        this.deps.changed()
        this.json(req, res, 200, { ok: true })
        return
      }
      case '/api/rename-device': {
        const body = (await readJson(req)) as { name?: unknown }
        this.deps.registry.rename(d.id, cleanDeviceName(body.name))
        this.deps.changed()
        this.json(req, res, 200, { ok: true })
        return
      }
      default:
        throw new HttpError(404, 'Not found')
    }
  }

  private logWrite(d: StoredDevice, method: string, args: unknown[]): void {
    let detail = method
    if (method === 'updateMeta') {
      const fields = Object.keys((args[1] ?? {}) as object)
      detail = `Edited ${fields.join(', ') || 'nothing'} of a session`
    } else if (method === 'updateSettings') {
      detail = `Changed settings: ${Object.keys((args[0] ?? {}) as object).join(', ') || 'none'}`
    }
    this.deps.registry.log({
      action: method === 'updateSettings' ? 'settings' : 'edit',
      deviceId: d.id,
      device: d.name,
      detail,
      ok: true
    })
  }
}
