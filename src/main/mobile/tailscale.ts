// Tailscale: detect it, read its status, and add or remove the one
// `tailscale serve` rule that publishes the companion server to the tailnet.
//
// Rules: never Funnel (public internet), never `serve reset` or `clear`, never
// `tailscale up` (it can change other preferences). Only the rule for our own
// HTTPS port is ever added or removed, and only when that port isn't already
// used by someone else's rule.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { ServeState, TailscaleStatus } from '@shared/mobile'
import { fileExists, findOnPath } from '../core/which'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  /** Set when the run was stopped early because a sign-in/approval link appeared. */
  link?: string
}

export type Runner = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; stopAtLink?: boolean }
) => Promise<RunResult>

/** Links Tailscale prints for sign-in or for turning HTTPS / Serve on. */
const LINK_RE = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_?=&.%-]+/

export function findLink(text: string): string | undefined {
  return text.match(LINK_RE)?.[0]
}

/** Every Tailscale command the app runs passes this check first. */
export function assertSafeTailscaleArgs(args: string[]): void {
  const verb = args[0]
  if (args.some((a) => /funnel/i.test(a))) throw new Error('Refusing to use Tailscale Funnel.')
  const allowed = ['version', 'status', 'serve', 'login']
  if (!allowed.includes(verb)) throw new Error(`Refusing to run "tailscale ${verb}".`)
  if (verb === 'serve') {
    if (
      args.some((a) => a === 'reset' || a === 'clear' || a === 'drain' || a.startsWith('--service'))
    )
      throw new Error('Refusing to change other Tailscale serve settings.')
    const isStatus = args[1] === 'status'
    if (!isStatus && !args.some((a) => /^--https=\d+$/.test(a)))
      throw new Error('A serve rule must name its own HTTPS port.')
  }
}

export function serveTarget(localPort: number): string {
  return `http://127.0.0.1:${localPort}`
}

export function serveOnArgs(httpsPort: number, localPort: number): string[] {
  return ['serve', '--bg', '--yes', `--https=${httpsPort}`, serveTarget(localPort)]
}

/** Removes only the rule on our HTTPS port. */
export function serveOffArgs(httpsPort: number): string[] {
  return ['serve', '--yes', `--https=${httpsPort}`, 'off']
}

interface StatusJson {
  Version?: string
  BackendState?: string
  AuthURL?: string
  Self?: { DNSName?: string; Online?: boolean }
  CurrentTailnet?: { Name?: string; MagicDNSEnabled?: boolean } | null
  CertDomains?: string[] | null
  Peer?: Record<
    string,
    { HostName?: string; DNSName?: string; OS?: string; Online?: boolean }
  > | null
}

export function parseStatus(text: string): Omit<TailscaleStatus, 'installed' | 'serve'> & {
  authUrl?: string
} {
  const j = JSON.parse(text) as StatusJson
  const dnsName = j.Self?.DNSName?.replace(/\.$/, '') || undefined
  const state = j.BackendState
  return {
    version: j.Version?.split('-')[0],
    backendState: state,
    loggedIn: state === 'Running' || state === 'Starting',
    dnsName,
    tailnet: j.CurrentTailnet?.Name || undefined,
    httpsEnabled: !!dnsName && (j.CertDomains ?? []).some((d) => d.replace(/\.$/, '') === dnsName),
    authUrl: j.AuthURL && LINK_RE.test(j.AuthURL) ? j.AuthURL : undefined,
    phones: Object.values(j.Peer ?? {})
      .filter((p) => /^(ios|android)$/i.test(p.OS ?? ''))
      .map((p) => ({
        name: p.HostName || p.DNSName?.split('.')[0] || 'phone',
        os: /^ios$/i.test(p.OS ?? '') ? 'iOS' : 'Android',
        online: p.Online === true
      }))
  }
}

interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
  AllowFunnel?: Record<string, boolean>
}

/**
 * Is our rule there? 'on': our port proxies to our server. 'conflict': the
 * port is used by something else, or Funnel is on for it (then we don't touch it).
 */
