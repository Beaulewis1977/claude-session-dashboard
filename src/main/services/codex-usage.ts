// Codex usage records and limit readings, kept apart from Claude Code's.
//
// Every session's own copy of what its rollout holds is kept (a fork's file
// repeats its parent's events, see providers/codex/usage.ts). Across
// sessions, events with the same identity are one response: the earliest
// copy wins (the parent's, at its real time), so nothing is counted twice,
// whatever order the files are read in, and a session parsed again (or
// gone) never loses a response another session also holds.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodexLimitReading } from '@shared/usage/codex'
import type { UsageRecord } from '@shared/usage/types'
import { writeFileAtomic } from '../core/json-store'
import { listFiles, readNdjson, writeNdjson } from '../core/ndjson'

/** Bumped when the Codex usage parser changes: every Codex session is read again. */
// 2: records carry the plan_type of the account that ran them; 299/10079-minute windows.
// 3: identities count repeats within a file; readings without a plan take their session's.
export const CODEX_USAGE_VERSION = 3

const RECORDS_RE = /^codex-records-\d{4}-\d{2}\.ndjson$/
const LIMITS_RE = /^codex-limits-\d{4}-\d{2}\.ndjson$/
const INDEX = 'codex-index.json'

interface Copies {
  records: UsageRecord[]
  readings: CodexLimitReading[]
}

