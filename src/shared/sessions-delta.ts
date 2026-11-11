// The session list's changes, instead of the whole list (thousands of
// sessions, megabytes) every time one session changes: the main process
// remembers what it last sent each window and sends only the sessions that
// changed or went, plus the order when it changed. The window merges them
// into its list, keeping the unchanged sessions as they were (so their rows
// don't redraw).

import type { SessionsPayload, SessionSummary } from './types'

export interface SessionsDelta {
  /** Sessions that are new or changed. */
  upserts: SessionSummary[]
  /** Keys of sessions that are gone. */
  removed: string[]
  /** Every key in order, when the order (or the set) changed. */
  keys?: string[]
  sources: SessionsPayload['sources']
  scan: SessionsPayload['scan']
}

/**
 * What was last sent to one window: a hash of each session's JSON (53 bits:
 * keeping the strings would keep megabytes per window), and the order.
 */
export interface SentList {
  json: Map<string, number>
  order: string
}

/** A 53-bit hash of a string (cyrb53). */
export function hash53(s: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** The delta from what was sent to `payload`, and what's sent after it. */
export function sessionsDelta(
  sent: SentList,
  payload: SessionsPayload
): { delta: SessionsDelta; next: SentList } {
  const json = new Map<string, number>()
  const upserts: SessionSummary[] = []
  for (const s of payload.sessions) {
    const j = hash53(JSON.stringify(s))
    json.set(s.key, j)
    if (sent.json.get(s.key) !== j) upserts.push(s)
  }
  const removed: string[] = []
  for (const k of sent.json.keys()) if (!json.has(k)) removed.push(k)
  const keys = payload.sessions.map((s) => s.key)
  const order = keys.join('\n')
  return {
    delta: {
      upserts,
      removed,
      ...(order !== sent.order ? { keys } : {}),
      sources: payload.sources,
      scan: payload.scan
    },
    next: { json, order }
  }
}

/** What's sent after a full list. */
export function sentOf(payload: SessionsPayload): SentList {
  const json = new Map<string, number>()
  for (const s of payload.sessions) json.set(s.key, hash53(JSON.stringify(s)))
  return { json, order: payload.sessions.map((s) => s.key).join('\n') }
}

/** A delta that changes nothing (worth not sending). */
export function isEmptyDelta(
  d: SessionsDelta,
  prev: Pick<SessionsPayload, 'sources' | 'scan'>
): boolean {
  return (
    !d.upserts.length &&
    !d.removed.length &&
    !d.keys &&
    JSON.stringify(d.sources) === JSON.stringify(prev.sources) &&
    JSON.stringify(d.scan) === JSON.stringify(prev.scan)
  )
}

/**
 * The window's list with a delta applied: changed sessions replaced,
 * gone ones dropped, the order from `keys` when given (else as it was, new
 * ones at the end). Unchanged sessions are the same objects as before.
 */
export function applySessionsDelta(list: SessionSummary[], d: SessionsDelta): SessionSummary[] {
  const byKey = new Map(list.map((s) => [s.key, s]))
  for (const k of d.removed) byKey.delete(k)
  const fresh = new Map(d.upserts.map((s) => [s.key, s]))
  for (const [k, s] of fresh) byKey.set(k, s)
  if (d.keys) return d.keys.map((k) => byKey.get(k)).filter((s): s is SessionSummary => !!s)
  const out: SessionSummary[] = []
  for (const s of list) {
    const now = byKey.get(s.key)
    if (now) out.push(now)
  }
  const had = new Set(list.map((s) => s.key))
  for (const s of d.upserts) if (!had.has(s.key)) out.push(s)
  return out
}
