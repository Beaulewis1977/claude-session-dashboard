// Remote Control: which sessions were launched with it, and how to describe that.

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
