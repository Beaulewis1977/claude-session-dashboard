// Token usage from session logs. Every session (live or archived) is parsed
// once, every API response is counted once (deduped across files with
// ccusage's rules, see shared/usage/dedupe.ts), and the results are kept in the app's data folder as
// monthly NDJSON files, so history survives Claude Code's cleanup and startup
// only parses files that changed.

import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseJsonl } from '@shared/jsonl'
import { now } from '@shared/clock'
import { buildReport, breakdown, emptyTotals, addRecord, toCsv } from '@shared/usage/aggregate'
import { analyzeUsage } from '@shared/usage/parse'
import { UsageDeduper } from '@shared/usage/dedupe'
import { estimateCost, type ModelPrice } from '@shared/usage/pricing'
import { localTimeZone } from '@shared/usage/time'
import type {
  LimitHit,
  SessionUsage,
  TurnSample,
  UsageQuery,
  UsageRecord,
  UsageReport,
  UsageStatus,
  WeekStart
} from '@shared/usage/types'
import type { SessionSummary } from '@shared/types'
import { writeFileAtomic } from '../core/json-store'
import { listFiles, readNdjson, writeNdjson } from '../core/ndjson'
import { assertAppDataWrite, isInside } from '../core/safe-paths'
import type { SessionService } from './sessions'

// 2: dedupe follows ccusage (session-scoped requestless ids, sidechain replays).
const INDEX_VERSION = 2

interface IndexFile {
  version: number
  /** Keyed by session key: the signature of what was parsed last. */
  sessions: Record<string, string>
}

export interface UsageSettings {
  weekStart: WeekStart
  prices: ModelPrice[]
}

export interface UsagePaths {
  dataDir: string
  archiveDir: string
  usageDir: string
}

export function usagePaths(dataDir: string, archiveDir: string): UsagePaths {
  return { dataDir, archiveDir, usageDir: join(dataDir, 'usage') }
}

