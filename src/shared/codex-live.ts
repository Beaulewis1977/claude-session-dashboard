// "Running now" for Codex: which Codex threads are open, and what each one is
// doing (docs/ROADMAP.md, feature 5, Phase D1). Pure, so it can be tested.
//
// Signals, checked on codex-cli 0.166 (Windows and WSL) and the desktop app:
//
// 1. Thread locks, `<codex home>/thread-writer-locks/<thread-id>.lock`. A
//    Codex process holds a kernel lock on it while it has the thread open,
//    and the OS drops the lock when that process ends (so a reused PID can
//    never hold it). Windows: a byte-range lock (a read of the file fails
//    with EBUSY). WSL: a `flock`, listed in the distro's `/proc/locks` with
//    the holder's PID and the file's inode. The lock file's mtime is when the
//    holder took it (Codex rewrites the file then): turns that started
//    before it belong to an earlier run of the thread.
// 2. The rollout's own events: `task_started` (a turn is running),
//    `task_complete` / `turn_aborted` (it ended), tool calls and their
//    outputs (a call without output is still running, or waiting).
// 3. Optional: the app's `PermissionRequest` hook in `<codex home>/hooks.json`
//    (opt-in), the only exact signal for "needs approval". Without it, an
//    escalated command that has waited a while without output is shown as
//    "probably needs approval".

import type { ProviderId } from './provider'
import type { HookEvent, LiveSession, LiveState } from './live'
import { EXITED_KEEP_MS, UNVERIFIED_MAX_MS } from './live'
import type { EnvKind } from './types'

// --------------------------------------------------------------- rollouts

/** A tool call that has no output yet. */
export interface PendingCall {
  /** When it was recorded, epoch ms. */
  at: number
  /** Asks to run outside the sandbox (`sandbox_permissions: "require_escalated"`). */
  escalated: boolean
  /** A question for the user (`request_user_input`). */
  question: boolean
  /** The question is certain (a direct call), not found inside a code-mode script. */
  direct: boolean
}

/** What a rollout says about its thread right now (kept per file, updated as it grows). */
export interface RolloutState {
  /** Open turns: turn id → start, epoch ms. */
  open: Record<string, number>
  /** Tool calls without output: call id → call. */
  pending: Record<string, PendingCall>
  /** Calls answered lately (their output arrived): call id → when it was made and answered. */
  done?: Record<string, { at: number; escalated: boolean; doneAt: number }>
  lastStartAt?: number
  lastEndAt?: number
  lastEnd?: 'complete' | 'aborted'
  /** turn_aborted's reason ("interrupted", …). */
  abortReason?: string
  /** The newest approval policy (turn_context / thread settings): "never" asks nothing. */
  approvalPolicy?: string
  /** Time of the newest line, epoch ms. */
  lastLineAt?: number
  /** Time of the newest tool output, and of the newest tool call, epoch ms. */
  lastOutputAt?: number
  lastCallAt?: number
  /**
   * Only the end of the file was read and no turn event was in it (a very
   * long turn): whether a turn is running is told by recent activity instead.
   */
  partial?: boolean
}

export const emptyRollout = (): RolloutState => ({ open: {}, pending: {} })

const MAX_PENDING = 64
const MAX_OPEN = 32

const TS_RE = /^\{"timestamp":"([^"]{10,40})"/
const CALL_ID_RE = /"call_id":"([^"]{1,200})"/
/** Lines worth parsing; everything else is skipped by a substring test (rollouts are big). */
const INTERESTING =
  /"type":"(task_started|task_complete|turn_aborted|turn_context|thread_settings_applied|function_call|custom_tool_call|function_call_output|custom_tool_call_output|local_shell_call)"/

/** Escalation asked for in a call's arguments (JSON, or JS text inside code mode). */
const ESCALATED_RE =
  /sandbox_permissions\\*"?\s*:\s*\\*"require_escalated|with_escalated_permissions\\*"?\s*:\s*true/
const QUESTION_RE = /request_user_input/

/** Biggest line that is fully parsed; bigger ones are read by pattern only. */
const PARSE_MAX = 256 * 1024

