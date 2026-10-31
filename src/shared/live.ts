// "Running now": which Claude Code sessions are running, and what each one is
// doing. Three signals, combined here (pure, so it can be tested):
//
// 1. Claude Code's own registry, `<home>/.claude/sessions/<pid>.json` (read
//    only). Newer versions keep a live `status` in it: busy, idle, waiting
//    (a dialog is open) or shell (idle, with a background shell running).
//    Files stay behind when a session crashes, so the process must be alive.
// 2. Hook events saved by the opt-in hook bridge (`csd-hook.ps1/.sh`) in
//    `<home>/.claude-session-dashboard/events/`: the most precise signal for
//    "needs approval" and "finished", and the only one for older versions.
// 3. Recent activity in the session's JSONL transcript (the fallback).

import { remoteSessionUrl } from './jsonl'
import type { EnvKind } from './types'

export type LiveState = 'working' | 'approval' | 'idle' | 'exited'

/** The hook events the bridge subscribes to (all cheap, none per tool call). */
export const HOOK_EVENTS = [
  'Notification',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd'
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

/** One saved hook payload, reduced to what the dashboard uses (no prompts or replies). */
export interface HookEvent {
  /** When it was saved (file time on the app's clock), epoch ms. */
  ts: number
  /** Source id of the Claude home it came from. */
  source: string
  event: string
  sessionId: string
  cwd?: string
  /** Notification: permission_prompt, idle_prompt, elicitation_dialog, … */
  notificationType?: string
  /** Notification text, e.g. "Claude needs your permission to use Bash" (cut short). */
  message?: string
  /** PermissionRequest: the tool waiting for a yes. */
  toolName?: string
  /** SessionStart: startup, resume, clear, compact, fork. */
  startSource?: string
  /** SessionEnd: clear, logout, prompt_input_exit, other, … */
  reason?: string
  /** StopFailure: the error type. */
  error?: string
  /** The session's custom title (UserPromptSubmit), if it has one. */
  sessionTitle?: string
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const EVENT_RE = /^[A-Za-z]{1,40}$/

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function text(v: unknown, max = 200): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  return undefined
}

function parseJson(raw: string | unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') return obj(raw)
  try {
    return obj(JSON.parse(raw.replace(/^\uFEFF/, '')))
  } catch {
    return undefined
  }
}

/**
 * Parse one hook payload. Defensive: the format changes between Claude Code
 * versions, so every field is optional except the session and the event name.
 * The prompt, the last reply and tool input are never kept.
 */
export function parseHookEvent(
  raw: string | unknown,
  meta: { ts: number; source: string }
): HookEvent | undefined {
  const o = parseJson(raw)
  if (!o) return undefined
  const sessionId = text(o.session_id ?? o.sessionId, 128)
  const event = text(o.hook_event_name ?? o.hookEventName, 40)
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || !event || !EVENT_RE.test(event))
    return undefined
  const e: HookEvent = { ts: meta.ts, source: meta.source, event, sessionId }
  e.cwd = text(o.cwd, 1000)
  if (event === 'Notification') {
    e.notificationType = text(o.notification_type, 60)
    e.message = text(o.message, 200)
  } else if (event === 'PermissionRequest') {
    e.toolName = text(o.tool_name, 100)
  } else if (event === 'SessionStart') {
    e.startSource = text(o.source, 30)
  } else if (event === 'SessionEnd') {
    e.reason = text(o.reason, 60)
  } else if (event === 'StopFailure') {
    e.error = text(o.error_type ?? o.error ?? o.reason, 100)
  } else if (event === 'UserPromptSubmit') {
    e.sessionTitle = text(o.session_title, 200)
  }
  for (const k of Object.keys(e) as (keyof HookEvent)[]) if (e[k] === undefined) delete e[k]
  return e
}

