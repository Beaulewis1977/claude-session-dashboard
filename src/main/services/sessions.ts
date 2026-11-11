// The session catalogue: scans sources, parses files, keeps the search index
// and the archive up to date, and serves summaries/details to the renderer.
//
// Reads only. The only writes go to the app's data folder (archive, metadata).

import { createHash } from 'node:crypto'
import { COWORK_SOURCE_ID, readDesktopIndex } from '../providers/claude/desktop'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withStatusLine, type StatusContext } from '@shared/context'
import { now } from '@shared/clock'
import { computeTitle } from '@shared/title'
import type { SessionLineage } from '@shared/lineage'
import type { DetectedSource } from '@shared/source-label'
import { summarySearchText, type AiSummary } from '@shared/summary'
import type {
  ArchiveRecord,
  ArchiveTally,
  Availability,
  CodexArchiveEstimate,
  BranchRecord,
  SessionDetail,
  SessionMeta,
  SessionsPayload,
  SessionSummary,
  ScanState,
  SourceInfo
} from '@shared/types'
import { metaKey, type ProviderId } from '@shared/provider'
import type { SearchHit } from '@shared/api'
import type { GitBadge, SessionGitSignals } from '@shared/git/types'
import { hasGitFilters, parseGitQuery, type GitQuery } from '@shared/git/query'
import type { SessionBilling } from '@shared/usage/credits'
import { archiveGrowth, archiveSession } from '../core/archive'
import { writeFileAtomic, type JsonStore } from '../core/json-store'
import { isInside } from '../core/safe-paths'
import type { Platform } from '../platform'
import { defaultProviders, type ProviderRegistry } from '../providers/registry'
import type { BaseSummary, SessionFile, SessionProvider } from '../providers/types'
import { breathe } from '../core/breathe'
import { SearchIndex } from './search'
import type { ResolvedSource } from './sources'
import {
  cleanMetaPatch,
  type AppPaths,
  type MetadataFile,
  type PendingContinue,
  type SettingsFile
} from './store'

// v2: lineage fields (firstUuid, forkedFrom, copiedFrom) and, separately,
// source hints (entrypoint, IDE context, cloud link) for the source label.
// v3: both together, so neither kind of v2 cache is reused.
// v4: the Remote Control link (remoteUrl) from `bridge_status` entries.
// v5: statuses copied into a branch no longer count as the branch's own link.
// v6: the name given in Claude Code (custom-title / agent-name) and ai-title.
// v7: summaries in the search index (a new field).
// v8: the context size (last reply's usage, compactions, cache lifetime).
// v9: the cache lifetime as a 1-hour share (mixed 5-minute / 1-hour caches).
// v10: the 1-hour share of what is cached now (not of all writes).
// v11: git signals (branches, edited files, commits and PRs a session's own
// tool calls printed, active stretches) for the git links.
// v12: when each file was edited, and a Codex copy found by where its own history starts.
// v13: when each claude.ai/code link was seen, and older Codex copies found more closely.
// v14: cloud-link hints only for a real link outside Remote Control (local sessions were
// labelled "Cloud" for an empty `remote_session_change` attachment).
// v15: the model of each session's last reply (what fast mode is offered for).
const CACHE_VERSION = 15

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
  /** The provider's parse version when it was read (absent: a provider without one, e.g. Claude Code). */
  pv?: number
  /**
   * The agent's own name (e.g. a Codex thread name) its search entry was built
   * with: a name read again at startup that matches needs no re-index.
   */
  indexedName?: string
  /** What its file says about its git work (see @shared/git/signals). */
  git?: SessionGitSignals
}

/** One session as the git links service sees it (see SessionService.gitInputs). */
export interface GitInput {
  key: string
  sessionId: string
  provider: ProviderId
  env: SessionSummary['env']
  distro?: string
  /** The Linux user of its WSL home (runs git as that user). */
  sourceUser?: string
  cwd?: string
  title?: string
  /** A Codex subagent: its parent thread's id. */
  parentId?: string
  /**
   * A fork or branch with its parent's history copied in: the parent's id, and
   * when they split (its lines before then are the parent's work).
   */
  forkOf?: string
  forkAt?: number
  signals?: SessionGitSignals
  /** Changes when the session does (size, last activity, availability). */
  rev: string
}

/** What an imported entry was loaded from: reloaded when either changes. */
const importRev = (rec: ArchiveRecord): string => `${rec.sha256}|${rec.archivePath}`

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

/** A pending Continue fresh link is kept this long (the new session should show up in seconds). */
export const PENDING_CONTINUE_MS = 7 * 24 * 3600_000