function tsOf(line: string, o?: Record<string, unknown>): number | undefined {
  const raw = typeof o?.timestamp === 'string' ? o.timestamp : TS_RE.exec(line)?.[1]
  if (!raw) return undefined
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : undefined
}

const secs = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 1e9 && v < 1e11 ? v * 1000 : undefined

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined

function trimTo<T>(rec: Record<string, T>, max: number, at: (v: T) => number): void {
  const keys = Object.keys(rec)
  if (keys.length <= max) return
  keys
    .sort((a, b) => at(rec[a]) - at(rec[b]))
    .slice(0, keys.length - max)
    .forEach((k) => delete rec[k])
}

/**
 * Apply new rollout lines to the state (in file order). Defensive: unknown or
 * broken lines are skipped. Prompts, replies and tool output are never kept.
 */
export function reduceRollout(state: RolloutState, lines: Iterable<string>): RolloutState {
  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue
    const ts = tsOf(line)
    if (ts !== undefined && (state.lastLineAt === undefined || ts > state.lastLineAt))
      state.lastLineAt = ts
    const m = INTERESTING.exec(line.length > 4096 ? line.slice(0, 4096) : line)
    if (!m) continue
    const kind = m[1]
    if (kind.endsWith('_output')) {
      const id = CALL_ID_RE.exec(line.slice(0, 2048))?.[1]
      if (id && state.pending[id]) {
        // Kept a while as answered: which call an approval request was for is
        // told by its output (see deriveCodex).
        const c = state.pending[id]
        delete state.pending[id]
        state.done ??= {}
        state.done[id] = { at: c.at, escalated: c.escalated, doneAt: ts ?? c.at }
        trimTo(state.done, MAX_PENDING, (v) => v.doneAt)
      }
      if (ts !== undefined) state.lastOutputAt = Math.max(state.lastOutputAt ?? 0, ts)
      continue
    }
    if (line.length > PARSE_MAX) {
      // A huge tool call (a long script): what it is, by pattern.
      if (kind === 'function_call' || kind === 'custom_tool_call') {
        const id = CALL_ID_RE.exec(line)?.[1]
        if (ts !== undefined) state.lastCallAt = Math.max(state.lastCallAt ?? 0, ts)
        if (id && ts !== undefined)
          state.pending[id] = {
            at: ts,
            escalated: ESCALATED_RE.test(line),
            question: QUESTION_RE.test(line),
            direct: false
          }
      }
      continue
    }
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const p = (o.payload && typeof o.payload === 'object' ? o.payload : {}) as Record<
      string,
      unknown
    >
    const at = tsOf(line, o) ?? state.lastLineAt ?? 0
    // turn_context is a line type of its own (its payload has no type).
    switch (o.type === 'turn_context' ? 'turn_context' : p.type) {
      case 'task_started': {
        const id = str(p.turn_id) ?? `@${at}`
        const start = secs(p.started_at) ?? at
        state.partial = undefined
        state.open[id] = start
        trimTo(state.open, MAX_OPEN, (v) => v)
        state.lastStartAt = Math.max(state.lastStartAt ?? 0, start)
        break
      }
      case 'task_complete':
      case 'turn_aborted': {
        const id = str(p.turn_id)
        state.partial = undefined
        if (id) delete state.open[id]
        // Turns nest (a turn another agent started); the last one ending ends them all.
        else state.open = {}
        const end =
          (p.type === 'task_complete' ? secs(p.completed_at) : undefined) ?? Math.max(at, 0)
        state.lastEndAt = end
        state.lastEnd = p.type === 'task_complete' ? 'complete' : 'aborted'
        state.abortReason = p.type === 'turn_aborted' ? str(p.reason) : undefined
        if (!Object.keys(state.open).length) state.pending = {}
        break
      }
      case 'turn_context': {
        const a = str(p.approval_policy)
        if (a) state.approvalPolicy = a
        break
      }
      case 'thread_settings_applied': {
        const s = p.thread_settings as Record<string, unknown> | undefined
        const a = str(s?.approval_policy)
        if (a) state.approvalPolicy = a
        break
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const id = str(p.call_id) ?? str(p.id)
        if (!id) break
        const name = str(p.name) ?? ''
        const body =
          typeof p.arguments === 'string'
            ? p.arguments
            : typeof p.input === 'string'
              ? p.input
              : JSON.stringify(p.action ?? '')
        const direct = name === 'request_user_input'
        state.lastCallAt = Math.max(state.lastCallAt ?? 0, at)
        state.pending[id] = {
          at,
          escalated: ESCALATED_RE.test(body),
          question: direct || QUESTION_RE.test(body),
          direct
        }
        trimTo(state.pending, MAX_PENDING, (v) => v.at)
        break
      }
    }
  }
  return state
}

