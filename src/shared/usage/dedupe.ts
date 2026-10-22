// Counting every API response once. Claude Code logs one response several
// times: one line per content block, again in resumed and forked sessions
// (copied history), and again when a /btw sidechain replays parent messages.
// The rules below follow ccusage (https://github.com/ccusage/ccusage, MIT,
// see THIRD_PARTY_NOTICES), so our totals match `ccusage daily` on the same
// files. This is our own code, written from ccusage's documented behavior.

import type { UsageRecord } from './types'

/** Real Anthropic ids are unique per response; gateway placeholder ids are not. */
export function isAnthropicMessageId(id: string): boolean {
  return id.startsWith('msg_') || id.startsWith('resp_')
}

/**
 * The exact-match dedupe key.
 * - message id + request id identify one response across all sessions;
 * - without a request id the key is scoped to the session, and also to the
 *   timestamp unless the id is a real Anthropic id (gateways reuse one id);
 * - lines without a message id are never deduped (`fallback`).
 */
export function recordId(
  mid: string | undefined,
  rid: string | undefined,
  sid: string,
  ts: number,
  fallback: string
): string {
  if (!mid) return fallback
  if (rid) return `${mid}:${rid}`
  return isAnthropicMessageId(mid) ? `${mid}|${sid}` : `${mid}|${sid}|${ts}`
}

function total(r: UsageRecord): number {
  return r.input + r.output + r.cacheWrite + r.cacheRead
}

/**
 * Which copy of a duplicated response to keep: the non-sidechain one, then the
 * one with more tokens (a line written later in the stream), then the one that
 * reports `speed`.
 */
export function shouldReplace(candidate: UsageRecord, existing: UsageRecord): boolean {
  if (!!candidate.sc !== !!existing.sc) return !!existing.sc
  const c = total(candidate)
  const e = total(existing)
  if (c !== e) return c > e
  return candidate.speed !== undefined && existing.speed === undefined
}

export type DedupeResult = 'added' | 'replaced' | 'duplicate'

/** A set of usage records with ccusage's dedupe rules. */
export class UsageDeduper {
  /** Canonical id → record. */
  readonly records = new Map<string, UsageRecord>()
  /** Other id → canonical id. */
  private alias = new Map<string, string>()
  /** `${sid}\n${mid}` → canonical ids, for sidechain replays. */
  private replay = new Map<string, Set<string>>()

  constructor(records: Iterable<UsageRecord> = []) {
    for (const r of records) this.insert(r)
  }

  get size(): number {
    return this.records.size
  }

  get(id: string): UsageRecord | undefined {
    return this.records.get(this.alias.get(id) ?? id)
  }

  values(): IterableIterator<UsageRecord> {
    return this.records.values()
  }

  /**
   * Add one entry. A duplicate either replaces the stored copy's tokens (see
   * `shouldReplace`) or is dropped. The stored copy keeps its id and session,
   * so a response stays with the session that logged it first.
   */
  add(c: UsageRecord): { result: DedupeResult; stored: UsageRecord; previous?: UsageRecord } {
    const e = this.get(c.id) ?? this.findReplay(c)
    if (!e) {
      this.insert(c)
      return { result: 'added', stored: c }
    }
    if (c.id !== e.id && !this.alias.has(c.id)) {
      this.alias.set(c.id, e.id)
      e.aka = [...(e.aka ?? []), c.id]
    }
    if (c.sid && c.mid) this.index(c.sid, c.mid, e.id)
    if (!shouldReplace(c, e)) {
      // Same tokens: only pick up a stop reason that wasn't known yet.
      if (c.stop && !e.stop && total(c) === total(e)) {
        const stored = { ...e, stop: c.stop }
        this.records.set(e.id, stored)
        return { result: 'replaced', stored, previous: e }
      }
      return { result: 'duplicate', stored: e }
    }
    const stored: UsageRecord = {
      ...c,
      id: e.id,
      key: e.key,
      project: e.project,
      env: e.env,
      ...(e.aka ? { aka: e.aka } : {})
    }
    if (!stored.stop && e.stop) stored.stop = e.stop
    this.records.set(e.id, stored)
    if (stored.sid && stored.mid) this.index(stored.sid, stored.mid, e.id)
    return { result: 'replaced', stored, previous: e }
  }

  /** Forget a record (used when a session is parsed again from scratch). */
  remove(id: string): void {
    const r = this.records.get(id)
    if (!r) return
    this.records.delete(id)
    for (const a of r.aka ?? []) this.alias.delete(a)
    if (r.sid && r.mid) this.replay.get(`${r.sid}\n${r.mid}`)?.delete(id)
  }

  private insert(r: UsageRecord): void {
    this.records.set(r.id, r)
    for (const a of r.aka ?? []) this.alias.set(a, r.id)
    if (r.sid && r.mid) this.index(r.sid, r.mid, r.id)
  }

  private index(sid: string, mid: string, id: string): void {
    const k = `${sid}\n${mid}`
    let set = this.replay.get(k)
    if (!set) this.replay.set(k, (set = new Set()))
    set.add(id)
  }

  /**
   * /btw sidechains replay parent messages, sometimes with new request ids.
   * Same session and message id, a sidechain on at least one side, and either
   * both requestless or the same timestamp: it's the same response.
   */
  private findReplay(c: UsageRecord): UsageRecord | undefined {
    if (!c.mid || !c.sid) return undefined
    const ids = this.replay.get(`${c.sid}\n${c.mid}`)
    if (!ids) return undefined
    for (const id of ids) {
      const e = this.records.get(id)
      if (!e || e.mid !== c.mid) continue
      if (!c.sc && !e.sc) continue
      if ((!c.rid && !e.rid) || e.ts === c.ts) return e
    }
    return undefined
  }
}
