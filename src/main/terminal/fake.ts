// A stand-in PC for fixtures mode and tests: it answers the probe and "runs"
// the wizard's scripts against an in-memory state. Nothing real is touched.

import { createHash } from 'node:crypto'
import type { ProbeResult, RunOutcome, ScriptRunner } from './host'
import type { BuiltScript } from './scripts'

export interface FakePc {
  probe(): Promise<ProbeResult>
  run: ScriptRunner
  state: ProbeResult & { keys: string[] }
  /** Every script that "ran", for tests. */
  ran: BuiltScript[]
}

export function fakePc(
  opts: { config?: Buffer; admin?: boolean; installed?: boolean } = {}
): FakePc {
  const state: FakePc['state'] = {
    sshdExe: !!opts.installed,
    sshdService: opts.installed ? { status: 'Stopped', startType: 'Manual' } : undefined,
    oursRule: false,
    defaultRule: opts.installed ? { enabled: true } : undefined,
    admin: opts.admin ?? true,
    tsAlias: 'Tailscale',
    defaultDistro: 'Ubuntu-24.04',
    config: opts.installed ? opts.config : undefined,
    events: [],
    eventsOk: true,
    keys: []
  }
  const ran: BuiltScript[] = []
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

  const part = (
    name: string,
    body: string,
    q: Record<string, unknown>
  ): Record<string, unknown> => {
    switch (name) {
      case 'install':
        if (state.sshdExe) return { ok: true }
        state.sshdExe = true
        state.sshdVersion = '9.5.0.0'
        state.sshdService = { status: 'Stopped', startType: 'Manual' }
        state.defaultRule = { enabled: true }
        state.config = opts.config
        return { ok: true, installed: true }
      case 'uninstall':
        state.sshdExe = false
        state.sshdService = undefined
        state.defaultRule = undefined
        return { ok: true }
      case 'service':
        if (!state.sshdService)
          return { ok: false, error: 'Cannot find any service with service name sshd.' }
        state.sshdService =
          typeof q.StartType === 'string'
            ? { status: 'Stopped', startType: q.StartType }
            : { status: 'Running', startType: 'Automatic' }
        return { ok: true }
      case 'firewall':
        state.oursRule = typeof q.Port === 'string'
        return { ok: true }
      case 'default-rule':
        if (!state.defaultRule) return { ok: false, error: 'No rule named OpenSSH-Server-In-TCP.' }
        state.defaultRule = { enabled: body.startsWith('Enable') }
        return { ok: true }
      case 'shell':
        state.shell = typeof q.Shell === 'string' ? q.Shell : undefined
        return { ok: true }
      case 'key': {
        const line = String(q.Line)
        if (typeof q.Blob === 'string') {
          const already = state.keys.some((k) => k.includes(` ${String(q.Blob)}`))
          if (!already) state.keys.push(line)
          // Pretend the phone logged in with it a moment later.
          const fp = /SHA256:\S+/.exec(String(q.Fingerprint ?? ''))?.[0] ?? ''
          state.events.unshift({
            at: new Date().toISOString(),
            message: `sshd: Accepted publickey for beau from 100.101.102.103 port 50122 ssh2: ED25519 ${fp}`
          })
          return { ok: true, already }
        }
        const before = state.keys.length
        state.keys = state.keys.filter((k) => k.trim() !== line)
        return { ok: true, removed: before - state.keys.length }
      }
      case 'sshd-config': {
        if (!state.config || sha(state.config) !== q.Expect)
          return {
            ok: false,
            error: 'sshd_config changed since it was read, so nothing was changed. Try again.'
          }
        state.config = Buffer.from(String(q.Content), 'base64')
        return { ok: true }
      }
      default:
        return { ok: false, error: `Unknown part ${name}` }
    }
  }

  return {
    state,
    ran,
    probe: async () => ({ ...state, events: [...state.events] }),
    run: async (s): Promise<RunOutcome> => {
      ran.push(s)
      const parts = s.parts.map((p) => part(p.name, p.body, p.params))
      return {
        ok: parts.every((p) => p.ok),
        error: parts.find((p) => !p.ok)?.error as string | undefined,
        parts
      }
    }
  }
}