/** Split a chunk into whole lines; returns the lines and the unfinished rest. */
export function splitLines(chunk: string, carry = ''): { lines: string[]; rest: string } {
  const text = carry + chunk
  const end = text.lastIndexOf('\n')
  if (end < 0) return { lines: [], rest: text }
  return {
    lines: text
      .slice(0, end)
      .split('\n')
      .map((l) => l.replace(/\r$/, '')),
    rest: text.slice(end + 1)
  }
}

// ---------------------------------------------------------------- locks

/** One held flock in a distro's `/proc/locks`. */
export interface ProcLock {
  pid: number
  /** The file's inode (decimal). */
  inode: string
  /** "MAJOR:MINOR" of the device (hex, as /proc prints it). */
  dev: string
}

/**
 * The exclusive (WRITE) FLOCK locks in `/proc/locks` text. Lines like
 * `19: FLOCK  ADVISORY  WRITE 51234 08:30:4505 0 EOF`. Blocked waiters
 * (`-> ...`) and POSIX/OFD locks aren't Codex's thread locks.
 */
export function parseProcLocks(text: string): ProcLock[] {
  const out: ProcLock[] = []
  for (const line of text.split('\n')) {
    const m = /^\d+:\s+FLOCK\s+\S+\s+WRITE\s+(\d+)\s+([0-9a-f]+:[0-9a-f]+):(\d+)\s/i.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (pid > 0) out.push({ pid, dev: m[2].toLowerCase(), inode: m[3] })
  }
  return out
}

/** The thread id of a lock file name (`<uuid>.lock`), or undefined. */
export function lockThreadId(name: string): string | undefined {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i.exec(name)
  return m ? m[1].toLowerCase() : undefined
}

// ------------------------------------------------------------- the list

/** What the session list knows about a Codex thread. */
export interface CodexThreadInfo {
  /** Detected product label ("codex-cli", "codex-desktop", "codex-subagent", …). */
  label?: string
  parentId?: string
  cwd?: string
  name?: string
}

export interface CodexThreadInput {
  sourceId: string
  env: EnvKind
  distro?: string
  threadId: string
  /**
   * true: a process holds its lock · false: nobody does · undefined: can't
   * tell (the distro's /proc can't be read right now).
   */
  held: boolean | undefined
  /** When the current holder took the lock (the lock file's mtime), epoch ms. */
  heldSince?: number
  /** The holder's PID (WSL: in the distro), when known. */
  pid?: number
  /** The rollout's state (undefined: not read, e.g. compressed or not found). */
  rollout?: RolloutState
  /** Rollout file modification time, epoch ms. */
  rolloutMtime?: number
  info: CodexThreadInfo
}

export interface CodexLiveInputs {
  now: number
  threads: CodexThreadInput[]
  /** PermissionRequest events from the opt-in hook, newest per session. */
  events: HookEvent[]
  /** Sources where the Codex hook is installed and trusted: no guessing there. */
  exactApprovals: ReadonlySet<string>
  /** The previous result (keys → sessions), to keep start times and spot exits. */
  prev?: ReadonlyMap<string, LiveSession>
  /** Threads the app saw working this run, while nobody held their lock (desktop app). */
  seenWorking: ReadonlySet<string>
  /**
   * When the app last saw each thread's lock held (kept by the caller, outside the
   * snapshot, so it doesn't change every poll). A lock that can't be checked now
   * keeps its thread open (unconfirmed) for UNVERIFIED_MAX_MS after that.
   */
  lockSeenAt?: ReadonlyMap<string, number>
}

