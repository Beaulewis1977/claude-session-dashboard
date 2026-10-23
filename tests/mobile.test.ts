import { X509Certificate } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { MOBILE_SAFE_SETTINGS, versionAtLeast } from '../src/shared/mobile'
import type { LaunchOptions, SessionSummary } from '../src/shared/types'
import { JsonStore } from '../src/main/core/json-store'
import { createSelfSignedCert } from '../src/main/mobile/cert'
import {
  DeviceRegistry,
  hashToken,
  newPairingCode,
  normalizeCode,
  PAIRING_MAX_FAILURES,
  type MobileFile
} from '../src/main/mobile/devices'
import {
  FIREWALL_RULE_NAME,
  firewallAddArgs,
  firewallDeleteArgs,
  firewallUpdateArgs,
  netshCommandLine
} from '../src/main/mobile/firewall'
import {
  allowedHosts,
  BindError,
  bindAddress,
  isPrivateIPv4,
  lanAddresses,
  originAllowed
} from '../src/main/mobile/network'
import { RateLimiter } from '../src/main/mobile/rate-limit'
import {
  parseLaunchRequest,
  RemoteLauncher,
  remoteLaunchOptions,
  type RemoteLaunchDeps
} from '../src/main/mobile/remote-launch'
import { phoneMetaPatch, phoneSettingsPatch, rpcMethod, RPC } from '../src/main/mobile/rpc'
import { MobileServer } from '../src/main/mobile/server'
import {
  assertSafeTailscaleArgs,
  fakeTailscale,
  findLink,
  parseServe,
  parseStatus,
  serveOffArgs,
  serveOnArgs
} from '../src/main/mobile/tailscale'
import { webAssets } from '../src/main/mobile/web-assets'

let dir: string
let now = Date.parse('2026-10-23T12:00:00Z')
const clock = (): number => now

function store(): JsonStore<MobileFile> {
  return new JsonStore<MobileFile>(join(dir, 'mobile.json'), dir, () => ({
    version: 1,
    devices: [],
    activity: []
  }))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-mobile-'))
  now = Date.parse('2026-10-23T12:00:00Z')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ------------------------------------------------------------------ pairing

describe('pairing and tokens', () => {
  it('makes readable one-time codes', () => {
    const c = newPairingCode()
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(normalizeCode('k7qm-2xra')).toBe('K7QM2XRA')
    expect(normalizeCode('O0 IL')).toBe('0011')
  })

  it('pairs once with the right code and stores only the token hash', async () => {
    const st = store()
    const reg = new DeviceRegistry(st, clock)
    const p = reg.startPairing('https://pc.tail.ts.net:8443')
    expect(p.url).toBe(`https://pc.tail.ts.net:8443/#pair=${p.code}`)
    const r = reg.pair(p.code.toLowerCase(), "Beau's <iPhone>", 'Safari')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.device.name).toBe("Beau's iPhone")
    await st.flush()
    const saved = JSON.stringify(st.value)
    expect(saved).not.toContain(r.token)
    expect(saved).toContain(hashToken(r.token))
    // Single use.
    expect(reg.pair(p.code, 'Again').ok).toBe(false)
    expect(reg.authenticate(r.token)?.id).toBe(r.device.id)
    expect(reg.authenticate('x'.repeat(43))).toBeUndefined()
    expect(reg.authenticate(undefined)).toBeUndefined()
  })

  it('expires codes and closes pairing after too many wrong guesses', () => {
    const reg = new DeviceRegistry(store(), clock)
    const p = reg.startPairing('http://127.0.0.1:1')
    now += 5 * 60_000 + 1
    const late = reg.pair(p.code, 'x')
    expect(late.ok).toBe(false)
    expect(!late.ok && late.status).toBe(410)

    const p2 = reg.startPairing('http://127.0.0.1:1')
    for (let i = 0; i < PAIRING_MAX_FAILURES - 1; i++) {
      const r = reg.pair('AAAA-AAAA', 'x')
      expect(!r.ok && r.status).toBe(403)
    }
    const last = reg.pair('AAAA-AAAA', 'x')
    expect(!last.ok && last.status).toBe(429)
    // Even the right code no longer works.
    expect(reg.pair(p2.code, 'x').ok).toBe(false)
  })

  it('revokes devices and forgets ones unused for 30 days', () => {
    const reg = new DeviceRegistry(store(), clock)
    const a = reg.pair(reg.startPairing('h').code, 'A')
    const b = reg.pair(reg.startPairing('h').code, 'B')
    if (!a.ok || !b.ok) throw new Error('pairing failed')
    reg.revoke(a.device.id)
    expect(reg.authenticate(a.token)).toBeUndefined()
    expect(reg.authenticate(b.token)).toBeDefined()
    now += 31 * 24 * 3600_000
    expect(reg.authenticate(b.token)).toBeUndefined()
    expect(reg.list()).toEqual([])
    expect(reg.activity().map((e) => e.action)).toContain('expire')
  })
})