/** The handoff id named in a Continue fresh session's first prompt (Codex: `handoffs/codex/<id>.md`). */
export function continuedHandoffId(firstPrompt: string): string | undefined {
  return /[\\/]handoffs[\\/]codex[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md\b/i
    .exec(firstPrompt)?.[1]
    ?.toLowerCase()
}

export class SessionService extends EventEmitter<{ changed: [] }> {
  sources: ResolvedSource[] = []
  private entries = new Map<string, Entry>()
  private search = new SearchIndex()
  private scan: ScanState = { phase: 'idle', done: 0, total: 0 }
  private archiveQueue: Promise<void> = Promise.resolve()
  /** Re-reads started in the background (renamed sessions): idle() waits for them. */
  private background = new Set<Promise<void>>()
  private syncing = new Map<string, Promise<void>>()
  private emitTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly platform: Platform,
    private readonly paths: AppPaths,
    private readonly metadata: JsonStore<MetadataFile>,
    private readonly settings: JsonStore<SettingsFile>,
    /** The coding agents whose sessions are shown (Claude Code only, unless the app adds Codex). */
    readonly providers: ProviderRegistry = defaultProviders()
  ) {
    super()
  }

  /** Per session: how many file reads have started (see loadFile). */
  private loadSeq = new Map<string, number>()

  /** Which provider each entry was loaded with (kept when its source goes away). */
  private owner = new Map<string, ProviderId>()

  /** The provider a session belongs to (as loaded, else its source's, else its archive record's). */
  providerOf(base: Pick<BaseSummary, 'key' | 'sourceId'>): SessionProvider {
    const known = this.owner.get(base.key)
    // Its own provider even if that was just turned off: in-flight work for it
    // is dropped by the isOn checks before it's kept, never by a throw here.
    if (known) return this.providers.owner({ provider: known })
    const owner: { provider?: ProviderId } | undefined =
      this.source(base.sourceId) ?? this.metadata.value.archive[base.key]
    return this.providers.owner(owner)
  }

  /**
   * A session's key in `metadata.json` (see metaKey in @shared/provider):
   * Claude Code's bare session id, `codex:<id>` for Codex.
   */
  metaKeyOf(base: Pick<BaseSummary, 'key' | 'sourceId' | 'sessionId'>): string {
    return metaKey(this.providerOf(base).id, base.sessionId)
  }

  private metaOf(base: Pick<BaseSummary, 'key' | 'sourceId' | 'sessionId'>): SessionMeta {
    return this.metadata.value.sessions[this.metaKeyOf(base)] ?? {}
  }

  // ---------------------------------------------------------------- public

  /** A scan is running. */
  get scanning(): boolean {
    return this.scan.phase === 'scanning'
  }

  payload(): SessionsPayload {
    return {
      sessions: this.list(),
      sources: this.sources.map(publicSource),
      scan: { ...this.scan }
    }
  }

  list(): SessionSummary[] {
    return [...this.entries.values()].filter((e) => this.isOn(e)).map((e) => this.withMeta(e.base))
  }

  get(key: string): SessionSummary | undefined {
    const e = this.entries.get(key)
    return e && this.isOn(e) ? this.withMeta(e.base) : undefined
  }

  /**
   * Its provider is on. Right after one is turned off its entries may still be
   * here until the rescan drops them: they're skipped, never looked up.
   */
  private isOn(e: Entry): boolean {
    // Cowork sessions (archive copies included) only while that source is on.
    if (e.base.sourceId === COWORK_SOURCE_ID && !this.coworkOn()) return false
    const p = this.owner.get(e.base.key)
    return !p || this.providers.isOn(p)
  }

  /** Settings → Sources: the Claude desktop app's Cowork sessions are shown. */
  coworkOn(): boolean {
    return this.settings.value.coworkSource === true
  }

  /** `%APPDATA%/Claude` (set at startup): the desktop app's Code-tab index is read from it. */
  desktopDir?: string
  /** Session ids the Claude desktop app's Code tab lists (see providers/claude/desktop.ts). */
  private desktopIds: ReadonlySet<string> = new Set()

  /** Re-read the desktop app's Code-tab index; the labels follow (cheap: a few small files). */
  async refreshDesktopIndex(): Promise<void> {
    if (!this.desktopDir) return
    const next = await readDesktopIndex(this.desktopDir).catch(() => new Set<string>())
    const same =
      next.size === this.desktopIds.size && [...next].every((id) => this.desktopIds.has(id))
    this.desktopIds = next
    if (!same) this.emitChanged()
  }

  source(id: string): ResolvedSource | undefined {
    return this.sources.find((s) => s.id === id)
  }

  /**
   * Where a session came from, by its key: the app's own record (Fork / Continue
   * fresh / Branch from the app; also before its file exists, e.g. a session just
   * continued fresh), else what its file says (a Codex fork's `forked_from_id`;
   * Codex forks the app launched get no record of their own).
   */
  originOf(key: string): { parentKey?: string; via: 'app' | 'fork' | 'continue' } | undefined {
    const i = key.indexOf(':')
    if (i <= 0) return undefined
    const sourceId = key.slice(0, i)
    const b = this.metaOf({ key, sourceId, sessionId: key.slice(i + 1) }).branch
    if (b) return { parentKey: b.parentKey, via: b.via }
    const s = this.get(key)
    if (s?.forkedFromId) return { parentKey: `${sourceId}:${s.forkedFromId}`, via: 'fork' }
    const l = s?.lineage
    if (l?.parentKey && (l.via === 'fork' || l.via === 'continue'))
      return { parentKey: l.parentKey, via: l.via }
    return undefined
  }

  archiveRecord(key: string): ArchiveRecord | undefined {
    return this.metadata.value.archive[key]
  }

  searchKeys(query: string): SearchHit[] {
    // Only sessions that are shown (a provider turned off, or the Cowork source while it's off).
    const shown = (h: SearchHit): boolean => {
      const e = this.entries.get(h.key)
      return !!e && this.isOn(e)
    }
    const q = parseGitQuery(query)
    if (!hasGitFilters(q) || !this.gitFilter) return this.search.search(query).filter(shown)
    const keys = this.gitFilter(q)
    if (!q.text) return [...keys].map((key) => ({ key, score: 1, fields: ['git'] })).filter(shown)
    return this.search.search(q.text).filter((h) => keys.has(h.key) && shown(h))
  }

  /** The sessions a `touched:` / `commit:` filter matches (set by the git links service). */
  gitFilter?: (q: GitQuery) => Set<string>
  /** A session's git badge ("3 commits · PR #14"), set by the git links service. */
  gitBadgeResolver?: (key: string) => GitBadge | undefined

  /** What the git links service needs of every session (its own provider on). */
  gitInputs(): GitInput[] {
    const out: GitInput[] = []
    for (const e of this.entries.values()) {
      if (!this.isOn(e) || e.base.availability === 'imported') continue
      const b = e.base
      const src = this.source(b.sourceId)
      // Continue fresh starts empty; every other kind of child carries a copy of its parent.
      const lin = this.lineageResolver?.(b.key)
      const fork = lin && lin.via !== 'continue' ? lin : undefined
      // Codex records its own fork parent (forked_from_id). A Codex fork or subagent
      // starts from its parent's history, so its own start is the split. A fork or
      // branch the app made has its creation time in the app's record: everything it
      // copied is from before, everything of its own after (the split point itself
      // can't be worked out when the parent is gone).
      const forkOf = fork?.parentSessionId ?? b.forkedFromId
      const record = this.metaOf(b).branch
      const made =
        fork && record && record.via !== 'continue' && record.parentSessionId === forkOf
          ? record.createdAt
          : undefined
      const split = fork?.atTime ?? made ?? (b.forkedFromId || b.subagent ? b.startedAt : undefined)
      const forkAt = split ? Date.parse(split) : NaN
      out.push({
        key: b.key,
        sessionId: b.sessionId,
        provider: this.providerOf(b).id,
        env: b.env,
        distro: b.distro,
        sourceUser: src?.kind === 'custom' ? undefined : src?.user,
        cwd: b.cwd,
        title: this.metaOf(b).name ?? b.claudeName ?? b.summary ?? b.firstPrompt?.slice(0, 80),
        parentId: b.subagent?.parentId,
        ...(forkOf ? { forkOf } : {}),
        ...(Number.isFinite(forkAt) ? { forkAt } : {}),
        signals: e.git,
        // Its fork point counts too: lineage is worked out after the scan.
        rev: `${e.size}|${b.lastActivityAt ?? ''}|${b.availability}|${forkOf ?? ''}|${split ?? ''}`
      })
    }
    return out
  }

  /** The signals of one session (for `touched:` and the Changes tab). */
  gitSignals(key: string): SessionGitSignals | undefined {
    return this.entries.get(key)?.git
  }

  /** Commits I unlinked from a session (kept in the app's metadata, never in the agent's files). */
  gitUnlinked(key: string): string[] {
    const e = this.entries.get(key)
    return e ? (this.metaOf(e.base).gitUnlinked ?? []) : []
  }

  setGitUnlinked(key: string, shas: string[]): boolean {
    const e = this.entries.get(key)
    if (!e || !this.isOn(e)) return false
    const mk = this.metaKeyOf(e.base)
    const clean = [...new Set(shas.filter((x) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(x)))].slice(
      0,
      5000
    )
    this.metadata.update((d) => {
      const next: SessionMeta = { ...(d.sessions[mk] ?? {}), updatedAt: new Date().toISOString() }
      if (clean.length) next.gitUnlinked = clean
      else delete next.gitUnlinked
      d.sessions[mk] = next
    })
    this.emitChanged()
    return true
  }

  async detail(key: string): Promise<SessionDetail | null> {
    const e = this.entries.get(key)
    if (!e || !this.isOn(e)) return null
    const provider = this.providerOf(e.base)
    let text: string
    try {
      text = await provider.readText(e.base.filePath, 'view')
    } catch {
      return null
    }
    // Turned off while it was being read.
    if (!this.providers.isOn(provider.id)) return null
    return {
      summary: this.withMeta(e.base),
      messages: provider.buildMessages(text, e.base)
    }
  }

  updateMeta(key: string, patch: Partial<SessionMeta>): SessionSummary | null {
    const e = this.entries.get(key)
    if (!e || !this.isOn(e)) return null
    const provider = this.providerOf(e.base)
    const mk = metaKey(provider.id, e.base.sessionId)
    const clean = cleanMetaPatch(patch, provider.effortLevels)
    this.metadata.update((d) => {
      const prev = d.sessions[mk] ?? {}
      const at = new Date().toISOString()
      const next: SessionMeta = { ...prev, ...clean, updatedAt: at }
      // When I named it here, to compare with a later rename in Claude Code.
      if ('name' in clean) next.nameAt = clean.name ? at : undefined
      for (const k of Object.keys(next) as (keyof SessionMeta)[]) {
        const v = next[k]
        if (v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0))
          delete next[k]
      }
      d.sessions[mk] = next
    })
    this.inBackground(this.reindex(key))
    // "Only named, pinned or tagged": naming one may make it worth keeping.
    const src = this.source(e.base.sourceId)
    if (src && e.base.availability === 'live' && provider.id !== 'claude')
      this.queueArchive(src, e.base)
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
      const s = this.get(key)
      if (!s?.claudeName || !s.meta.name) continue
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
    const opts = {
      extraFolders: s.extraFolders,
      scanStoppedDistros: s.scanStoppedDistros,
      cowork: s.coworkSource === true
    }
    const detected: ResolvedSource[] = []
    for (const p of this.providers.all())
      detected.push(...(await p.detectSources(this.platform, opts)))
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
    if (this.desktopDir) await this.refreshDesktopIndex()
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
    if (this.desktopDir) await this.refreshDesktopIndex()
    this.sources = await this.detect()
    this.dropDisabled()
    const files = new Map<string, SessionFile[]>()
    const renamed = new Map<string, string[]>()
    for (const src of this.sources) {
      // Its provider may be turned off while this rescan runs (a new one follows).
      const provider = this.providers.find(src)
      if (src.status !== 'ok' || !provider) continue
      const list = await provider.listSessionFiles(src)
      if (list) files.set(src.id, list)
      else Object.assign(src, { status: 'unreadable', statusMessage: "Folder can't be read" })
      const changed = list ? await provider.names?.refresh(src).catch(() => []) : undefined
      if (changed?.length) renamed.set(src.id, changed)
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
    for (const [sourceId, ids] of renamed) this.reindexNames(sourceId, ids)
    this.scan = { phase: 'ready', done: total, total, finishedAt: now() }
    this.emitChanged(true)
  }

  /** Cheap re-check of one source: list + stat, parse only what changed. */
  async pollSource(sourceId: string): Promise<void> {
    const src = this.source(sourceId)
    if (!src || src.status !== 'ok') return
    const provider = this.providers.find(src)
    if (!provider) return
    // The Windows home's safety-net poll (every minute) also re-reads the desktop app's index.
    if (sourceId === 'windows' && this.desktopDir) await this.refreshDesktopIndex()
    const list = await provider.listSessionFiles(src)
    if (!list) {
      // e.g. the WSL distro was shut down: show archive copies instead.
      Object.assign(src, { status: 'unreadable', statusMessage: "Can't be read right now" })
    } else {
      await this.syncSource(src, list, false)
      const renamed = await provider.names?.refresh(src).catch(() => [])
      if (renamed?.length) {
        this.reindexNames(src.id, renamed)
        this.emitChanged()
      }
    }
    await this.syncArchiveOnly()
    if (!list) this.emitChanged()
  }

  /** Called by the watcher for a single file event. */
  async fileChanged(sourceId: string, path: string): Promise<void> {
    const src = this.source(sourceId)
    if (!src || src.status !== 'ok') return
    const provider = this.providers.find(src)
    if (!provider) return
    const file = provider.sessionFileOf(path)
    if (!file) return
    const key = `${src.id}:${file.sessionId}`
    let st
    try {
      st = await stat(path)
    } catch {
      // A late "unlink" for a path the session has since moved from (a Codex
      // rollout moving to archived_sessions/): the entry now follows the new
      // file, which is still there.
      const e = this.entries.get(key)
      if (
        e?.base.availability === 'live' &&
        !samePath(e.base.filePath, path) &&
        (await this.platform.pathExists(e.base.filePath))
      )
        return
      await this.originalGone(key)
      return
    }
    await this.loadFile(src, {
      path,
      projectDir: file.projectDir,
      sessionId: file.sessionId,
      size: st.size,
      mtimeMs: st.mtimeMs
    })
    this.emitChanged()
  }

  /**
   * Wait for pending archive copies and background re-reads, then save the
   * cache (used on quit and in tests). A re-read that finished later would
   * mark the cache changed and save it again afterwards (in a test, into a
   * folder that was already removed).
   */
  async idle(): Promise<void> {
    // Until nothing is left: each kind of work can queue the other.
    for (;;) {
      const queue = this.archiveQueue
      await Promise.all([queue, ...this.background])
      if (queue === this.archiveQueue && this.background.size === 0) break
    }
    if (this.cacheDirty) await this.saveCache()
  }

  /** Run `work` in the background, where idle() waits for it. */
  private inBackground(work: Promise<unknown>): void {
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined
    )
    this.background.add(done)
    void done.then(() => this.background.delete(done))
  }

  // --------------------------------------------------------------- private

  /** Resolves billing for a session (set by the app: tags + bridge inference). */
  billingResolver?: (sessionId: string, meta: SessionMeta) => SessionBilling | undefined
  /** The status line's latest context reading for a session (see LimitsService). */
  contextResolver?: (sessionId: string) => StatusContext | undefined
  /** Resolves where a session was branched from (set by the lineage service). */
  lineageResolver?: (key: string) => SessionLineage | undefined

  private detectSource(base: BaseSummary): DetectedSource {
    const meta = this.metaOf(base)
    return this.providerOf(base).detectSource(base, {
      env: base.env,
      cwd: base.cwd,
      sourceUser: this.source(base.sourceId)?.user,
      firstPrompt: base.firstPrompt,
      launchedByApp: meta.billing?.source === 'launch',
      imported: base.availability === 'imported',
      desktopIndexed: base.env === 'windows' && this.desktopIds.has(base.sessionId.toLowerCase()),
      cowork: base.sourceId === COWORK_SOURCE_ID
    })
  }

  private withMeta(raw: BaseSummary): SessionSummary {
    const provider = this.providerOf(raw)
    // The agent's own name for it, when kept outside its file (Codex's thread names).
    const agent = provider.names?.get(raw.sourceId, raw.sessionId)
    const base = agent ? { ...raw, claudeName: agent.name, claudeNameAt: agent.at } : raw
    const meta = this.metaOf(base)
    const manual = meta.source?.by === 'manual' ? meta.source : undefined
    const det = manual ? undefined : this.detectSource(base)
    const title = computeTitle(
      meta,
      { name: base.claudeName, at: base.claudeNameAt },
      base.summary,
      base.firstPrompt
    )
    // The dashboard's own runs (Ask Claude, summaries): titled by what they are.
    const own =
      title.titleSource === 'first-prompt' ? provider.ownRunTitle(base.firstPrompt) : undefined
    if (own) title.title = own
    return {
      ...base,
      provider: provider.id,
      meta,
      ...title,
      // Billing and the status line's context are Claude Code's (Codex usage comes in Phase C).
      billing: provider.capabilities.apiBilling
        ? this.billingResolver?.(base.sessionId, meta)
        : undefined,
      source: manual?.label ?? det!.label,
      sourceReason: manual ? 'Set by hand' : det!.reason,
      lineage: this.lineageResolver?.(base.key),
      git: this.gitBadgeResolver?.(base.key),
      // Claude desktop Cowork: read, search, usage and git links only.
      ...(base.sourceId === COWORK_SOURCE_ID ? { viewOnly: 'cowork' as const } : {}),
      context: provider.capabilities.usage
        ? withStatusLine(base.context, this.contextResolver?.(base.sessionId))
        : base.context
    }
  }

  /** Keep the detected label in the app's metadata (never in Claude's files). */
  private rememberSource(base: BaseSummary): void {
    const mk = this.metaKeyOf(base)
    const meta = this.metadata.value.sessions[mk]
    if (meta?.source?.by === 'manual') return
    const det = this.detectSource(base)
    if (meta?.source?.label === det.label && meta.source.reason === det.reason) return
    this.metadata.update((d) => {
      d.sessions[mk] = {
        ...(d.sessions[mk] ?? {}),
        source: { label: det.label, by: 'auto', reason: det.reason }
      }
    })
  }

  /**
   * Store (or with undefined, remove) a session's AI summary, in the app's
   * metadata only. Never written to Claude's files.
   */
  setAiSummary(key: string, summary: AiSummary | undefined): SessionSummary | null {
    const e = this.entries.get(key)
    if (!e || !this.isOn(e)) return null
    const mk = this.metaKeyOf(e.base)
    this.metadata.update((d) => {
      const next: SessionMeta = { ...(d.sessions[mk] ?? {}) }
      if (summary) next.aiSummary = summary
      else delete next.aiSummary
      next.updatedAt = new Date().toISOString()
      d.sessions[mk] = next
    })
    this.inBackground(this.reindex(key))
    this.emitChanged()
    return this.get(key) ?? null
  }

  /**
   * Record a branch made from the app (in the app's metadata only) and give it
   * a default name if it has none.
   */
  recordBranch(
    /** The new session's metadata key (Claude Code's session id; see metaKeyOf). */
    sessionId: string,
    branch: BranchRecord,
    name?: string,
    /** The parent's own model / effort / fast-mode choice, kept by the branch. */
    inherit: Pick<SessionMeta, 'model' | 'effort' | 'fast'> = {}
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
        ...(kept.fast && !prev.fast ? { fast: kept.fast } : {}),
        updatedAt: new Date().toISOString()
      }
    })
    for (const e of this.entries.values())
      if (e.base.sessionId === sessionId) this.inBackground(this.reindex(e.base.key))
    this.emitChanged()
  }

  /**
   * Continue fresh for an agent that picks its own new session id (Codex):
   * remembered by the handoff's id until the new session shows up (see
   * linkContinued). Older pending links than PENDING_CONTINUE_MS are dropped.
   */
  recordPendingContinue(handoffId: string, p: PendingContinue): void {
    const t = Date.now()
    this.metadata.update((d) => {
      const pending = { ...(d.pendingContinues ?? {}) }
      for (const [k, v] of Object.entries(pending))
        if (!(t - Date.parse(v.createdAt) < PENDING_CONTINUE_MS)) delete pending[k]
      pending[handoffId] = p
      d.pendingContinues = pending
    })
    // Already indexed (Codex wrote its file before this was recorded): link it now.
    for (const e of this.entries.values()) this.linkContinued(e.base)
  }

  /** Forget a pending Continue fresh link (nothing was started). */
  dropPendingContinue(handoffId: string): void {
    if (!this.metadata.value.pendingContinues?.[handoffId]) return
    this.metadata.update((d) => {
      if (d.pendingContinues) delete d.pendingContinues[handoffId]
    })
  }

  /**
   * A new session whose first prompt names a pending Continue fresh handoff
   * (`…handoffs/codex/<id>.md`, a random id only the app made): record where
   * it came from and its default name, as for Claude Code's Continue fresh.
   */
  private linkContinued(base: BaseSummary): void {
    const pending = this.metadata.value.pendingContinues
    if (!pending || !base.firstPrompt) return
    const id = continuedHandoffId(base.firstPrompt)
    const p = id ? pending[id] : undefined
    if (!id || !p || p.sourceId !== base.sourceId || p.parentSessionId === base.sessionId) return
    if (!(Date.now() - Date.parse(p.createdAt) < PENDING_CONTINUE_MS)) return
    this.metadata.update((d) => {
      if (d.pendingContinues) delete d.pendingContinues[id]
    })
    this.recordBranch(
      this.metaKeyOf(base),
      {
        parentSessionId: p.parentSessionId,
        parentKey: p.parentKey,
        via: 'continue',
        createdAt: p.createdAt
      },
      p.name,
      { model: p.model, effort: p.effort, fast: p.fast }
    )
  }

  /** Load a file the app just created, and return its summary. */
  async loadNew(sourceId: string, path: string): Promise<SessionSummary | undefined> {
    await this.fileChanged(sourceId, path)
    const src = this.source(sourceId)
    const file = src && this.providers.find(src)?.sessionFileOf(path)
    return file ? this.get(`${sourceId}:${file.sessionId}`) : undefined
  }

  /** Tell the renderer that derived fields (e.g. billing) changed. */
  touch(): void {
    this.emitChanged()
  }

  /** Tag a session's billing (from a launch), without touching Claude's files. `sessionId`: its metadata key. */
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
    files: SessionFile[],
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

  private async loadFile(src: ResolvedSource, f: SessionFile): Promise<void> {
    // Its provider may have been turned off since this scan or event started.
    const provider = this.providers.find(src)
    if (!provider) return
    const key = `${src.id}:${f.sessionId}`
    const existing = this.entries.get(key)
    if (
      existing &&
      existing.base.availability === 'live' &&
      existing.base.filePath === f.path &&
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
      cached.pv === provider.parseVersion &&
      this.search.has(key)
    ) {
      // Unchanged since the last run: reuse the cached summary and index entry.
      const base = {
        ...cached.base,
        sourceLabel: src.label,
        archivePath: record?.archivePath ?? cached.base.archivePath
      }
      const pv = provider.parseVersion
      this.loadSeq.set(key, (this.loadSeq.get(key) ?? 0) + 1)
      this.owner.set(key, provider.id)
      this.entries.set(key, {
        base,
        size: f.size,
        mtimeMs: f.mtimeMs,
        ...(pv ? { pv } : {}),
        // The agent name its (reused) search entry was built with.
        ...(cached.indexedName !== undefined ? { indexedName: cached.indexedName } : {}),
        ...(cached.git ? { git: cached.git } : {})
      })
      this.linkContinued(base)
      this.queueArchive(src, base)
      return
    }
    // Overlapping events (a big rollout moved or compressed while it was read): only
    // the read started last is kept, so an older, slower one can't put stale data back.
    const seq = (this.loadSeq.get(key) ?? 0) + 1
    this.loadSeq.set(key, seq)
    let text: string
    try {
      text = await provider.readText(f.path)
    } catch {
      return
    }
    // Parsing and indexing a big session are long synchronous steps: let the
    // app's other work (a dialog's IPC) in before each.
    await breathe()
    if (this.loadSeq.get(key) !== seq) return
    // Turned off while the file was being read: nothing of it is kept.
    if (!this.providers.isOn(provider.id)) return
    const { base, searchText, git } = provider.parseSession(text, f, src)
    if (record) base.archivePath = record.archivePath
    this.owner.set(key, provider.id)
    const pv = provider.parseVersion
    this.entries.set(key, {
      base,
      size: f.size,
      mtimeMs: f.mtimeMs,
      ...(pv ? { pv } : {}),
      ...(git ? { git } : {})
    })
    await breathe()
    // Replaced by a newer read meanwhile: that one indexes it.
    if (this.loadSeq.get(key) !== seq) return
    this.index(base, searchText)
    this.linkContinued(base)
    this.queueArchive(src, base)
  }

  /**
   * Is this session copied into the archive? Claude Code's always are.
   * Another agent's follow Settings → Archive (Codex: off by default, only
   * named, pinned or tagged ones, or all), because Codex doesn't remove old
   * sessions itself and its history can be very large.
   */
  archiveWanted(
    provider: SessionProvider,
    base: Pick<BaseSummary, 'sessionId' | 'sourceId'>
  ): boolean {
    if (provider.id === 'claude') return true
    const mode = this.settings.value.codexArchive ?? 'off'
    if (mode === 'all') return true
    if (mode !== 'marked') return false
    return this.marked(provider, base)
  }

  /** Named (here or in the agent, e.g. a Codex thread name), pinned or tagged. */
  private marked(
    provider: SessionProvider,
    base: Pick<BaseSummary, 'sessionId' | 'sourceId'>
  ): boolean {
    const m = this.metadata.value.sessions[metaKey(provider.id, base.sessionId)]
    if (m?.name?.trim() || m?.pinned || m?.tags?.length) return true
    return !!provider.names?.get(base.sourceId, base.sessionId)
  }

  /**
   * Copy (or update) the archive copies the Codex archive setting now asks
   * for: after the setting changed. Nothing already archived is removed.
   */
  archiveWantedNow(): void {
    for (const e of this.entries.values()) {
      if (e.base.availability !== 'live' || !this.isOn(e)) continue
      const src = this.source(e.base.sourceId)
      if (src && this.providerOf(e.base).id !== 'claude') this.queueArchive(src, e.base)
    }
  }

  /**
   * What "Archive Codex sessions" would copy: the live Codex sessions per
   * mode, and the part not archived yet. `bytes` counts every session of the
   * mode; `newBytes` and `backupBytes` only what isn't archived as it is now
   * (new, or holding more). Backups keep each file once, gzip-compressed:
   * compressed rollouts stay about the same size, plain ones shrink
   * (estimated at a quarter).
   */
  codexArchiveEstimate(): CodexArchiveEstimate {
    const all = emptyTally()
    const marked = emptyTally()
    for (const e of this.entries.values()) {
      if (e.base.availability !== 'live' || !this.isOn(e)) continue
      const provider = this.providerOf(e.base)
      if (provider.id !== 'codex') continue
      // A record whose copy is gone counts as not archived: the archiver copies it all again.
      const recorded = this.metadata.value.archive[e.base.key]
      const rec = recorded && existsSync(recorded.archivePath) ? recorded : undefined
      const add = (t: ArchiveTally): void => {
        const compressed = e.base.filePath.endsWith('.zst')
        t.sessions++
        t.bytes += e.size
        // Whether it's copied is decided by content (a compressed rollout is
        // smaller than its plain copy); what it adds, by what the archive writes.
        const now = e.base.contentBytes ?? e.size
        const had = rec ? (rec.contentSize ?? rec.size) : 0
        const ext = provider.archiveExtOf?.(e.base.originalPath) ?? provider.archiveExt
        if (rec && now <= had) return
        t.newBytes += archiveGrowth(rec, e.size, ext)
        // Backups add each new or changed copy whole (content-addressed, so the
        // unchanged copies already in a backup add nothing).
        t.backupBytes += compressed ? e.size : Math.round(e.size / 4)
      }
      add(all)
      if (this.marked(provider, e.base)) add(marked)
    }
    let archived = 0
    let archivedBytes = 0
    for (const r of Object.values(this.metadata.value.archive))
      if (r.provider === 'codex' && existsSync(r.archivePath)) {
        archived++
        archivedBytes += r.size
      }
    return { all, marked, archived, archivedBytes }
  }

  private queueArchive(src: ResolvedSource, base: BaseSummary): void {
    const provider = this.providers.find(src)
    if (!provider || !this.archiveWanted(provider, base)) return
    this.archiveQueue = this.archiveQueue.then(async () => {
      // Asked again when it's this one's turn: the setting may have changed (or the
      // provider been turned off) while thousands of copies were waiting.
      if (!this.providers.isOn(provider.id) || !this.archiveWanted(provider, base)) return
      try {
        const key = base.key
        const rec = await archiveSession(
          {
            provider: provider.id,
            ext: provider.archiveExtOf?.(base.originalPath) ?? provider.archiveExt,
            sessionId: base.sessionId,
            sourceId: src.id,
            sourceLabel: src.label,
            env: src.env,
            distro: src.distro,
            originalPath: base.originalPath,
            cwd: base.cwd,
            ...(base.contentBytes !== undefined ? { contentSize: base.contentBytes } : {})
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
    // A read that started before the file went away must not put it back.
    this.cancelReads(key)
    const rec = this.metadata.value.archive[key]
    if (!rec) {
      this.entries.delete(key)
      this.owner.delete(key)
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
    // Kept by a provider this version doesn't have: left alone (it stays archived).
    const provider = this.providers.find(rec)
    if (!provider) return
    let text: string
    const imported = availability === 'imported'
    const key = `${rec.sourceId}:${rec.sessionId}`
    const before = this.entries.get(key)
    try {
      text = await provider.readText(rec.archivePath)
    } catch {
      if (imported) this.dropEntry(key)
      return
    }
    // Turned off while the copy was being read.
    if (!this.providers.isOn(provider.id)) return
    // The live file came back (or moved) while the copy was being read: the
    // live entry wins over the archive copy.
    const cur = this.entries.get(key)
    if (!imported && cur !== before && cur?.base.availability === 'live') return
    // An imported conversation's file must hold what was imported (archives
    // from before collision-proof names may hold another conversation).
    if (imported && createHash('sha256').update(text).digest('hex') !== rec.sha256) {
      console.warn('archive copy does not match its conversation', rec.archivePath)
      this.dropEntry(`${rec.sourceId}:${rec.sessionId}`)
      return
    }
    // Claude Code's text is the file; another agent's is a digest of it (see readText).
    const size = provider.id === 'claude' ? Buffer.byteLength(text) : rec.size
    const src = this.source(rec.sourceId) ?? {
      id: rec.sourceId,
      label: rec.sourceLabel,
      env: rec.env,
      distro: rec.distro
    }
    const { base, searchText, git } = provider.parseSession(
      text,
      {
        path: rec.archivePath,
        projectDir: provider.projectDirOf(rec.originalPath),
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
    // A live read still in flight (its source went offline) must not replace it.
    this.cancelReads(base.key)
    this.owner.set(base.key, provider.id)
    this.entries.set(base.key, {
      base,
      size,
      mtimeMs: 0,
      ...(imported ? { rev: importRev(rec) } : {}),
      ...(git && !imported ? { git } : {})
    })
    this.index(base, searchText)
  }

  /** Reads of this session still in flight are dropped when they finish (see loadFile). */
  private cancelReads(key: string): void {
    this.loadSeq.set(key, (this.loadSeq.get(key) ?? 0) + 1)
  }

  private dropEntry(key: string): void {
    this.cancelReads(key)
    if (!this.entries.delete(key)) return
    this.owner.delete(key)
    this.search.remove(key)
    this.markCacheDirty()
  }

  /**
   * Sessions of a provider that was turned off (Settings → Providers) leave
   * the list and the search index. Their metadata and archive copies stay,
   * so turning it back on brings everything back.
   */
  dropDisabled(): void {
    let dropped = false
    for (const [key, p] of this.owner) {
      if (this.providers.isOn(p)) continue
      this.cancelReads(key)
      this.entries.delete(key)
      this.owner.delete(key)
      this.search.remove(key)
      this.markCacheDirty()
      dropped = true
    }
    // The desktop and phones update now, not at the next rescan.
    if (dropped) this.emitChanged(true)
  }

  /** Search entries of sessions whose name the agent changed (e.g. a Codex thread rename). */
  private reindexNames(sourceId: string, sessionIds: string[]): void {
    const ids = new Set(sessionIds.map((x) => x.toLowerCase()))
    const src = this.source(sourceId)
    const keys: string[] = []
    for (const e of this.entries.values())
      if (e.base.sourceId === sourceId && ids.has(e.base.sessionId.toLowerCase())) {
        // At startup every name counts as new (none were read yet in this run):
        // only those that differ from the name the search entry has are read again.
        if (e.indexedName !== (this.withMeta(e.base).claudeName ?? '')) keys.push(e.base.key)
        // A name given in the agent can make it "named" for the archive.
        if (src && e.base.availability === 'live') this.queueArchive(src, e.base)
      }
    // Two at a time: each one reads its whole session again.
    if (keys.length) this.inBackground(mapLimit(keys, 2, (k) => this.reindex(k)))
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
        this.owner.delete(key)
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
      name: [s.meta.name, s.claudeName].filter(Boolean).join(' '),
      description: s.meta.description ?? '',
      tags: (s.meta.tags ?? []).join(' '),
      summary: summarySearchText(s.meta.aiSummary),
      project: `${base.projectName} ${base.cwd ?? ''} ${base.gitBranch ?? ''}`,
      text: searchText
    })
    const e = this.entries.get(base.key)
    if (e) e.indexedName = s.claudeName ?? ''
  }

  private async reindex(key: string): Promise<void> {
    const e = this.entries.get(key)
    if (!e || !this.isOn(e)) return
    try {
      const provider = this.providerOf(e.base)
      const text = await provider.readText(e.base.filePath, 'view')
      // Turned off, or the entry replaced, while it was being read.
      if (!this.providers.isOn(provider.id) || this.entries.get(key) !== e) return
      this.index(e.base, provider.searchText(text))
    } catch {
      // keep the old index entry
    }
  }
}

/** The same file (Windows paths: case and slashes don't matter). */
function samePath(a: string, b: string): boolean {
  return isInside(a, b) && isInside(b, a)
}

function emptyTally(): ArchiveTally {
  return { sessions: 0, bytes: 0, newBytes: 0, backupBytes: 0 }
}

function publicSource(s: ResolvedSource): SourceInfo {
  const { distroRoot: _distroRoot, ...rest } = s
  return rest
}