/** An escalated command without output for this long probably waits for approval. */
export const APPROVAL_GUESS_MS = 5000
/** A question without an answer for this long waits for you. */
export const QUESTION_MS = 1500
/** Rollout activity this recent keeps an unlocked thread "working" (the desktop app). */
export const UNLOCKED_ACTIVE_MS = 10 * 60_000
/** A finished thread nobody holds stays "waiting for you" this long (Codex ends idle ones after 30 min). */
export const UNLOCKED_IDLE_MS = 30 * 60_000
/** A rollout read only in part counts as working while its lines are this recent. */
export const PARTIAL_ACTIVE_MS = 90_000
/** Slack between the lock being taken and the turn's own start time. */
const RUN_SLACK_MS = 5000

/** Products whose threads show only while they work (the user isn't driving them). */
const ONLY_WHILE_WORKING = new Set(['codex-claude-code', 'codex-exec'])
/**
 * Products whose app-server keeps threads loaded long after use (VS Code, the
 * desktop app): an idle one shows only for a while after its last turn.
 */
const APP_SERVER = new Set(['codex-vscode', 'codex-desktop'])
/**
 * Threads that may run without anyone holding their lock: the desktop app's and
 * VS Code's (their app-server), and subagents (shown only on their parent).
 */
const RUNS_UNLOCKED = new Set([...APP_SERVER, 'codex-subagent'])

const keyOf = (sourceId: string, id: string): string => `${sourceId}:${id}`

interface Derived {
  state: LiveState
  since: number
  detail?: string
  failed?: boolean
  guess?: boolean
  basis: LiveSession['basis']
}

/** Turns and calls from this run only (not from a run before the lock was taken). */
function current(r: RolloutState, from: number | undefined): RolloutState {
  if (from === undefined) return r
  const cut = from - RUN_SLACK_MS
  const open = Object.fromEntries(Object.entries(r.open).filter(([, t]) => t >= cut))
  const pending = Object.fromEntries(Object.entries(r.pending).filter(([, c]) => c.at >= cut))
  return { ...r, open, pending }
}

/**
 * Is the approval a PermissionRequest hook reported (at `at`) still waiting? The
 * request is for one of the calls made before it and still running then (an
 * escalated one, if any is): it waits until that call's output arrives. Another
 * tool finishing, or progress lines, don't answer it. Codex logs nothing when an
 * approval is granted; an approved command's call returns its output within its
 * yield time (a second or so in code mode), which is when the row goes back to
 * Working. Without a matching call (none logged yet), any tool output or new call
 * after the request counts as answered.
 */
export function hookStillWaiting(r: RolloutState | undefined, at: number): boolean {
  const asked = [
    ...Object.values(r?.pending ?? {})
      .filter((c) => c.at <= at)
      .map((c) => ({ escalated: c.escalated, open: true })),
    ...Object.values(r?.done ?? {})
      .filter((c) => c.at <= at && c.doneAt > at)
      .map((c) => ({ escalated: c.escalated, open: false }))
  ]
  const escalated = asked.filter((c) => c.escalated)
  const candidates = escalated.length ? escalated : asked
  if (candidates.length) return candidates.some((c) => c.open)
  const after = at + 1000
  return (r?.lastOutputAt ?? 0) <= after && (r?.lastCallAt ?? 0) <= after
}