// ------------------------------------------------------------------ network

describe('where the server may listen', () => {
  const ifaces = {
    'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    'vEthernet (WSL)': [{ address: '172.25.208.1', family: 'IPv4', internal: false }],
    Tailscale: [{ address: '100.111.120.35', family: 'IPv4', internal: false }],
    Public: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>

  it('uses 127.0.0.1 for Tailscale', () => {
    expect(bindAddress({ mode: 'tailscale', lanAddress: '192.168.1.20' }, ifaces)).toBe('127.0.0.1')
  })

  it('home Wi-Fi: only a private address this PC has', () => {
    expect(bindAddress({ mode: 'lan', lanAddress: '192.168.1.20' }, ifaces)).toBe('192.168.1.20')
    for (const bad of ['0.0.0.0', '8.8.8.8', '100.111.120.35', '192.168.1.99', '::', '', undefined])
      expect(() => bindAddress({ mode: 'lan', lanAddress: bad }, ifaces)).toThrow(BindError)
    expect(lanAddresses(ifaces)).toEqual([{ address: '192.168.1.20', interface: 'Wi-Fi' }])
    expect(isPrivateIPv4('172.31.0.1')).toBe(true)
    expect(isPrivateIPv4('172.32.0.1')).toBe(false)
  })

  it('answers only its own host names and origins', () => {
    const hosts = allowedHosts({
      bind: '127.0.0.1',
      port: 47821,
      tailscaleName: 'pc.tail.ts.net.',
      httpsPort: 8443
    })
    expect([...hosts].sort()).toEqual(['127.0.0.1:47821', 'localhost:47821', 'pc.tail.ts.net:8443'])
    expect(originAllowed('https://pc.tail.ts.net:8443', hosts)).toBe(true)
    expect(originAllowed('http://127.0.0.1:47821', hosts)).toBe(true)
    expect(originAllowed('https://evil.example', hosts)).toBe(false)
    expect(originAllowed('null', hosts)).toBe(false)
    expect(originAllowed(undefined, hosts)).toBe(false)
    const h443 = allowedHosts({
      bind: '127.0.0.1',
      port: 1,
      tailscaleName: 'pc.ts.net',
      httpsPort: 443
    })
    expect(originAllowed('https://pc.ts.net', h443)).toBe(true)
  })
})

// ------------------------------------------------------------- remote launch

const SESSION = {
  key: 'windows:7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
  sessionId: '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
  title: 'Fix login',
  availability: 'live',
  meta: {}
} as unknown as SessionSummary

function launcher(over: Partial<ReturnType<RemoteLaunchDeps['settings']>> = {}, confirm = true) {
  const launched: LaunchOptions[] = []
  const log: string[] = []
  const deps: RemoteLaunchDeps = {
    session: (k) => (k === SESSION.key ? SESSION : undefined),
    preview: async () => ({
      commandLine: 'x',
      claudeCommand: 'claude',
      terminal: 'wt',
      fellBack: false,
      cwd: 'C:\\code',
      cwdExists: true,
      willRestore: false,
      restoreImpossible: false,
      originalPath: 'x',
      billingLabel: 'Subscription',
      remoteControlName: 'Fix login'
    }),
    launch: async (opts) => {
      launched.push(opts)
      return { ok: true, restored: false, commandLine: 'x' }
    },
    settings: () => ({
      terminal: 'wt',
      readOnly: false,
      confirmOnPc: false,
      branchConfirmed: true,
      ...over
    }),
    confirm: async () => confirm,
    log: (e) => log.push(`${e.action}:${e.ok}:${e.detail}`),
    now: clock
  }
  return { rl: new RemoteLauncher(deps), launched, log }
}

const DEVICE = { id: 'd1', name: 'iPhone', tokenHash: '', createdAt: '', lastSeenAt: '' }

describe('launches from a phone', () => {
  it('only Resume, Fork or Branch, with fixed safe options', () => {
    // Whatever extra fields the phone sends are ignored.
    const req = parseLaunchRequest({
      key: SESSION.key,
      kind: 'fork',
      skipPermissions: true,
      billingAccountId: 'acct-1',
      cwdOverride: 'C:\\Windows',
      command: 'calc.exe'
    })
    expect(req).toEqual({ key: SESSION.key, kind: 'fork' })
    const opts = remoteLaunchOptions(req as never, 'powershell')
    expect(opts).toEqual({
      key: SESSION.key,
      fork: true,
      skipPermissions: false,
      remoteControl: true,
      terminal: 'powershell'
    })
    expect(parseLaunchRequest({ key: SESSION.key, kind: 'run' })).toEqual({
      error: 'Bad launch kind'
    })
    expect(parseLaunchRequest({ key: SESSION.key, kind: 'newSession' })).toHaveProperty('error')
    expect(parseLaunchRequest({ key: SESSION.key, kind: 'branch' })).toHaveProperty('error')
  })

  it('never adds --dangerously-skip-permissions and always uses the subscription', async () => {
    const { rl, launched } = launcher()
    for (const kind of ['resume', 'fork'] as const) {
      expect((await rl.launch(DEVICE, { key: SESSION.key, kind, skipPermissions: true })).ok).toBe(
        true
      )
      now += 11_000 // past the one-per-10-seconds limit
    }
    await rl.launch(DEVICE, {
      key: SESSION.key,
      kind: 'branch',
      branch: { at: 'm1', mode: 'include' }
    })
    expect(launched.length).toBe(3)
    for (const o of launched) {
      expect(o.skipPermissions).toBe(false)
      expect(o.billingAccountId).toBeUndefined()
      expect(o.remoteControl).toBe(true)
      expect(o.cwdOverride).toBeUndefined()
      expect(o.newSession).toBeUndefined()
    }
  })

  it('rejects unknown session ids', async () => {
    const { rl, launched, log } = launcher()
    const r = await rl.launch(DEVICE, { key: 'windows:not-a-session', kind: 'resume' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/isn't on this PC/)
    expect(launched).toHaveLength(0)
    expect(log[0]).toMatch(/^launch:false/)
    expect((await rl.preview({ key: '../../etc', kind: 'resume' })).ok).toBe(false)
  })

  it('honours read-only mode, rate limits and the PC confirmation', async () => {
    const ro = launcher({ readOnly: true })
    expect((await ro.rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })).ok).toBe(false)
    expect(ro.launched).toHaveLength(0)

    const rate = launcher()
    expect((await rate.rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })).ok).toBe(true)
    const again = await rate.rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/Too many launches/)

    const denied = launcher({ confirmOnPc: true }, false)
    const d = await denied.rl.launch(DEVICE, { key: SESSION.key, kind: 'resume' })
    expect(d).toMatchObject({ ok: false, denied: true })
    expect(denied.launched).toHaveLength(0)
    expect(denied.log.at(-1)).toMatch(/declined on the PC/)
  })

  it('branches only after "Branch from here" was confirmed once on the PC', async () => {
    const { rl, launched } = launcher({ branchConfirmed: false })
    const r = await rl.launch(DEVICE, {
      key: SESSION.key,
      kind: 'branch',
      branch: { at: 'm1', mode: 'include' }
    })
    expect(r.ok).toBe(false)
    expect(launched).toHaveLength(0)
  })
})

