// Token usage from session logs. Every session (live or archived) is parsed
// once, every API response is counted once (deduped across files with
// ccusage's rules, see shared/usage/dedupe.ts), and the results are kept in the app's data folder as
// monthly NDJSON files, so history survives Claude Code's cleanup and startup
// only parses files that changed.

import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { now } from '@shared/clock'
import { buildReport, breakdown, emptyTotals, addRecord, toCsv } from '@shared/usage/aggregate'
import { UsageDeduper } from '@shared/usage/dedupe'
import { estimateCost, type ModelPrice } from '@shared/usage/pricing'
import { localTimeZone } from '@shared/usage/time'
import {
  buildSpeedTrends,
  speedSignal,
  speedStats,
  type SpeedSignal,
  type SpeedTrendsReport
} from '@shared/usage/speed'
import type { UsageCommandReading } from '@shared/usage/usage-command'
import type {
  LimitHit,
  SessionUsage,
  TurnSample,
  CodexTurnSample,
  UsageAnalysis,
  UsageQuery,
  UsageRecord,
  UsageReport,
  UsageStatus,
  WeekStart
} from '@shared/usage/types'
import type { SessionSummary } from '@shared/types'
import type { CodexLimitReading } from '@shared/usage/codex'
import type { ProviderView } from '@shared/provider'
import { isOwnUsageKey, ownUsageLabel } from '@shared/summary'
import { writeFileAtomic } from '../core/json-store'
import { listFiles, readNdjson, writeNdjson } from '../core/ndjson'
import { assertAppDataWrite, assertRealAppDataWrite, isInside } from '../core/safe-paths'
import { copyShared } from '../core/shared-copy'
import { sessionProvider } from '../providers/registry'
import type { SessionService } from './sessions'
import { CodexUsageStore } from './codex-usage'
import { InProcessParser, type UsageParser } from './usage-parse'
import type { SessionProvider } from '../providers/types'

// 2: dedupe follows ccusage (session-scoped requestless ids, sidechain replays).
// 3: /usage output is read as limit readings (backfill).
// 4: each response's generation time and time to first token (token speed).
const INDEX_VERSION = 4

/** Usage of the app's own runs (session summaries), see addDashboardRecords. */
const DASHBOARD_FILE = 'dashboard-runs.ndjson'

interface IndexFile {
  version: number
  /** Keyed by session key: the signature of what was parsed last. */
  sessions: Record<string, string>
  /**
   * Sessions whose saved records an older parser made and that haven't been
   * read again yet: saved, so a restart in the middle of the re-read still
   * replaces their records (instead of adding to them) when they are read.
   */
  stale?: string[]
}

export interface UsageSettings {
  weekStart: WeekStart
  prices: ModelPrice[]
  /** Codex's own price table (absent: Codex usage is shown without cost). */
  codexPrices?: ModelPrice[]
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

/** How often a scan says what Codex sessions it has read so far (for the limit alerts). */
const CODEX_PROGRESS_MS = 5_000

export class UsageService extends EventEmitter<{ changed: []; 'codex-progress': [] }> {
  private records = new UsageDeduper()
  /** Sessions whose stored records predate the current parser (purged on reparse). */
  private stale = new Set<string>()
  private turns = new Map<string, TurnSample>()
  private hits = new Map<string, LimitHit>()
  private usageCmd = new Map<string, UsageCommandReading>()
  /**
   * The app's own `claude -p` runs (session summaries): they leave no session
   * file, so their usage is recorded here, from the CLI's answer. Kept in
   * their own file, so "Recalculate" (which parses session files again)
   * never loses them.
   */
  private dashboard = new Map<string, UsageRecord>()
  private dashboardDirty = false
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
  /** Codex usage and limits: their own store and files, never mixed into Claude Code's. */
  private codex = new CodexUsageStore()

  constructor(
    private readonly sessions: SessionService,
    private readonly paths: UsagePaths,
    private readonly settings: () => UsageSettings,
    /** Where session files are read and parsed (the app: a worker thread). */
    private readonly parser: UsageParser = new InProcessParser()
  ) {
    super()
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    await this.whenLoaded()
    this.sessions.on('changed', () => this.scheduleSync())
    await this.sync()
  }

  private loading?: Promise<void>