/** One `~/.claude/sessions/<pid>.json` file: a Claude Code process says it's running. */
export interface RunningFile {
  pid: number
  sessionId: string
  cwd?: string
  /** Epoch ms. */
  startedAt?: number
  /**
   * When the process started, to tell a reused PID apart: a Windows FILETIME
   * (100 ns since 1601) or, in Linux, the start time in clock ticks since boot.
   */
  procStart?: string
  version?: string
  kind?: string
  entrypoint?: string
  /** Name given in Claude Code (`/rename`, Remote Control) or derived. */
  name?: string
  /** busy, idle, waiting, shell (newer versions only). */
  status?: string
  /** What a "waiting" session waits for, e.g. "dialog open". */
  waitingFor?: string
  updatedAt?: number
  statusUpdatedAt?: number
  /** Remote Control session id ("session_01…"), when Remote Control is on. */
  bridgeSessionId?: string
}

export function parseRunningFile(raw: string | unknown): RunningFile | undefined {
  const o = parseJson(raw)
  if (!o) return undefined
  const pid = num(o.pid)
  const sessionId = text(o.sessionId ?? o.session_id, 128)
  if (!pid || !Number.isInteger(pid) || pid <= 0 || !sessionId || !SESSION_ID_RE.test(sessionId))
    return undefined
  const f: RunningFile = { pid, sessionId }
  f.cwd = text(o.cwd, 1000)
  f.startedAt = num(o.startedAt)
  const ps = o.procStart
  if ((typeof ps === 'string' && /^\d{1,24}$/.test(ps)) || typeof ps === 'number')
    f.procStart = String(ps)
  f.version = text(o.version, 40)
  f.kind = text(o.kind, 40)
  f.entrypoint = text(o.entrypoint, 40)
  f.name = text(o.name, 200)
  f.status = text(o.status, 40)?.toLowerCase()
  f.waitingFor = text(o.waitingFor, 120)
  f.updatedAt = num(o.updatedAt)
  f.statusUpdatedAt = num(o.statusUpdatedAt)
  const bridge = text(o.bridgeSessionId, 80)
  if (bridge && /^session_[A-Za-z0-9]{8,64}$/.test(bridge)) f.bridgeSessionId = bridge
  for (const k of Object.keys(f) as (keyof RunningFile)[]) if (f[k] === undefined) delete f[k]
  return f
}

/** claude.ai/code link of a running session's Remote Control connection. */
export function remoteUrlOf(bridgeSessionId: string | undefined): string | undefined {
  return bridgeSessionId ? remoteSessionUrl(`https://claude.ai/code/${bridgeSessionId}`) : undefined
}

/** One running (or just ended) session, as the UI shows it. */
export interface LiveSession {
  /** `${sourceId}:${sessionId}`, the same key as the session list's. */
  key: string
  sessionId: string
  sourceId: string
  env: EnvKind
  distro?: string
  pid?: number
  state: LiveState
  /** When the current state began (best known), epoch ms. */
  since: number
  /** When the session (process) started, epoch ms. */
  startedAt?: number
  /** Last sign of life: transcript activity, a hook event or a status change. */
  lastSeenAt: number
  /** What it waits for ("Claude needs your permission to use Bash", "dialog open"). */
  detail?: string
  /** The last turn ended with an error (StopFailure). */
  failed?: boolean
  /** Idle, with a background shell still running. */
  background?: boolean
  /** Claude Code's own name for the session (from the running file). */
  name?: string
  cwd?: string
  /** claude.ai/code link, when Remote Control is on. */
  remoteUrl?: string
  version?: string
  entrypoint?: string
  /** Which signal the state comes from. */
  basis: 'status' | 'hook' | 'activity'
  /** The process couldn't be checked: it may have ended. */
  unverified?: boolean
}

/** A running file with its process check. */
export interface ProcInput {
  sourceId: string
  env: EnvKind
  distro?: string
  file: RunningFile
  /** File modification time, epoch ms (app clock). */
  mtime: number
  /** true: running · false: gone (or the PID belongs to another process now) · undefined: can't tell. */
  alive: boolean | undefined
  /**
   * When the app noticed the process gone, if it had seen it running before
   * (kept by the caller across polls). Unset for a file found already dead.
   */
  goneAt?: number
}