// -------------------------------------------------------------- RPC allow-list

describe('what a phone may call', () => {
  it('reaches only the allowed channels', () => {
    const channels = Object.values(RPC).map((m) => m.channel)
    for (const forbidden of [
      'launch:run',
      'launch:pickCwd',
      'settings:addFolder',
      'accounts:add',
      'bridge:apply',
      'ask:run',
      'import:claudeAi',
      'shell:openExternal',
      'mobile:pair',
      'mobile:update',
      'archive:open',
      'export:markdown'
    ])
      expect(channels).not.toContain(forbidden)
    expect(rpcMethod('constructor')).toBeUndefined()
    expect(rpcMethod('__proto__')).toBeUndefined()
    expect(rpcMethod('toString')).toBeUndefined()
    expect(
      Object.values(RPC)
        .filter((m) => m.kind === 'write')
        .map((m) => m.channel)
    ).toEqual(['sessions:updateMeta', 'settings:update'])
  })

  it('narrows edits to the safe fields', () => {
    expect(
      phoneMetaPatch({
        name: 'n',
        billing: { mode: 'api' },
        source: { label: 'x' },
        remote: {},
        pinned: 1,
        hidden: true
      })
    ).toEqual({ name: 'n', pinned: false, hidden: true })
    expect(
      phoneSettingsPatch({
        theme: 'dark',
        skipPermissionsDefault: true,
        extraFolders: ['C:\\'],
        defaultBilling: 'acct-1',
        mobile: { readOnly: false },
        terminal: 'cmd',
        alertsEnabled: false
      })
    ).toEqual({ terminal: 'cmd', alertsEnabled: false })
    expect(MOBILE_SAFE_SETTINGS).not.toContain('skipPermissionsDefault')
  })

  it('hides PC folders and API key characters', () => {
    expect(
      RPC.getInfo.result!({ version: '1', dataDir: 'C:\\x', archiveDir: 'C:\\y' })
    ).toMatchObject({ dataDir: '', archiveDir: '' })
    const c = RPC.getCredits.result!({
      accounts: [{ id: 'a', masked: 'sk-ant-api03-…Q7xA' }],
      summaries: []
    }) as {
      accounts: { masked: string }[]
    }
    expect(c.accounts[0].masked).toBe('')
  })
})

