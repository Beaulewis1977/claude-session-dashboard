// Launches requested from a paired phone.
//
// A phone can only ask for Resume, Fork, Branch or Continue fresh of a
// session the app knows (Codex sessions: Resume, Fork and Continue fresh; no Branch),
// or for "Open in Codex app on PC": the existing Codex thread opened in the Codex
// desktop app (a fixed `codex://threads/<id>` link, nothing else), or for "Focus
// terminal on PC" of a running session (nothing is started or typed).
// A session that is already running on the PC (or, for Fork / Continue fresh, a
// fork or continuation of it the app launched) isn't started again unless the
// phone sends `force` ("Start another copy anyway", confirmed on the phone);
// every other option stays the same then.
// The options are fixed here, whatever the phone sends: Remote Control on
// (Claude Code; Codex has none, and asks before acting, in its workspace sandbox),
// the Claude subscription (never an API key), permission prompts kept
// (never --dangerously-skip-permissions), the session's own folder, and the
// terminal chosen in Settings. Nothing else can be run.

import type { RemoteLaunchPreview, RemoteLaunchRequest, RemoteLaunchResult } from '@shared/mobile'
import type { FocusResult } from '@shared/live'
import { runningError, type RunningCopy } from '@shared/running'
import { VIEW_ONLY_ERROR } from '@shared/view-only'
import type {
  LaunchOptions,
  LaunchPreview,
  LaunchResult,
  SessionSummary,
  TerminalPref
} from '@shared/types'
import { PROVIDER_LABEL, providerOf, type ProviderId } from '@shared/provider'
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
  /** "Focus terminal" of a running session (the desktop's own; absent: not offered). */
  focus?(key: string): Promise<FocusResult>
  /** What of this launch already runs on the PC (checked before the rate limit and the PC confirm). */
  running?(opts: LaunchOptions): RunningCopy | undefined
  log(entry: { device: StoredDevice; action: string; detail?: string; ok: boolean }): void
  now?: () => number
}

const KINDS = ['resume', 'fork', 'branch', 'continue', 'codex-app', 'focus'] as const

const VERB: Record<RemoteLaunchRequest['kind'], string> = {
  resume: 'Resume',
  fork: 'Fork',
  branch: 'Branch',
  continue: 'Continue fresh',
  'codex-app': 'Open in Codex app',
  focus: 'Focus terminal'
}

/** Validate what the phone sent; anything unexpected is refused, not fixed up. */
export function parseLaunchRequest(v: unknown): RemoteLaunchRequest | { error: string } {
  if (!v || typeof v !== 'object') return { error: 'Bad request' }
  const o = v as Record<string, unknown>
  if (typeof o.key !== 'string' || !o.key || o.key.length > 300) return { error: 'Bad session' }
  if (!KINDS.includes(o.kind as (typeof KINDS)[number])) return { error: 'Bad launch kind' }
  const kind = o.kind as RemoteLaunchRequest['kind']
  if (o.force !== undefined && o.force !== true) return { error: 'Bad request' }
  const force =
    o.force === true && kind !== 'focus' && kind !== 'branch' ? { force: true as const } : {}
  if (kind !== 'branch') return { key: o.key, kind, ...force }
  const b = o.branch as Record<string, unknown> | undefined
  if (!b || typeof b.at !== 'string' || !b.at || b.at.length > 200)
    return { error: 'Bad branch point' }
  if (b.mode !== 'include' && b.mode !== 'before') return { error: 'Bad branch mode' }
  return { key: o.key, kind, branch: { at: b.at, mode: b.mode } }
}

/** The only launch options a phone can produce. */
export function remoteLaunchOptions(
  req: RemoteLaunchRequest,
  terminal: TerminalPref,
  provider: ProviderId = 'claude'
): LaunchOptions {
  // Only after a confirm on the phone; nothing else changes.
  const dup = req.force === true ? { allowDuplicate: true } : {}
  // Only the thread itself, in the Codex app: no folder, terminal or flags.
  if (req.kind === 'codex-app')
    return {
      key: req.key,
      fork: false,
      skipPermissions: false,
      askPermissions: true,
      terminal,
      openIn: 'codex-app',
      ...dup
    }
  return {
    key: req.key,
    fork: req.kind === 'fork',
    // Never --dangerously-skip-permissions or --dangerously-bypass-approvals-and-sandbox.
    skipPermissions: false,
    // Prompts on, whatever the user's settings or the agent's own default say.
    askPermissions: true,
    // Remote Control is Claude Code's (on the Claude subscription).
    ...(provider === 'claude' ? { remoteControl: true } : {}),
    terminal,
    ...(req.kind === 'branch' && req.branch ? { branch: { ...req.branch } } : {}),
    // A new id is picked on the PC; the phone can't choose one.
    ...(req.kind === 'continue' ? { continueFresh: {} } : {}),
    ...dup
  }
}