export interface TranscriptInfo {
  lastActivityAt?: number
  cwd?: string
  remoteUrl?: string
}

export interface LiveInputs {
  now: number
  procs: ProcInput[]
  /** The newest event per (source, session, event name) is enough. */
  events: HookEvent[]
  /** What the session list knows about a session (by key). */
  transcript: (key: string) => TranscriptInfo | undefined
  /** Sources where the hook bridge is on (hook-only sessions are trusted only there). */
  hooksOn: ReadonlySet<string>
  /** The previous result, so a state keeps its start time across polls. */
  prev?: ReadonlyMap<string, LiveSession>
  sourceEnv: (sourceId: string) => { env: EnvKind; distro?: string } | undefined
}

/** How long an ended session stays in "Running now" (as Exited). */
export const EXITED_KEEP_MS = 20 * 60_000
/** A process that can't be checked counts as running while there's news this recent. */
export const UNVERIFIED_MAX_MS = 30 * 60_000
/** Hook events alone (no running file) are trusted this long after the last sign of life. */
export const HOOK_ONLY_MAX_MS = 3 * 60 * 60_000
/** Transcript activity this recent means it's working (when nothing better says otherwise). */
export const ACTIVE_MS = 90_000

interface Signal {
  ts: number
  state: LiveState
  basis: LiveSession['basis']
  detail?: string
  failed?: boolean
  background?: boolean
}

const APPROVAL_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input'
])

/** What one hook event says about the session's state (undefined: nothing). */
export function hookSignal(e: HookEvent): Signal | undefined {
  const s = (state: LiveState, extra: Partial<Signal> = {}): Signal => ({
    ts: e.ts,
    state,
    basis: 'hook',
    ...extra
  })
  switch (e.event) {
    case 'UserPromptSubmit':
    case 'SubagentStop':
      return s('working')
    case 'PermissionRequest':
      return s('approval', {
        detail: e.toolName ? `Wants to use ${e.toolName}` : 'Waiting for your approval'
      })
    case 'Notification': {
      const t = e.notificationType
      if (t && APPROVAL_NOTIFICATIONS.has(t))
        return s('approval', { detail: e.message ?? 'Waiting for your answer' })
      if (t === 'idle_prompt') return s('idle', { detail: e.message })
      // Older versions send no type: the permission message says so.
      if (!t && e.message && /permission/i.test(e.message))
        return s('approval', { detail: e.message })
      return undefined
    }
    case 'Stop':
      return s('idle')
    case 'StopFailure':
      return s('idle', {
        failed: true,
        detail: e.error ? `Stopped: ${e.error}` : 'Stopped with an error'
      })
    case 'SessionStart':
      return s(e.startSource === 'compact' ? 'working' : 'idle')
    case 'SessionEnd':
      return s('exited', {
        detail: e.reason ? `Ended (${e.reason.replace(/_/g, ' ')})` : undefined
      })
    default:
      return undefined
  }
}

/** What the running file's `status` says (newer Claude Code versions). */
export function statusSignal(f: RunningFile, mtime: number): Signal | undefined {
  const ts = f.statusUpdatedAt ?? f.updatedAt ?? mtime
  switch (f.status) {
    case 'busy':
    case 'running':
    case 'working':
      return { ts, state: 'working', basis: 'status' }
    case 'idle':
      return { ts, state: 'idle', basis: 'status' }
    case 'shell':
      return { ts, state: 'idle', basis: 'status', background: true }
    case 'waiting':
      return {
        ts,
        state: 'approval',
        basis: 'status',
        detail: f.waitingFor && f.waitingFor !== 'dialog open' ? f.waitingFor : undefined
      }
    default:
      return undefined
  }
}

/** The newest signal wins; a hook adds its detail to a matching status. */
function pick(status: Signal | undefined, hook: Signal | undefined): Signal | undefined {
  if (!status) return hook
  if (!hook) return status
  // An exit is final, whatever the status file still says.
  if (hook.state === 'exited') return hook
  if (hook.ts > status.ts) return hook
  if (hook.state === status.state && Math.abs(hook.ts - status.ts) < 15_000)
    return {
      ...status,
      detail: hook.detail ?? status.detail,
      failed: hook.failed ?? status.failed
    }
  return status
}

