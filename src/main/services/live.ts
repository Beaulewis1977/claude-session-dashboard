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
  parseHookEvent,
  parseRunningFile,
  type HookEnv,
  type HookEvent,
  type LiveSession,
  type LiveSnapshot,
  type ProcInput,
  type RunningFile
} from '@shared/live'
import {
  alertVerdict,
  detectAlerts,
  type Alert,
  type AlertKind,
  type LiveAlertSettings
} from '@shared/live-alerts'
import type { SourceInfo } from '@shared/types'
import { isInsideClaudeDir } from '../core/safe-paths'
import type { Alive, ProcQuery } from '../core/procs'
import { BRIDGE_DIR_NAME, envPaths } from './bridge'
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
}

export interface LiveDeps {
  sessions: SessionService
  hooks: HooksInstaller
  procs: ProcCheck
  settings: () => LiveAlertSettings
  /** Desktop notification. */
  notify: (alert: Alert, title: string) => void
  /** Web Push to phones that turned it on; returns how many got it. */
  push: (kind: AlertKind, ref: string) => Promise<number>
  /** Host path of a WSL source's distro root (for /proc). */
  distroRoot: (sourceId: string) => string | undefined
}

interface Cached<T> {
  mtimeMs: number
  size: number
  value: T | undefined
}

interface SourceDirs {
  src: SourceInfo
  sessionsDir: string
  eventsDir: string
  home: string
}

export function sourceDirs(src: SourceInfo): SourceDirs | undefined {
  const p = envPaths(src)
  if (!p || src.status !== 'ok') return undefined
  return {
    src,
    sessionsDir: join(dirname(p.settingsPath), 'sessions'),
    eventsDir: join(p.bridgeDir, 'events'),
    home: p.home
  }
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
  private hookEnvsAt = 0
  private lastShown = new Map<string, number>()
  private refs = new Map<string, { key: string; at: number }>()
  private lastPrune = 0
  private at = 0

  constructor(private readonly deps: LiveDeps) {
    super()
  }

  start(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  snapshot(): LiveSnapshot {
    return { sessions: this.current, at: this.at, hooks: this.hookEnvs }
  }

  /** Re-read the hook bridge state (after enabling or disabling it). */
  async refreshHooks(): Promise<void> {
    this.hookEnvsAt = 0
    await this.poll(true)
  }

  /** The session an alert's opaque reference points at (a tapped phone notification). */
  resolveRef(ref: unknown): string | null {
    return typeof ref === 'string' ? (this.refs.get(ref)?.key ?? null) : null
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
    const dirs = this.deps.sessions.sources.map(sourceDirs).filter((d): d is SourceDirs => !!d)
    const idlePrompts = new Set<string>()
    for (const d of dirs) {
      const every = isUnc(d.sessionsDir) ? POLL_UNC_MS : POLL_MS
      if (!force && t - (this.lastRead.get(d.src.id) ?? 0) < every - 200) continue
      this.lastRead.set(d.src.id, t)
      await this.readRunning(d)
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

    const events = [...this.events.values()]
      .map((c) => c.value)
      .filter((e): e is HookEvent => !!e && known.has(e.source) && t - e.ts < EVENT_RELEVANT_MS)

    if (force || t - this.hookEnvsAt > 30_000) await this.describeHooks(events)
    const hooksOn = new Set(this.hookEnvs.filter((h) => h.installed).map((h) => h.sourceId))

    const next = computeLive({
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

    this.alert(this.prev, next, idlePrompts, t)
    this.prev = new Map(next.map((s) => [s.key, s]))
    this.current = next
    this.at = t
    const json = JSON.stringify([next, this.hookEnvs])
    if (json !== this.lastJson) {
      this.lastJson = json
      this.emit('changed')
    }
    if (t - this.lastPrune > 60 * 60_000) {
      this.lastPrune = t
      void this.prune(dirs).catch((err: unknown) => console.warn('event prune failed', err))
    }
  }

  private async describeHooks(events: HookEvent[]): Promise<void> {
    const last = new Map<string, number>()
    for (const e of events) last.set(e.source, Math.max(last.get(e.source) ?? 0, e.ts))
    const out: HookEnv[] = []
    for (const src of this.deps.sessions.sources) {
      if (src.kind !== 'auto' || !src.claudeSettingsPath) continue
      const d = await this.deps.hooks.describe(src, last.get(src.id)).catch(() => undefined)
      if (d) out.push(d)
    }
    this.hookEnvs = out
    this.hookEnvsAt = now()
  }

  private async readRunning(d: SourceDirs): Promise<void> {
    const prefix = `${d.src.id}|`
    let names: string[]
    try {
      names = (await readdir(d.sessionsDir)).filter((n) => RUNNING_FILE_RE.test(n))
    } catch {
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
        const value = parseRunningFile(await readFile(path, 'utf8'))
        this.running.set(k, { mtimeMs: st.mtimeMs, size: st.size, value })
      } catch {
        // Being rewritten right now: read it next time.
      }
    }
    for (const k of this.running.keys())
      if (k.startsWith(prefix) && !seen.has(k)) this.running.delete(k)
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
        const value = parseHookEvent(await readFile(path, 'utf8'), {
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
        const ref = this.newRef(a.key, t)
        void this.deps.push(a.kind, ref).catch((err: unknown) => console.warn('push failed', err))
      }
    }
  }

  /** A random reference for a push; only the PC knows which session it means. */
  private newRef(key: string, t: number): string {
    const ref = randomBytes(12).toString('base64url')
    this.refs.set(ref, { key, at: t })
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
  private async prune(dirs: SourceDirs[]): Promise<void> {
    const cutoff = Date.now() - EVENT_KEEP_MS
    for (const d of dirs) {
      let real: string
      try {
        const [r, h] = await Promise.all([realpath(d.eventsDir), realpath(d.home)])
        const expected = join(h, BRIDGE_DIR_NAME, 'events')
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
