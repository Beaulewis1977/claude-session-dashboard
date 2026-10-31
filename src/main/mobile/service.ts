// The phone companion as a whole: settings, the server, Tailscale serve, the
// home Wi-Fi certificate and firewall rule, pairing, and live updates.
//
// Off by default. Turning it on starts the server on 127.0.0.1 (or the chosen
// LAN address) and, in Tailscale mode, adds our one `tailscale serve` rule.
// Turning it off stops the server and removes only that rule.

import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_MOBILE,
  versionAtLeast,
  type ActivityEntry,
  type ClaudeCheck,
  type LanAddress,
  type MobileEvent,
  type MobileSettings,
  type MobileStatus,
  type PairingInfo,
  type PushKind,
  type TailscaleStatus
} from '@shared/mobile'
import type { TerminalPref } from '@shared/types'
import { REMOTE_CONTROL_MIN_VERSION, REMOTE_CONTROL_UNSET_ENV } from '../core/launch'
import type { JsonStore } from '../core/json-store'
import { createSelfSignedCert, fingerprint } from './cert'
import { DeviceRegistry, type MobileFile } from './devices'
import { firewallRuleExists } from './firewall'
import { allowedHosts, bindAddress, lanAddresses, LOOPBACK } from './network'
import { RemoteLauncher, type RemoteLaunchDeps } from './remote-launch'
import { MobileServer, type ServerDeps, type WebAssets } from './server'
import type { TailscaleClient } from './tailscale'
import {
  createVapidKeys,
  parseSubscription,
  sendPush,
  type PushPost,
  type VapidKeys
} from './webpush'

export interface KeyBox {
  available(): boolean
  encrypt(s: string): Buffer
  decrypt(b: Buffer): string
}

export interface MobileServiceDeps {
  store: JsonStore<MobileFile>
  settings(): MobileSettings
  saveSettings(next: MobileSettings): Promise<void>
  call(channel: string, args: unknown[]): Promise<unknown>
  launch: Omit<RemoteLaunchDeps, 'settings' | 'log' | 'deviceActive'> & {
    settings(): { terminal: TerminalPref; branchConfirmed: boolean }
  }
  web: WebAssets
  /** The web app was built (out/renderer/mobile.html exists). */
  webAppFile: string
  tailscale: TailscaleClient
  keys: KeyBox
  appVersion: string
  fixtures: boolean
  /** Claude Code for Windows (absolute path), if found. */
  claudePath(): Promise<string | undefined>
  /** Terminal access: a phone offers its public SSH key (shown on the PC only). */
  proposeKey?: ServerDeps['proposeKey']
  /** For tests: how a push is posted (default: HTTPS to the push service). */
  pushPost?: PushPost
}

