// "Already running on your PC": before Resume / Fork / Continue fresh (from the
// phone or the desktop), is that session (or what it would start) already open
// on the PC? Pure, so it can be tested; main enforces it (see Launcher), the
// desktop dialog and the phone's launch sheet show what to do instead.
//
// - Resume (and Open in Codex app / Claude desktop app): the session itself.
// - Fork / Continue fresh: a fork or continuation of this session that the app
//   launched earlier (recorded in its metadata) and that is still running.
//   Forking a running session itself stays allowed.

import { isRunning, type LiveSession, type LiveState } from './live'
import type { ProviderId } from './provider'
import type { EnvKind } from './types'

export type RunningKind = 'resume' | 'fork' | 'continue' | 'codex-app' | 'claude-app'

/** What is already running, as the launch dialog and the phone show it. */
export interface RunningCopy {
  /** The running session's key. */
  key: string
  /** This session itself, or a fork / continuation of it the app launched. */
  relation: 'self' | 'fork' | 'continue'
  state: LiveState
  provider: ProviderId
  env: EnvKind
  distro?: string
  /** Where it runs: a terminal, the Codex desktop app, the Claude desktop app, or not known. */
  where: 'terminal' | 'codex-app' | 'claude-app' | 'unknown'
  /** Its Remote Control link (Claude Code), only when Remote Control is on in this run. */
  remoteUrl?: string
  /** Its name in Claude Code, if any (the title is added by the caller). */
  name?: string
  title?: string
  /** Launched from the dashboard a moment ago, not in Running now yet. */
  pending?: true
  /** Pending: when that launch began (PC clock, epoch ms). */
  pendingSince?: number
  /** Pending: the folder it was launched in (a fork or continuation is found by it). */
  cwd?: string
}

/** How the app recorded a session was made (Fork / Continue fresh from the app). */
export interface RecordedOrigin {
  parentKey?: string
  via: 'app' | 'fork' | 'continue'
}

export interface RunningInput {
  kind: RunningKind
  /** The session asked for. */
  key: string
  live: readonly LiveSession[]
  /** The app's record of where a running session came from (by its key). */
  origin: (key: string) => RecordedOrigin | undefined
  /**
   * The Claude desktop app runs this session (its Code tab lists it). It can run
   * them through the SDK, so the running file's entrypoint can say "sdk-cli".
   */
  desktopApp?: (key: string) => boolean
}

function whereOf(l: LiveSession, desktopApp?: (key: string) => boolean): RunningCopy['where'] {
  if ((l.provider ?? 'claude') === 'codex') {
    if (l.lockHeld === true) return 'terminal'
    // Working without anyone holding its lock: the Codex app (its app server) runs it.
    if (l.lockHeld === false && !l.lockUnknown) return 'codex-app'
    return 'unknown'
  }
  if (l.entrypoint === 'claude-desktop' || l.entrypoint === 'claude-desktop-3p') return 'claude-app'
  // Not a terminal (cli) session, and the desktop app lists it: the desktop app runs it.
  if (l.entrypoint !== 'cli' && desktopApp?.(l.key)) return 'claude-app'
  return 'terminal'
}

/** A running session as a running copy (a pending launch once Running now shows it). */
export function runningCopyOf(
  l: LiveSession,
  relation: RunningCopy['relation'],
  desktopApp?: (key: string) => boolean
): RunningCopy {
  return copyOf(l, relation, desktopApp)
}

/** Slack between the launch and the new process's start time. */
const START_SLACK_MS = 2000

/**
 * The run a pending launch became, once Running now shows it: Resume (and the
 * apps) by its own key, started after the launch; Fork / Continue fresh by the
 * one new process in its folder (its id is only known once it runs). Undefined:
 * not there yet, or more than one could be it.
 */
export function startedRun(p: RunningCopy, live: readonly LiveSession[]): LiveSession | undefined {
  if (!p.pending || p.pendingSince === undefined) return undefined
  const after = (l: LiveSession): boolean =>
    isRunning(l) && (l.startedAt ?? l.since) >= p.pendingSince! - START_SLACK_MS
  if (p.relation === 'self') return live.find((l) => l.key === p.key && after(l))
  const sourceId = p.key.slice(0, p.key.indexOf(':'))
  const cwd = p.cwd
  if (!cwd) return undefined
  const same = (c: string | undefined): boolean =>
    !!c && (p.env === 'windows' ? c.toLowerCase() === cwd.toLowerCase() : c === cwd)
  const kids = live.filter(
    (l) => l.key !== p.key && l.sourceId === sourceId && same(l.cwd) && after(l)
  )
  return kids.length === 1 ? kids[0] : undefined
}

function copyOf(
  l: LiveSession,
  relation: RunningCopy['relation'],
  desktopApp?: (key: string) => boolean
): RunningCopy {
  const provider = l.provider ?? 'claude'
  return {
    key: l.key,
    relation,
    state: l.state,
    provider,
    env: l.env,
    ...(l.distro ? { distro: l.distro } : {}),
    where: whereOf(l, desktopApp),
    ...(provider === 'claude' && l.remoteActive && l.remoteUrl ? { remoteUrl: l.remoteUrl } : {}),
    ...(l.name ? { name: l.name } : {})
  }
}

