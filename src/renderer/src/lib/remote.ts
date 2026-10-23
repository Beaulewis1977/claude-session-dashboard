// Remote Control: which sessions were launched with it, and how to describe that.

import type { RemoteLaunchResult } from '@shared/mobile'
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
  'key' | 'sourceId' | 'cwd' | 'env' | 'remoteUrl' | 'remoteUrlAt'
>

/** Recorded at or after the launch (a little slack for the PC's and phone's clocks). */
const fresh = (s: LinkFields, since: number): boolean =>
  !!s.remoteUrl && !!s.remoteUrlAt && Date.parse(s.remoteUrlAt) >= since - 2000

/**
 * The Remote Control link of what a phone just launched, once Claude Code has
 * recorded it. A fork has a new session id: look for a new link in the same
 * folder (never the parent's).
 */
export function freshRemoteUrl(
  sessions: LinkFields[],
  result: Pick<RemoteLaunchResult, 'key' | 'fork'> | null,
  since: number
): string | undefined {
  if (!result) return undefined
  if (result.key) {
    const s = sessions.find((x) => x.key === result.key)
    return s && fresh(s, since) ? s.remoteUrl : undefined
  }
  const f = result.fork
  if (!f?.cwd) return undefined
  const same = (s: LinkFields): boolean =>
    s.env === 'windows' ? s.cwd?.toLowerCase() === f.cwd!.toLowerCase() : s.cwd === f.cwd
  const found = sessions
    .filter((s) => s.key !== f.parentKey && s.sourceId === f.sourceId && same(s) && fresh(s, since))
    .sort((a, b) => Date.parse(b.remoteUrlAt!) - Date.parse(a.remoteUrlAt!))
  return found[0]?.remoteUrl
}