export class MobileService extends EventEmitter<{ changed: [] }> {
  readonly registry: DeviceRegistry
  readonly server: MobileServer
  private pairing: PairingInfo | undefined
  private lastError: string | undefined
  private ts: TailscaleStatus | undefined
  private changeTimer: NodeJS.Timeout | undefined
  private pushTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly deps: MobileServiceDeps) {
    super()
    this.registry = new DeviceRegistry(deps.store)
    const launcher = new RemoteLauncher({
      ...deps.launch,
      settings: () => {
        const m = this.settings
        return { ...deps.launch.settings(), readOnly: m.readOnly, confirmOnPc: m.confirmOnPc }
      },
      deviceActive: (id) => this.registry.isActive(id),
      log: ({ device, ...e }) => {
        this.registry.log({ deviceId: device.id, device: device.name, ...e })
        this.changed()
      }
    })
    this.server = new MobileServer({
      registry: this.registry,
      call: deps.call,
      launcher,
      web: deps.web,
      flags: () => ({
        readOnly: this.settings.readOnly,
        confirmOnPc: this.settings.confirmOnPc,
        mode: this.settings.mode,
        appVersion: deps.appVersion
      }),
      hosts: () => this.hosts(),
      changed: () => this.changed(),
      proposeKey: deps.proposeKey,
      push: {
        publicKey: () => this.pushPublicKey(),
        subscribe: (id, sub) => this.subscribePush(id, sub),
        unsubscribe: (id) => this.pushOff(id, 'phone'),
        test: (id) => this.webPush({ kind: 'test' }, id)
      }
    })
  }

  get tailscale(): TailscaleClient {
    return this.deps.tailscale
  }

  get settings(): MobileSettings {
    return { ...DEFAULT_MOBILE, ...this.deps.settings() }
  }

  private hosts(): Set<string> {
    const s = this.settings
    const addr = this.server.address()
    return allowedHosts({
      bind: addr?.host ?? LOOPBACK,
      port: addr?.port ?? s.port,
      tailscaleName: s.mode === 'tailscale' ? this.ts?.dnsName : undefined,
      httpsPort: s.httpsPort
    })
  }

  /** Tell the desktop window (debounced). */
  changed(): void {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      this.emit('changed')
    }, 150)
  }

  /** Push a live-update notice to phones (at most one per second per kind). */
  push(channel: Extract<MobileEvent, { type: 'event' }>['channel']): void {
    if (!this.server.running || this.pushTimers.has(channel)) return
    this.pushTimers.set(
      channel,
      setTimeout(() => {
        this.pushTimers.delete(channel)
        this.server.broadcast({ type: 'event', channel })
      }, 1000)
    )
  }

  toast(title: string, body?: string, deviceId?: string): number {
    if (!this.server.running) return 0
    return this.server.broadcast({ type: 'toast', title, body }, deviceId)
  }

  // ------------------------------------------------------------ status

  /** Where a phone opens the companion. */
  phoneUrl(): string | undefined {
    const s = this.settings
    const addr = this.server.address()
    if (!addr) return undefined
    if (s.mode === 'lan') return `https://${addr.host}:${addr.port}/`
    if (this.ts?.serve === 'on' && this.ts.dnsName)
      return `https://${this.ts.dnsName}${s.httpsPort === 443 ? '' : `:${s.httpsPort}`}/`
    return undefined
  }

  async refreshTailscale(): Promise<TailscaleStatus> {
    const s = this.settings
    this.ts = await this.deps.tailscale.status(s.httpsPort, s.port)
    return this.ts
  }

  async status(refresh = true): Promise<MobileStatus> {
    const s = this.settings
    if (refresh) await this.refreshTailscale().catch(() => undefined)
    const addr = this.server.address()
    let webAppMissing = false
    try {
      await access(this.deps.webAppFile)
    } catch {
      webAppMissing = true
    }
    if (this.pairing && Date.parse(this.pairing.expiresAt) < Date.now()) this.pairing = undefined
    if (this.pairing && !this.registry.pairingActive()) this.pairing = undefined
    return {
      settings: s,
      running: this.server.running,
      listening: addr ? `${addr.host}:${addr.port}` : undefined,
      url: this.phoneUrl(),
      error: this.lastError,
      tailscale: this.ts,
      firewallRule:
        s.mode === 'lan'
          ? !!this.deps.store.value.firewallRule ||
            (!this.deps.fixtures && (await firewallRuleExists()))
          : undefined,
      certFingerprint:
        s.mode === 'lan' && this.server.running && this.deps.store.value.lanCert
          ? fingerprint(this.deps.store.value.lanCert.cert)
          : undefined,
      devices: this.registry.list((id) => this.server.isConnected(id)),
      pairing: this.pairing,
      webAppMissing
    }
  }

  activity(limit?: number): ActivityEntry[] {
    return this.registry.activity(limit)
  }

  lanAddresses(): LanAddress[] {
    return lanAddresses()
  }

  // ------------------------------------------------------------ on / off

  // Start, stop, update and retry run one at a time: overlapping clicks
  // (or the wizard and Settings together) can't leave a second listener behind.
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  update(patch: Partial<MobileSettings>): Promise<MobileStatus> {
    return this.serial(() => this.doUpdate(patch))
  }

  start(): Promise<MobileStatus> {
    return this.serial(() => this.doStart())
  }

  stop(prev?: MobileSettings, keepEnabled = false): Promise<MobileStatus> {
    return this.serial(() => this.doStop(prev ?? this.settings, keepEnabled))
  }

  retryServe(): Promise<MobileStatus> {
    return this.serial(() => this.doRetryServe())
  }

  private async doUpdate(patch: Partial<MobileSettings>): Promise<MobileStatus> {
    const before = this.settings
    const next: MobileSettings = { ...before }
    if (typeof patch.readOnly === 'boolean') next.readOnly = patch.readOnly
    if (typeof patch.confirmOnPc === 'boolean') next.confirmOnPc = patch.confirmOnPc
    if (typeof patch.autoStart === 'boolean') next.autoStart = patch.autoStart
    if (patch.mode === 'tailscale' || patch.mode === 'lan') next.mode = patch.mode
    // On a shared network a stranger could sit between the phone and the PC
    // behind the self-signed certificate warning: ask on the PC before every
    // launch (can be turned off again).
    if (before.mode !== 'lan' && next.mode === 'lan' && typeof patch.confirmOnPc !== 'boolean')
      next.confirmOnPc = true
    if (typeof patch.lanAddress === 'string') next.lanAddress = patch.lanAddress
    const port = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : undefined
    next.port = port(patch.port) ?? next.port
    next.httpsPort = port(patch.httpsPort) ?? (patch.httpsPort === 443 ? 443 : next.httpsPort)
    await this.deps.saveSettings(next)
    if (before.readOnly !== next.readOnly || before.confirmOnPc !== next.confirmOnPc)
      this.registry.log({
        action: 'settings',
        detail: `On the PC: read-only ${next.readOnly ? 'on' : 'off'}, confirm on PC ${next.confirmOnPc ? 'on' : 'off'}`,
        ok: true
      })
    // Where it listens changed: restart (and move the serve rule).
    const moved =
      before.mode !== next.mode ||
      before.port !== next.port ||
      before.httpsPort !== next.httpsPort ||
      before.lanAddress !== next.lanAddress
    if (moved && this.server.running) {
      // A move isn't the user turning phone access off: it stays on.
      await this.doStop(before, true)
      if (this.deps.store.value.serveRule) {
        // The old Tailscale rule couldn't be removed: don't move, or it would
        // be left behind pointing at the old port.
        const why = this.lastError
        await this.deps.saveSettings({ ...before })
        await this.doStart()
        this.lastError = `Phone access wasn't moved: the Tailscale rule for the old port couldn't be removed (${why ?? 'unknown error'}). Try again.`
        this.changed()
        return this.status()
      }
      await this.doStart()
    }
    // Phones show (or hide) their launch and edit controls from this.
    if (before.readOnly !== next.readOnly || before.confirmOnPc !== next.confirmOnPc)
      this.server.broadcast({ type: 'event', channel: 'policy' })
    this.changed()
    return this.status()
  }

  private async doStart(): Promise<MobileStatus> {
    if (this.closing) return this.status(false)
    const s = this.settings
    this.lastError = undefined
    let host: string
    try {
      host = bindAddress(s)
    } catch (err) {
      this.lastError = (err as Error).message
      return this.status()
    }
    try {
      await this.server.start({
        host,
        port: s.port,
        tls: s.mode === 'lan' ? this.lanCert(host) : undefined
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      this.lastError =
        e.code === 'EADDRINUSE'
          ? `Port ${s.port} is already in use on this PC. Choose another port.`
          : e.message
      return this.status()
    }
    if (!s.enabled) await this.deps.saveSettings({ ...s, enabled: true })
    if (s.mode === 'tailscale') {
      const r = await this.deps.tailscale
        .serveOn(s.httpsPort, s.port)
        .catch((err: Error) => ({ ok: false, link: undefined, error: err.message }))
      if (r.ok) {
        this.deps.store.update((f) => {
          f.serveRule = { httpsPort: s.httpsPort, target: `http://127.0.0.1:${s.port}` }
        })
      } else if (r.link) {
        this.lastError = `Tailscale needs your OK first: ${r.link}`
      } else {
        this.lastError = r.error
      }
    }
    this.registry.log({
      action: 'server',
      detail: `Phone access on (${s.mode === 'lan' ? 'home Wi-Fi' : 'Tailscale'})`,
      ok: true
    })
    this.changed()
    return this.status()
  }

  /** Stop the server and remove our serve rule (never anyone else's). */
  private async doStop(prev: MobileSettings, keepEnabled: boolean): Promise<MobileStatus> {
    await this.server.stop()
    this.pairing = undefined
    this.registry.cancelPairing()
    // Our rule: the one the app recorded, or (if it was added by hand) a rule on
    // our HTTPS port that proxies exactly to our own local server. serveOff
    // removes it only when it still matches that; anything else is left alone.
    const rule = this.deps.store.value.serveRule
    this.lastError = undefined
    if (prev.mode === 'tailscale' || rule) {
      const r = await this.deps.tailscale
        .serveOff(
          rule?.httpsPort ?? prev.httpsPort,
          (rule && recordedPort(rule.target)) ?? prev.port
        )
        .catch((err: Error) => ({ ok: false, error: err.message }))
      if (r.ok)
        this.deps.store.update((f) => {
          f.serveRule = undefined
        })
      else if (rule) this.lastError = r.error
    }
    if (!keepEnabled && this.settings.enabled)
      await this.deps.saveSettings({ ...this.settings, enabled: false })
    this.registry.log({ action: 'server', detail: 'Phone access off', ok: true })
    this.changed()
    return this.status()
  }

  /** At app start: bring the companion back if it was on and auto-start is set. */
  async autoStart(): Promise<void> {
    const s = this.settings
    if (s.enabled && s.autoStart) await this.start()
  }

  /** On quit: stop serving, but remember it was on (auto-start brings it back). */
  /** Quitting: after anything already queued, stop, and start nothing after. */
  shutdown(): Promise<void> {
    this.closing = true
    return this.serial(async () => {
      // Also when stopped but our rule is still there (an earlier removal failed).
      if (this.server.running || this.deps.store.value.serveRule)
        await this.doStop(this.settings, true)
    })
  }

  /** Retry `tailscale serve` (after the user approved HTTPS in the browser). */
  private async doRetryServe(): Promise<MobileStatus> {
    const s = this.settings
    if (this.server.running && s.mode === 'tailscale') {
      this.lastError = undefined
      const r = await this.deps.tailscale.serveOn(s.httpsPort, s.port)
      if (r.ok)
        this.deps.store.update((f) => {
          f.serveRule = { httpsPort: s.httpsPort, target: `http://127.0.0.1:${s.port}` }
        })
      else this.lastError = r.link ? `Tailscale needs your OK first: ${r.link}` : r.error
    }
    return this.status()
  }

  private lanCert(address: string): { cert: string; key: string } {
    const saved = this.deps.store.value.lanCert
    if (
      saved &&
      saved.address === address &&
      Date.parse(saved.expiresAt) > Date.now() + 7 * 864e5
    ) {
      try {
        const key = saved.encrypted
          ? this.deps.keys.decrypt(Buffer.from(saved.key, 'base64'))
          : saved.key
        return { cert: saved.cert, key }
      } catch {
        // Make a new one below.
      }
    }
    const c = createSelfSignedCert(address)
    const encrypted = this.deps.keys.available()
    this.deps.store.update((f) => {
      f.lanCert = {
        address,
        cert: c.cert,
        key: encrypted ? this.deps.keys.encrypt(c.key).toString('base64') : c.key,
        encrypted,
        expiresAt: c.expiresAt
      }
    })
    return { cert: c.cert, key: c.key }
  }

  // ------------------------------------------------------------ pairing

  startPairing(): PairingInfo | { error: string } {
    if (!this.server.running) return { error: 'Turn on phone access first.' }
    const addr = this.server.address()!
    const base = this.phoneUrl() ?? `http://${addr.host}:${addr.port}/`
    this.pairing = this.registry.startPairing(base)
    this.changed()
    return this.pairing
  }

  cancelPairing(): void {
    this.pairing = undefined
    this.registry.cancelPairing()
    this.changed()
  }

  revoke(id: string): void {
    this.registry.revoke(id)
    this.server.disconnect(id)
    this.changed()
  }

  rename(id: string, name: string): void {
    this.registry.rename(id, name)
    this.changed()
  }

  sendTest(deviceId?: string): number {
    const n = this.toast(
      'Hello from your PC 👋',
      'Live updates work. You can close this.',
      deviceId
    )
    this.registry.log({
      action: 'test',
      detail: `Test message sent to ${n} connection${n === 1 ? '' : 's'}`,
      ok: n > 0
    })
    this.changed()
    return n
  }

  // ------------------------------------------------------------ push

  private vapidCache: VapidKeys | undefined

  /** The app's VAPID keys: made once, kept in mobile.json (private key encrypted when possible). */
  private vapid(): VapidKeys {
    if (this.vapidCache) return this.vapidCache
    const saved = this.deps.store.value.vapid
    if (saved) {
      try {
        const privateKeyPkcs8 = saved.encrypted
          ? this.deps.keys.decrypt(Buffer.from(saved.privateKey, 'base64'))
          : saved.privateKey
        this.vapidCache = { publicKey: saved.publicKey, privateKeyPkcs8 }
        return this.vapidCache
      } catch {
        // Can't be read on this PC any more (e.g. a copied profile): make new
        // keys. Phones then have to turn push on again, since their
        // subscriptions belong to the old key.
        this.deps.store.update((f) => {
          for (const d of f.devices) delete d.push
        })
      }
    }
    const k = createVapidKeys()
    const encrypted = this.deps.keys.available()
    this.deps.store.update((f) => {
      f.vapid = {
        publicKey: k.publicKey,
        privateKey: encrypted
          ? this.deps.keys.encrypt(k.privateKeyPkcs8).toString('base64')
          : k.privateKeyPkcs8,
        encrypted
      }
    })
    this.vapidCache = k
    return k
  }

  /** What a phone passes as `applicationServerKey` when it subscribes. */
  pushPublicKey(): string {
    return this.vapid().publicKey
  }

  private subscribePush(deviceId: string, raw: unknown): { ok: boolean; error?: string } {
    const sub = parseSubscription(raw)
    if ('error' in sub) return { ok: false, error: sub.error }
    // Only for a key the phone got from this PC (re-made keys invalidate old subscriptions).
    this.vapid()
    const d = this.registry.list().find((x) => x.id === deviceId)
    this.registry.setPush(deviceId, sub)
    this.registry.log({
      action: 'push',
      deviceId,
      device: d?.name,
      detail: 'Push alerts turned on for this phone',
      ok: true
    })
    this.changed()
    return { ok: true }
  }

  /** Turn a phone's push alerts off (from the PC, or the phone itself). */
  pushOff(deviceId: string, by: 'pc' | 'phone' = 'pc'): void {
    const d = this.registry.list().find((x) => x.id === deviceId)
    if (!d?.push) return
    this.registry.setPush(deviceId, undefined)
    this.registry.log({
      action: 'push',
      deviceId,
      device: d.name,
      detail:
        by === 'pc' ? 'Push alerts turned off on the PC' : 'Push alerts turned off on the phone',
      ok: true
    })
    this.changed()
  }

  /**
   * Send a push alert to every paired phone with push on (or one). The
   * message is only `{v, kind, ref}` (see webpush.ts). Only while phone access
   * is on: turning it off stops push too. In fixtures mode nothing is sent.
   * Returns how many phones it was sent to.
   */
  async webPush(notice: { kind: PushKind; ref?: string }, deviceId?: string): Promise<number> {
    if (!this.settings.enabled) return 0
    const targets = this.registry.pushTargets().filter((d) => !deviceId || d.id === deviceId)
    if (!targets.length) return 0
    if (this.deps.fixtures) {
      this.registry.log({
        action: 'push',
        detail: `Push “${notice.kind}” (simulated) for ${phones(targets.length)}`,
        ok: true
      })
      this.changed()
      return targets.length
    }
    const vapid = this.vapid()
    const results = await Promise.all(
      targets.map(async (d) => ({
        d,
        r: await sendPush(d.push!, notice, vapid, { post: this.deps.pushPost })
      }))
    )
    let sent = 0
    for (const { d, r } of results) {
      if (r.ok) sent++
      else if (r.gone) {
        this.registry.setPush(d.id, undefined)
        this.registry.log({
          action: 'push',
          deviceId: d.id,
          device: d.name,
          detail: 'The phone ended its push subscription: push alerts are off for it now',
          ok: false
        })
      } else
        this.registry.log({
          action: 'push',
          deviceId: d.id,
          device: d.name,
          detail: `Push “${notice.kind}” failed: ${r.error ?? 'unknown error'}`,
          ok: false
        })
    }
    if (sent)
      this.registry.log({
        action: 'push',
        detail: `Push “${notice.kind}” sent to ${phones(sent)}`,
        ok: true
      })
    this.changed()
    return sent
  }

  /** Settings → Phone: a test push to one phone. */
  sendTestPush(deviceId: string): Promise<number> {
    return this.webPush({ kind: 'test' }, deviceId)
  }

  // ------------------------------------------------------------ checks

  async claudeCheck(): Promise<ClaudeCheck> {
    const blockingEnv = ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_GROWTHBOOK'].filter(
      (k) => !!process.env[k]
    )
    const apiKeyEnv = REMOTE_CONTROL_UNSET_ENV.filter((k) => !!process.env[k])
    if (this.deps.fixtures)
      return {
        found: true,
        version: '2.1.309',
        versionOk: true,
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: 'max',
        blockingEnv,
        apiKeyEnv
      }
    const claude = await this.deps.claudePath()
    if (!claude) return { found: false, versionOk: false, blockingEnv, apiKeyEnv }
    const run = (args: string[]): Promise<string> =>
      new Promise((resolve) => {
        // Fixed arguments; a .cmd shim needs the shell, an .exe doesn't.
        const shell = /\.(cmd|bat)$/i.test(claude)
        execFile(
          shell ? `"${claude}"` : claude,
          args,
          { windowsHide: true, timeout: 20_000, shell, env: { ...process.env, NO_COLOR: '1' } },
          (_err, stdout) => resolve(String(stdout ?? ''))
        )
      })
    const [ver, auth] = await Promise.all([run(['--version']), run(['auth', 'status', '--json'])])
    const version = ver.match(/\d+\.\d+\.\d+/)?.[0]
    let a: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {}
    try {
      a = JSON.parse(auth) as typeof a
    } catch {
      // Older Claude Code: no JSON status.
    }
    return {
      found: true,
      version,
      versionOk: versionAtLeast(version, REMOTE_CONTROL_MIN_VERSION),
      loggedIn: a.loggedIn,
      authMethod: a.authMethod,
      subscriptionType: a.subscriptionType,
      blockingEnv,
      apiKeyEnv,
      error: version ? undefined : "Couldn't read Claude Code's version."
    }
  }

  /** For "Copy diagnostics": no tokens, codes, keys, e-mail or names of other people. */
  async diagnostics(): Promise<string> {
    const st = await this.status()
    const c = await this.claudeCheck().catch(() => undefined)
    const t = st.tailscale
    const lines = [
      `Claude Session Dashboard ${this.deps.appVersion} (${process.platform} ${process.arch})`,
      `Phone access: ${st.running ? 'on' : 'off'} · mode ${st.settings.mode} · listening ${st.listening ?? '-'}`,
      `Ports: local ${st.settings.port}, Tailscale HTTPS ${st.settings.httpsPort}`,
      `Read-only ${st.settings.readOnly} · confirm on PC ${st.settings.confirmOnPc} · auto-start ${st.settings.autoStart}`,
      `Paired phones: ${st.devices.length} (${st.devices.filter((d) => d.connected).length} connected)`,
      `Web app built: ${!st.webAppMissing}`,
      `Tailscale: ${t ? `${t.installed ? `installed ${t.version ?? ''}` : 'not installed'} · state ${t.backendState ?? '-'} · HTTPS certs ${t.httpsEnabled ? 'on' : 'off'} · serve ${t.serve}` : '-'}`,
      st.settings.mode === 'lan' ? `Firewall rule: ${st.firewallRule ? 'present' : 'missing'}` : '',
      `Claude Code: ${c ? `${c.found ? (c.version ?? 'unknown version') : 'not found'} · Remote Control version ${c.versionOk ? 'OK' : 'too old'} · signed in ${c.loggedIn ?? '?'} (${c.authMethod ?? '?'}, ${c.subscriptionType ?? '?'})` : '-'}`,
      c?.blockingEnv.length ? `Blocking variables set: ${c.blockingEnv.join(', ')}` : '',
      c?.apiKeyEnv.length
        ? `API key variables set (removed for launches): ${c.apiKeyEnv.join(', ')}`
        : '',
      st.error ? `Last error: ${st.error.replace(/https:\/\/\S+/g, '<link>')}` : ''
    ]
    return lines.filter(Boolean).join('\n')
  }
}

/** The local port of a rule the app recorded ("http://127.0.0.1:47821" → 47821). */
export function recordedPort(target: string): number | undefined {
  const m = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(target)
  const n = m ? Number(m[1]) : NaN
  return n >= 0 && n <= 65535 ? n : undefined
}

export function webAppFile(rendererDir: string): string {
  return join(rendererDir, 'mobile.html')
}

const phones = (n: number): string => `${n} phone${n === 1 ? '' : 's'}`