const keyOf = (sourceId: string, sessionId: string): string => `${sourceId}:${sessionId}`

/**
 * Combine everything into the "Running now" list. Stale files (process gone
 * long ago) and crashed sessions drop out; a session that just ended stays a
 * while as Exited.
 */
export function computeLive(inp: LiveInputs): LiveSession[] {
  const { now } = inp
  // Newest hook signal and the latest event time, per session.
  const hooks = new Map<string, { signal?: Signal; last: number; cwd?: string; ended?: number }>()
  for (const e of inp.events) {
    const k = keyOf(e.source, e.sessionId)
    const h = hooks.get(k) ?? { last: 0 }
    const sig = hookSignal(e)
    if (sig && (!h.signal || sig.ts >= h.signal.ts)) h.signal = sig
    if (e.ts > h.last) h.last = e.ts
    if (e.event === 'SessionEnd') h.ended = Math.max(h.ended ?? 0, e.ts)
    h.cwd ??= e.cwd
    hooks.set(k, h)
  }

  const out = new Map<string, LiveSession>()
  const consider = (s: LiveSession): void => {
    const prev = inp.prev?.get(s.key)
    // The same state keeps the time it began (a status file rewritten while
    // still waiting doesn't restart "waiting since").
    if (prev && prev.state === s.state && prev.since <= s.since) s.since = prev.since
    const have = out.get(s.key)
    // Two files for one session (a restarted process): the running one wins.
    if (
      !have ||
      (have.state === 'exited' && s.state !== 'exited') ||
      have.lastSeenAt < s.lastSeenAt
    )
      out.set(s.key, s)
  }

  // Newest file per session first, so an old file of a restarted session loses.
  const procs = [...inp.procs].sort((a, b) => b.mtime - a.mtime)
  for (const p of procs) {
    const f = p.file
    const key = keyOf(p.sourceId, f.sessionId)
    const t = inp.transcript(key)
    const h = hooks.get(key)
    const lastSeenAt = Math.max(
      t?.lastActivityAt ?? 0,
      h?.last ?? 0,
      f.statusUpdatedAt ?? 0,
      f.updatedAt ?? 0,
      f.startedAt ?? 0,
      p.mtime
    )
    const base = {
      key,
      sessionId: f.sessionId,
      sourceId: p.sourceId,
      env: p.env,
      distro: p.distro,
      pid: f.pid,
      startedAt: f.startedAt,
      lastSeenAt,
      name: f.name,
      cwd: f.cwd ?? t?.cwd ?? h?.cwd,
      remoteUrl: remoteUrlOf(f.bridgeSessionId) ?? t?.remoteUrl,
      version: f.version,
      entrypoint: f.entrypoint
    }
    if (p.alive === false) {
      // Gone: shown as Exited for a while (from when it was last seen alive
      // or noticed gone), then dropped. A file left behind long ago is stale.
      const endedAt = h?.ended ?? p.goneAt ?? lastSeenAt
      if (now - endedAt > EXITED_KEEP_MS) continue
      consider({ ...base, state: 'exited', since: endedAt, basis: 'status' })
      continue
    }
    if (p.alive === undefined && now - lastSeenAt > UNVERIFIED_MAX_MS) continue
    let sig = pick(statusSignal(f, p.mtime), h?.signal)
    // No live status (older versions): transcript activity newer than the
    // last signal means it went back to work (say, after an approval).
    if (sig?.basis !== 'status' && sig?.state !== 'exited') sig = withActivity(sig, t, now)
    sig ??= { ts: f.startedAt ?? p.mtime, state: 'idle', basis: 'activity' }
    consider({
      ...base,
      state: sig.state,
      since: sig.ts,
      detail: sig.detail,
      failed: sig.failed,
      background: sig.background,
      basis: sig.basis,
      unverified: p.alive === undefined ? true : undefined
    })
  }

  // Sessions known only from hook events (no running file can be read).
  for (const [key, h] of hooks) {
    if (out.has(key) || !h.signal) continue
    const sourceId = key.slice(0, key.indexOf(':'))
    if (!inp.hooksOn.has(sourceId)) continue
    const env = inp.sourceEnv(sourceId)
    if (!env) continue
    const t = inp.transcript(key)
    const lastSeenAt = Math.max(h.last, t?.lastActivityAt ?? 0)
    const ended = h.signal.state === 'exited'
    if (ended ? now - h.signal.ts > EXITED_KEEP_MS : now - lastSeenAt > HOOK_ONLY_MAX_MS) continue
    const sig = ended ? h.signal : (withActivity(h.signal, t, now) ?? h.signal)
    consider({
      key,
      sessionId: key.slice(key.indexOf(':') + 1),
      sourceId,
      env: env.env,
      distro: env.distro,
      state: sig.state,
      since: sig.ts,
      lastSeenAt,
      detail: sig.detail,
      failed: sig.failed,
      cwd: h.cwd ?? t?.cwd,
      remoteUrl: t?.remoteUrl,
      basis: sig.basis,
      unverified: ended ? undefined : true
    })
  }

  return [...out.values()].sort(liveOrder)
}