/** UTC month of a timestamp, used only to partition the storage files. */
function storageMonth(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Subagent transcripts live next to the session: `<project>/<session-id>/subagents/*.jsonl`. */
export async function listSubagentFiles(
  sessionFile: string,
  sessionId: string
): Promise<{ path: string; size: number }[]> {
  const dir = join(dirname(sessionFile), sessionId, 'subagents')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: { path: string; size: number }[] = []
  for (const n of names.sort()) {
    if (!n.endsWith('.jsonl')) continue
    try {
      const st = await stat(join(dir, n))
      if (st.isFile()) out.push({ path: join(dir, n), size: st.size })
    } catch {
      // vanished
    }
  }
  return out
}

export class UsageService extends EventEmitter<{ changed: [] }> {
  private records = new UsageDeduper()
  /** Sessions whose stored records predate the current parser (purged on reparse). */
  private stale = new Set<string>()
  private turns = new Map<string, TurnSample>()
  private hits = new Map<string, LimitHit>()
  private index: IndexFile = { version: INDEX_VERSION, sessions: {} }
  private dirtyMonths = new Set<string>()
  private dirtyTurnMonths = new Set<string>()
  private hitsDirty = false
  private indexDirty = false
  private saveTimer: NodeJS.Timeout | undefined
  private syncTimer: NodeJS.Timeout | undefined
  private running: Promise<void> = Promise.resolve()
  private parsing = false
  private loaded = false
  private cachedList: UsageRecord[] | undefined
  private lastUpdated: number | undefined

  constructor(
    private readonly sessions: SessionService,
    private readonly paths: UsagePaths,
    private readonly settings: () => UsageSettings
  ) {
    super()
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    await this.load()
    this.sessions.on('changed', () => this.scheduleSync())
    await this.sync()
  }

  scheduleSync(delay = 1500): void {
    if (this.syncTimer) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.sync()
    }, delay)
  }

  /** Parse every session whose file changed since the last run. */
  sync(force = false): Promise<void> {
    this.running = this.running
      .then(() => this.syncNow(force))
      .catch((err) => {
        console.warn('usage sync failed', err)
      })
    return this.running
  }

  async idle(): Promise<void> {
    await this.running
    await this.flush()
  }

  /** Forget everything and parse all sessions again. */
  async recalculate(): Promise<void> {
    await this.running
    const months = new Set([...this.records.values()].map((r) => storageMonth(r.ts)))
    const turnMonths = new Set([...this.turns.values()].map((t) => storageMonth(t.ts)))
    this.records = new UsageDeduper()
    this.stale.clear()
    this.turns.clear()
    this.hits.clear()
    this.index = { version: INDEX_VERSION, sessions: {} }
    // Rewrite every existing month file (possibly as empty).
    for (const m of months) this.dirtyMonths.add(m)
    for (const m of turnMonths) this.dirtyTurnMonths.add(m)
    this.hitsDirty = true
    this.indexDirty = true
    this.invalidate()
    await this.sync(true)
    await this.flush()
  }

  // ---------------------------------------------------------------- queries

  status(): UsageStatus {
    return {
      records: this.records.size,
      files: Object.keys(this.index.sessions).length,
      parsing: this.parsing || !this.loaded,
      lastUpdated: this.lastUpdated
    }
  }

  allRecords(): UsageRecord[] {
    if (!this.cachedList) this.cachedList = [...this.records.values()].sort((a, b) => a.ts - b.ts)
    return this.cachedList
  }

  allTurns(): TurnSample[] {
    return [...this.turns.values()].sort((a, b) => a.ts - b.ts)
  }

  limitHits(): LimitHit[] {
    return [...this.hits.values()].sort((a, b) => a.ts - b.ts)
  }

  report(query: UsageQuery, billingOf?: (key: string) => string): UsageReport {
    const s = this.settings()
    return buildReport(this.allRecords(), query, {
      timeZone: localTimeZone(),
      weekStart: s.weekStart,
      prices: s.prices,
      now: now(),
      loading: !this.loaded || (this.parsing && this.records.size === 0),
      billingOf,
      sessionLabel: (key) => {
        const ses = this.sessions.get(key)
        return ses ? { label: ses.title, detail: ses.projectName } : undefined
      }
    })
  }

  sessionUsage(key: string): SessionUsage {
    const s = this.settings()
    const recs = this.allRecords().filter((r) => r.key === key)
    const totals = emptyTotals()
    for (const r of recs) addRecord(totals, r, estimateCost(r, s.prices))
    return {
      key,
      ...totals,
      byModel: breakdown(recs, 'model', {
        timeZone: localTimeZone(),
        weekStart: s.weekStart,
        prices: s.prices,
        now: now()
      }),
      firstAt: recs[0]?.ts,
      lastAt: recs[recs.length - 1]?.ts
    }
  }

  csv(query: UsageQuery, perRecord: boolean): string {
    const recs = this.allRecords().filter(
      (r) =>
        (query.from === undefined || r.ts >= query.from) &&
        (query.to === undefined || r.ts < query.to) &&
        (!query.models?.length || query.models.includes(r.model))
    )
    return toCsv(recs, { timeZone: localTimeZone(), prices: this.settings().prices }, perRecord)
  }

  // ---------------------------------------------------------------- private

  private invalidate(): void {
    this.cachedList = undefined
  }

  private async load(): Promise<void> {
    const dir = this.paths.usageDir
    let current = true
    try {
      const idx = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as IndexFile
      if (idx.version === INDEX_VERSION && idx.sessions) this.index = idx
      else current = false
    } catch {
      // first run
    }
    const loaded: UsageRecord[] = []
    for (const f of await listFiles(dir, /^records-\d{4}-\d{2}\.ndjson$/)) {
      for (const r of await readNdjson<UsageRecord>(join(dir, f))) {
        if (r && typeof r.id === 'string' && typeof r.ts === 'number') loaded.push(r)
      }
    }
    this.records = new UsageDeduper(loaded)
    // Records from an older parser are replaced session by session as each
    // session is parsed again. Sessions whose files are gone keep theirs.
    if (!current) for (const r of loaded) this.stale.add(r.key)
    for (const f of await listFiles(dir, /^turns-\d{4}-\d{2}\.ndjson$/)) {
      for (const t of await readNdjson<TurnSample>(join(dir, f))) {
        if (t && typeof t.id === 'string' && typeof t.ts === 'number') this.turns.set(t.id, t)
      }
    }
    for (const h of await readNdjson<LimitHit>(join(dir, 'limit-hits.ndjson'))) {
      if (h && typeof h.id === 'string') this.hits.set(h.id, h)
    }
    this.loaded = true
    this.invalidate()
  }

  private purge(key: string): void {
    for (const r of [...this.records.values()]) {
      if (r.key !== key) continue
      this.records.remove(r.id)
      this.dirtyMonths.add(storageMonth(r.ts))
    }
  }

  private async signature(s: SessionSummary): Promise<{ sig: string; subagents: string[] }> {
    const subs = await listSubagentFiles(s.filePath, s.sessionId)
    const sig = [`${s.filePath}|${s.sizeBytes}|${s.lastActivityAt ?? ''}`]
    for (const f of subs) sig.push(`${basename(f.path)}:${f.size}`)
    return { sig: sig.join(';'), subagents: subs.map((f) => f.path) }
  }

  private async syncNow(force: boolean): Promise<void> {
    if (!this.loaded) await this.load()
    const list = this.sessions.list()
    if (!list.length) return
    this.parsing = true
    let changed = false
    try {
      for (const s of list) {
        const { sig, subagents } = await this.signature(s)
        if (!force && this.index.sessions[s.key] === sig) continue
        if (this.stale.delete(s.key)) this.purge(s.key)
        const ok = await this.parseFile(s.filePath, s)
        for (const file of subagents) await this.parseFile(file, s)
        if (s.availability === 'live') await this.archiveSubagents(s, subagents)
        if (ok) {
          this.index.sessions[s.key] = sig
          this.indexDirty = true
        }
        changed = true
        // Let other work (IPC) run between files on big histories.
        await new Promise((r) => setImmediate(r))
      }
    } finally {
      this.parsing = false
    }
    if (changed || force) {
      this.invalidate()
      this.lastUpdated = now()
      this.scheduleSave()
      this.emit('changed')
    }
  }

  private async parseFile(path: string, s: SessionSummary): Promise<boolean> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return false
    }
    const { events } = parseJsonl(text)
    const a = analyzeUsage(events, {
      key: s.key,
      project: s.projectName,
      env: s.env,
      sessionId: s.sessionId,
      file: basename(path)
    })
    for (const r of a.records) {
      // New, or a copy with more tokens (it was still streaming last time).
      const { result, stored, previous } = this.records.add(r)
      if (result === 'duplicate') continue
      this.dirtyMonths.add(storageMonth(stored.ts))
      if (previous) this.dirtyMonths.add(storageMonth(previous.ts))
    }
    for (const t of a.turns) {
      const prev = this.turns.get(t.id)
      if (!prev || JSON.stringify(prev) !== JSON.stringify(t)) {
        if (prev && prev.key !== t.key) continue // copied into a fork: keep the original
        this.turns.set(t.id, t)
        this.dirtyTurnMonths.add(storageMonth(t.ts))
      }
    }
    for (const h of a.limitHits) {
      if (!this.hits.has(h.id)) {
        this.hits.set(h.id, h)
        this.hitsDirty = true
      }
    }
    return true
  }

  /**
   * Copy subagent transcripts into the archive (next to the session's archive
   * copy) when they are new or have grown, so their usage survives cleanup too.
   */
  private async archiveSubagents(s: SessionSummary, files: string[]): Promise<void> {
    if (!s.archivePath || !files.length) return
    const destDir = join(dirname(s.archivePath), s.sessionId, 'subagents')
    if (!isInside(destDir, this.paths.archiveDir)) return
    for (const src of files) {
      const dest = join(destDir, basename(src))
      try {
        const [a, b] = await Promise.all([stat(src), stat(dest).catch(() => undefined)])
        if (b && b.size >= a.size) continue
        assertAppDataWrite(dest, this.paths.dataDir)
        await mkdir(destDir, { recursive: true })
        const tmp = `${dest}.${process.pid}.tmp`
        await copyFile(src, tmp, constants.COPYFILE_FICLONE)
        await rename(tmp, dest).catch(async (err) => {
          await unlink(tmp).catch(() => undefined)
          throw err
        })
      } catch (err) {
        console.warn('could not archive subagent file', src, err)
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flush(), 2000)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const dir = this.paths.usageDir
    const dataDir = this.paths.dataDir
    try {
      if (this.dirtyMonths.size) {
        const months = [...this.dirtyMonths]
        this.dirtyMonths.clear()
        const byMonth = new Map<string, UsageRecord[]>(months.map((m) => [m, []]))
        for (const r of this.records.values()) byMonth.get(storageMonth(r.ts))?.push(r)
        for (const [m, rows] of byMonth) {
          rows.sort((a, b) => a.ts - b.ts)
          await writeNdjson(join(dir, `records-${m}.ndjson`), rows, dataDir)
        }
      }
      if (this.dirtyTurnMonths.size) {
        const months = [...this.dirtyTurnMonths]
        this.dirtyTurnMonths.clear()
        const byMonth = new Map<string, TurnSample[]>(months.map((m) => [m, []]))
        for (const t of this.turns.values()) byMonth.get(storageMonth(t.ts))?.push(t)
        for (const [m, rows] of byMonth) {
          rows.sort((a, b) => a.ts - b.ts)
          await writeNdjson(join(dir, `turns-${m}.ndjson`), rows, dataDir)
        }
      }
      if (this.hitsDirty) {
        this.hitsDirty = false
        await writeNdjson(join(dir, 'limit-hits.ndjson'), this.limitHits(), dataDir)
      }
      if (this.indexDirty) {
        this.indexDirty = false
        await writeFileAtomic(join(dir, 'index.json'), JSON.stringify(this.index), dataDir)
      }
    } catch (err) {
      console.warn('could not save usage data', err)
    }
  }
}