function month(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The copy that counts: the earliest, then the lowest session key (stable). */
function better(a: { ts: number; key: string }, b: { ts: number; key: string }): boolean {
  return a.ts < b.ts || (a.ts === b.ts && a.key < b.key)
}

export class CodexUsageStore {
  private bySession = new Map<string, Copies>()
  private winners?: { records: UsageRecord[]; readings: CodexLimitReading[] }
  /** Keyed by session key: the signature of what was parsed last. */
  index: Record<string, string> = {}
  private dirtyMonths = new Set<string>()
  private indexDirty = false

  get size(): number {
    return this.records().length
  }

  has(key: string): boolean {
    return this.bySession.has(key)
  }

  sessionKeys(): string[] {
    return [...this.bySession.keys()]
  }

  /** Replace one session's copies (it was parsed again). */
  set(key: string, records: UsageRecord[], readings: CodexLimitReading[], sig?: string): void {
    const old = this.bySession.get(key)
    for (const x of [...(old?.records ?? []), ...(old?.readings ?? []), ...records, ...readings])
      this.dirtyMonths.add(month(x.ts))
    this.bySession.set(key, { records, readings })
    if (sig !== undefined) {
      this.index[key] = sig
      this.indexDirty = true
    }
    this.winners = undefined
  }

  clear(): void {
    for (const c of this.bySession.values())
      for (const x of [...c.records, ...c.readings]) this.dirtyMonths.add(month(x.ts))
    if (this.bySession.size || Object.keys(this.index).length) this.indexDirty = true
    this.bySession.clear()
    this.index = {}
    this.winners = undefined
  }

  /** One record per response, sorted by time. */
  records(): UsageRecord[] {
    return this.resolve().records
  }

  /** One reading per event, sorted by time. */
  readings(): CodexLimitReading[] {
    return this.resolve().readings
  }

  /** Each known Codex session's parent (`forkedFromId`), by session id; null: not a fork. */
  private parents = new Map<string, string | null>()

  /** The catalogue's fork links, for telling copied history from independent responses. */
  setLineage(sessions: { sessionId: string; forkedFromId?: string }[]): void {
    const next = new Map(sessions.map((x) => [x.sessionId, x.forkedFromId ?? null] as const))
    const same =
      next.size === this.parents.size && [...next].every(([k, v]) => this.parents.get(k) === v)
    if (same) return
    this.parents = next
    this.winners = undefined
  }

  private ancestors(sid: string | undefined): Set<string> {
    const out = new Set<string>()
    let p = sid ? this.parents.get(sid) : undefined
    while (p && !out.has(p)) {
      out.add(p)
      p = this.parents.get(p)
    }
    return out
  }

  /**
   * The copies of one event that count. The same session (a rollout found in
   * two homes, or its archive copy) counts once. A copy in a fork whose
   * ancestor also holds it is copied history: only the ancestor's counts.
   * Copies left in unrelated forks are independent responses that happen to
   * match (both count), unless the parent they would share is missing
   * everywhere: then they're taken to be its copied history (the earliest
   * counts).
   */
  private pick<T extends { id: string; ts: number; key: string }>(
    copies: T[],
    sidOf: (x: T) => string | undefined
  ): T[] {
    if (copies.length === 1) return copies
    const bySid = new Map<string, T>()
    for (const c of copies) {
      const k = sidOf(c) ?? c.key
      const e = bySid.get(k)
      if (!e || better(c, e)) bySid.set(k, c)
    }
    const one = [...bySid.values()]
    // Fork links not known yet (before the first scan): the earliest copy only.
    if (!this.parents.size) {
      let e = one[0]
      for (const k of one) if (better(k, e)) e = k
      return [e]
    }
    const kept = one.filter((c) => {
      const anc = this.ancestors(sidOf(c))
      return !one.some((d) => d !== c && anc.has(sidOf(d) ?? ''))
    })
    if (kept.length <= 1) return kept
    const anc0 = this.ancestors(sidOf(kept[0]))
    const common = [...anc0].filter((a) => kept.every((k) => this.ancestors(sidOf(k)).has(a)))
    if (common.length && !common.some((a) => this.parents.has(a))) {
      let e = kept[0]
      for (const k of kept) if (better(k, e)) e = k
      return [e]
    }
    // Independent: each keeps its own id, so lists and tables can tell them apart.
    return kept.map((k, i) => (i === 0 ? k : { ...k, id: `${k.id}:${sidOf(k) ?? k.key}` }))
  }

  private resolve(): { records: UsageRecord[]; readings: CodexLimitReading[] } {
    if (this.winners) return this.winners
    const recs = new Map<string, UsageRecord[]>()
    const reads = new Map<string, CodexLimitReading[]>()
    for (const c of this.bySession.values()) {
      for (const r of c.records) recs.set(r.id, [...(recs.get(r.id) ?? []), r])
      for (const r of c.readings) reads.set(r.id, [...(reads.get(r.id) ?? []), r])
    }
    this.winners = {
      records: [...recs.values()]
        .flatMap((c) => this.pick(c, (r) => r.sid))
        .sort((a, b) => a.ts - b.ts),
      readings: [...reads.values()]
        .flatMap((c) => this.pick(c, (r) => r.sessionId))
        .sort((a, b) => a.ts - b.ts)
    }
    return this.winners
  }

  // ---------------------------------------------------------- persistence

  async load(dir: string): Promise<void> {
    let current = false
    try {
      const idx = JSON.parse(await readFile(join(dir, INDEX), 'utf8')) as {
        version?: number
        sessions?: Record<string, string>
      }
      if (idx.version === CODEX_USAGE_VERSION && idx.sessions) {
        this.index = idx.sessions
        current = true
      }
    } catch {
      // first run
    }
    const copies = new Map<string, Copies>()
    const of = (key: string): Copies => {
      let c = copies.get(key)
      if (!c) copies.set(key, (c = { records: [], readings: [] }))
      return c
    }
    if (current) {
      for (const f of await listFiles(dir, RECORDS_RE))
        for (const r of await readNdjson<UsageRecord>(join(dir, f)))
          if (
            r &&
            typeof r.id === 'string' &&
            typeof r.ts === 'number' &&
            typeof r.key === 'string'
          )
            of(r.key).records.push({ ...r, provider: 'codex' })
      for (const f of await listFiles(dir, LIMITS_RE))
        for (const r of await readNdjson<CodexLimitReading>(join(dir, f)))
          if (
            r &&
            typeof r.id === 'string' &&
            typeof r.ts === 'number' &&
            typeof r.key === 'string'
          )
            of(r.key).readings.push(r)
    } else {
      // An older parser's data: rewrite (empty) and read every session again.
      for (const f of [...(await listFiles(dir, RECORDS_RE)), ...(await listFiles(dir, LIMITS_RE))])
        this.dirtyMonths.add(f.replace(/^codex-(?:records|limits)-|\.ndjson$/g, ''))
      this.index = {}
      // Nothing is written while there's no Codex data at all.
      this.indexDirty = this.dirtyMonths.size > 0
    }
    this.bySession = copies
    this.winners = undefined
  }

  async flush(dir: string, dataDir: string): Promise<void> {
    if (this.dirtyMonths.size) {
      const months = [...this.dirtyMonths]
      this.dirtyMonths.clear()
      const recs = new Map<string, UsageRecord[]>(months.map((m) => [m, []]))
      const reads = new Map<string, CodexLimitReading[]>(months.map((m) => [m, []]))
      for (const c of this.bySession.values()) {
        for (const r of c.records) recs.get(month(r.ts))?.push(r)
        for (const r of c.readings) reads.get(month(r.ts))?.push(r)
      }
      for (const m of months) {
        const r = recs.get(m)!.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key))
        const l = reads.get(m)!.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key))
        await writeNdjson(join(dir, `codex-records-${m}.ndjson`), r, dataDir)
        await writeNdjson(join(dir, `codex-limits-${m}.ndjson`), l, dataDir)
      }
    }
    if (this.indexDirty) {
      this.indexDirty = false
      await writeFileAtomic(
        join(dir, INDEX),
        JSON.stringify({ version: CODEX_USAGE_VERSION, sessions: this.index }),
        dataDir
      )
    }
  }
}

/**
 * The first thread of each Codex session's fork chain (its lineage), by
 * session id: follow `forkedFromId` while the parent is known. A parent the
 * app doesn't have is the root itself, so a fork and its siblings still
 * share one lineage.
 */
export function lineageRoots(
  sessions: { sessionId: string; forkedFromId?: string }[]
): Map<string, string> {
  const parent = new Map<string, string | null>()
  for (const s of sessions) parent.set(s.sessionId, s.forkedFromId ?? null)
  const out = new Map<string, string>()
  for (const s of sessions) {
    let id = s.sessionId
    const seen = new Set<string>([id])
    for (;;) {
      const p = parent.get(id)
      if (!p || seen.has(p)) break
      seen.add(p)
      id = p
      if (!parent.has(id)) break
    }
    out.set(s.sessionId, id)
  }
  return out
}