function withActivity(
  sig: Signal | undefined,
  t: TranscriptInfo | undefined,
  now: number
): Signal | undefined {
  const at = t?.lastActivityAt
  if (!at || now - at > ACTIVE_MS) return sig
  if (!sig) return { ts: at, state: 'working', basis: 'activity' }
  if (sig.state !== 'working' && at > sig.ts + 5000)
    return { ts: at, state: 'working', basis: 'activity' }
  return sig
}

const ORDER: Record<LiveState, number> = { approval: 0, idle: 1, working: 2, exited: 3 }

/** Needs me first (longest waiting first), then working, then ended. */
export function liveOrder(a: LiveSession, b: LiveSession): number {
  return ORDER[a.state] - ORDER[b.state] || a.since - b.since || a.key.localeCompare(b.key)
}

/** Is it still running (anything but Exited)? */
export const isRunning = (s: Pick<LiveSession, 'state'>): boolean => s.state !== 'exited'

export const STATE_LABEL: Record<LiveState, string> = {
  working: 'Working',
  approval: 'Needs approval',
  idle: 'Waiting for you',
  exited: 'Exited'
}

/** "Working · 3m", "Needs approval · since 2:47 PM". */
export function stateLine(s: LiveSession, now: number, time: (ms: number) => string): string {
  const d = Math.max(0, now - s.since)
  const mins = Math.round(d / 60_000)
  const short =
    mins < 1 ? '<1m' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
  if (s.state === 'working') return `Working for ${short}`
  if (s.state === 'exited') return `${s.failed ? 'Stopped' : 'Exited'} at ${time(s.since)}`
  return `${s.state === 'approval' ? 'Needs approval' : 'Waiting for you'} since ${time(s.since)}`
}

/** The state shown in the list, from the running data (for the badge). */
export interface LiveSnapshot {
  sessions: LiveSession[]
  /** When the data was last read, epoch ms. */
  at: number
  /** Sources where the hook bridge is installed. */
  hooks: HookEnv[]
}

/** One Claude home where session alerts (the hook bridge) can be turned on. */
export interface HookEnv {
  sourceId: string
  label: string
  env: EnvKind
  user?: string
  settingsPath: string
  installed: boolean
  installedAt?: string
  /** Last hook event received, epoch ms. */
  lastEventAt?: number
  /** Our hooks were removed or changed by someone else since the app added them. */
  changedSinceInstall?: boolean
  unavailable?: string
}

/** What "Focus terminal" did. */
export interface FocusResult {
  ok: boolean
  /** 'tab': its Windows Terminal tab was selected too. 'window': only the window came forward. */
  how?: 'tab' | 'window'
  /** Why it didn't work, for the user. */
  error?: string
  simulated?: boolean
}