/** Needs me first, then the most recently seen. */
const rank = (a: LiveSession, b: LiveSession): number =>
  (a.state === 'approval' ? 0 : 1) - (b.state === 'approval' ? 0 : 1) || b.lastSeenAt - a.lastSeenAt

/** The copy already running on the PC for this launch, or undefined (go ahead). */
export function findRunningCopy(inp: RunningInput): RunningCopy | undefined {
  const running = inp.live.filter(isRunning)
  if (inp.kind === 'fork' || inp.kind === 'continue') {
    const kids = running
      .filter((l) => {
        if (l.key === inp.key) return false
        const o = inp.origin(l.key)
        return !!o && o.parentKey === inp.key && (o.via === 'fork' || o.via === 'continue')
      })
      .sort(rank)
    const k = kids[0]
    return k ? copyOf(k, inp.origin(k.key)!.via as 'fork' | 'continue', inp.desktopApp) : undefined
  }
  const self = running.find((l) => l.key === inp.key)
  if (!self) return undefined
  const copy = copyOf(self, 'self', inp.desktopApp)
  // The Codex app showing a thread it already runs is the same thread, not a second copy.
  if (inp.kind === 'codex-app' && copy.where === 'codex-app') return undefined
  return copy
}

export type RunningAction = 'open-remote' | 'focus' | 'open-codex-app' | 'another'

export interface RunningAdvice {
  title: string
  body: string
  /** Best first; 'another' (Start another copy anyway) is always last and needs a confirm. */
  actions: RunningAction[]
}

const WHAT: Record<RunningCopy['relation'], string> = {
  self: 'This session',
  fork: 'A fork of this session',
  continue: 'A continuation of this session'
}

/**
 * What to say and offer. `on` is where it's shown: the phone (Remote Control
 * and "type /rc" matter there) or the PC (Focus terminal first).
 */
export function runningAdvice(r: RunningCopy, on: 'phone' | 'pc'): RunningAdvice {
  const what = WHAT[r.relation]
  const actions: RunningAction[] = []
  if (r.pending)
    return {
      title: 'Just started on your PC',
      body: `${what} was started from the dashboard a moment ago and isn't in Running now yet. Give it a few seconds, then refresh.`,
      actions: ['another']
    }
  if (r.provider === 'codex') {
    if (r.where === 'codex-app')
      return {
        title: 'Already open in the Codex app on your PC',
        body: `${what} is running in the Codex desktop app. Open it there${on === 'phone' ? ', or continue it from the ChatGPT app (Codex Remote reaches Codex app threads, not terminals)' : ''}.`,
        actions: ['open-codex-app', 'another']
      }
    return {
      title: 'Already running on your PC',
      body: `${what} is running in a terminal on your PC${on === 'phone' ? '. To continue it from your phone, close that terminal and open it in the Codex app on your PC: Codex Remote (ChatGPT app) reaches Codex app threads only' : ''}.`,
      actions: ['focus', 'open-codex-app', 'another']
    }
  }
  if (r.remoteUrl) {
    actions.push('open-remote')
    if (r.where !== 'claude-app') actions.push('focus')
    if (on === 'pc') actions.reverse()
    actions.push('another')
    return {
      title: 'Already running on your PC',
      body: `${what} is running${r.where === 'claude-app' ? ' in the Claude desktop app' : ''} with Remote Control on: continue it in the Claude app.`,
      actions
    }
  }
  if (r.where === 'claude-app')
    return {
      title: 'Already open in the Claude desktop app',
      body: `${what} is running in the Claude desktop app on your PC, without Remote Control.`,
      actions: ['another']
    }
  if (on === 'phone')
    return {
      title: 'Already running on your PC without Remote Control',
      body: 'Type /rc in that terminal, then refresh.',
      actions: ['focus', 'another']
    }
  return {
    title: 'Already running on this PC',
    body: `${what} is open in a terminal. Switch to it instead of starting a second copy (two copies of one session write into the same file).`,
    actions: ['focus', 'another']
  }
}

/** The error a launch refused for a running copy returns. */
export function runningError(r: RunningCopy): string {
  return `${WHAT[r.relation]} is already running on your PC. Switch to it, or start another copy anyway.`
}

/** Which duplicate check a launch needs (none for Branch or a new session). */
export function runningKindOf(o: {
  fork?: boolean
  continueFresh?: unknown
  branch?: unknown
  newSession?: boolean
  openIn?: string
}): RunningKind | undefined {
  if (o.branch || o.newSession) return undefined
  if (o.openIn === 'codex-app') return o.continueFresh ? 'continue' : o.fork ? 'fork' : 'codex-app'
  if (o.openIn === 'claude-app') return o.fork ? 'fork' : 'claude-app'
  return o.continueFresh ? 'continue' : o.fork ? 'fork' : 'resume'
}

/**
 * Opening a thread in the Codex app while a terminal still runs it is a second
 * copy: it needs the same confirm as "Start another copy" (the phone asks too).
 */
export function needsConfirm(r: RunningCopy, a: RunningAction): boolean {
  return a === 'open-codex-app' && r.where !== 'codex-app'
}

/** The first "switch to it" action that needs no confirm (the dialog's main button while it runs). */
export function primaryAction(r: RunningCopy): RunningAction | undefined {
  return runningAdvice(r, 'pc').actions.find((a) => a !== 'another' && !needsConfirm(r, a))
}