/** A thread's state from its rollout, the hook events and the lock. */
export function deriveCodex(
  t: CodexThreadInput,
  hook: HookEvent | undefined,
  exact: boolean,
  now: number
): Derived | undefined {
  const r = t.rollout ? current(t.rollout, t.held ? t.heldSince : undefined) : undefined
  const open = r ? Object.values(r.open) : []
  const working = open.length > 0
  const lastLine = r?.lastLineAt ?? t.rolloutMtime ?? 0
  const turnStart = working ? Math.min(...open) : undefined

  // Needs approval: the hook says so, until it's answered, else a guess. Answered
  // means a tool output or a new tool call after the request (or the turn ending);
  // progress lines another tool writes meanwhile (item_completed, token_count) don't.
  if (working && hook && hook.event === 'PermissionRequest' && hook.ts >= (turnStart ?? 0) - 1000) {
    if (hookStillWaiting(r, hook.ts))
      return {
        state: 'approval',
        since: hook.ts,
        detail: hook.toolName ? `Wants to use ${hook.toolName}` : 'Waiting for your approval',
        basis: 'hook'
      }
  }
  if (working && r) {
    const calls = Object.values(r.pending)
    const q = calls.filter((c) => c.question && now - c.at >= QUESTION_MS)
    if (q.length) {
      const c = q.reduce((a, b) => (a.at <= b.at ? a : b))
      return {
        state: 'approval',
        since: c.at,
        detail: 'Asked you a question',
        guess: c.direct ? undefined : true,
        basis: 'rollout'
      }
    }
    if (!exact && r.approvalPolicy !== 'never') {
      const e = calls.filter((c) => c.escalated && now - c.at >= APPROVAL_GUESS_MS)
      if (e.length) {
        const c = e.reduce((a, b) => (a.at <= b.at ? a : b))
        return {
          state: 'approval',
          since: c.at,
          detail: 'Probably waiting for your approval (a command outside the sandbox)',
          guess: true,
          basis: 'rollout'
        }
      }
    }
  }
  if (working) return { state: 'working', since: turnStart!, basis: 'rollout' }
  // A turn too long for the part that was read: recent lines mean it still runs.
  if (r?.partial && t.held !== false && now - lastLine <= PARTIAL_ACTIVE_MS)
    return { state: 'working', since: lastLine, basis: 'activity' }
  if (r?.lastEnd) {
    const failed = r.lastEnd === 'aborted' && !!r.abortReason && r.abortReason !== 'interrupted'
    // Waiting since the last turn ended, or since it was resumed (the lock taken), if later.
    const ended = r.lastEndAt ?? lastLine
    return {
      state: 'idle',
      since: t.held && t.heldSince && t.heldSince > ended ? t.heldSince : ended,
      failed: failed || undefined,
      detail: failed ? `Stopped: ${r.abortReason!.replace(/_/g, ' ')}` : undefined,
      basis: 'rollout'
    }
  }
  if (!t.rollout) return undefined
  return { state: 'idle', since: t.heldSince ?? lastLine, basis: 'lock' }
}

/**
 * Combine everything into Codex's part of the "Running now" list.
 *
 * - A held lock means the thread is open: Working, Needs approval or Waiting
 *   for you, from the rollout.
 * - A lock that was held and is now free means it ended: Exited (kept
 *   EXITED_KEEP_MS, like Claude Code's).
 * - A thread nobody holds (the desktop app may not lock idle threads) shows
 *   only while its rollout shows a running turn with recent activity, and
 *   then as "waiting for you" for a while after the app saw it working.
 * - Subagent threads never get a row of their own: a working (or waiting)
 *   subagent shows on its parent. Claude Code's Codex plugin and `codex exec`
 *   threads show only while they work.
 */
