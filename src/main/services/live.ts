// "Running now": polls each Claude home's running-session files and the hook
// bridge's events, works out each session's state (shared/live.ts) and sends
// alerts (shared/live-alerts.ts) on the desktop and to phones.
//
// Read only, except for pruning the app's own old event files in its own
// `<home>/.claude-session-dashboard/events/` folder. Nothing in `.claude` is
// ever written or deleted.

import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { clockOffset, now } from '@shared/clock'
import {
  computeLive,
  type HookEnv,
  type HookEvent,
  type LiveSession,
  type LiveSnapshot,
  type ProcInput,
  type RunningFile,
  EXITED_KEEP_MS
} from '@shared/live'
import {
  alertVerdict,
  detectAlerts,
  type Alert,
  type AlertKind,
  type LiveAlertSettings
} from '@shared/live-alerts'
import { computeCodexLive, UNLOCKED_ACTIVE_MS, type CodexThreadInput } from '@shared/codex-live'
import { liveOrder, parseHookEvent } from '@shared/live'
import type { SourceInfo } from '@shared/types'
import { isInsideClaudeDir } from '../core/safe-paths'
import type { Alive, ProcQuery } from '../core/procs'
import { CodexLiveReader, type ProcLockIndex, type ThreadLock } from '../providers/codex/live'
import { catalogueProviders } from '../providers/registry'
import type { LiveDirs, SessionProvider } from '../providers/types'
import { BRIDGE_DIR_NAME } from './bridge'
import { CODEX_EVENTS_DIR, codexHookPaths, type CodexHooksInstaller } from './codex-hooks'
import type { HooksInstaller } from './hooks'
import type { SessionService } from './sessions'

const RUNNING_FILE_RE = /^\d{1,10}\.json$/
const EVENT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[A-Za-z]{1,40}\.json$/
/** Event files older than this are the app's to delete (its own folder only). */
const EVENT_KEEP_MS = 7 * 24 * 60 * 60_000
/** Events this old don't matter for "Running now" any more. */
const EVENT_RELEVANT_MS = 24 * 60 * 60_000
const POLL_MS = 2000
/** WSL folders are network shares: read less often. */
const POLL_UNC_MS = 5000
const isUnc = (p: string): boolean => /^[\\/]{2}/.test(p)

export interface ProcCheck {
  check(items: ProcQuery[]): Promise<Alive[]>
  /** Stops any helper process. */
  dispose?(): void
}

export interface LiveDeps {
  sessions: SessionService
  hooks: HooksInstaller
  procs: ProcCheck
  settings: () => LiveAlertSettings
  /** Desktop notification. */
  notify: (alert: Alert, title: string) => void
  /**
   * Web Push to phones that turned it on; returns how many got it. Each phone
   * gets its own reference (`refFor(deviceId)`).
   */
  push: (kind: AlertKind, refFor: (deviceId: string) => string) => Promise<number>
  /** Host path of a WSL source's distro root (for /proc). */
  distroRoot: (sourceId: string) => string | undefined
  /** Monotonic milliseconds, for intervals (the wall clock can jump back). */
  mono?: () => number
  /** Codex's opt-in PermissionRequest hook (absent: Codex rows come from locks and rollouts only). */
  codexHooks?: CodexHooksInstaller
  /** Reads Codex's thread locks and rollouts (a seam for tests and fixtures mode). */
  codexReader?: CodexLiveReader
}

/** Codex homes are polled this often while one of their threads is open… */
const CODEX_ACTIVE_MS = 2000
const CODEX_ACTIVE_UNC_MS = 5000
/** …and backed off to this while nothing runs there. */
const CODEX_IDLE_MS = 10_000
const CODEX_IDLE_UNC_MS = 15_000

/** How long a push reference can be opened. */
export const REF_TTL_MS = 24 * 60 * 60_000

interface Cached<T> {
  mtimeMs: number
  size: number
  value: T | undefined
}

/** A home's "Running now" folders, with its provider's readers. */
interface SourceDirs extends LiveDirs {
  live: NonNullable<SessionProvider['live']>
}

