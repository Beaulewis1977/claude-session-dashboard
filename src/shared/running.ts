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
}

function whereOf(l: LiveSession): RunningCopy['where'] {
  if ((l.provider ?? 'claude') === 'codex') {
    if (l.lockHeld === true) return 'terminal'
    // Working without anyone holding its lock: the Codex app (its app server) runs it.
    if (l.lockHeld === false && !l.lockUnknown) return 'codex-app'
    return 'unknown'
  }
  if (l.entrypoint === 'claude-desktop' || l.entrypoint === 'claude-desktop-3p') return 'claude-app'
  return 'terminal'
}

function copyOf(l: LiveSession, relation: RunningCopy['relation']): RunningCopy {
  const provider = l.provider ?? 'claude'
  return {
    key: l.key,
    relation,
    state: l.state,
    provider,
    env: l.env,
    ...(l.distro ? { distro: l.distro } : {}),
    where: whereOf(l),
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
    return k ? copyOf(k, inp.origin(k.key)!.via as 'fork' | 'continue') : undefined
  }
  const self = running.find((l) => l.key === inp.key)
  if (!self) return undefined
  const copy = copyOf(self, 'self')
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
