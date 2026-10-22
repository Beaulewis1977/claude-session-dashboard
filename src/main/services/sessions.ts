// The session catalogue: scans sources, parses files, keeps the search index
// and the archive up to date, and serves summaries/details to the renderer.
//
// Reads only. The only writes go to the app's data folder (archive, metadata).

import { EventEmitter } from 'node:events'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { analyzeEvents, buildMessages, parseJsonl } from '@shared/jsonl'
import { baseName } from '@shared/format'
import { computeTitle } from '@shared/title'
import type {
  ArchiveRecord,
  Availability,
  SessionDetail,
  SessionMeta,
  SessionsPayload,
  SessionSummary,
  ScanState,
  SourceInfo
} from '@shared/types'
import type { SearchHit } from '@shared/api'
import { archiveSession } from '../core/archive'
import type { JsonStore } from '../core/json-store'
import { isInside } from '../core/safe-paths'
import type { Platform } from '../platform'
import { SearchIndex } from './search'
import { detectSources, type ResolvedSource } from './sources'
import { cleanMetaPatch, type AppPaths, type MetadataFile, type SettingsFile } from './store'

type BaseSummary = Omit<SessionSummary, 'meta' | 'title' | 'titleSource'>

interface Entry {
  base: BaseSummary
  size: number
  mtimeMs: number
}

interface FileInfo {
  path: string
  projectDir: string
  sessionId: string
  size: number
  mtimeMs: number
}

const SESSION_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.jsonl$/i

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
  const a = analyzeEvents(events)
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
      firstPrompt: a.firstPrompt,
      startedAt: a.startedAt,
      lastActivityAt: a.lastActivityAt,
      messageCount: a.userMessageCount + a.assistantMessageCount,
      userMessageCount: a.userMessageCount,
      assistantMessageCount: a.assistantMessageCount,
      toolCallCount: a.toolCallCount,
      malformedLines,
      sizeBytes: file.size,
      models: a.models
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
      const next: SessionMeta = { ...prev, ...clean, updatedAt: new Date().toISOString() }
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
    await this.rescan()
  }

  /** Re-detect sources and sync every one of them. */
  async rescan(): Promise<void> {
    const s = this.settings.value
    const detected = await detectSources(this.platform, {
      extraFolders: s.extraFolders,
      scanStoppedDistros: s.scanStoppedDistros
    })
    // Drop duplicates (e.g. an extra folder that is also auto-detected) and
    // anything inside the app's own data folder.
    const seen = new Set<string>()
    this.sources = detected.filter((src) => {
      const k = src.projectsDir.toLowerCase()
      if (seen.has(k) || isInside(src.projectsDir, this.paths.dataDir)) return false
      seen.add(k)
      return true
    })
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
    this.scan = { phase: 'ready', done: total, total }
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

  /** Wait for pending archive copies (used on quit and in tests). */
  async idle(): Promise<void> {
    await this.archiveQueue
  }

  // --------------------------------------------------------------- private

  private withMeta(base: BaseSummary): SessionSummary {
    const meta = this.metadata.value.sessions[base.sessionId] ?? {}
    return { ...base, meta, ...computeTitle(meta, base.summary, base.firstPrompt) }
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
    let text: string
    try {
      text = await readFile(f.path, 'utf8')
    } catch {
      return
    }
    const { base, searchText } = parseSessionText(text, f, src)
    const record = this.metadata.value.archive[key]
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
    try {
      text = await readFile(rec.archivePath, 'utf8')
    } catch {
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
    this.entries.set(base.key, { base, size, mtimeMs: 0 })
    this.index(base, searchText)
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
    const s = this.withMeta(base)
    this.search.upsert({
      id: base.key,
      title: s.title,
      name: s.meta.name ?? '',
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
