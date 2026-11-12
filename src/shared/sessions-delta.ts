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
  /** The list version it applies to, and the version it makes (set when it's sent). */
  base?: number
  version?: number
}

/**
 * A window's session list kept in step with the main process: a full list
 * (with a version) is taken only if it's newer than what the window has, and
 * a delta only on top of the version it was made for. Anything else (a delta
 * that came before the list it applies to, or after a list it missed) asks
 * for the full list again.
 */
export class SessionsSync {
  private version: number | undefined
  private resyncing = false
  /** Deltas that came before the list they apply to (replayed once it is here). */
  private pending: SessionsDelta[] = []

  constructor(
    private readonly get: () => SessionSummary[],
    private readonly put: (p: Omit<SessionsPayload, 'version'>) => void,
    private readonly fetchFull: () => Promise<SessionsPayload>
  ) {}

  /** A full list: getSessions() or a full push. */
  full(p: SessionsPayload): void {
    if (p.version !== undefined && this.version !== undefined && p.version < this.version) return
    this.version = p.version
    this.put({ sessions: p.sessions, sources: p.sources, scan: p.scan })
    // Deltas made from this list (or after it) that came early.
    const early = this.pending
    this.pending = []
    for (
      let d = early.find((x) => x.base === this.version);
      d;
      d = early.find((x) => x.base === this.version)
    )
      this.apply(d)
  }

  delta(d: SessionsDelta): void {
    if (d.base === undefined || this.version === undefined || d.base !== this.version) {
      if (d.base !== undefined && this.pending.length < 100) this.pending.push(d)
      this.resync()
      return
    }
    this.apply(d)
  }

  private apply(d: SessionsDelta): void {
    this.version = d.version
    this.put({ sessions: applySessionsDelta(this.get(), d), sources: d.sources, scan: d.scan })
  }

  /** The list version the window has (tests). */
  get current(): number | undefined {
    return this.version
  }

  private resync(): void {
    if (this.resyncing) return
    this.resyncing = true
    void this.fetchFull()
      .then((p) => this.full(p))
      .catch(() => undefined)
      .finally(() => (this.resyncing = false))
  }
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