// ------------------------------------------------------------------ server

interface Res {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

function req(
  port: number,
  path: string,
  opts: { method?: string; host?: string; token?: string; body?: unknown; origin?: string } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? (data ? 'POST' : 'GET'),
        headers: {
          host: opts.host ?? `127.0.0.1:${port}`,
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.origin ? { origin: opts.origin } : {})
        }
      },
      (res) => {
        let body = ''
        res.on('data', (c: Buffer) => (body += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      }
    )
    r.on('error', reject)
    r.end(data)
  })
}

describe('the companion server', () => {
  let server: MobileServer
  let reg: DeviceRegistry
  let port: number
  let readOnly = false
  const calls: [string, unknown[]][] = []

  beforeEach(async () => {
    readOnly = false
    calls.length = 0
    reg = new DeviceRegistry(store())
    const { rl } = launcher()
    server = new MobileServer({
      registry: reg,
      call: async (channel, args) => {
        calls.push([channel, args])
        return { channel }
      },
      launcher: rl,
      web: {
        file: async (p) =>
          p === '/mobile.html'
            ? { body: Buffer.from('<html>'), type: 'text/html; charset=utf-8' }
            : undefined
      },
      flags: () => ({ readOnly, confirmOnPc: false, mode: 'tailscale', appVersion: '1.0.0' }),
      hosts: () =>
        allowedHosts({ bind: '127.0.0.1', port, tailscaleName: 'pc.tail.ts.net', httpsPort: 8443 }),
      changed: () => undefined
    })
    await server.start({ host: '127.0.0.1', port: 0 })
    port = server.address()!.port
  })
  afterEach(async () => {
    await server.stop()
  })

  const pair = async (): Promise<string> => {
    const p = reg.startPairing(`http://127.0.0.1:${port}`)
    const r = await req(port, '/api/pair', { body: { code: p.code, name: 'Test phone' } })
    expect(r.status).toBe(200)
    return (JSON.parse(r.body) as { token: string }).token
  }

  it('listens on 127.0.0.1 only', () => {
    expect(server.address()?.host).toBe('127.0.0.1')
  })

  it('serves the app with a strict CSP and refuses unknown hosts (DNS rebinding)', async () => {
    const page = await req(port, '/')
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toContain("default-src 'self'")
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect((await req(port, '/', { host: 'evil.example' })).status).toBe(421)
    expect((await req(port, '/', { host: 'pc.tail.ts.net:8443' })).status).toBe(200)
    expect((await req(port, '/../../secret')).status).toBe(404)
  })

  it('needs a paired token for the API', async () => {
    expect((await req(port, '/api/me')).status).toBe(401)
    expect((await req(port, '/api/rpc', { body: { method: 'getSessions' } })).status).toBe(401)
    expect(
      (await req(port, '/api/rpc', { token: 'nope'.repeat(10), body: { method: 'getSessions' } }))
        .status
    ).toBe(401)
    const token = await pair()
    const me = await req(port, '/api/me', { token })
    expect(me.status).toBe(200)
    expect(JSON.parse(me.body).device.name).toBe('Test phone')
    expect(me.headers['cache-control']).toBe('no-store')
  })

  it('calls only allow-listed handlers, with narrowed arguments', async () => {
    const token = await pair()
    const ok = await req(port, '/api/rpc', { token, body: { method: 'getSessions', args: [] } })
    expect(ok.status).toBe(200)
    expect(calls.at(-1)?.[0]).toBe('sessions:list')
    expect(
      (await req(port, '/api/rpc', { token, body: { method: 'launch', args: [{}] } })).status
    ).toBe(404)
    expect(
      (await req(port, '/api/rpc', { token, body: { method: 'addAccount', args: ['x', 'sk'] } }))
        .status
    ).toBe(404)
    await req(port, '/api/rpc', {
      token,
      body: { method: 'updateSettings', args: [{ skipPermissionsDefault: true, theme: 'dark' }] }
    })
    expect(calls.at(-1)).toEqual(['settings:update', [{}]])
    // Another site's page can't post.
    expect(
      (
        await req(port, '/api/rpc', {
          token,
          origin: 'https://evil.example',
          body: { method: 'getSessions' }
        })
      ).status
    ).toBe(403)
  })

  it('refuses changes in read-only mode', async () => {
    const token = await pair()
    readOnly = true
    const r = await req(port, '/api/rpc', {
      token,
      body: { method: 'updateMeta', args: [SESSION.key, { name: 'x' }] }
    })
    expect(r.status).toBe(403)
    expect(calls.some(([c]) => c === 'sessions:updateMeta')).toBe(false)
    expect((await req(port, '/api/rpc', { token, body: { method: 'getSessions' } })).status).toBe(
      200
    )
  })

  it('logs every change made from a phone', async () => {
    const token = await pair()
    await req(port, '/api/rpc', {
      token,
      body: { method: 'updateMeta', args: [SESSION.key, { name: 'x', tags: ['a'] }] }
    })
    const log = reg.activity()
    expect(log[0]).toMatchObject({ action: 'edit', device: 'Test phone', ok: true })
    expect(log[0].detail).toContain('name, tags')
    expect(log.some((e) => e.action === 'pair')).toBe(true)
  })

  it('WebSocket: signs in with the token, then gets pushes; revoking closes it', async () => {
    const token = await pair()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { origin: `http://127.0.0.1:${port}` }
    })
    const messages: unknown[] = []
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })))
      ws.on('message', (m) => {
        messages.push(JSON.parse(String(m)))
        if (messages.length === 1) resolve()
      })
      ws.on('error', reject)
    })
    expect(messages[0]).toEqual({ type: 'ready' })
    const id = reg.list()[0].id
    expect(server.isConnected(id)).toBe(true)
    expect(server.broadcast({ type: 'toast', title: 'Hi' })).toBe(1)
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
    server.disconnect(id)
    expect(await closed).toBe(4403)
  })

  it('WebSocket: refuses other origins and bad tokens', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { origin: 'https://evil.example' }
    })
    await expect(
      new Promise((resolve, reject) => {
        bad.on('open', resolve)
        bad.on('error', reject)
      })
    ).rejects.toThrow()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, {
      headers: { origin: `http://127.0.0.1:${port}` }
    })
    const code = await new Promise<number>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'wrong'.repeat(10) })))
      ws.on('close', (c) => resolve(c))
    })
    expect(code).toBe(4401)
  })
})

