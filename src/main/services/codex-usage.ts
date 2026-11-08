// Codex usage records and limit readings, kept apart from Claude Code's.
//
// Every session's own copy of what its rollout holds is kept (a fork's file
// repeats its parent's events, see providers/codex/usage.ts). Across
// sessions, events with the same identity are told apart by ancestry and
// time (see pick): a fork's copy of history its parent already holds counts
// once, while independent responses that happen to match all count. Copies
// whose identity differs from their original's (an older parser's rows) are
// matched by their numbers (see dropCopies). A session parsed again (or
// gone) never loses a response another session also holds, and a session
// that's gone keeps its rows and its fork links (or a guessed one, see links).

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

/** A row's session id (older rows without one: from the session key). */
const recSid = (r: UsageRecord): string => r.sid ?? r.key.slice(r.key.lastIndexOf(':') + 1)
const readSid = (r: CodexLimitReading): string =>
  r.sessionId ?? r.key.slice(r.key.lastIndexOf(':') + 1)

/** What a copy has in common with its original whatever the parser version: its numbers. */
const recContent = (r: UsageRecord): string =>
  [r.input, r.cacheRead, r.cacheWrite, r.output, r.reasoning ?? 0].join(',')
const readContent = (r: CodexLimitReading): string =>
  r.limitId + '|' + r.windows.map((w) => [w.pct, w.minutes, w.resetsAt ?? 0].join(',')).join(';')

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

  /**
   * The fork links to count with: the saved and catalogue ones, plus a guess
   * for a session the app has rows of but no link for (its rollout was gone
   * before links were saved). Codex writes a fork's copies right when it makes
   * the fork, so such a session is a fork of the session that already held
   * what its first rows hold: the same events (same identity) or, between rows
   * of two parser versions, the same counts when there are two or more (a
   * session that isn't a fork has at most one response in its first second).
   */
  private links(): Map<string, Link> {
    if (!this.parents.size) return this.parents
    const first = new Map<string, number>()
    const note = (sid: string, ts: number) => {
      if (this.parents.has(sid)) return
      const t = first.get(sid)
      if (t === undefined || ts < t) first.set(sid, ts)
    }
    for (const c of this.bySession.values()) {
      for (const r of c.records) note(recSid(r), r.ts)
      for (const r of c.readings) note(readSid(r), r.ts)
    }
    if (!first.size) return this.parents
    const links = new Map(this.parents)
    // Each unknown session's first rows (its copies, if it's a fork).
    const burst = new Map<string, UsageRecord[]>()
    const wanted = new Set<string>()
    for (const c of this.bySession.values())
      for (const r of c.records) {
        const start = first.get(recSid(r))
        if (start === undefined || r.ts > start + COPY_MS) continue
        const rows = burst.get(recSid(r)) ?? []
        if (!rows.length) burst.set(recSid(r), rows)
        rows.push(r)
        wanted.add(r.id).add(recContent(r))
      }
    // Who else held those, and when.
    const held = new Map<string, { sid: string; ts: number; old: boolean }[]>()
    for (const [key, c] of this.bySession)
      for (const r of c.records)
        for (const k of [r.id, recContent(r)]) {
          if (!wanted.has(k)) continue
          const hs = held.get(k) ?? []
          if (!hs.length) held.set(k, hs)
          hs.push({ sid: recSid(r), ts: r.ts, old: this.legacy.has(key) })
        }
    const startOf = (sid: string) => links.get(sid)?.start ?? first.get(sid) ?? 0
    for (const [sid, rows] of burst) {
      const start = first.get(sid)!
      const score = new Map<string, number>()
      for (const r of rows) {
        const mine = this.legacy.has(r.key)
        const hits = new Set<string>()
        for (const h of held.get(r.id) ?? []) if (h.sid !== sid && h.ts <= start) hits.add(h.sid)
        if (rows.length >= 2)
          for (const h of held.get(recContent(r)) ?? [])
            if (h.sid !== sid && h.ts <= start && h.old !== mine) hits.add(h.sid)
        for (const x of hits) score.set(x, (score.get(x) ?? 0) + 1)
      }
      let best: string | undefined
      for (const [x, n] of score) {
        const b = best === undefined ? -1 : score.get(best)!
        // Ties: the nearest ancestor (the one made last).
        if (n > b || (n === b && startOf(x) > startOf(best!))) best = x
      }
      if (best !== undefined && score.get(best)! >= Math.ceil(rows.length * 0.8))
        links.set(sid, { parent: best, start })
    }
    return links
  }

  private static ancestors(links: Map<string, Link>, sid: string): Set<string> {
    const out = new Set<string>()
    let p = links.get(sid)?.parent
    while (p && !out.has(p) && p !== sid) {
      out.add(p)
      p = links.get(p)?.parent
    }
    return out
  }

  /**
   * The copies of one event (same identity) that count. The same session (a
   * rollout found in two homes, or its archive copy) counts once. A copy in a
   * fork is copied history when it was written when the fork was made and an
   * ancestor held the event from before then: only the ancestor's counts. A
   * matching response of an ancestor's from after the fork was made, or one
   * the fork wrote later, is an independent response (both count). Copies
   * left in forks of one parent that holds none of them: those made when
   * their fork was (or, with no start time known, all of them when the
   * parent is missing everywhere) are its copied history and count once.
   */
  private pick<T extends { id: string; ts: number; key: string }>(
    copies: T[],
    sidOf: (x: T) => string,
    links: Map<string, Link>
  ): T[] {
    if (copies.length === 1) return copies
    const bySid = new Map<string, T>()
    for (const c of copies) {
      const k = sidOf(c)
      const e = bySid.get(k)
      if (!e || better(c, e)) bySid.set(k, c)
    }
    const one = [...bySid.values()]
    // Fork links not known yet (before the first scan): the earliest copy only.
    if (!links.size) {
      let e = one[0]
      for (const k of one) if (better(k, e)) e = k
      return [e]
    }
    const anc = (x: T) => CodexUsageStore.ancestors(links, sidOf(x))
    const startOf = (x: T) => links.get(sidOf(x))?.start
    const kept = one.filter((c) => {
      const start = startOf(c)
      // Written after its fork was made: the fork's own response.
      if (start !== undefined && c.ts > start + COPY_MS) return true
      const a = anc(c)
      return !one.some((d) => d !== c && a.has(sidOf(d)) && (start === undefined || d.ts <= start))
    })
    if (kept.length <= 1) return kept
    let out = kept
    const anc0 = anc(kept[0])
    const common = [...anc0].filter((a) => kept.every((k) => anc(k).has(a)))
    if (common.length) {
      const parentGone = !common.some((a) => links.has(a))
      const copied = kept.filter((k) => {
        const start = startOf(k)
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
      .map((k, i) => (i === 0 ? k : { ...k, id: `${k.id}:${sidOf(k)}` }))
  }

  /**
   * Copies that don't share an identity with their original: rows an older
   * parser made (another identity scheme) for a fork or its parent, or a fork
   * read against another lineage root. A fork's row written when the fork was
   * made is a copy by construction: it gives way to an ancestor that held the
   * same counts from before then, and between forks of one parent (which
   * holds none of it) the earliest copy counts. Rows a fork wrote later
   * always count.
   */
  private dropCopies<T extends { id: string; ts: number; key: string }>(
    rows: T[],
    all: T[],
    sidOf: (x: T) => string,
    contentOf: (x: T) => string,
    links: Map<string, Link>
  ): T[] {
    const isCopy = (x: T) => {
      const l = links.get(sidOf(x))
      return !!l?.parent && l.start !== undefined && x.ts <= l.start + COPY_MS
    }
    const candidates = rows.filter(isCopy)
    if (!candidates.length) return rows
    const wanted = new Set(candidates.map(contentOf))
    const held = new Map<string, T[]>()
    for (const x of all) {
      const k = contentOf(x)
      if (!wanted.has(k)) continue
      const hs = held.get(k) ?? []
      if (!hs.length) held.set(k, hs)
      hs.push(x)
    }
    // Rows that count so far (an independent copy of pick's has its own id).
    const live = new Set(rows.map((x) => `${x.key}\u0000${x.ts}\u0000${contentOf(x)}`))
    const counts = (x: T) => live.has(`${x.key}\u0000${x.ts}\u0000${contentOf(x)}`)
    const drop = new Set<T>()
    for (const c of candidates) {
      const sid = sidOf(c)
      const start = links.get(sid)!.start!
      const a = CodexUsageStore.ancestors(links, sid)
      const same = held.get(contentOf(c)) ?? []
      if (same.some((d) => a.has(sidOf(d)) && d.ts <= start)) {
        drop.add(c)
        continue
      }
      const sibling = same.some((d) => {
        const ds = sidOf(d)
        if (ds === sid || a.has(ds) || !isCopy(d) || !better(d, c) || !counts(d)) return false
        const da = CodexUsageStore.ancestors(links, ds)
        return !da.has(sid) && [...da].some((x) => a.has(x))
      })
      if (sibling) drop.add(c)
    }
    return drop.size ? rows.filter((x) => !drop.has(x)) : rows
  }

  private resolve(): { records: UsageRecord[]; readings: CodexLimitReading[] } {
    if (this.winners) return this.winners
    const links = this.links()
    const recs = new Map<string, UsageRecord[]>()
    const reads = new Map<string, CodexLimitReading[]>()
    const allRecs: UsageRecord[] = []
    const allReads: CodexLimitReading[] = []
    const add = <T extends { id: string }>(m: Map<string, T[]>, x: T) => {
      const g = m.get(x.id)
      if (g) g.push(x)
      else m.set(x.id, [x])
    }
    for (const c of this.bySession.values()) {
      for (const r of c.records) {
        add(recs, r)
        allRecs.push(r)
      }
      for (const r of c.readings) {
        add(reads, r)
        allReads.push(r)
      }
    }
    const records = [...recs.values()].flatMap((c) => this.pick(c, recSid, links))
    const readings = [...reads.values()].flatMap((c) => this.pick(c, readSid, links))
    this.winners = {
      records: this.dropCopies(records, allRecs, recSid, recContent, links).sort(
        (a, b) => a.ts - b.ts
      ),
      readings: this.dropCopies(readings, allReads, readSid, readContent, links).sort(
        (a, b) => a.ts - b.ts
      )
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
