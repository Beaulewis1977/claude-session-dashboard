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
// A reading's reset time is left out: older Codex gave it relative to the event
// (resets_in_seconds), and a fork's copy has a new event time.
const readContent = (r: CodexLimitReading): string =>
  r.limitId + '|' + r.windows.map((w) => [w.pct, w.minutes].join(',')).join(';')

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
   * the fork, in order, so such a session is a fork of the session whose
   * earlier rows its first rows repeat: matched one to one and in order, by
   * identity, or between rows of two parser versions by their numbers when
   * two or more match (a session that isn't a fork has at most one response
   * in its first second).
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
    // Each unknown session's first rows (its copies, if it's a fork), per home.
    const burst = new Map<string, UsageRecord[]>()
    const wanted = new Set<string>()
    for (const [key, c] of this.bySession)
      for (const r of c.records) {
        const start = first.get(recSid(r))
        if (start === undefined || r.ts > start + COPY_MS) continue
        const rows = burst.get(key) ?? []
        if (!rows.length) burst.set(key, rows)
        rows.push(r)
        wanted.add(r.id).add(recContent(r))
      }
    // The other homes' sessions that hold any of those.
    const holders = new Set<string>()
    for (const [key, c] of this.bySession)
      if (c.records.some((r) => wanted.has(r.id) || wanted.has(recContent(r)))) holders.add(key)
    const byTime = (a: UsageRecord, b: UsageRecord) => a.ts - b.ts || (a.id < b.id ? -1 : 1)
    const startOf = (sid: string) => links.get(sid)?.start ?? first.get(sid) ?? 0
    for (const [key, rows] of burst) {
      const sid = recSid(rows[0])
      if (links.has(sid)) continue // another home of it already found its parent
      const start = first.get(sid)!
      const mine = this.legacy.has(key)
      rows.sort(byTime)
      let best: { sid: string; n: number } | undefined
      for (const hk of holders) {
        if (hk === key) continue
        const theirs = this.bySession
          .get(hk)!
          .records.filter((r) => r.ts <= start && recSid(r) !== sid)
          .sort(byTime)
        if (!theirs.length) continue
        const versions = this.legacy.has(hk) !== mine
        // One to one, in order: each of their rows stands for one of these at most.
        let j = 0
        let byId = 0
        let n = 0
        for (const r of rows) {
          let k = j
          while (
            k < theirs.length &&
            theirs[k].id !== r.id &&
            !(versions && recContent(theirs[k]) === recContent(r))
          )
            k++
          if (k === theirs.length) continue
          if (theirs[k].id === r.id) byId++
          n++
          j = k + 1
        }
        if (n < Math.ceil(rows.length * 0.8) || (!byId && n < 2)) continue
        const x = recSid(theirs[0])
        // Ties: the nearest ancestor (the one made last).
        if (!best || n > best.n || (n === best.n && startOf(x) > startOf(best.sid)))
          best = { sid: x, n }
      }
      if (best) links.set(sid, { parent: best.sid, start })
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
   * The copies of one event (same identity: one to one by construction) that
   * count. The same session (a rollout found in two homes, or its archive
   * copy) counts once. A copy in a fork is copied history when it was written
   * when the fork was made and an ancestor held the event from before then:
   * only the ancestor's counts. A matching response of an ancestor's from
   * after the fork was made, or one the fork wrote later, is an independent
   * response (both count). Copies left in forks of one parent that holds none
   * of them: those made when their fork was (or, with no start time known,
   * all of them when the parent is missing everywhere) count once.
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
    let out = kept
    if (kept.length > 1) {
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
    }
    if (out.length <= 1) return out
    // Independent so far: each keeps its own id, so lists and tables can tell them apart.
    return out
      .sort((a, b) => (better(a, b) ? -1 : 1))
      .map((k, i) => (i === 0 ? k : { ...k, id: `${k.id}:${sidOf(k)}` }))
  }

  /**
   * Copies pick can't match by identity: rows an older parser made (another
   * identity scheme) for a fork or its parent, or a fork read against another
   * lineage root. Codex writes a fork's copies when it makes the fork, so a
   * fork's rows from then are copies (with a known start), and rows it wrote
   * later are its own (always counted). These are matched by their numbers,
   * one to one: as many of a fork's copies with given numbers give way as an
   * ancestor held rows with those numbers before the fork was made, or as an
   * earlier fork of the same parent copied, less those pick already matched.
   * The rest count: history no other session holds.
   */
  private dropCopies<T extends { id: string; ts: number; key: string }>(
    rows: T[],
    all: T[],
    sidOf: (x: T) => string,
    contentOf: (x: T) => string,
    links: Map<string, Link>
  ): T[] {
    const copyEnd = (sid: string): number | undefined => {
      const l = links.get(sid)
      return l?.parent && l.start !== undefined ? l.start + COPY_MS : undefined
    }
    // Each fork's copies, by its numbers.
    const cand = new Map<string, { sid: string; content: string; rows: T[] }>()
    for (const x of rows) {
      const end = copyEnd(sidOf(x))
      if (end === undefined || x.ts > end) continue
      const k = `${sidOf(x)}\u0000${contentOf(x)}`
      const g = cand.get(k)
      if (g) g.rows.push(x)
      else cand.set(k, { sid: sidOf(x), content: contentOf(x), rows: [x] })
    }
    if (!cand.size) return rows
    const wanted = new Set([...cand.values()].map((g) => g.content))
    // Who held rows with those numbers, when: by content, session and home.
    const held = new Map<string, Map<string, Map<string, number[]>>>()
    for (const x of all) {
      const k = contentOf(x)
      if (!wanted.has(k)) continue
      let bySid = held.get(k)
      if (!bySid) held.set(k, (bySid = new Map()))
      let byKey = bySid.get(sidOf(x))
      if (!byKey) bySid.set(sidOf(x), (byKey = new Map()))
      const ts = byKey.get(x.key)
      if (ts) ts.push(x.ts)
      else byKey.set(x.key, [x.ts])
    }
    // The most any one home of a session held (a session in two homes is one).
    const most = (byKey: Map<string, number[]>, upTo: number) => {
      let m = 0
      for (const ts of byKey.values()) m = Math.max(m, ts.filter((t) => t <= upTo).length)
      return m
    }
    const startOf = (sid: string) => links.get(sid)!.start!
    const drop = new Set<T>()
    for (const g of cand.values()) {
      const start = startOf(g.sid)
      const parent = links.get(g.sid)!.parent
      const a = CodexUsageStore.ancestors(links, g.sid)
      let m = 0
      for (const [s2, byKey] of held.get(g.content) ?? []) {
        if (s2 === g.sid) continue
        if (a.has(s2)) {
          m = Math.max(m, most(byKey, start))
          continue
        }
        // An earlier fork of the same parent: its copies are the same history.
        const l2 = links.get(s2)
        if (
          l2?.parent === parent &&
          l2.start !== undefined &&
          (l2.start < start || (l2.start === start && s2 < g.sid)) &&
          !CodexUsageStore.ancestors(links, s2).has(g.sid)
        )
          m = Math.max(m, most(byKey, l2.start + COPY_MS))
      }
      if (!m) continue
      // pick already matched some of this fork's copies by identity (each of
      // those used up one of the rows held): only the rest of m is left.
      const total = most(held.get(g.content)!.get(g.sid)!, start + COPY_MS)
      const more = Math.min(
        g.rows.length,
        Math.max(0, Math.min(total, m) - (total - g.rows.length))
      )
      if (!more) continue
      g.rows.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1))
      for (const x of g.rows.slice(0, more)) drop.add(x)
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