  /** Resolves once the saved usage data is loaded (before the logs are scanned). */
  whenLoaded(): Promise<void> {
    return (this.loading ??= this.load())
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
    this.usageCmd.clear()
    this.codex.clear()
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

  /** Reading the logs (or loading the saved data) right now. */
  get busy(): boolean {
    return this.parsing || !this.loaded
  }

  status(): UsageStatus {
    const codex = this.codex.size
    return {
      records: this.records.size,
      files: Object.keys(this.index.sessions).length,
      parsing: this.parsing || !this.loaded,
      lastUpdated: this.lastUpdated,
      ...(codex ? { codexRecords: codex } : {})
    }
  }

  /** Codex usage, one record per response (forks' copies counted once), sorted by time. */
  codexRecords(): UsageRecord[] {
    return this.codex.records()
  }

  /** Codex plan limit readings from every rollout, sorted by time. */
  /** Codex turns (one per turn, forks' copies counted once), for Codex trends. */
  codexTurns(): CodexTurnSample[] {
    return this.codex.turns()
  }

  codexLimitReadings(): CodexLimitReading[] {
    return this.codex.readings()
  }

  /** Both agents' records, merged (kept until either list changes). */
  private merged?: { claude: UsageRecord[]; codex: UsageRecord[]; list: UsageRecord[] }
  private mergedPrices?: { claude: ModelPrice[]; codex?: ModelPrice[]; list: ModelPrice[] }

  /** Records of one view: Claude Code's (as before), Codex's, or both. */
  recordsOf(view: ProviderView): UsageRecord[] {
    if (view === 'claude') return this.allRecords()
    if (view === 'codex') return this.codexRecords()
    const claude = this.allRecords()
    const codex = this.codexRecords()
    const m = this.merged
    if (m && m.claude === claude && m.codex === codex) return m.list
    const list = [...claude, ...codex].sort((a, b) => a.ts - b.ts)
    this.merged = { claude, codex, list }
    return list
  }

  /** The price table for a view's records (the two tables never share a model id). */
  pricesOf(view: ProviderView): ModelPrice[] {
    const s = this.settings()
    if (view === 'claude') return s.prices
    if (view === 'codex') return s.codexPrices ?? []
    // The same table while neither changes (costs are worked out once per table).
    const m = this.mergedPrices
    if (m && m.claude === s.prices && m.codex === s.codexPrices) return m.list
    const list = [...s.prices, ...(s.codexPrices ?? [])]
    this.mergedPrices = { claude: s.prices, codex: s.codexPrices, list }
    return list
  }

  /** The last answer of a pure calculation, kept while its inputs are the same objects. */
  private memo = new Map<string, { deps: unknown[]; value: unknown }>()

  memoized<T>(name: string, deps: unknown[], make: () => T): T {
    const m = this.memo.get(name)
    if (m && m.deps.length === deps.length && m.deps.every((d, i) => d === deps[i]))
      return m.value as T
    const value = make()
    this.memo.set(name, { deps, value })
    return value
  }

  allRecords(): UsageRecord[] {
    if (!this.cachedList)
      this.cachedList = [...this.records.values(), ...this.dashboard.values()].sort(
        (a, b) => a.ts - b.ts
      )
    return this.cachedList
  }

  /** Record the usage of one of the app's own runs (a session summary, an Ask question). */
  addDashboardRecords(recs: UsageRecord[]): void {
    let added = false
    for (const r of recs) {
      if (!isOwnUsageKey(r.key) || this.dashboard.has(r.id)) continue
      this.dashboard.set(r.id, r)
      added = true
    }
    if (!added) return
    this.dashboardDirty = true
    this.invalidate()
    this.lastUpdated = now()
    this.scheduleSave()
    this.emit('changed')
  }

  /** Sorted turns, kept until a turn changes. */
  private cachedTurns: TurnSample[] | undefined

  allTurns(): TurnSample[] {
    return (this.cachedTurns ??= [...this.turns.values()].sort((a, b) => a.ts - b.ts))
  }

  limitHits(): LimitHit[] {
    return [...this.hits.values()].sort((a, b) => a.ts - b.ts)
  }

  /** Limit readings from /usage output in transcripts (backfill). */
  usageCommandReadings(): UsageCommandReading[] {
    return [...this.usageCmd.values()].sort((a, b) => a.ts - b.ts)
  }

  report(
    query: UsageQuery,
    billingOf?: (key: string) => string,
    sourceOf?: (key: string) => string
  ): UsageReport {
    const s = this.settings()
    const view = query.provider ?? 'claude'
    return buildReport(view === 'claude' ? this.allRecords() : this.recordsOf(view), query, {
      timeZone: localTimeZone(),
      weekStart: s.weekStart,
      prices: this.pricesOf(view),
      now: now(),
      loading:
        !this.loaded ||
        (this.parsing && (view === 'codex' ? this.codex.size : this.records.size) === 0),
      ...(view === 'all' ? { byProvider: true } : {}),
      billingOf,
      sourceOf,
      sessionLabel: (key) => {
        const own = ownUsageLabel(key)
        if (own) return { label: own, detail: 'claude -p' }
        const ses = this.sessions.get(key)
        return ses ? { label: ses.title, detail: ses.projectName } : undefined
      }
    })
  }

  sessionUsage(key: string): SessionUsage {
    const s = this.settings()
    const view: ProviderView = this.codex.has(key) ? 'codex' : 'claude'
    const prices = this.pricesOf(view)
    const recs = this.recordsOf(view).filter((r) => r.key === key)
    const totals = emptyTotals()
    for (const r of recs) addRecord(totals, r, estimateCost(r, prices))
    return {
      key,
      ...totals,
      byModel: breakdown(recs, 'model', {
        timeZone: localTimeZone(),
        weekStart: s.weekStart,
        prices,
        now: now()
      }),
      firstAt: recs[0]?.ts,
      lastAt: recs[recs.length - 1]?.ts,
      speed: speedStats(
        recs,
        view === 'codex' ? this.codexTurns().filter((t) => t.key === key) : undefined
      )
    }
  }

  /** Weekly output speed per model, Claude Code's and Codex's together. */
  speedTrends(): SpeedTrendsReport {
    const records = this.recordsOf('all')
    const timeZone = localTimeZone()
    const weekStart = this.settings().weekStart
    return this.memoized('speedTrends', [records, timeZone, weekStart], () =>
      buildSpeedTrends({ records, timeZone, weekStart })
    )
  }

  /** Recent output speed against the weeks before (limit health's extra signal). */
  speedSignal(view: ProviderView): SpeedSignal {
    return speedSignal(this.recordsOf(view), now())
  }

  csv(query: UsageQuery, perRecord: boolean): string {
    const view = query.provider ?? 'claude'
    const recs = this.recordsOf(view).filter(
      (r) =>
        (query.from === undefined || r.ts >= query.from) &&
        (query.to === undefined || r.ts < query.to) &&
        (!query.models?.length || query.models.includes(r.model))
    )
    return toCsv(recs, { timeZone: localTimeZone(), prices: this.pricesOf(view) }, perRecord)
  }

  // ---------------------------------------------------------------- private

  private invalidate(): void {
    this.cachedList = undefined
    this.cachedTurns = undefined
  }

  private async load(): Promise<void> {
    const dir = this.paths.usageDir
    let current = true
    try {
      const idx = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as IndexFile
      if (idx.version === INDEX_VERSION && idx.sessions) {
        this.index = { version: idx.version, sessions: idx.sessions }
        // A re-read that a restart interrupted: those sessions are still stale.
        if (Array.isArray(idx.stale))
          for (const k of idx.stale) if (typeof k === 'string') this.stale.add(k)
      } else current = false
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
    if (!current) {
      for (const r of loaded) this.stale.add(r.key)
      // Save the list with the new version at once (see IndexFile.stale).
      this.indexDirty = true
    }
    for (const f of await listFiles(dir, /^turns-\d{4}-\d{2}\.ndjson$/)) {
      for (const t of await readNdjson<TurnSample>(join(dir, f))) {
        if (t && typeof t.id === 'string' && typeof t.ts === 'number') this.turns.set(t.id, t)
      }
    }
    for (const h of await readNdjson<LimitHit>(join(dir, 'limit-hits.ndjson'))) {
      if (h && typeof h.id === 'string') this.hits.set(h.id, h)
    }
    for (const r of await readNdjson<UsageCommandReading>(join(dir, 'usage-readings.ndjson'))) {
      if (r && typeof r.id === 'string' && typeof r.ts === 'number') this.usageCmd.set(r.id, r)
    }
    for (const r of await readNdjson<UsageRecord>(join(dir, DASHBOARD_FILE))) {
      if (r && typeof r.id === 'string' && typeof r.ts === 'number' && isOwnUsageKey(r.key))
        this.dashboard.set(r.id, r)
    }
    await this.codex.load(dir)
    this.loaded = true
    this.invalidate()
    // A view that asked while loading showed "loading": the saved data is here
    // (the scan after it says nothing when no file changed).
    this.emit('changed')
  }

  private purge(key: string): void {
    for (const r of [...this.records.values()]) {
      if (r.key !== key) continue
      this.records.remove(r.id)
      this.dirtyMonths.add(storageMonth(r.ts))
    }
  }

  private async signature(s: SessionSummary): Promise<{ sig: string; subagents: string[] }> {
    // More files with this session's usage (Claude Code: its subagents' transcripts).
    const subs = await sessionProvider(this.sessions, s).usage.extraFiles(s)
    const sig = [`${s.filePath}|${s.sizeBytes}|${s.lastActivityAt ?? ''}`]
    for (const f of subs) sig.push(`${basename(f.path)}:${f.size}`)
    return { sig: sig.join(';'), subagents: subs.map((f) => f.path) }
  }

  private async syncNow(force: boolean): Promise<void> {
    if (!this.loaded) await this.whenLoaded()
    const list = this.sessions.list()
    if (!list.length) return
    this.parsing = true
    let changed = false
    try {
      // Codex first, the most recently active first: a session running now
      // (whose limits may just have crossed an alert line) is read within
      // seconds, also on a long re-read after an update. Each step of the way
      // is announced (at most every few seconds) for those alerts.
      const codex = list
        .filter(
          (s) =>
            s.availability !== 'imported' &&
            sessionProvider(this.sessions, s).id === 'codex' &&
            sessionProvider(this.sessions, s).capabilities.usage
        )
        .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
      if (codex.length) {
        // The catalogue's links added to the saved ones (a fork whose
        // rollout is gone still descends from its parent).
        this.codex.setLineage(list.filter((x) => x.provider === 'codex'))
        const roots = this.codex.roots()
        // At once for the first session read, then at most every few seconds;
        // what was read within that time is told when it's over or when the
        // Codex sessions are done, whichever comes first (never only after
        // the Claude Code scan).
        let told = 0
        let later: NodeJS.Timeout | undefined
        const tell = () => {
          if (later) clearTimeout(later)
          later = undefined
          told = Date.now()
          this.emit('codex-progress')
        }
        try {
          for (const s of codex) {
            const provider = sessionProvider(this.sessions, s)
            if (!(await this.syncCodex(s, provider, roots.get(s.sessionId) ?? s.sessionId, force)))
              continue
            changed = true
            const wait = told + CODEX_PROGRESS_MS - Date.now()
            if (wait <= 0) tell()
            else later ??= setTimeout(tell, wait)
          }
        } finally {
          if (later) tell()
        }
      }
      for (const s of list) {
        // Imported claude.ai conversations have no token usage.
        if (s.availability === 'imported') continue
        const provider = sessionProvider(this.sessions, s)
        if (!provider.capabilities.usage || provider.id === 'codex') continue
        const { sig, subagents } = await this.signature(s)
        if (!force && this.index.sessions[s.key] === sig) continue
        // Read everything first: a session's saved records (stale after a
        // parser update) are replaced only once all its files were read, so
        // a file that can't be read right now never loses saved usage. The
        // session counts as read (its signature saved) only then too, so an
        // unreadable file (the main one or a subagent's) is tried again at
        // the next sync.
        const main = await this.readUsage(s.filePath, s)
        const subs = await Promise.all(subagents.map((f) => this.readUsage(f, s)))
        const ok = main !== undefined && subs.every((a) => a !== undefined)
        if (ok && this.stale.delete(s.key)) {
          this.purge(s.key)
          this.indexDirty = true
        }
        if (main) this.apply(main)
        for (const a of subs) if (a) this.apply(a)
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

  /** Parse one Codex session if its file (or its lineage) changed. */
  private async syncCodex(
    s: SessionSummary,
    provider: SessionProvider,
    root: string,
    force: boolean
  ): Promise<boolean> {
    const sig = [s.filePath, s.sizeBytes, s.lastActivityAt ?? '', root].join('|')
    if (!force && this.codex.index[s.key] === sig) return false
    const ctx = {
      key: s.key,
      project: s.projectName,
      env: s.env,
      sessionId: s.sessionId,
      file: basename(s.filePath),
      lineageRoot: root,
      source: s.sourceId,
      ...(s.version ? { version: s.version } : {})
    }
    let a: UsageAnalysis | undefined
    if (provider.id === 'codex') {
      // Read and parsed off this thread (the app's parser is a worker).
      a = await this.parser.parse({ provider: 'codex', path: s.filePath, ctx })
      if (!a) return false
    } else {
      let text: string
      try {
        text = provider.usage.readText
          ? await provider.usage.readText(s.filePath)
          : await readFile(s.filePath, 'utf8')
      } catch {
        return false
      }
      a = provider.usage.analyze(text, ctx)
    }
    this.codex.set(s.key, a.records, a.codexLimits ?? [], sig, a.codexTurns ?? [])
    // Let other work (IPC) run between files on big histories.
    await new Promise((r) => setImmediate(r))
    return true
  }

  /** Read and analyze one file of a session (nothing is changed yet); undefined if unreadable. */
  private async readUsage(path: string, s: SessionSummary): Promise<UsageAnalysis | undefined> {
    const provider = sessionProvider(this.sessions, s)
    if (provider.id === 'claude')
      return this.parser.parse({
        provider: 'claude',
        path,
        ctx: {
          key: s.key,
          project: s.projectName,
          env: s.env,
          sessionId: s.sessionId,
          file: basename(path)
        }
      })
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return undefined
    }
    return sessionProvider(this.sessions, s).usage.analyze(text, {
      key: s.key,
      project: s.projectName,
      env: s.env,
      sessionId: s.sessionId,
      file: basename(path)
    })
  }

  private apply(a: UsageAnalysis): void {
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
        this.cachedTurns = undefined
        this.dirtyTurnMonths.add(storageMonth(t.ts))
      }
    }
    for (const h of a.limitHits) {
      if (!this.hits.has(h.id)) {
        this.hits.set(h.id, h)
        this.hitsDirty = true
      }
    }
    for (const r of a.usageReadings) {
      if (!this.usageCmd.has(r.id)) {
        this.usageCmd.set(r.id, r)
        this.hitsDirty = true
      }
    }
  }

  /**
   * Copy subagent transcripts into the archive (next to the session's archive
   * copy) when they are new or have grown, so their usage survives cleanup too.
   */
  private async archiveSubagents(s: SessionSummary, files: string[]): Promise<void> {
    if (!s.archivePath || !files.length) return
    const destDir = sessionProvider(this.sessions, s).usage.extrasArchiveDir(
      s.archivePath,
      s.sessionId
    )
    if (!isInside(destDir, this.paths.archiveDir)) return
    for (const src of files) {
      const dest = join(destDir, basename(src))
      try {
        const [a, b] = await Promise.all([stat(src), stat(dest).catch(() => undefined)])
        if (b && b.size >= a.size) continue
        assertAppDataWrite(dest, this.paths.dataDir)
        await assertRealAppDataWrite(dest, this.paths.dataDir)
        await mkdir(destDir, { recursive: true })
        const tmp = `${dest}.${process.pid}.tmp`
        // Subagent logs are written while a session runs: don't lock them.
        await copyShared(src, tmp)
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
        await writeNdjson(join(dir, 'usage-readings.ndjson'), this.usageCommandReadings(), dataDir)
      }
      if (this.dashboardDirty) {
        this.dashboardDirty = false
        const rows = [...this.dashboard.values()].sort((a, b) => a.ts - b.ts)
        await writeNdjson(join(dir, DASHBOARD_FILE), rows, dataDir)
      }
      if (this.indexDirty) {
        this.indexDirty = false
        const index: IndexFile = { ...this.index, stale: [...this.stale].sort() }
        await writeFileAtomic(join(dir, 'index.json'), JSON.stringify(index), dataDir)
      }
      await this.codex.flush(dir, dataDir)
    } catch (err) {
      console.warn('could not save usage data', err)
    }
  }
}