export class LiveService extends EventEmitter<{ changed: [] }> {
  private timer: NodeJS.Timeout | undefined
  private polling = false
  private running = new Map<string, Cached<RunningFile>>()
  private events = new Map<string, Cached<HookEvent>>()
  private lastRead = new Map<string, number>()
  private goneAt = new Map<string, number>()
  private wasAlive = new Set<string>()
  private current: LiveSession[] = []
  private prev: Map<string, LiveSession> | undefined
  private lastJson = ''
  private hookEnvs: HookEnv[] = []
  private hookEnvsAt: number | undefined
  private lastShown = new Map<string, number>()
  private refs = new Map<string, { key: string; deviceId: string; at: number }>()
  /** Sessions whose running file disappeared after the app saw them running. */
  private tombstones = new Map<string, { input: Omit<ProcInput, 'alive'>; goneAt: number }>()
  private lastPrune: number | undefined
  private at = 0
  private readonly mono: () => number
  /** Per Codex home: its locks and thread inputs from the last read. */
  private codex = new Map<string, { at: number; locks: ThreadLock[]; inputs: CodexThreadInput[] }>()
  private codexEvents = new Map<string, Cached<HookEvent>>()
  /** Codex threads seen working while nobody held their lock (the desktop app). */
  private codexSeenWorking = new Set<string>()
  private readonly codexReader: CodexLiveReader

  constructor(private readonly deps: LiveDeps) {
    super()
    this.mono = deps.mono ?? (() => performance.now())
    this.codexReader = deps.codexReader ?? new CodexLiveReader()
  }

  /** A Codex thread's lock file (for Focus terminal: who holds it). */
  codexLockPath(key: string): string | undefined {
    const i = key.indexOf(':')
    const id = key.slice(i + 1)
    return this.codex.get(key.slice(0, i))?.locks.find((l) => l.threadId === id)?.path
  }

  start(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.deps.procs.dispose?.()
  }

  snapshot(): LiveSnapshot {
    return { sessions: this.current, at: this.at, hooks: this.hookEnvs }
  }

  /** Re-read the hook bridge state (after enabling or disabling it). */
  async refreshHooks(): Promise<void> {
    this.hookEnvsAt = undefined
    await this.poll(true)
  }

  /**
   * The session a tapped push alert points at. A reference works once, only
   * for the phone it was sent to, and only for a day.
   */
  resolveRef(deviceId: string, ref: unknown): string | null {
    if (typeof ref !== 'string') return null
    const r = this.refs.get(ref)
    if (!r || r.deviceId !== deviceId) return null
    this.refs.delete(ref)
    return now() - r.at <= REF_TTL_MS ? r.key : null
  }