export function parseServe(
  text: string,
  opts: { httpsPort: number; localPort: number; dnsName?: string }
): ServeState {
  let j: ServeJson
  try {
    j = JSON.parse(text || '{}') as ServeJson
  } catch {
    return 'unknown'
  }
  const port = String(opts.httpsPort)
  const hostPorts = Object.keys(j.Web ?? {}).filter((hp) => hp.endsWith(`:${port}`))
  if (Object.entries(j.AllowFunnel ?? {}).some(([hp, on]) => on && hp.endsWith(`:${port}`)))
    return 'conflict'
  if (!j.TCP?.[port] && !hostPorts.length) return 'off'
  if (j.TCP?.[port]?.TCPForward) return 'conflict'
  const target = serveTarget(opts.localPort)
  const ours = hostPorts.some((hp) => {
    const handlers = j.Web?.[hp]?.Handlers ?? {}
    const keys = Object.keys(handlers)
    return keys.length === 1 && keys[0] === '/' && handlers['/']?.Proxy === target
  })
  return ours ? 'on' : 'conflict'
}

const defaultRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    assertSafeTailscaleArgs(args)
    const child = spawn(file, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (r: Partial<RunResult>): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, ...r })
    }
    const watch = (): void => {
      if (!opts.stopAtLink) return
      const link = findLink(stdout + stderr)
      if (link) {
        child.kill()
        finish({ link })
      }
    }
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
      watch()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
      watch()
    })
    child.on('error', (err) => finish({ code: -1, stderr: err.message }))
    child.on('close', (code) => finish({ code }))
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, link: findLink(stdout + stderr) })
    }, opts.timeoutMs)
  })

export function tailscaleCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
    join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe')
  ]
}

export class TailscaleClient {
  private path: string | undefined

  constructor(
    private readonly run: Runner = defaultRunner,
    private readonly locate: () => Promise<string | undefined> = async () => {
      for (const c of tailscaleCandidates()) if (await fileExists(c)) return c
      return findOnPath('tailscale', ['.exe'])
    }
  ) {}

  async find(): Promise<string | undefined> {
    if (!this.path || !(await fileExists(this.path))) this.path = await this.locate()
    return this.path
  }

  /** The Tailscale tray app (to sign in by hand). */
  async guiPath(): Promise<string | undefined> {
    const cli = await this.find()
    if (!cli) return undefined
    const gui = join(cli, '..', 'tailscale-ipn.exe')
    return (await fileExists(gui)) ? gui : undefined
  }

  private async exec(args: string[], timeoutMs = 10_000, stopAtLink = false): Promise<RunResult> {
    assertSafeTailscaleArgs(args)
    const file = await this.find()
    if (!file) return { code: -1, stdout: '', stderr: 'Tailscale is not installed.' }
    return this.run(file, args, { timeoutMs, stopAtLink })
  }

  async status(
    httpsPort: number,
    localPort: number
  ): Promise<TailscaleStatus & { authUrl?: string }> {
    if (!(await this.find())) return { installed: false, loggedIn: false, serve: 'unknown' }
    const r = await this.exec(['status', '--json'])
    let base: ReturnType<typeof parseStatus>
    try {
      base = parseStatus(r.stdout)
    } catch {
      return {
        installed: true,
        loggedIn: false,
        serve: 'unknown',
        error: (r.stderr || r.stdout).trim().slice(0, 300) || "Tailscale didn't answer."
      }
    }
    let serve: ServeState = 'unknown'
    if (base.loggedIn) {
      const s = await this.exec(['serve', 'status', '--json'])
      serve =
        s.code === 0
          ? parseServe(s.stdout, { httpsPort, localPort, dnsName: base.dnsName })
          : 'unknown'
    }
    return {
      installed: true,
      ...base,
      serve,
      serveUrl:
        base.dnsName && serve === 'on'
          ? `https://${base.dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}/`
          : undefined
    }
  }