export function computeCodexLive(inp: CodexLiveInputs): LiveSession[] {
  const { now } = inp
  const hooks = new Map<string, HookEvent>()
  for (const e of inp.events) {
    if (e.event !== 'PermissionRequest') continue
    const k = keyOf(e.source, e.sessionId)
    const have = hooks.get(k)
    if (!have || e.ts > have.ts) hooks.set(k, e)
  }

  const rows = new Map<string, LiveSession>()
  const subs: { parentKey: string; d: Derived }[] = []
  for (const t of inp.threads) {
    const key = keyOf(t.sourceId, t.threadId)
    const prev = inp.prev?.get(key)
    const base = {
      key,
      sessionId: t.threadId,
      sourceId: t.sourceId,
      env: t.env,
      distro: t.distro,
      provider: 'codex' as ProviderId,
      pid: t.pid,
      name: t.info.name,
      cwd: t.info.cwd
    }
    // The lock can't be checked right now (an unreadable WSL share, say), but it was
    // held lately: the thread is still taken as open (unconfirmed), never as ended.
    const lockSeenAt = t.held === true ? now : inp.lockSeenAt?.get(key)
    const stillOpen =
      t.held === undefined &&
      !!prev?.lockHeld &&
      lockSeenAt !== undefined &&
      now - lockSeenAt <= UNVERIFIED_MAX_MS
    const heldLike = t.held === true || stillOpen
    if (t.held === false) {
      // It ended (the app saw it open before), or it's the desktop app's.
      const wasOpen = prev && prev.state !== 'exited' && prev.basis !== 'activity'
      if (wasOpen && prev.lockHeld) {
        rows.set(key, {
          ...base,
          state: 'exited',
          since: now,
          lastSeenAt: prev.lastSeenAt,
          startedAt: prev.startedAt,
          basis: 'lock'
        })
        continue
      }
      if (prev?.state === 'exited' && now - prev.since <= EXITED_KEEP_MS) {
        rows.set(key, { ...prev, pid: undefined })
        continue
      }
      // Free, and not a product that runs threads without a lock (the CLI always
      // holds it): a crashed run's open turn must not look like work.
      if (!RUNS_UNLOCKED.has(t.info.label ?? '')) continue
    }
    const d = deriveCodex(
      heldLike ? { ...t, held: true } : t,
      hooks.get(key),
      inp.exactApprovals.has(t.sourceId),
      now
    )
    if (!d) continue
    const lastSeenAt = Math.max(t.rollout?.lastLineAt ?? 0, t.rolloutMtime ?? 0, t.heldSince ?? 0)
    if (!heldLike) {
      // Nobody holds it (or that can't be checked): only fresh work counts.
      const active = d.state !== 'idle' && now - lastSeenAt <= UNLOCKED_ACTIVE_MS
      const recentlyDone =
        d.state === 'idle' &&
        (inp.seenWorking.has(key) || (prev && prev.state !== 'exited')) &&
        now - d.since <= UNLOCKED_IDLE_MS
      if (!active && !recentlyDone) continue
    }
    if (t.info.label === 'codex-subagent') {
      if (t.info.parentId && d.state !== 'idle')
        subs.push({ parentKey: keyOf(t.sourceId, t.info.parentId), d })
      continue
    }
    if (ONLY_WHILE_WORKING.has(t.info.label ?? '') && d.state === 'idle') continue
    if (
      APP_SERVER.has(t.info.label ?? '') &&
      d.state === 'idle' &&
      now - d.since > UNLOCKED_IDLE_MS
    )
      continue
    const s: LiveSession = {
      ...base,
      state: d.state,
      since: d.since,
      startedAt: heldLike ? t.heldSince : undefined,
      lastSeenAt,
      detail: d.detail,
      failed: d.failed,
      guess: d.guess,
      basis: d.basis,
      lockHeld: heldLike || undefined,
      unverified: t.held === true ? undefined : true,
      lockUnknown: t.held === undefined || undefined
    }
    if (prev && prev.state === s.state && prev.since <= s.since) s.since = prev.since
    for (const k of Object.keys(s) as (keyof LiveSession)[]) if (s[k] === undefined) delete s[k]
    rows.set(key, s)
  }

  // Subagents show on their parent: it works (or waits) while one of them does.
  for (const { parentKey, d } of subs) {
    const p = rows.get(parentKey)
    if (!p || p.state === 'exited') continue
    if (d.state === 'approval' && p.state !== 'approval') {
      rows.set(parentKey, {
        ...p,
        state: 'approval',
        since: d.since,
        detail: `A subagent: ${d.detail ?? 'needs your approval'}`,
        guess: d.guess,
        basis: d.basis
      })
    } else if (p.state === 'idle') {
      const prev = inp.prev?.get(parentKey)
      rows.set(parentKey, {
        ...p,
        state: 'working',
        since: prev?.state === 'working' ? prev.since : d.since,
        detail: 'A subagent is working',
        failed: undefined,
        basis: 'rollout'
      })
    }
  }
  return [...rows.values()]
}

/**
 * Threads to keep an eye on: open now or in the last run (their rows), plus
 * those whose rollout changed recently. Used to decide how often to poll.
 */
export function anyCodexActive(list: readonly LiveSession[]): boolean {
  return list.some((s) => s.provider === 'codex' && s.state !== 'exited')
}

// -------------------------------------------------------------- hook trust

/** Codex's hook trust for one handler, as config.toml's `[hooks.state."<key>"]` records it. */
export interface HookTrust {
  /** `<hooks.json path>:<event>:<group>:<handler>`. */
  key: string
  trusted: boolean
  /** The recorded hash ("sha256:…"): which version of the hook was trusted. */
  hash?: string
  /** Turned off in Codex's /hooks. */
  disabled: boolean
}

