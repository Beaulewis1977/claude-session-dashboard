// Codex usage records and limit readings, kept apart from Claude Code's.
//
// Every session's own copy of what its rollout holds is kept (a fork's file
// repeats its parent's events, see providers/codex/usage.ts). Across
// sessions, events with the same identity are told apart by ancestry and
// time (see pick): a fork's copy of history its parent already holds counts
// once, while independent responses that happen to match all count. A
// session parsed again (or gone) never loses a response another session also
// holds, and a session that's gone keeps its rows and its fork links.

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

/** A session's place in its fork chain: its parent and when it was created. */
interface Link {
  parent: string | null
  start?: number
}

/**
 * Codex writes a fork's copy of its parent's events right when it creates
 * the fork (0-10 ms after its meta line in real rollouts), and the parent's
 * originals all came before it; the fork's own responses come seconds later.
 */
const COPY_MS = 1000

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
  private lineageDirty = false

  get size(): number {
    return this.records().length
  }

  has(key: string): boolean {
    return this.bySession.has(key)
  }

  sessionKeys(): string[] {
    return [...this.bySession.keys()]
  }

  /**
   * Sessions whose rows an older parser made and that haven't been read
   * again yet (offline, unreadable or gone during an update): their rows stay
   * until the session is parsed again.
   */
  private legacy = new Set<string>()

  /** Replace one session's copies (it was parsed again). */
  set(key: string, records: UsageRecord[], readings: CodexLimitReading[], sig?: string): void {
    const old = this.bySession.get(key)
    for (const x of [...(old?.records ?? []), ...(old?.readings ?? []), ...records, ...readings])
      this.dirtyMonths.add(month(x.ts))
    this.bySession.set(key, { records, readings })
    if (this.legacy.delete(key)) this.indexDirty = true
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
    this.legacy.clear()
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

  /**
   * Each known Codex session's fork link, by session id. Saved with the
   * index: a session whose rollout is gone keeps its rows, so it keeps its
   * link too (else its copies of its parent's history would count again).
   */
  private parents = new Map<string, Link>()

  /** The catalogue's fork links (added to the known ones), for telling copied history apart. */
  setLineage(sessions: { sessionId: string; forkedFromId?: string; startedAt?: string }[]): void {
    let changed = false
    for (const x of sessions) {
      const t = x.startedAt ? Date.parse(x.startedAt) : Number.NaN
      const next: Link = {
        parent: x.forkedFromId ?? null,
        ...(Number.isFinite(t) ? { start: t } : {})
      }
      const cur = this.parents.get(x.sessionId)
      if (cur && cur.parent === next.parent && cur.start === next.start) continue
      this.parents.set(x.sessionId, next)
      changed = true
    }
    if (!changed) return
    this.lineageDirty = true
    this.winners = undefined
  }

  /** Every known session's lineage root (see lineageRoots), gone sessions included. */
  roots(): Map<string, string> {
    return lineageRoots(
      [...this.parents].map(([sessionId, l]) => ({
        sessionId,
        ...(l.parent ? { forkedFromId: l.parent } : {})
      }))
    )
  }

  private ancestors(sid: string | undefined): Set<string> {
    const out = new Set<string>()
    let p = sid ? this.parents.get(sid)?.parent : undefined
    while (p && !out.has(p)) {
      out.add(p)
      p = this.parents.get(p)?.parent
    }
    return out
  }

  private startOf(sid: string | undefined): number | undefined {
    return sid ? this.parents.get(sid)?.start : undefined
  }

  /**
   * The copies of one event that count. The same session (a rollout found in
   * two homes, or its archive copy) counts once. A copy in a fork is copied
   * history when an ancestor holds it from before the fork was made: only the
   * ancestor's counts. An ancestor's matching response from after the fork
   * was made is an independent one (both count). Copies left in forks of one
   * parent that holds none of them: those made when their fork was (or, with
   * no start time known, all of them when the parent is missing everywhere)
   * are its copied history and count once; the rest are independent.
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
      const start = this.startOf(sidOf(c))
      return !one.some(
        (d) =>
          d !== c && anc.has(sidOf(d) ?? '') && (start === undefined || d.ts <= start + COPY_MS)
      )
    })
    if (kept.length <= 1) return kept
    let out = kept
    const anc0 = this.ancestors(sidOf(kept[0]))
    const common = [...anc0].filter((a) => kept.every((k) => this.ancestors(sidOf(k)).has(a)))
    if (common.length) {
      const parentGone = !common.some((a) => this.parents.has(a))
      const copied = kept.filter((k) => {
        const start = this.startOf(sidOf(k))
        return start === undefined ? parentGone : k.ts <= start + COPY_MS
      })
      if (copied.length > 1) {
        let e = copied[0]
        for (const k of copied) if (better(k, e)) e = k
        out = kept.filter((k) => k === e || !copied.includes(k))
      }
    }
    if (out.length <= 1) return out
    // Independent: each keeps its own id, so lists and tables can tell them apart.
    return out
      .sort((a, b) => (better(a, b) ? -1 : 1))
      .map((k, i) => (i === 0 ? k : { ...k, id: `${k.id}:${sidOf(k) ?? k.key}` }))
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
        legacy?: string[]
        lineage?: Record<string, [string | null, number | null]>
      }
      if (idx.version === CODEX_USAGE_VERSION && idx.sessions) {
        this.index = idx.sessions
        current = true
        if (Array.isArray(idx.legacy))
          for (const k of idx.legacy) if (typeof k === 'string') this.legacy.add(k)
      }
      // Fork links don't depend on the parser: kept across updates.
      if (idx.lineage && typeof idx.lineage === 'object')
        for (const [sid, v] of Object.entries(idx.lineage)) {
          if (!Array.isArray(v)) continue
          const [parent, start] = v
          this.parents.set(sid, {
            parent: typeof parent === 'string' ? parent : null,
            ...(typeof start === 'number' && Number.isFinite(start) ? { start } : {})
          })
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
    // An older parser's rows are kept too, until each session is read again
    // (one that's offline or unreadable during the update keeps its history).
    {
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
    }
    if (!current) {
      // Every session is read again; until then its old rows stand.
      this.index = {}
      for (const k of copies.keys()) this.legacy.add(k)
      // Nothing is written while there's no Codex data at all.
      this.indexDirty = copies.size > 0
    }
    this.bySession = copies
    this.winners = undefined
  }

  async flush(dir: string, dataDir: string): Promise<void> {
    // The index (with the fork links) goes with the rows; nothing is written without Codex data.
    const hasData = this.bySession.size > 0 || Object.keys(this.index).length > 0
    if (hasData && (this.dirtyMonths.size || this.lineageDirty)) this.indexDirty = true
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
      this.lineageDirty = false
      const lineage: Record<string, [string | null, number | null]> = {}
      for (const [sid, l] of this.parents) lineage[sid] = [l.parent, l.start ?? null]
      await writeFileAtomic(
        join(dir, INDEX),
        JSON.stringify({
          version: CODEX_USAGE_VERSION,
          sessions: this.index,
          ...(this.legacy.size ? { legacy: [...this.legacy] } : {}),
          lineage
        }),
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