  /**
   * Publish the companion to the tailnet. Returns a link when Tailscale needs
   * the user to approve something first (e.g. turning HTTPS on).
   */
  async serveOn(
    httpsPort: number,
    localPort: number
  ): Promise<{ ok: boolean; link?: string; error?: string }> {
    const before = await this.status(httpsPort, localPort)
    if (!before.installed) return { ok: false, error: 'Tailscale is not installed.' }
    if (!before.loggedIn) return { ok: false, error: 'Sign in to Tailscale first.' }
    if (before.serve === 'on') return { ok: true }
    // Only add a rule when we know the port is free: an unreadable status
    // could hide someone else's rule there.
    if (before.serve === 'unknown')
      return {
        ok: false,
        error: "Couldn't read Tailscale's serve settings, so nothing was changed. Try again."
      }
    if (before.serve === 'conflict')
      return {
        ok: false,
        error: `HTTPS port ${httpsPort} is already used by another Tailscale serve rule (or Funnel). Pick another port in Settings → Phone; the app won't change that rule.`
      }
    const r = await this.exec(serveOnArgs(httpsPort, localPort), 30_000, true)
    if (r.link) return { ok: false, link: r.link }
    if (r.code !== 0)
      return {
        ok: false,
        error: (r.stderr || r.stdout).trim().slice(0, 400) || 'tailscale serve failed.'
      }
    return { ok: true }
  }

  /** Remove our rule only, and only if it's still ours. */
  async serveOff(httpsPort: number, localPort: number): Promise<{ ok: boolean; error?: string }> {
    const st = await this.status(httpsPort, localPort)
    if (!st.installed || st.serve === 'off') return { ok: true }
    if (st.serve !== 'on')
      return { ok: false, error: `The rule on port ${httpsPort} isn't the app's; left unchanged.` }
    const r = await this.exec(serveOffArgs(httpsPort), 20_000)
    if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 400) }
    return { ok: true }
  }

  /** Start signing in: the link to open in the browser. */
  async loginLink(): Promise<{ link?: string; error?: string }> {
    const st = await this.status(443, 0)
    if (!st.installed) return { error: 'Tailscale is not installed.' }
    if (st.loggedIn) return {}
    if (st.authUrl) return { link: st.authUrl }
    const r = await this.exec(['login'], 30_000, true)
    return r.link
      ? { link: r.link }
      : { error: (r.stderr || r.stdout).trim().slice(0, 300) || undefined }
  }
}

/**
 * A stand-in Tailscale for tests and fixtures mode: answers `status`,
 * `serve status` and our serve on/off from memory. The real one is never run.
 */
export function fakeTailscale(opts: {
  dnsName?: string
  loggedIn?: boolean
  httpsEnabled?: boolean
  /** Serve rules that exist before the app adds its own (port → proxy target). */
  existing?: Record<string, string>
  calls?: string[][]
}): TailscaleClient {
  const dns = opts.dnsName ?? 'my-pc.tail1234.ts.net'
  const rules = new Map<string, string>(Object.entries(opts.existing ?? {}))
  const runner: Runner = async (_file, args) => {
    assertSafeTailscaleArgs(args)
    opts.calls?.push(args)
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })
    if (args[0] === 'status')
      return ok(
        JSON.stringify({
          Version: '1.104.2-fake',
          BackendState: opts.loggedIn === false ? 'NeedsLogin' : 'Running',
          Self: { DNSName: `${dns}.` },
          CurrentTailnet: { Name: 'you@example.com', MagicDNSEnabled: true },
          CertDomains: opts.httpsEnabled === false ? null : [dns],
          Peer: {
            a: {
              HostName: 'iphone-15',
              DNSName: 'iphone-15.tail1234.ts.net.',
              OS: 'iOS',
              Online: true
            }
          }
        })
      )
    if (args[0] === 'serve' && args[1] === 'status') {
      const TCP: Record<string, { HTTPS: boolean }> = {}
      const Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> = {}
      for (const [port, target] of rules) {
        TCP[port] = { HTTPS: true }
        Web[`${dns}:${port}`] = { Handlers: { '/': { Proxy: target } } }
      }
      return ok(JSON.stringify(rules.size ? { TCP, Web } : {}))
    }
    if (args[0] === 'serve') {
      const port = args.find((a) => a.startsWith('--https='))!.slice(8)
      if (args.at(-1) === 'off') rules.delete(port)
      else {
        if (opts.httpsEnabled === false)
          return {
            code: null,
            stdout:
              'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc123\n',
            stderr: '',
            link: 'https://login.tailscale.com/f/serve?node=abc123'
          }
        rules.set(port, args.at(-1)!)
      }
      return ok('')
    }
    return ok('1.104.2-fake')
  }
  return new TailscaleClient(runner, async () => 'C:\\Program Files\\Tailscale\\tailscale.exe')
}