/** Unquote a TOML key part ('literal' or "basic" with escapes). */
function tomlKey(q: string, body: string): string {
  if (q === "'") return body
  return body.replace(/\\(["\\bfnrt]|u[0-9a-fA-F]{4})/g, (_m, e: string) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16))
    return { '"': '"', '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e] ?? e
  })
}

/**
 * The `[hooks.state."…"]` tables of config.toml (read only, by pattern: the
 * app never writes config.toml). Only these tables are looked at; every
 * other line is skipped without being kept.
 */
export function parseHookTrust(configToml: string): HookTrust[] {
  const out: HookTrust[] = []
  let cur: HookTrust | undefined
  for (const raw of configToml.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      cur = undefined
      const m = /^\[\s*hooks\s*\.\s*state\s*\.\s*(['"])(.*)\1\s*\]$/.exec(line)
      if (m) {
        cur = { key: tomlKey(m[1], m[2]), trusted: false, disabled: false }
        out.push(cur)
      }
      continue
    }
    if (!cur) continue
    const kv = /^([A-Za-z_]+)\s*=\s*(.+?)\s*(#.*)?$/.exec(line)
    if (!kv) continue
    if (kv[1] === 'trusted_hash') {
      const m = /^["']([^"']+)["']$/.exec(kv[2])
      cur.trusted = !!m
      if (m) cur.hash = m[1]
    } else if (kv[1] === 'enabled') cur.disabled = kv[2] === 'false'
  }
  return out
}

/** Is `[features] hooks = false` (or the old `codex_hooks = false`) set? */
export function hooksFeatureOff(configToml: string): boolean {
  let inFeatures = false
  for (const raw of configToml.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inFeatures = /^\[\s*features\s*\]$/.test(line)
      continue
    }
    if (/^features\s*\.\s*(codex_)?hooks\s*=\s*false\b/.test(line)) return true
    if (inFeatures && /^(codex_)?hooks\s*=\s*false\b/.test(line)) return true
  }
  return false
}

/** Codex's name for a hook event in trust keys ("PermissionRequest" → "permission_request"). */
export const snakeEvent = (e: string): string => e.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase()

/**
 * The trust of one of our handlers: the key Codex uses (the hooks.json path
 * as Codex sees it, the event, the group's and the handler's position).
 * Paths compare case-insensitively with either slash on Windows.
 */
export function trustEntry(
  entries: readonly HookTrust[],
  hooksPath: string,
  event: string,
  group: number,
  handler: number,
  windows: boolean
): HookTrust | undefined {
  const norm = (p: string): string => (windows ? p.replace(/\//g, '\\').toLowerCase() : p)
  const want = `${norm(hooksPath)}:${snakeEvent(event)}:${group}:${handler}`
  return entries.find((x) => {
    const i = x.key.lastIndexOf(':', x.key.lastIndexOf(':', x.key.lastIndexOf(':') - 1) - 1)
    return i > 0 && `${norm(x.key.slice(0, i))}${x.key.slice(i)}` === want
  })
}

/**
 * Whether Codex trusts the app's handler, from config.toml (never written by
 * the app). Codex keys trust by position and records the hash of the hook it
 * trusted, a hash of its own normalized form that the app doesn't recompute.
 * So an entry only counts when it is new since the app added its hook: one
 * that was already there (`priorHash`: left behind by an older hook at the
 * same position) or a config.toml not saved since the install is stale, and
 * Codex will still skip the hook until it's trusted in /hooks.
 */
export function trustOf(
  entries: readonly HookTrust[],
  where: { hooksPath: string; event: string; group: number; handler: number; windows: boolean },
  since?: { priorHash?: string | null; installedAt?: number; configSavedAt?: number }
): 'trusted' | 'untrusted' | 'disabled' {
  const e = trustEntry(
    entries,
    where.hooksPath,
    where.event,
    where.group,
    where.handler,
    where.windows
  )
  if (!e) return 'untrusted'
  if (e.disabled) return 'disabled'
  if (!e.trusted) return 'untrusted'
  if (since?.priorHash && e.hash === since.priorHash) return 'untrusted'
  if (
    since?.installedAt !== undefined &&
    since.configSavedAt !== undefined &&
    since.configSavedAt < since.installedAt
  )
    return 'untrusted'
  return 'trusted'
}
