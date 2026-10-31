// The session catalogue: scans sources, parses files, keeps the search index
// and the archive up to date, and serves summaries/details to the renderer.
//
// Reads only. The only writes go to the app's data folder (archive, metadata).

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { analyzeEvents, buildMessages, isUuid, parseJsonl } from '@shared/jsonl'
import { now } from '@shared/clock'
import { baseName } from '@shared/format'
import { computeTitle } from '@shared/title'
import type { SessionLineage } from '@shared/lineage'
import { detectSource, type DetectedSource } from '@shared/source-label'
import { askQuestionOf } from '@shared/ask'
import type {
  ArchiveRecord,
  Availability,
  BranchRecord,
  SessionDetail,
  SessionMeta,
  SessionsPayload,
  SessionSummary,
  ScanState,
  SourceInfo
} from '@shared/types'
import type { SearchHit } from '@shared/api'
import type { SessionBilling } from '@shared/usage/credits'
import { archiveSession } from '../core/archive'
import { writeFileAtomic, type JsonStore } from '../core/json-store'
import { isInside } from '../core/safe-paths'
import type { Platform } from '../platform'
import { SearchIndex } from './search'
import { detectSources, type ResolvedSource } from './sources'
import { cleanMetaPatch, type AppPaths, type MetadataFile, type SettingsFile } from './store'

type BaseSummary = Omit<
  SessionSummary,
  'meta' | 'title' | 'titleSource' | 'billing' | 'lineage' | 'source' | 'sourceReason'
>

// v2: lineage fields (firstUuid, forkedFrom, copiedFrom) and, separately,
// source hints (entrypoint, IDE context, cloud link) for the source label.
// v3: both together, so neither kind of v2 cache is reused.
// v4: the Remote Control link (remoteUrl) from `bridge_status` entries.
// v5: statuses copied into a branch no longer count as the branch's own link.
// v6: the name given in Claude Code (custom-title / agent-name) and ai-title.
const CACHE_VERSION = 6

interface CacheFile {
  version: number
  entries: Entry[]
  search: string
}

interface Entry {
  base: BaseSummary
  size: number
  mtimeMs: number
  /** Imported entries: the archive copy's SHA-256, to notice any re-import. */
  rev?: string
}

interface FileInfo {
  path: string
  projectDir: string
  sessionId: string
  size: number
  mtimeMs: number
}

const SESSION_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.jsonl$/i

/** What an imported entry was loaded from: reloaded when either changes. */
const importRev = (rec: ArchiveRecord): string => `${rec.sha256}|${rec.archivePath}`

/** Lists `<projectsDir>/<project>/<session>.jsonl`. Undefined if the folder can't be read. */
export async function listSessionFiles(projectsDir: string): Promise<FileInfo[] | undefined> {
  const out: FileInfo[] = []
  let projects
  try {
    projects = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const dir = join(projectsDir, p.name)
    let files
    try {
      files = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !SESSION_FILE_RE.test(f.name)) continue
      const path = join(dir, f.name)
      try {
        const st = await stat(path)
        out.push({
          path,
          projectDir: p.name,
          sessionId: f.name.slice(0, -6),
          size: st.size,
          mtimeMs: st.mtimeMs
        })
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  })
  await Promise.all(workers)
}

export function parseSessionText(
  text: string,
  file: { path: string; projectDir: string; sessionId: string; size: number },
  src: Pick<SourceInfo, 'id' | 'label' | 'env' | 'distro'>
): { base: BaseSummary; searchText: string } {
  const { events, malformedLines } = parseJsonl(text)
  const a = analyzeEvents(events, { sessionId: file.sessionId })
  return {
    searchText: a.searchText,
    base: {
      key: `${src.id}:${file.sessionId}`,
      sessionId: file.sessionId,
      sourceId: src.id,
      sourceLabel: src.label,
      env: src.env,
      distro: src.distro,
      filePath: file.path,
      originalPath: file.path,
      availability: 'live',
      projectDir: file.projectDir,
      projectName: baseName(a.cwd) || file.projectDir,
      cwd: a.cwd,
      gitBranch: a.gitBranch,
      version: a.version,
      summary: a.summary,
      claudeName: a.claudeName,
      claudeNameAt: a.claudeNameAt,
      firstPrompt: a.firstPrompt,
      startedAt: a.startedAt,
      lastActivityAt: a.lastActivityAt,
      messageCount: a.userMessageCount + a.assistantMessageCount,
      userMessageCount: a.userMessageCount,
      assistantMessageCount: a.assistantMessageCount,
      toolCallCount: a.toolCallCount,
      malformedLines,
      sizeBytes: file.size,
      models: a.models,
      firstUuid: a.firstUuid,
      forkedFrom: a.forkedFrom,
      copiedFrom:
        a.sessionId && a.sessionId !== file.sessionId && isUuid(a.sessionId)
          ? a.sessionId
          : undefined,
      sourceHints: a.sourceHints,
      remoteUrl: a.remoteUrl,
      remoteUrlAt: a.remoteUrlAt
    }
  }
}

