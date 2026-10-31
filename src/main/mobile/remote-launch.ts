// Launches requested from a paired phone.
//
// A phone can only ask for Resume, Fork or Branch of a session the app knows.
// The options are fixed here, whatever the phone sends: Remote Control on,
// the Claude subscription (never an API key), permission prompts kept
// (never --dangerously-skip-permissions), the session's own folder, and the
// terminal chosen in Settings. Nothing else can be run.

import type { RemoteLaunchPreview, RemoteLaunchRequest, RemoteLaunchResult } from '@shared/mobile'
import type {
  LaunchOptions,
  LaunchPreview,
  LaunchResult,
  SessionSummary,
  TerminalPref
} from '@shared/types'
import type { LaunchContext } from '../services/launcher'
import type { StoredDevice } from './devices'
import { RateLimiter } from './rate-limit'

export interface RemoteLaunchDeps {
  session(key: string): SessionSummary | undefined
  preview(opts: LaunchOptions): Promise<LaunchPreview>
  launch(opts: LaunchOptions, ctx: LaunchContext): Promise<LaunchResult>
  settings(): {
    terminal: TerminalPref
    readOnly: boolean
    confirmOnPc: boolean
    branchConfirmed: boolean
  }
  /** Ask on the PC; resolves false if declined or not answered in time. */
  confirm(device: StoredDevice, what: string): Promise<boolean>
  /** The phone is still paired (not revoked or expired since the request began). */
  deviceActive(id: string): boolean
  log(entry: { device: StoredDevice; action: string; detail?: string; ok: boolean }): void
  now?: () => number
}

const KINDS = ['resume', 'fork', 'branch'] as const

/** Validate what the phone sent; anything unexpected is refused, not fixed up. */
export function parseLaunchRequest(v: unknown): RemoteLaunchRequest | { error: string } {
  if (!v || typeof v !== 'object') return { error: 'Bad request' }
  const o = v as Record<string, unknown>
  if (typeof o.key !== 'string' || !o.key || o.key.length > 300) return { error: 'Bad session' }
  if (!KINDS.includes(o.kind as (typeof KINDS)[number])) return { error: 'Bad launch kind' }
  const kind = o.kind as RemoteLaunchRequest['kind']
  if (kind !== 'branch') return { key: o.key, kind }
  const b = o.branch as Record<string, unknown> | undefined
  if (!b || typeof b.at !== 'string' || !b.at || b.at.length > 200)
    return { error: 'Bad branch point' }
  if (b.mode !== 'include' && b.mode !== 'before') return { error: 'Bad branch mode' }
  return { key: o.key, kind, branch: { at: b.at, mode: b.mode } }
}

/** The only launch options a phone can produce. */
export function remoteLaunchOptions(
  req: RemoteLaunchRequest,
  terminal: TerminalPref
): LaunchOptions {
  return {
    key: req.key,
    fork: req.kind === 'fork',
    skipPermissions: false,
    // Prompts on, whatever the user's settings or Claude Code's default say.
    askPermissions: true,
    remoteControl: true,
    terminal,
    ...(req.kind === 'branch' && req.branch ? { branch: { ...req.branch } } : {})
  }
}

export class RemoteLauncher {
  private readonly limiter: RateLimiter

  constructor(private readonly deps: RemoteLaunchDeps) {
    // One launch per 10 seconds and 12 an hour, per phone.
    this.limiter = new RateLimiter(
      [
        { max: 1, windowMs: 10_000 },
        { max: 12, windowMs: 3600_000 }
      ],
      deps.now
    )
  }

  private check(req: RemoteLaunchRequest): { s?: SessionSummary; error?: string } {
    const s = this.deps.session(req.key)
    if (!s) return { error: "That session isn't on this PC." }
    if (s.availability === 'imported')
      return { error: 'Conversations imported from claude.ai can be read, not resumed.' }
    if (req.kind === 'branch' && !this.deps.settings().branchConfirmed)
      return {
        error:
          'Use "Branch from here" once on your PC first: it explains what it adds to Claude’s project folder.'
      }
    return { s }
  }