export class RemoteLauncher {
  private readonly limiter: RateLimiter
  private readonly focusLimiter: RateLimiter

  constructor(private readonly deps: RemoteLaunchDeps) {
    // One launch per 10 seconds and 12 an hour, per phone.
    this.limiter = new RateLimiter(
      [
        { max: 1, windowMs: 10_000 },
        { max: 12, windowMs: 3600_000 }
      ],
      deps.now
    )
    // Focus terminal starts nothing: one per 3 seconds, 60 an hour.
    this.focusLimiter = new RateLimiter(
      [
        { max: 1, windowMs: 3000 },
        { max: 60, windowMs: 3600_000 }
      ],
      deps.now
    )
  }

  private check(req: RemoteLaunchRequest): { s?: SessionSummary; error?: string } {
    const s = this.deps.session(req.key)
    if (!s) return { error: "That session isn't on this PC." }
    if (s.availability === 'imported')
      return { error: 'Conversations imported from claude.ai can be read, not resumed.' }
    if (s.viewOnly) return { error: VIEW_ONLY_ERROR }
    const provider = providerOf(s)
    if (req.kind === 'codex-app' && provider !== 'codex')
      return { error: 'Only Codex sessions open in the Codex app.' }
    if (provider !== 'claude' && req.kind === 'branch')
      return {
        error: `${VERB[req.kind]} isn't available for ${PROVIDER_LABEL[provider]} sessions.`
      }
    if (req.kind === 'branch' && !this.deps.settings().branchConfirmed)
      return {
        error:
          'Use "Branch from here" once on your PC first: it explains what it adds to Claude’s project folder.'
      }
    if (req.kind === 'continue' && !s.meta.aiSummary)
      return {
        error: 'Summarize this session on your PC first: Continue fresh starts from its summary.'
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
    if (req.kind === 'focus')
      return {
        ok: !st.readOnly && !!this.deps.focus,
        error: st.readOnly
          ? 'Read-only mode is on: launches from the phone are turned off.'
          : undefined,
        title: this.deps.session(req.key)?.title ?? '',
        terminal: st.terminal,
        confirmOnPc: false,
        willRestore: false
      }
    const { s, error } = this.check(req)
    if (!s) return fail(error ?? 'Unknown session')
    let p: LaunchPreview
    try {
      p = await this.deps.preview({
        ...remoteLaunchOptions(req, st.terminal, providerOf(s)),
        branch: req.branch
      })
    } catch (err) {
      return fail((err as Error).message, s.title)
    }
    const problem =
      req.kind === 'codex-app'
        ? p.codexApp?.available
          ? undefined
          : (p.codexApp?.reason ?? "This session can't be opened in the Codex app.")
        : (p.launchError ??
          p.branchError ??
          p.continueError ??
          (!p.cwd
            ? 'No working folder is recorded for this session.'
            : !p.cwdExists
              ? `The folder no longer exists: ${p.cwd}. Choose another folder on the PC.`
              : p.restoreImpossible
                ? 'The session file is missing and there is no archive copy.'
                : undefined))
    return {
      ok: !problem && !st.readOnly,
      error: st.readOnly
        ? 'Read-only mode is on: launches from the phone are turned off.'
        : problem,
      title: s.title,
      ...(req.kind === 'codex-app' ? { codexApp: true } : { cwd: p.cwd }),
      terminal: p.terminal,
      remoteControlName: p.remoteControlName,
      confirmOnPc: st.confirmOnPc,
      willRestore: p.willRestore,
      modelChoice: p.modelChoice,
      ...(p.continueFresh ? { newSinceSummary: p.continueFresh.newSince } : {}),
      // Model names only: what the Fast picker goes by for this branch.
      ...(p.branch ? { branch: p.branch.lastModel ? { lastModel: p.branch.lastModel } : {} } : {}),
      ...(p.context ? { context: p.context } : {}),
      ...(p.running ? { running: this.titled(p.running) } : {})
    }
  }

  /** The running copy, with its title as the PC shows it. */
  private titled<T extends { key: string; title?: string; name?: string }>(r: T): T {
    const t = this.deps.session(r.key)?.title ?? r.name
    return t ? { ...r, title: t } : r
  }

  /**
   * Focus terminal on PC: brings the running session's terminal forward.
   * Nothing is started or typed. Refused in read-only mode, rate-limited, logged.
   */
  private async focus(device: StoredDevice, req: RemoteLaunchRequest): Promise<RemoteLaunchResult> {
    const title = this.deps.session(req.key)?.title ?? 'a running session'
    const log = (ok: boolean, why?: string): void =>
      this.deps.log({
        device,
        action: 'focus',
        detail: `Focus terminal “${title}”${why ? `: ${why}` : ''}`,
        ok
      })
    if (this.deps.settings().readOnly) {
      log(false, 'read-only mode')
      return { ok: false, error: 'Read-only mode is on: launches from the phone are turned off.' }
    }
    if (!this.deps.focus) return { ok: false, error: "Focus terminal isn't available on this PC." }
    // The request body was read after the phone was checked: it may have been revoked meanwhile.
    if (!this.deps.deviceActive(device.id)) {
      log(false, 'the phone was revoked')
      return { ok: false, error: 'Not done: the phone was revoked.' }
    }
    if (!this.focusLimiter.take(device.id)) {
      log(false, 'rate limited')
      const wait = this.focusLimiter.retryAfter(device.id)
      return { ok: false, error: `Too many requests. Try again in ${wait} s.` }
    }
    const r = await this.deps.focus(req.key)
    log(r.ok, r.ok ? undefined : r.error)
    return r.ok
      ? { ok: true, key: req.key, focused: r.how, simulated: r.simulated }
      : { ok: false, error: r.error ?? "Couldn't find its terminal window." }
  }

  async launch(device: StoredDevice, raw: unknown): Promise<RemoteLaunchResult> {
    const st = this.deps.settings()
    const req = parseLaunchRequest(raw)
    if ('error' in req) {
      this.deps.log({ device, action: 'launch', detail: req.error, ok: false })
      return { ok: false, error: req.error }
    }
    if (req.kind === 'focus') return this.focus(device, req)
    const what = VERB[req.kind]
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
    // Already running on the PC: say so before asking on the PC or counting a launch.
    if (!req.force) {
      const running = this.deps.running?.(remoteLaunchOptions(req, st.terminal, providerOf(s)))
      if (running) {
        this.deps.log({
          device,
          action: 'launch',
          detail: `${what} “${s.title}”: already running on the PC`,
          ok: false
        })
        return { ok: false, error: runningError(running), running: this.titled(running) }
      }
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
    const res = await this.deps.launch(remoteLaunchOptions(req, now.terminal, providerOf(s)), {
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
      detail: `${what} “${s.title}”${req.kind === 'codex-app' ? '' : providerOf(s) === 'claude' ? ' with Remote Control' : ` (${PROVIDER_LABEL[providerOf(s)]})`}${req.force ? ' (another copy, confirmed on the phone)' : ''}${res.ok ? '' : res.running ? ': already running on the PC' : `: ${res.error ?? 'failed'}`}`,
      ok: res.ok
    })
    if (res.running) return { ok: false, error: res.error, running: this.titled(res.running) }
    return {
      ok: res.ok,
      error: res.error,
      // A fork gets a new session id Claude Code picks itself: the phone finds
      // it by folder and start time instead of watching the parent.
      key:
        req.kind === 'fork'
          ? undefined
          : req.kind === 'continue'
            ? res.continuedKey
            : (res.branch?.key ?? s.key),
      fork:
        req.kind === 'fork' ? { parentKey: s.key, sourceId: s.sourceId, cwd: s.cwd } : undefined,
      simulated: res.simulated
    }
  }
}