  async poll(force = false): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.pollNow(force)
    } catch (err) {
      console.warn('running-now poll failed', err)
    } finally {
      this.polling = false
    }
  }

  private async pollNow(force: boolean): Promise<void> {
    const t = now()
    const m = this.mono()
    const dirs = this.sourceDirs()
    const idlePrompts = new Set<string>()
    for (const d of dirs) {
      const every = isUnc(d.sessionsDir) ? POLL_UNC_MS : POLL_MS
      const last = this.lastRead.get(d.src.id)
      if (!force && last !== undefined && m - last < every - 200) continue
      this.lastRead.set(d.src.id, m)
      await this.readRunning(d, t)
      for (const k of await this.readEvents(d)) idlePrompts.add(k)
    }
    const known = new Set(dirs.map((d) => d.src.id))

    // Running files, with a process check for each.
    const procs: { input: Omit<ProcInput, 'alive'>; query: ProcQuery; id: string }[] = []
    for (const [path, c] of this.running) {
      const sourceId = path.slice(0, path.indexOf('|'))
      if (!c.value || !known.has(sourceId)) continue
      const src = this.deps.sessions.source(sourceId)
      if (!src) continue
      const f = c.value
      const id = `${sourceId}|${f.pid}|${f.sessionId}`
      procs.push({
        id,
        input: {
          sourceId,
          env: src.env,
          distro: src.distro,
          file: f,
          mtime: Math.round(c.mtimeMs + clockOffset())
        },
        query: {
          env: src.env,
          distroRoot: this.deps.distroRoot(sourceId),
          pid: f.pid,
          procStart: f.procStart
        }
      })
    }
    const alive = await this.deps.procs.check(procs.map((p) => p.query))
    const inputs: ProcInput[] = procs.map((p, i) => {
      const a = alive[i]
      if (a) {
        this.wasAlive.add(p.id)
        this.goneAt.delete(p.id)
      } else if (a === false && this.wasAlive.has(p.id) && !this.goneAt.has(p.id)) {
        this.goneAt.set(p.id, t)
      }
      return { ...p.input, alive: a, goneAt: this.goneAt.get(p.id) }
    })
    const ids = new Set(procs.map((p) => p.id))
    for (const id of this.wasAlive) if (!ids.has(id)) this.wasAlive.delete(id)
    for (const id of this.goneAt.keys()) if (!ids.has(id)) this.goneAt.delete(id)
    // Running files that disappeared: Exited from when they went, for a while.
    for (const [id, tomb] of this.tombstones) {
      if (t - tomb.goneAt > EXITED_KEEP_MS || ids.has(id) || !known.has(tomb.input.sourceId))
        this.tombstones.delete(id)
      else inputs.push({ ...tomb.input, alive: false, goneAt: tomb.goneAt })
    }

    const events = [...this.events.values()]
      .map((c) => c.value)
      .filter((e): e is HookEvent => !!e && known.has(e.source) && t - e.ts < EVENT_RELEVANT_MS)

    if (force || this.hookEnvsAt === undefined || m - this.hookEnvsAt > 30_000)
      await this.describeHooks(events)
    const hooksOn = new Set(this.hookEnvs.filter((h) => h.installed).map((h) => h.sourceId))

    const claude = computeLive({
      now: t,
      procs: inputs,
      events,
      hooksOn,
      prev: this.prev,
      transcript: (key) => {
        const s = this.deps.sessions.get(key)
        if (!s) return undefined
        const at = s.lastActivityAt ? Date.parse(s.lastActivityAt) : NaN
        return {
          lastActivityAt: Number.isFinite(at) ? at : undefined,
          cwd: s.cwd,
          remoteUrl: s.remoteUrl
        }
      },
      sourceEnv: (id) => {
        const s = this.deps.sessions.source(id)
        return s ? { env: s.env, distro: s.distro } : undefined
      }
    })
    const next = [...claude, ...(await this.pollCodex(t, m, force))].sort(liveOrder)

    this.alert(this.prev, next, idlePrompts, t)
    this.prev = new Map(next.map((s) => [s.key, s]))
    this.current = next
    this.at = t
    const json = JSON.stringify([next, this.hookEnvs])
    if (json !== this.lastJson) {
      this.lastJson = json
      this.emit('changed')
    }
    if (this.lastPrune === undefined || m - this.lastPrune > 60 * 60_000) {
      this.lastPrune = m
      const codexDirs = this.codexSources().flatMap((src) => {
        const p = codexHookPaths(src)
        return p ? [{ eventsDir: join(p.bridgeDir, CODEX_EVENTS_DIR), home: dirname(p.home) }] : []
      })
      void this.prune([
        ...dirs.map((d) => ({ eventsDir: d.eventsDir, home: d.home, name: 'events' })),
        ...codexDirs.map((d) => ({ ...d, name: CODEX_EVENTS_DIR }))
      ]).catch((err: unknown) => console.warn('event prune failed', err))
      this.codexReader.prune()
    }
  }

  /** Readable Codex homes, while Codex is on (Settings → Providers). */
  private codexSources(): SourceInfo[] {
    const providers = catalogueProviders(this.deps.sessions)
    return this.deps.sessions.sources.filter((src) => {
      const p = providers.find(src)
      return p?.id === 'codex' && p.capabilities.live && src.status === 'ok'
    })
  }

  /**
   * Codex's part of Running now (see shared/codex-live.ts). Each home is read
   * every 2 s (5 s for WSL) while one of its threads is open or recently
   * active, and every 10 s (15 s) while nothing runs there.
   */
  private async pollCodex(t: number, m: number, force: boolean): Promise<LiveSession[]> {
    const sources = this.codexSources()
    const known = new Set(sources.map((s) => s.id))
    for (const id of this.codex.keys()) if (!known.has(id)) this.codex.delete(id)
    if (!sources.length) return []
    const off = clockOffset()
    // Threads whose rollout changed recently (a thread the desktop app runs may not be locked).
    const recent = new Map<string, string[]>()
    for (const s of this.deps.sessions.list()) {
      if (s.provider !== 'codex' || !known.has(s.sourceId) || !s.lastActivityAt) continue
      const at = Date.parse(s.lastActivityAt)
      if (!Number.isFinite(at) || t - at > UNLOCKED_ACTIVE_MS) continue
      const list = recent.get(s.sourceId) ?? []
      list.push(s.sessionId)
      recent.set(s.sourceId, list)
    }
    const procLocks = new Map<string, ProcLockIndex>()
    for (const src of sources) {
      const unc = isUnc(src.projectsDir)
      const open = [...(this.prev?.values() ?? [])].some(
        (s) => s.sourceId === src.id && s.state !== 'exited'
      )
      const active = open || !!recent.get(src.id)?.length
      const every = active
        ? unc
          ? CODEX_ACTIVE_UNC_MS
          : CODEX_ACTIVE_MS
        : unc
          ? CODEX_IDLE_UNC_MS
          : CODEX_IDLE_MS
      const have = this.codex.get(src.id)
      if (!force && have && m - have.at < every - 200) continue
      const locks = await this.codexReader.locks(
        { env: src.env, home: dirname(src.projectsDir), distroRoot: this.deps.distroRoot(src.id) },
        procLocks
      )
      await this.readCodexEvents(src)
      // Open threads, threads the last poll showed, and recently active ones.
      const ids = new Set<string>()
      for (const l of locks) if (l.held !== false) ids.add(l.threadId)
      for (const s of this.prev?.values() ?? [])
        if (s.sourceId === src.id && s.provider === 'codex') ids.add(s.sessionId)
      for (const id of recent.get(src.id) ?? []) ids.add(id)
      const byId = new Map(locks.map((l) => [l.threadId, l]))
      const inputs: CodexThreadInput[] = []
      for (const id of ids) {
        const key = `${src.id}:${id}`
        const s = this.deps.sessions.get(key)
        const lock = byId.get(id)
        const path = s && s.availability === 'live' ? s.originalPath : undefined
        const r = path ? await this.codexReader.rollout(path) : undefined
        inputs.push({
          sourceId: src.id,
          env: src.env,
          distro: src.distro,
          threadId: id,
          held: lock ? lock.held : false,
          heldSince: lock ? Math.round(lock.mtimeMs + off) : undefined,
          pid: lock?.pid,
          rollout: r?.state,
          rolloutMtime: r ? Math.round(r.mtimeMs + off) : undefined,
          info: {
            label: s?.source,
            parentId: s?.subagent?.parentId,
            cwd: s?.cwd
          }
        })
      }
      this.codex.set(src.id, { at: m, locks, inputs })
    }

    const events = [...this.codexEvents.values()]
      .map((c) => c.value)
      .filter((e): e is HookEvent => !!e && known.has(e.source) && t - e.ts < EVENT_RELEVANT_MS)
    const exact = this.deps.codexHooks?.exactSources(
      this.hookEnvs.filter((h) => h.provider === 'codex' && !h.hooksFeatureOff)
    )
    const rows = computeCodexLive({
      now: t,
      threads: [...this.codex.values()].flatMap((c) => c.inputs),
      events,
      exactApprovals: exact ?? new Set(),
      prev: this.prev,
      seenWorking: this.codexSeenWorking
    })
    const keys = new Set(rows.map((r) => r.key))
    for (const k of this.codexSeenWorking) if (!keys.has(k)) this.codexSeenWorking.delete(k)
    for (const r of rows) if (r.state === 'working' && !r.lockHeld) this.codexSeenWorking.add(r.key)
    return rows
  }

  /** The app's own Codex hook events (only for homes where it's installed). */
  private async readCodexEvents(src: SourceInfo): Promise<void> {
    const prefix = `${src.id}|`
    const installed = this.hookEnvs.some((h) => h.sourceId === src.id && h.installed)
    const p = codexHookPaths(src)
    const seen = new Set<string>()
    if (installed && p) {
      const dir = join(p.bridgeDir, CODEX_EVENTS_DIR)
      const names = await readdir(dir).then(
        (all) => all.filter((n) => EVENT_FILE_RE.test(n)),
        () => [] as string[]
      )
      for (const n of names) {
        const path = join(dir, n)
        const k = prefix + path
        seen.add(k)
        try {
          const st = await stat(path)
          if (!st.isFile() || st.size > 64 * 1024) continue
          const c = this.codexEvents.get(k)
          if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue
          const value = parseHookEvent(await readFile(path, 'utf8'), {
            ts: Math.round(st.mtimeMs + clockOffset()),
            source: src.id
          })
          this.codexEvents.set(k, { mtimeMs: st.mtimeMs, size: st.size, value })
        } catch {
          // Being replaced right now: read it next time.
        }
      }
    }
    for (const k of this.codexEvents.keys())
      if (k.startsWith(prefix) && !seen.has(k)) this.codexEvents.delete(k)
  }

  /** Every readable home whose provider has "Running now". */
  private sourceDirs(): SourceDirs[] {
    const providers = catalogueProviders(this.deps.sessions)
    const out: SourceDirs[] = []
    for (const src of this.deps.sessions.sources) {
      const live = providers.find(src)?.live
      const d = live?.dirs(src)
      if (live && d) out.push({ ...d, live })
    }
    return out
  }

  private async describeHooks(events: HookEvent[]): Promise<void> {
    const last = new Map<string, number>()
    for (const e of events) last.set(e.source, Math.max(last.get(e.source) ?? 0, e.ts))
    const out: HookEnv[] = []
    const providers = catalogueProviders(this.deps.sessions)
    for (const e of this.codexEvents.values())
      if (e.value) last.set(e.value.source, Math.max(last.get(e.value.source) ?? 0, e.value.ts))
    for (const src of this.deps.sessions.sources) {
      const p = providers.find(src)
      if (p?.id === 'codex' && p.capabilities.live && this.deps.codexHooks) {
        const d = await this.deps.codexHooks.describe(src, last.get(src.id)).catch(() => undefined)
        if (d) out.push(d)
        continue
      }
      if (!p?.live?.hooksPossible(src)) continue
      const d = await this.deps.hooks.describe(src, last.get(src.id)).catch(() => undefined)
      if (d) out.push(d)
    }
    this.hookEnvs = out
    this.hookEnvsAt = this.mono()
  }

  private async readRunning(d: SourceDirs, t: number): Promise<void> {
    const prefix = `${d.src.id}|`
    let names: string[]
    try {
      names = (await readdir(d.sessionsDir)).filter((n) => RUNNING_FILE_RE.test(n))
    } catch (err) {
      // Can't be listed right now (a WSL share, say): keep what was read before.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return
      names = []
    }
    const seen = new Set<string>()
    for (const n of names) {
      const path = join(d.sessionsDir, n)
      const k = prefix + path
      seen.add(k)
      try {
        const st = await stat(path)
        if (!st.isFile() || st.size > 64 * 1024) continue
        const c = this.running.get(k)
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue
        const value = d.live.parseRunning(await readFile(path, 'utf8'))
        this.running.set(k, { mtimeMs: st.mtimeMs, size: st.size, value })
      } catch {
        // Being rewritten right now: read it next time.
      }
    }
    for (const [k, c] of this.running) {
      if (!k.startsWith(prefix) || seen.has(k)) continue
      this.running.delete(k)
      // Claude Code removed the file (it does on exit): if the app saw the
      // session running, it stays as Exited for a while (bounded).
      const f = c.value
      const id = f && `${d.src.id}|${f.pid}|${f.sessionId}`
      if (!f || !id || !this.wasAlive.has(id)) continue
      this.tombstones.set(id, {
        input: {
          sourceId: d.src.id,
          env: d.src.env,
          distro: d.src.distro,
          file: f,
          mtime: Math.round(c.mtimeMs + clockOffset())
        },
        goneAt: this.goneAt.get(id) ?? t
      })
      if (this.tombstones.size > 200) this.tombstones.delete(this.tombstones.keys().next().value!)
    }
  }

  /** Read new or changed event files; returns sessions that just got an idle reminder. */
  private async readEvents(d: SourceDirs): Promise<string[]> {
    const prefix = `${d.src.id}|`
    const idle: string[] = []
    let names: string[]
    try {
      names = (await readdir(d.eventsDir)).filter((n) => EVENT_FILE_RE.test(n))
    } catch {
      names = []
    }
    const seen = new Set<string>()
    for (const n of names) {
      const path = join(d.eventsDir, n)
      const k = prefix + path
      seen.add(k)
      try {
        const st = await stat(path)
        if (!st.isFile() || st.size > 1024 * 1024) continue
        const c = this.events.get(k)
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue
        const value = d.live.parseHook(await readFile(path, 'utf8'), {
          ts: Math.round(st.mtimeMs + clockOffset()),
          source: d.src.id
        })
        this.events.set(k, { mtimeMs: st.mtimeMs, size: st.size, value })
        // A reminder that arrived since the last read (not one found at startup).
        if (c && value?.event === 'Notification' && value.notificationType === 'idle_prompt')
          idle.push(`${d.src.id}:${value.sessionId}`)
      } catch {
        // Being replaced right now: read it next time.
      }
    }
    for (const k of this.events.keys())
      if (k.startsWith(prefix) && !seen.has(k)) this.events.delete(k)
    return idle
  }

  private alert(
    prev: Map<string, LiveSession> | undefined,
    next: LiveSession[],
    idlePrompts: Set<string>,
    t: number
  ): void {
    const settings = this.deps.settings()
    for (const a of detectAlerts(prev, next, idlePrompts)) {
      const v = alertVerdict(a, settings, {
        now: t,
        muted: (key) => this.deps.sessions.get(key)?.meta.muteAlerts === true,
        workedSince: (key) => {
          const p = prev?.get(key)
          return p?.state === 'working' ? p.since : undefined
        },
        lastShown: (key, kind) => this.lastShown.get(`${key}|${kind}`)
      })
      if (!v.show) continue
      this.lastShown.set(`${a.key}|${a.kind}`, t)
      const s = this.deps.sessions.get(a.key)
      const title = s?.title ?? a.session.name ?? a.session.cwd?.split(/[\\/]/).pop() ?? 'A session'
      if (v.desktop) {
        try {
          this.deps.notify(a, title)
        } catch (err) {
          console.warn('desktop alert failed', err)
        }
      }
      if (v.phone) {
        void this.deps
          .push(a.kind, (deviceId) => this.newRef(a.key, deviceId, t))
          .catch((err: unknown) => console.warn('push failed', err))
      }
    }
  }

  /** A random reference for one phone's push; only the PC knows which session it means. */
  private newRef(key: string, deviceId: string, t: number): string {
    const ref = randomBytes(12).toString('base64url')
    this.refs.set(ref, { key, deviceId, at: t })
    if (this.refs.size > 500) {
      const oldest = [...this.refs.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)
      for (const [r] of oldest) this.refs.delete(r)
    }
    return ref
  }

  /**
   * Delete the app's own event files older than a week. Only files named like
   * the hook script names them, directly in the real
   * `<home>/.claude-session-dashboard/events` folder (links followed), never
   * anything in `.claude`.
   */
  private async prune(dirs: { eventsDir: string; home: string; name: string }[]): Promise<void> {
    const cutoff = Date.now() - EVENT_KEEP_MS
    for (const d of dirs) {
      let real: string
      try {
        const [r, h] = await Promise.all([realpath(d.eventsDir), realpath(d.home)])
        const expected = join(h, BRIDGE_DIR_NAME, d.name)
        const same =
          process.platform === 'win32' ? r.toLowerCase() === expected.toLowerCase() : r === expected
        if (!same || isInsideClaudeDir(r)) continue
        real = r
      } catch {
        continue
      }
      let names: string[]
      try {
        names = await readdir(real)
      } catch {
        continue
      }
      for (const n of names) {
        const tmp = /^\.tmp\.\d+\./.test(n) && EVENT_FILE_RE.test(n.replace(/^\.tmp\.\d+\./, ''))
        if (!EVENT_FILE_RE.test(n) && !tmp) continue
        const file = join(real, n)
        try {
          const st = await lstat(file)
          // Temp files are only left behind by a hook that was killed.
          if (!st.isFile() || st.mtimeMs > (tmp ? Date.now() - 10 * 60_000 : cutoff)) continue
          await unlink(file)
        } catch {
          // Gone already, or in use.
        }
      }
    }
  }
}