  async preview(raw: unknown): Promise<RemoteLaunchPreview> {
    const req = parseLaunchRequest(raw)
    const st = this.deps.settings()
    const fail = (error: string, title = ''): RemoteLaunchPreview => ({
      ok: false,
      error,
      title,
      terminal: st.terminal,
      confirmOnPc: st.confirmOnPc,
      willRestore: false
    })
    if ('error' in req) return fail(req.error)
    const { s, error } = this.check(req)
    if (!s) return fail(error ?? 'Unknown session')
    let p: LaunchPreview
    try {
      p = await this.deps.preview({
        ...remoteLaunchOptions(req, st.terminal),
        branch: req.branch
      })
    } catch (err) {
      return fail((err as Error).message, s.title)
    }
    const problem =
      p.launchError ??
      p.branchError ??
      (!p.cwd
        ? 'No working folder is recorded for this session.'
        : !p.cwdExists
          ? `The folder no longer exists: ${p.cwd}. Choose another folder on the PC.`
          : p.restoreImpossible
            ? 'The session file is missing and there is no archive copy.'
            : undefined)
    return {
      ok: !problem && !st.readOnly,
      error: st.readOnly
        ? 'Read-only mode is on: launches from the phone are turned off.'
        : problem,
      title: s.title,
      cwd: p.cwd,
      terminal: p.terminal,
      remoteControlName: p.remoteControlName,
      confirmOnPc: st.confirmOnPc,
      willRestore: p.willRestore,
      modelChoice: p.modelChoice
    }
  }

  async launch(device: StoredDevice, raw: unknown): Promise<RemoteLaunchResult> {
    const st = this.deps.settings()
    const req = parseLaunchRequest(raw)
    if ('error' in req) {
      this.deps.log({ device, action: 'launch', detail: req.error, ok: false })
      return { ok: false, error: req.error }
    }
    const what = `${req.kind[0].toUpperCase()}${req.kind.slice(1)}`
    if (st.readOnly) {
      this.deps.log({
        device,
        action: 'launch',
        detail: `${what} refused: read-only mode`,
        ok: false
      })
      return { ok: false, error: 'Read-only mode is on: launches from the phone are turned off.' }
    }
    const { s, error } = this.check(req)
    if (!s) {
      this.deps.log({ device, action: 'launch', detail: `${what} refused: ${error}`, ok: false })
      return { ok: false, error }
    }
    if (!this.limiter.take(device.id)) {
      const wait = this.limiter.retryAfter(device.id)
      this.deps.log({
        device,
        action: 'launch',
        detail: `${what} “${s.title}”: rate limited`,
        ok: false
      })
      return { ok: false, error: `Too many launches. Try again in ${wait} s.` }
    }
    if (st.confirmOnPc) {
      const allowed = await this.deps.confirm(device, `${what} “${s.title}”`)
      if (!allowed) {
        this.deps.log({
          device,
          action: 'launch',
          detail: `${what} “${s.title}”: declined on the PC`,
          ok: false
        })
        return { ok: false, denied: true, error: 'Declined on the PC (or not answered in time).' }
      }
    }
    // Things may have changed while waiting (the PC dialog, the request body):
    // check the phone and read-only mode again right before launching.
    const now = this.deps.settings()
    if (!this.deps.deviceActive(device.id) || now.readOnly) {
      const why = now.readOnly ? 'read-only mode was turned on' : 'the phone was revoked'
      this.deps.log({ device, action: 'launch', detail: `${what} refused: ${why}`, ok: false })
      return { ok: false, error: `Not launched: ${why}.` }
    }
    const res = await this.deps.launch(remoteLaunchOptions(req, now.terminal), {
      via: 'phone',
      device: device.name,
      stillAllowed: () =>
        !this.deps.deviceActive(device.id)
          ? 'the phone was revoked'
          : this.deps.settings().readOnly
            ? 'read-only mode was turned on'
            : undefined
    })
    this.deps.log({
      device,
      action: 'launch',
      detail: `${what} “${s.title}” with Remote Control${res.ok ? '' : `: ${res.error ?? 'failed'}`}`,
      ok: res.ok
    })
    return {
      ok: res.ok,
      error: res.error,
      // A fork gets a new session id Claude Code picks itself: the phone finds
      // it by folder and start time instead of watching the parent.
      key: req.kind === 'fork' ? undefined : (res.branch?.key ?? s.key),
      fork:
        req.kind === 'fork' ? { parentKey: s.key, sourceId: s.sourceId, cwd: s.cwd } : undefined,
      simulated: res.simulated
    }
  }
}
