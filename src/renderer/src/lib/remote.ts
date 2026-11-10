// Remote Control: which sessions were launched with it, and how to describe that.

import type { RemoteLaunchResult } from '@shared/mobile'
import { isRunning, type LiveSession } from '@shared/live'
import type { RunningCopy } from '@shared/running'
import type { SessionSummary } from '@shared/types'
import { formatDateTime } from '@shared/format'

export type RemoteFields = Pick<SessionSummary, 'meta' | 'remoteUrl' | 'remoteUrlAt'>

/** Launched with Remote Control from the app, or Claude Code recorded a Remote Control link. */
export function isRemote(s: RemoteFields): boolean {
  return !!s.meta.remote || !!s.remoteUrl
}

export function remoteTitle(s: RemoteFields): string {
  const r = s.meta.remote
  const parts: string[] = []
  if (r) {
    const from = r.via === 'phone' ? `from ${r.device ? `“${r.device}”` : 'your phone'}` : ''
    parts.push(`Launched with Remote Control ${from} ${formatDateTime(r.at)}`.replace(/\s+/g, ' '))
  } else {
    parts.push('Remote Control was on in this session')
  }
  if (s.remoteUrl) parts.push(`Continue it in the Claude app or at ${s.remoteUrl}`)
  return parts.join('. ')
}

type LinkFields = Pick<
  SessionSummary,
  'key' | 'sourceId' | 'cwd' | 'env' | 'remoteUrl' | 'remoteUrlAt' | 'lineage'
>

type LiveLink = Pick<
  LiveSession,
  'key' | 'sourceId' | 'cwd' | 'env' | 'state' | 'remoteUrl' | 'remoteActive' | 'startedAt'
>

/**
 * The Remote Control link of a session running now, as soon as Remote Control
 * is on in it (launched with it, or `/rc` typed later): Running now reads it
 * from Claude Code's running-session file every few seconds, before the
 * transcript is read again. Never a link from an earlier run.
 */
export function liveRemoteUrl(
  live: readonly LiveLink[] | undefined,
  key: string
): string | undefined {
  const l = live?.find((x) => x.key === key)
  return l && isRunning(l) && l.remoteActive ? l.remoteUrl : undefined
}

/**
 * "Already running" as Running now says it is right now (the sheet stays open
 * while it changes): its Remote Control link only while it's on in the current
 * run (never one kept from when the sheet opened), and nothing once it ended.
 * A launch still on its way isn't in Running now yet: kept as it is.
 */
export function runningNow(
  seen: RunningCopy | undefined,
  live: readonly LiveLink[] | undefined
): RunningCopy | undefined {
  if (!seen) return undefined
  if (seen.pending || !live) return seen
  const l = live.find((x) => x.key === seen.key)
  if (!l || !isRunning(l)) return undefined
  const { remoteUrl: _old, ...rest } = seen
  const url = seen.provider === 'claude' && l.remoteActive ? l.remoteUrl : undefined
  return { ...rest, state: l.state, ...(url ? { remoteUrl: url } : {}) }
}

/** Recorded at or after the launch (a little slack for the PC's and phone's clocks). */
const fresh = (s: LinkFields, since: number): boolean =>
  !!s.remoteUrl && !!s.remoteUrlAt && Date.parse(s.remoteUrlAt) >= since - 2000

/**
 * The Remote Control link of what a phone just launched, once Claude Code has
 * recorded it. A fork has a new session id that only Claude Code knows: it
 * must be a session that didn't exist at launch (`existing`), in the same
 * folder; one the app has linked to the parent wins. Never the parent or
 * any other session that was already there.
 */
export function freshRemoteUrl(
  sessions: LinkFields[],
  result: Pick<RemoteLaunchResult, 'key' | 'fork'> | null,
  since: number,
  existing: ReadonlySet<string> = new Set(),
  /** Running now: its link shows up there first (a process started after the launch). */
  live: readonly LiveLink[] = []
): string | undefined {
  if (!result) return undefined
  const started = (l: LiveLink): boolean =>
    isRunning(l) && !!l.remoteActive && !!l.remoteUrl && (l.startedAt ?? 0) >= since - 2000
  if (result.key) {
    const l = live.find((x) => x.key === result.key)
    if (l && started(l)) return l.remoteUrl
    const s = sessions.find((x) => x.key === result.key)
    return s && fresh(s, since) ? s.remoteUrl : undefined
  }
  const f = result.fork
  if (!f?.cwd) return undefined
  const same = (s: Pick<LinkFields, 'env' | 'cwd'>): boolean =>
    s.env === 'windows' ? s.cwd?.toLowerCase() === f.cwd!.toLowerCase() : s.cwd === f.cwd
  // A process that started after the fork, in its folder, that the list didn't have,
  // and not known to be another session's fork (the same rule as the transcript's).
  const parentOf = (key: string): string | undefined =>
    sessions.find((s) => s.key === key)?.lineage?.parentKey
  const procs = live.filter((l) => {
    const parent = parentOf(l.key)
    return (
      l.key !== f.parentKey &&
      !existing.has(l.key) &&
      (!parent || parent === f.parentKey) &&
      l.sourceId === f.sourceId &&
      same(l) &&
      started(l)
    )
  })
  const procsLinked = procs.filter((l) => parentOf(l.key) === f.parentKey)
  if (procsLinked.length) return procsLinked[0]!.remoteUrl
  if (procs.length === 1) return procs[0]!.remoteUrl
  const found = sessions
    .filter(
      (s) =>
        s.key !== f.parentKey &&
        !existing.has(s.key) &&
        // Known to be another session's fork: not this one.
        (!s.lineage?.parentKey || s.lineage.parentKey === f.parentKey) &&
        s.sourceId === f.sourceId &&
        same(s) &&
        fresh(s, since)
    )
    .sort((a, b) => Date.parse(b.remoteUrlAt!) - Date.parse(a.remoteUrlAt!))
  const linked = found.filter((s) => s.lineage?.parentKey === f.parentKey)
  // Two new sessions in the folder and neither linked to the parent: don't guess.
  if (!linked.length && found.length > 1) return undefined
  return (linked[0] ?? found[0])?.remoteUrl
}
