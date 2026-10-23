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
import { MobileServer, type WebAssets } from './server'
import type { TailscaleClient } from './tailscale'

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
  launch: Omit<RemoteLaunchDeps, 'settings' | 'log'> & {
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
      changed: () => this.changed()
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
          ? !!this.deps.store.value.firewallRule || (await firewallRuleExists())
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

  async update(patch: Partial<MobileSettings>): Promise<MobileStatus> {
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
      await this.stop(before)
      await this.start()
    }
    this.changed()
    return this.status()
  }

  async start(): Promise<MobileStatus> {
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
  async stop(prev = this.settings, keepEnabled = false): Promise<MobileStatus> {
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
        .serveOff(rule?.httpsPort ?? prev.httpsPort, prev.port)
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
  async shutdown(): Promise<void> {
    if (this.server.running) await this.stop(this.settings, true)
  }

  /** Retry `tailscale serve` (after the user approved HTTPS in the browser). */
  async retryServe(): Promise<MobileStatus> {
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

export function webAppFile(rendererDir: string): string {
  return join(rendererDir, 'mobile.html')
}