export class SessionService extends EventEmitter<{ changed: [] }> {
  sources: ResolvedSource[] = []
  private entries = new Map<string, Entry>()
  private search = new SearchIndex()
  private scan: ScanState = { phase: 'idle', done: 0, total: 0 }
  private archiveQueue: Promise<void> = Promise.resolve()
  private syncing = new Map<string, Promise<void>>()
  private emitTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly platform: Platform,
    private readonly paths: AppPaths,
    private readonly metadata: JsonStore<MetadataFile>,
    private readonly settings: JsonStore<SettingsFile>
  ) {
    super()
  }

  // ---------------------------------------------------------------- public

  payload(): SessionsPayload {
    return {
      sessions: this.list(),
      sources: this.sources.map(publicSource),
      scan: { ...this.scan }
    }
  }

  list(): SessionSummary[] {
    return [...this.entries.values()].map((e) => this.withMeta(e.base))
  }

  get(key: string): SessionSummary | undefined {
    const e = this.entries.get(key)
    return e ? this.withMeta(e.base) : undefined
  }

  source(id: string): ResolvedSource | undefined {
    return this.sources.find((s) => s.id === id)
  }

  archiveRecord(key: string): ArchiveRecord | undefined {
    return this.metadata.value.archive[key]
  }

  searchKeys(query: string): SearchHit[] {
    return this.search.search(query)
  }

  async detail(key: string): Promise<SessionDetail | null> {
    const e = this.entries.get(key)
    if (!e) return null
    let text: string
    try {
      text = await readFile(e.base.filePath, 'utf8')
    } catch {
      return null
    }
    const { events } = parseJsonl(text)
    return { summary: this.withMeta(e.base), messages: buildMessages(events, e.base.cwd) }
  }

  updateMeta(key: string, patch: Partial<SessionMeta>): SessionSummary | null {
    const e = this.entries.get(key)
    if (!e) return null
    const clean = cleanMetaPatch(patch)
    this.metadata.update((d) => {
      const prev = d.sessions[e.base.sessionId] ?? {}
      const at = new Date().toISOString()
      const next: SessionMeta = { ...prev, ...clean, updatedAt: at }
      // When I named it here, to compare with a later rename in Claude Code.
      if ('name' in clean) next.nameAt = clean.name ? at : undefined
      for (const k of Object.keys(next) as (keyof SessionMeta)[]) {
        const v = next[k]
        if (v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0))
          delete next[k]
      }
      d.sessions[e.base.sessionId] = next
    })
    void this.reindex(key)
    this.emitChanged()
    return this.get(key) ?? null
  }

  async start(): Promise<void> {
    this.backfillNameTimes()
    await this.loadCache()
    await this.rescan()
    this.cached.clear()
    await this.saveCache()
  }

  /**
   * "Use name from Claude Code": clear my dashboard names, so the names given
   * in Claude Code show. Sessions without a Claude Code name keep mine.
   * Returns how many changed.
   */
  applyClaudeNames(keys: string[]): number {
    let n = 0
    for (const key of new Set(keys)) {
      const e = this.entries.get(key)
      if (!e?.base.claudeName || !this.metadata.value.sessions[e.base.sessionId]?.name) continue
      this.updateMeta(key, { name: '' })
      n++
    }
    return n
  }

  /**
   * The first run that reads names from Claude Code: names I set in the
   * dashboard before then get that time, so they keep winning over the names
   * already in Claude's files, and only a later rename in Claude Code replaces
   * them. Sessions I never named show their Claude Code name right away.
   */
  private backfillNameTimes(): void {
    if (this.metadata.value.claudeNamesSince) return
    const at = new Date().toISOString()
    this.metadata.update((d) => {
      for (const m of Object.values(d.sessions)) if (m.name?.trim() && !m.nameAt) m.nameAt = at
      d.claudeNamesSince = at
    })
  }

  // ------------------------------------------------------------ startup cache
  //
  // Parsing every session on each start is slow for large histories, so the
  // summaries and the search index are cached in the app's data folder and
  // reused for files whose size and mtime haven't changed.

  private cached = new Map<string, Entry>()
  private cacheDirty = false
  private cacheTimer: NodeJS.Timeout | undefined

  private get cacheFile(): string {
    return join(this.paths.dataDir, 'cache', `sessions-v${CACHE_VERSION}.json`)
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, 'utf8')) as CacheFile
      if (raw.version !== CACHE_VERSION || !this.search.load(raw.search)) return
      for (const e of raw.entries) this.cached.set(e.base.key, e)
    } catch {
      // No cache yet, or unreadable: do a full scan.
    }
  }

  async saveCache(): Promise<void> {
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = undefined
    this.cacheDirty = false
    const entries = [...this.entries.values()].filter((e) => e.base.availability === 'live')
    const data: CacheFile = { version: CACHE_VERSION, entries, search: this.search.toJSON() }
    try {
      await writeFileAtomic(this.cacheFile, JSON.stringify(data), this.paths.dataDir)
    } catch (err) {
      console.warn('could not write cache', err)
    }
  }

  private markCacheDirty(): void {
    this.cacheDirty = true
    if (!this.cacheTimer && this.scan.phase === 'ready') {
      this.cacheTimer = setTimeout(() => void this.saveCache(), 30_000)
    }
  }

  private async detect(): Promise<ResolvedSource[]> {
    const s = this.settings.value
    const detected = await detectSources(this.platform, {
      extraFolders: s.extraFolders,
      scanStoppedDistros: s.scanStoppedDistros
    })
    // Drop duplicates (e.g. an extra folder that is also auto-detected) and
    // anything inside the app's own data folder.
    const seen = new Set<string>()
    return detected.filter((src) => {
      const k = src.projectsDir.toLowerCase()
      if (seen.has(k) || isInside(src.projectsDir, this.paths.dataDir)) return false
      seen.add(k)
      return true
    })
  }

  /**
   * Sources are detected once per rescan. A WSL distro that wasn't running when
   * the app started (it often starts at login, before WSL) or that stopped
   * later stays "not running"/"unreadable" until something rescans, and only
   * readable sources are watched. So while any source isn't readable, the
   * watcher calls this now and then: it detects again and rescans if any
   * source's status changed. Returns true if it rescanned.
   */
  async recheckSources(): Promise<boolean> {
    if (this.scan.phase === 'scanning') return false
    const sig = (list: ResolvedSource[]): string =>
      list
        .map((x) => `${x.id}=${x.status}`)
        .sort()
        .join('|')
    if (sig(await this.detect()) === sig(this.sources)) return false
    await this.rescan()
    return true
  }

  private rescans: Promise<void> = Promise.resolve()

  /**
   * Re-detect sources and sync every one of them. Rescans run one at a time
   * (an automatic re-check can meet a manual one).
   */
  rescan(): Promise<void> {
    const run = this.rescans.then(
      () => this.rescanNow(),
      () => this.rescanNow()
    )
    this.rescans = run.catch(() => undefined)
    return run
  }

  private async rescanNow(): Promise<void> {
    this.sources = await this.detect()
    const files = new Map<string, FileInfo[]>()
    for (const src of this.sources) {
      if (src.status !== 'ok') continue
      const list = await listSessionFiles(src.projectsDir)
      if (list) files.set(src.id, list)
      else Object.assign(src, { status: 'unreadable', statusMessage: "Folder can't be read" })
    }
    const total = [...files.values()].reduce((n, f) => n + f.length, 0)
    this.scan = { phase: 'scanning', done: 0, total }
    this.emitChanged()
    for (const src of this.sources) {
      if (src.status === 'ok') await this.syncSource(src, files.get(src.id) ?? [], true)
    }
    await this.syncArchiveOnly()
    this.dropUnknownSources()
    // Drop index entries (e.g. from the cache) for sessions that no longer exist.
    for (const key of this.cached.keys()) if (!this.entries.has(key)) this.search.remove(key)
    this.scan = { phase: 'ready', done: total, total, finishedAt: now() }
    this.emitChanged(true)
  }

  /** Cheap re-check of one source: list + stat, parse only what changed. */
  async pollSource(sourceId: string): Promise<void> {
    const src = this.source(sourceId)
    if (!src || src.status !== 'ok') return
    const list = await listSessionFiles(src.projectsDir)
    if (!list) {
      // e.g. the WSL distro was shut down: show archive copies instead.
      Object.assign(src, { status: 'unreadable', statusMessage: "Can't be read right now" })
    } else {
      await this.syncSource(src, list, false)
    }
    await this.syncArchiveOnly()
    if (!list) this.emitChanged()
  }

  /** Called by the watcher for a single file event. */
  async fileChanged(sourceId: string, path: string): Promise<void> {
    const src = this.source(sourceId)
    if (!src || src.status !== 'ok') return
    const name = basename(path)
    if (!SESSION_FILE_RE.test(name)) return
    const key = `${src.id}:${name.slice(0, -6)}`
    let st
    try {
      st = await stat(path)
    } catch {
      await this.originalGone(key)
      return
    }
    await this.loadFile(src, {
      path,
      projectDir: basename(join(path, '..')),
      sessionId: name.slice(0, -6),
      size: st.size,
      mtimeMs: st.mtimeMs
    })
    this.emitChanged()
  }

  /** Wait for pending archive copies and save the cache (used on quit and in tests). */
  async idle(): Promise<void> {
    await this.archiveQueue
    if (this.cacheDirty) await this.saveCache()
  }

  // --------------------------------------------------------------- private

  /** Resolves billing for a session (set by the app: tags + bridge inference). */
  billingResolver?: (sessionId: string, meta: SessionMeta) => SessionBilling | undefined
  /** Resolves where a session was branched from (set by the lineage service). */
  lineageResolver?: (key: string) => SessionLineage | undefined

  private detectSource(base: BaseSummary): DetectedSource {
    const meta = this.metadata.value.sessions[base.sessionId] ?? {}
    return detectSource(base.sourceHints, {
      env: base.env,
      cwd: base.cwd,
      sourceUser: this.source(base.sourceId)?.user,
      firstPrompt: base.firstPrompt,
      launchedByApp: meta.billing?.source === 'launch',
      imported: base.availability === 'imported'
    })
  }

  private withMeta(base: BaseSummary): SessionSummary {
    const meta = this.metadata.value.sessions[base.sessionId] ?? {}
    const manual = meta.source?.by === 'manual' ? meta.source : undefined
    const det = manual ? undefined : this.detectSource(base)
    const title = computeTitle(
      meta,
      { name: base.claudeName, at: base.claudeNameAt },
      base.summary,
      base.firstPrompt
    )
    // The dashboard's own Ask Claude runs: title them by the question.
    const asked = title.titleSource === 'first-prompt' ? askQuestionOf(base.firstPrompt) : undefined
    if (asked) title.title = `Ask Claude: ${asked}`
    return {
      ...base,
      meta,
      ...title,
      billing: this.billingResolver?.(base.sessionId, meta),
      source: manual?.label ?? det!.label,
      sourceReason: manual ? 'Set by hand' : det!.reason,
      lineage: this.lineageResolver?.(base.key)
    }
  }

  /** Keep the detected label in the app's metadata (never in Claude's files). */
  private rememberSource(base: BaseSummary): void {
    const meta = this.metadata.value.sessions[base.sessionId]
    if (meta?.source?.by === 'manual') return
    const det = this.detectSource(base)
    if (meta?.source?.label === det.label && meta.source.reason === det.reason) return
    this.metadata.update((d) => {
      d.sessions[base.sessionId] = {
        ...(d.sessions[base.sessionId] ?? {}),
        source: { label: det.label, by: 'auto', reason: det.reason }
      }
    })
  }

  /**
   * Record a branch made from the app (in the app's metadata only) and give it
   * a default name if it has none.
   */
  recordBranch(
    sessionId: string,
    branch: BranchRecord,
    name?: string,
    /** The parent's own model / effort choice, kept by the branch. */
    inherit: Pick<SessionMeta, 'model' | 'effort'> = {}
  ): void {
    const kept = cleanMetaPatch(inherit)
    this.metadata.update((d) => {
      const prev = d.sessions[sessionId] ?? {}
      d.sessions[sessionId] = {
        ...prev,
        branch,
        ...(name && !prev.name ? { name, nameAt: new Date().toISOString() } : {}),
        ...(kept.model && !prev.model ? { model: kept.model } : {}),
        ...(kept.effort && !prev.effort ? { effort: kept.effort } : {}),
        updatedAt: new Date().toISOString()
      }
    })
    for (const e of this.entries.values())
      if (e.base.sessionId === sessionId) void this.reindex(e.base.key)
    this.emitChanged()
  }

  /** Load a file the app just created, and return its summary. */
  async loadNew(sourceId: string, path: string): Promise<SessionSummary | undefined> {
    await this.fileChanged(sourceId, path)
    return this.get(`${sourceId}:${basename(path).slice(0, -6)}`)
  }

  /** Tell the renderer that derived fields (e.g. billing) changed. */
  touch(): void {
    this.emitChanged()
  }

  /** Tag a session's billing (from a launch), without touching Claude's files. */
  tagBilling(sessionId: string, billing: NonNullable<SessionMeta['billing']>): void {
    this.metadata.update((d) => {
      d.sessions[sessionId] = { ...(d.sessions[sessionId] ?? {}), billing }
    })
    this.emitChanged()
  }

  /** Mark a session as launched with Remote Control (the app's metadata only). */
  tagRemote(sessionId: string, remote: NonNullable<SessionMeta['remote']>): void {
    this.metadata.update((d) => {
      d.sessions[sessionId] = { ...(d.sessions[sessionId] ?? {}), remote }
    })
    this.emitChanged()
  }

  private emitChanged(now = false): void {
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      this.emitTimer = undefined
      this.emit('changed')
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.emit('changed')
    }, 120)
  }

  private async syncSource(
    src: ResolvedSource,
    files: FileInfo[],
    initial: boolean
  ): Promise<void> {
    // Serialise syncs per source.
    const prev = this.syncing.get(src.id) ?? Promise.resolve()
    const run = prev.then(async () => {
      const present = new Set(files.map((f) => `${src.id}:${f.sessionId}`))
      await mapLimit(files, 6, async (f) => {
        await this.loadFile(src, f)
        if (initial) {
          this.scan.done++
          this.emitChanged()
        }
      })
      for (const [key, e] of this.entries) {
        if (e.base.sourceId === src.id && e.base.availability === 'live' && !present.has(key)) {
          await this.originalGone(key)
        }
      }
      src.sessionCount = files.length
    })
    this.syncing.set(
      src.id,
      run.catch(() => undefined)
    )
    await run
  }

  private async loadFile(src: ResolvedSource, f: FileInfo): Promise<void> {
    const key = `${src.id}:${f.sessionId}`
    const existing = this.entries.get(key)
    if (
      existing &&
      existing.base.availability === 'live' &&
      existing.size === f.size &&
      existing.mtimeMs === f.mtimeMs
    ) {
      return
    }
    const record = this.metadata.value.archive[key]
    const cached = this.cached.get(key)
    if (
      !existing &&
      cached &&
      cached.size === f.size &&
      cached.mtimeMs === f.mtimeMs &&
      cached.base.filePath === f.path &&
      this.search.has(key)
    ) {
      // Unchanged since the last run: reuse the cached summary and index entry.
      const base = {
        ...cached.base,
        sourceLabel: src.label,
        archivePath: record?.archivePath ?? cached.base.archivePath
      }
      this.entries.set(key, { base, size: f.size, mtimeMs: f.mtimeMs })
      this.queueArchive(src, base)
      return
    }
    let text: string
    try {
      text = await readFile(f.path, 'utf8')
    } catch {
      return
    }
    const { base, searchText } = parseSessionText(text, f, src)
    if (record) base.archivePath = record.archivePath
    this.entries.set(key, { base, size: f.size, mtimeMs: f.mtimeMs })
    this.index(base, searchText)
    this.queueArchive(src, base)
  }

  private queueArchive(src: ResolvedSource, base: BaseSummary): void {
    this.archiveQueue = this.archiveQueue.then(async () => {
      try {
        const key = base.key
        const rec = await archiveSession(
          {
            sessionId: base.sessionId,
            sourceId: src.id,
            sourceLabel: src.label,
            env: src.env,
            distro: src.distro,
            originalPath: base.originalPath,
            cwd: base.cwd
          },
          this.metadata.value.archive[key],
          this.paths.archiveDir,
          this.paths.dataDir
        )
        if (rec) {
          this.metadata.update((d) => {
            d.archive[key] = rec
          })
          const e = this.entries.get(key)
          if (e) e.base.archivePath = rec.archivePath
        }
      } catch (err) {
        console.warn('archive failed', base.originalPath, err)
      }
    })
  }

  /** The original file is gone: fall back to the archive copy, if any. */
  private async originalGone(key: string): Promise<void> {
    const rec = this.metadata.value.archive[key]
    if (!rec) {
      this.entries.delete(key)
      this.search.remove(key)
      this.markCacheDirty()
      this.emitChanged()
      return
    }
    await this.loadArchived(rec, 'archived-only')
    this.emitChanged()
  }

  /** Make sure every archive record has an entry (archived-only or source-offline). */
  private async syncArchiveOnly(): Promise<void> {
    for (const [key, rec] of Object.entries(this.metadata.value.archive)) {
      const e = this.entries.get(key)
      const src = this.source(rec.sourceId)
      let availability: Availability
      if (rec.origin === 'claude-ai') {
        if (e && e.rev === importRev(rec)) continue
        await this.loadArchived(rec, 'imported')
        continue
      }
      if (src?.status === 'ok') {
        // The source was scanned and the file wasn't there.
        if (e?.base.availability === 'live') continue
        availability = 'archived-only'
      } else if (src) {
        availability = 'source-offline'
      } else {
        // The source is no longer configured (e.g. a removed extra folder).
        if (e?.base.availability === 'live') continue
        availability = (await this.platform.pathExists(rec.originalPath))
          ? 'source-offline'
          : 'archived-only'
      }
      if (e && e.base.availability === availability) continue
      await this.loadArchived(rec, availability)
    }
  }

  private async loadArchived(rec: ArchiveRecord, availability: Availability): Promise<void> {
    let text: string
    const imported = availability === 'imported'
    try {
      text = await readFile(rec.archivePath, 'utf8')
    } catch {
      if (imported) this.dropEntry(`${rec.sourceId}:${rec.sessionId}`)
      return
    }
    // An imported conversation's file must hold what was imported (archives
    // from before collision-proof names may hold another conversation).
    if (imported && createHash('sha256').update(text).digest('hex') !== rec.sha256) {
      console.warn('archive copy does not match its conversation', rec.archivePath)
      this.dropEntry(`${rec.sourceId}:${rec.sessionId}`)
      return
    }
    const size = Buffer.byteLength(text)
    const src = this.source(rec.sourceId) ?? {
      id: rec.sourceId,
      label: rec.sourceLabel,
      env: rec.env,
      distro: rec.distro
    }
    const { base, searchText } = parseSessionText(
      text,
      {
        path: rec.archivePath,
        projectDir: basename(join(rec.originalPath, '..')),
        sessionId: rec.sessionId,
        size
      },
      src
    )
    base.originalPath = rec.originalPath
    base.archivePath = rec.archivePath
    base.availability = availability
    base.cwd = base.cwd ?? rec.cwd
    if (availability === 'imported') {
      base.projectDir = 'claude.ai'
      base.projectName = 'claude.ai'
    }
    // Imported entries remember their content hash and file: a re-import can
    // change the text without changing the size, or move it to another file.
    this.entries.set(base.key, {
      base,
      size,
      mtimeMs: 0,
      ...(imported ? { rev: importRev(rec) } : {})
    })
    this.index(base, searchText)
  }

  private dropEntry(key: string): void {
    if (!this.entries.delete(key)) return
    this.search.remove(key)
    this.markCacheDirty()
  }

  /** Pick up archive records added by an import. */
  async refreshArchive(): Promise<void> {
    await this.syncArchiveOnly()
    this.emitChanged(true)
  }

  /** Remove entries whose source is no longer configured and has no archive copy. */
  private dropUnknownSources(): void {
    const ids = new Set(this.sources.map((s) => s.id))
    for (const [key, e] of this.entries) {
      if (!ids.has(e.base.sourceId) && !this.metadata.value.archive[key]) {
        this.entries.delete(key)
        this.search.remove(key)
      }
    }
  }

  private index(base: BaseSummary, searchText: string): void {
    this.markCacheDirty()
    this.rememberSource(base)
    const s = this.withMeta(base)
    this.search.upsert({
      id: base.key,
      title: s.title,
      name: [s.meta.name, base.claudeName].filter(Boolean).join(' '),
      description: s.meta.description ?? '',
      tags: (s.meta.tags ?? []).join(' '),
      project: `${base.projectName} ${base.cwd ?? ''} ${base.gitBranch ?? ''}`,
      text: searchText
    })
  }

  private async reindex(key: string): Promise<void> {
    const e = this.entries.get(key)
    if (!e) return
    try {
      const text = await readFile(e.base.filePath, 'utf8')
      this.index(e.base, analyzeEvents(parseJsonl(text).events).searchText)
    } catch {
      // keep the old index entry
    }
  }
}

function publicSource(s: ResolvedSource): SourceInfo {
  const { distroRoot: _distroRoot, ...rest } = s
  return rest
}