// --------------------------------------------------------------- Tailscale

describe('tailscale serve', () => {
  it('adds and removes exactly our rule', () => {
    expect(serveOnArgs(8443, 47821)).toEqual([
      'serve',
      '--bg',
      '--yes',
      '--https=8443',
      'http://127.0.0.1:47821'
    ])
    expect(serveOffArgs(8443)).toEqual(['serve', '--yes', '--https=8443', 'off'])
  })

  it('never runs Funnel, reset, clear or up', () => {
    for (const bad of [
      ['funnel', '443', 'on'],
      ['serve', 'reset'],
      ['serve', 'clear', 'svc:x'],
      ['up'],
      ['up', '--reset'],
      ['serve', '--bg', 'http://127.0.0.1:1'],
      ['serve', '--funnel', '--https=443', 'x'],
      ['logout']
    ])
      expect(() => assertSafeTailscaleArgs(bad)).toThrow()
    for (const ok of [
      serveOnArgs(8443, 1),
      serveOffArgs(8443),
      ['status', '--json'],
      ['serve', 'status', '--json']
    ])
      expect(() => assertSafeTailscaleArgs(ok)).not.toThrow()
  })

  it('reads the serve status: ours, someone else’s, or Funnel', () => {
    const o = { httpsPort: 8443, localPort: 47821 }
    expect(parseServe('{}', o)).toBe('off')
    const ours = {
      TCP: { '8443': { HTTPS: true } },
      Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47821' } } } }
    }
    expect(parseServe(JSON.stringify(ours), o)).toBe('on')
    const other = {
      TCP: { '8443': { HTTPS: true } },
      Web: { 'pc.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }
    }
    expect(parseServe(JSON.stringify(other), o)).toBe('conflict')
    expect(
      parseServe(JSON.stringify({ ...ours, AllowFunnel: { 'pc.ts.net:8443': true } }), o)
    ).toBe('conflict')
    // A rule on another port is left alone and doesn't count.
    const elsewhere = {
      TCP: { '443': { HTTPS: true } },
      Web: { 'pc.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }
    }
    expect(parseServe(JSON.stringify(elsewhere), o)).toBe('off')
  })

  it('reads status: login, MagicDNS name, HTTPS certs and phones', () => {
    const s = parseStatus(
      JSON.stringify({
        Version: '1.104.2-t1',
        BackendState: 'Running',
        Self: { DNSName: 'ryzen.tail1.ts.net.' },
        CurrentTailnet: { Name: 'me@example.com' },
        CertDomains: ['ryzen.tail1.ts.net'],
        Peer: {
          x: { HostName: 'pixel', OS: 'android', Online: false },
          y: { HostName: 'nas', OS: 'linux' }
        }
      })
    )
    expect(s).toMatchObject({
      version: '1.104.2',
      loggedIn: true,
      dnsName: 'ryzen.tail1.ts.net',
      httpsEnabled: true
    })
    expect(s.phones).toEqual([{ name: 'pixel', os: 'Android', online: false }])
    expect(
      parseStatus(
        JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc' })
      )
    ).toMatchObject({
      loggedIn: false,
      authUrl: 'https://login.tailscale.com/a/abc'
    })
    expect(
      parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://evil.example/a' }))
        .authUrl
    ).toBeUndefined()
    expect(findLink('visit:\n\n\thttps://login.tailscale.com/f/serve?node=n1\n')).toBe(
      'https://login.tailscale.com/f/serve?node=n1'
    )
  })

  it('turning off leaves other rules alone; a busy port is never taken over', async () => {
    const calls: string[][] = []
    const ts = fakeTailscale({ existing: { '443': 'http://127.0.0.1:3000' }, calls })
    expect(await ts.serveOn(8443, 47821)).toEqual({ ok: true })
    expect((await ts.status(8443, 47821)).serve).toBe('on')
    expect(await ts.serveOff(8443, 47821)).toEqual({ ok: true })
    expect((await ts.status(443, 3000)).serve).toBe('on') // theirs is still there
    expect(calls.filter((c) => c[0] === 'serve' && c[1] !== 'status')).toEqual([
      serveOnArgs(8443, 47821),
      serveOffArgs(8443)
    ])

    const busy = fakeTailscale({ existing: { '8443': 'http://127.0.0.1:9999' }, calls: [] })
    const r = await busy.serveOn(8443, 47821)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already used/)
    expect((await busy.serveOff(8443, 47821)).ok).toBe(false)
    expect((await busy.status(8443, 9999)).serve).toBe('on')
  })

  it('passes on the link when Tailscale wants HTTPS turned on first', async () => {
    const ts = fakeTailscale({ httpsEnabled: false })
    expect(await ts.serveOn(8443, 1)).toEqual({
      ok: false,
      link: 'https://login.tailscale.com/f/serve?node=abc123'
    })
  })
})

// --------------------------------------------------------------- home Wi-Fi

describe('home Wi-Fi mode', () => {
  it('adds a firewall rule for the private profile and local subnet only', () => {
    const args = firewallAddArgs(
      47821,
      '192.168.1.20',
      'C:\\Program Files\\Claude Session Dashboard\\app.exe'
    )
    expect(args).toContain('profile=private')
    expect(args).toContain('remoteip=localsubnet')
    expect(args).toContain('localip=192.168.1.20')
    expect(args).toContain('localport=47821')
    expect(args).toContain('dir=in')
    expect(args.join(' ')).not.toMatch(/profile=(any|public|domain)|remoteip=any/)
    expect(netshCommandLine(args)).toContain(`name="${FIREWALL_RULE_NAME}"`)
    expect(netshCommandLine(args)).toContain(
      'program="C:\\Program Files\\Claude Session Dashboard\\app.exe"'
    )
    expect(firewallDeleteArgs()).toEqual([
      'advfirewall',
      'firewall',
      'delete',
      'rule',
      `name=${FIREWALL_RULE_NAME}`
    ])
    const upd = firewallUpdateArgs(47822, '192.168.1.30', 'C:\\a.exe')
    expect(upd.slice(0, 6)).toEqual([
      'advfirewall',
      'firewall',
      'set',
      'rule',
      `name=${FIREWALL_RULE_NAME}`,
      'new'
    ])
    expect(upd).toEqual(
      expect.arrayContaining(['profile=private', 'remoteip=localsubnet', 'localip=192.168.1.30'])
    )
    expect(() => firewallAddArgs(47821, '0.0.0.0; netsh', 'C:\\a.exe')).toThrow()
    expect(() => firewallAddArgs(80, '192.168.1.20', 'C:\\a.exe')).toThrow()
    expect(() => firewallAddArgs(47821, '192.168.1.20', 'a.exe" & calc')).toThrow()
  })

  it('makes a valid self-signed certificate for the LAN address', () => {
    const c = createSelfSignedCert('192.168.1.20', new Date('2026-10-23T00:00:00Z'))
    const x = new X509Certificate(c.cert)
    expect(x.checkIP('192.168.1.20')).toBe('192.168.1.20')
    expect(x.checkIP('192.168.1.21')).toBeUndefined()
    expect(x.ca).toBe(false)
    expect(x.verify(x.publicKey)).toBe(true)
    expect(x.keyUsage).toContain('1.3.6.1.5.5.7.3.1')
    expect(Date.parse(x.validTo)).toBeGreaterThan(Date.parse('2027-10-01'))
    expect(c.key).toContain('BEGIN PRIVATE KEY')
  })
})

// -------------------------------------------------------------------- misc

describe('helpers', () => {
  it('compares versions', () => {
    expect(versionAtLeast('2.1.309', '2.1.51')).toBe(true)
    expect(versionAtLeast('2.1.51 (Claude Code)', '2.1.51')).toBe(true)
    expect(versionAtLeast('2.1.50', '2.1.51')).toBe(false)
    expect(versionAtLeast('2.0.999', '2.1.51')).toBe(false)
    expect(versionAtLeast(undefined, '2.1.51')).toBe(false)
  })

  it('rate-limits with sliding windows', () => {
    const rl = new RateLimiter([{ max: 2, windowMs: 1000 }], clock)
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(true)
    expect(rl.take('a')).toBe(false)
    expect(rl.take('b')).toBe(true)
    expect(rl.retryAfter('a')).toBe(1)
    now += 1001
    expect(rl.take('a')).toBe(true)
  })

  it('serves only allow-listed web files from the build folder', async () => {
    const web = webAssets(dir, (size) => Buffer.from(`png${size}`))
    expect(await web.file('/icons/icon-192.png')).toMatchObject({ type: 'image/png' })
    expect(await web.file('/icons/apple-touch-icon.png')).toMatchObject({
      body: Buffer.from('png180')
    })
    expect(await web.file('/icons/icon-64.png')).toBeUndefined()
    for (const p of [
      '/index.html',
      '/../mobile.json',
      '/assets/../../x.js',
      '/assets/%2e%2e/x.js',
      '/mobile.json'
    ])
      expect(await web.file(p)).toBeUndefined()
  })
})

// ----------------------------------------------------------- the service

describe('turning phone access on and off', () => {
  async function service(existing: Record<string, string>, calls: string[][]) {
    const { MobileService } = await import('../src/main/mobile/service')
    const { DEFAULT_MOBILE } = await import('../src/shared/mobile')
    let settings = { ...DEFAULT_MOBILE, port: 0 }
    const st = store()
    const svc = new MobileService({
      store: st,
      settings: () => settings,
      saveSettings: async (next) => {
        settings = next
      },
      call: async () => null,
      launch: {
        session: () => undefined,
        preview: async () => {
          throw new Error('unused')
        },
        launch: async () => ({ ok: false, restored: false, commandLine: '' }),
        settings: () => ({ terminal: 'wt', branchConfirmed: false }),
        confirm: async () => false
      },
      web: { file: async () => undefined },
      webAppFile: join(dir, 'mobile.html'),
      tailscale: fakeTailscale({ existing, calls }),
      keys: {
        available: () => false,
        encrypt: (s) => Buffer.from(s),
        decrypt: (b) => b.toString()
      },
      appVersion: '1.0.0',
      fixtures: true,
      claudePath: async () => undefined
    })
    return { svc, st, port: () => settings.port }
  }

  it('starts on 127.0.0.1, adds our serve rule, and removes only that one', async () => {
    const calls: string[][] = []
    const { svc, st } = await service({ '443': 'http://127.0.0.1:3000' }, calls)
    const on = await svc.start()
    expect(on.running).toBe(true)
    expect(on.listening).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(st.value.serveRule?.httpsPort).toBe(8443)
    const off = await svc.stop()
    expect(off.running).toBe(false)
    expect(st.value.serveRule).toBeUndefined()
    const changes = calls.filter((c) => c[0] === 'serve' && c[1] !== 'status')
    expect(changes.map((c) => c.at(-1))).toEqual([
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      'off'
    ])
    expect((await svc.tailscale.status(443, 3000)).serve).toBe('on')
  })

  it('removes a matching rule it did not record (added by hand), but not a foreign one', async () => {
    const calls: string[][] = []
    // Our exact target on our port, as `tailscale serve` would have made it by hand.
    const { svc, st } = await service({ '8443': 'http://127.0.0.1:47821' }, calls)
    st.update((f) => {
      f.serveRule = undefined
    })
    await svc.stop({ ...svc.settings, port: 47821 })
    expect((await svc.tailscale.status(8443, 47821)).serve).toBe('off')

    const other: string[][] = []
    const foreign = await service({ '8443': 'http://127.0.0.1:9999' }, other)
    await foreign.svc.stop({ ...foreign.svc.settings, port: 47821 })
    expect(other.some((c) => c.at(-1) === 'off')).toBe(false)
    expect((await foreign.svc.tailscale.status(8443, 9999)).serve).toBe('on')
  })
})
