// Where the Ask index runs: in a worker thread (the app), so reading and
// indexing thousands of sessions never holds up the window or its IPC, with
// its own memory cap; or in this thread (tests, and as a fallback).

import { Worker } from 'node:worker_threads'
import {
  IndexCore,
  type CoreStatus,
  type IndexJob,
  type SearchRequest,
  type SearchResult
} from './core'
import type { ReadDeps } from './read'

export interface IndexHost {
  sync(jobs: IndexJob[], budgetChars: number): void
  search(req: SearchRequest): Promise<SearchResult>
  /** The latest status it reported. */
  status(): CoreStatus | undefined
  save(): Promise<void>
  clear(): Promise<void>
  stop(): Promise<void>
  onStatus(cb: (s: CoreStatus) => void): void
}

export interface HostOptions {
  /** `<data>/cache/ask`. */
  dir: string
  /** The app's data folder (the Codex text cache is in it). */
  dataDir: string
  minReindexMs?: number
  saveDelayMs?: number
}

/** Runs the index in this thread (tests; fixtures mode can use it too). */
export class InProcessHost implements IndexHost {
  private readonly core: IndexCore
  private readonly loaded: Promise<void>
  private last: CoreStatus | undefined
  private listeners: ((s: CoreStatus) => void)[] = []

  constructor(opts: HostOptions & { read?: ReadDeps; now?: () => number }) {
    this.core = new IndexCore({
      dir: opts.dir,
      read: opts.read,
      now: opts.now,
      minReindexMs: opts.minReindexMs,
      saveDelayMs: opts.saveDelayMs,
      onStatus: (s) => {
        this.last = s
        for (const cb of this.listeners) cb(s)
      }
    })
    this.loaded = this.core.load()
  }

  sync(jobs: IndexJob[], budgetChars: number): void {
    void this.loaded.then(() => this.core.sync(jobs, budgetChars))
  }

  async search(req: SearchRequest): Promise<SearchResult> {
    await this.loaded
    return this.core.search(req)
  }

  status(): CoreStatus | undefined {
    return this.last
  }

  async save(): Promise<void> {
    await this.loaded
    await this.core.save()
  }

  async clear(): Promise<void> {
    await this.loaded
    await this.core.clear()
  }

  async stop(): Promise<void> {
    await this.loaded
    await this.core.stop()
  }

  onStatus(cb: (s: CoreStatus) => void): void {
    this.listeners.push(cb)
  }

  /** Nothing left to read (tests). */
  async idle(): Promise<void> {
    await this.loaded
    await this.core.idle()
  }
}

type Reply = { t: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
type FromWorker = { t: 'status'; status: CoreStatus } | Reply

/** Runs the index in a worker thread with its own heap cap. */
export class WorkerHost implements IndexHost {
  private readonly worker: Worker
  private last: CoreStatus | undefined
  private listeners: ((s: CoreStatus) => void)[] = []
  private seq = 0
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  private gone?: string

  constructor(workerPath: string, opts: HostOptions & { maxHeapMb: number }) {
    this.worker = new Worker(workerPath, {
      workerData: {
        dir: opts.dir,
        dataDir: opts.dataDir,
        minReindexMs: opts.minReindexMs,
        saveDelayMs: opts.saveDelayMs
      },
      resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb }
    })
    this.worker.unref()
    this.worker.on('message', (m: FromWorker) => {
      if (m.t === 'status') {
        this.last = m.status
        for (const cb of this.listeners) cb(m.status)
        return
      }
      const w = this.waiting.get(m.id)
      if (!w) return
      this.waiting.delete(m.id)
      if (m.ok) w.ok(m.value)
      else w.fail(new Error(m.error ?? 'The index failed'))
    })
    const fail = (why: string): void => {
      if (this.gone) return
      this.gone = why
      for (const w of this.waiting.values()) w.fail(new Error(why))
      this.waiting.clear()
      const s: CoreStatus = {
        ...(this.last ?? {
          sessions: 0,
          passages: 0,
          chars: 0,
          bytes: 0,
          done: 0,
          total: 0,
          skipped: 0
        }),
        phase: 'error',
        error: why
      }
      this.last = s
      for (const cb of this.listeners) cb(s)
    }
    this.worker.on('error', (err: Error & { code?: string }) =>
      fail(
        err.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? `The index ran out of memory (its limit is ${opts.maxHeapMb} MB). Lower the index size in Settings → Ask, then Rebuild.`
          : `The index stopped: ${err.message}`
      )
    )
    this.worker.on('exit', (code) => {
      if (code !== 0) fail(`The index stopped (exit code ${code}).`)
      else this.gone ??= 'stopped'
    })
  }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    if (this.gone) return Promise.reject(new Error(this.gone))
    const id = ++this.seq
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail })
      this.worker.postMessage({ ...msg, id })
    })
  }

  sync(jobs: IndexJob[], budgetChars: number): void {
    if (!this.gone) this.worker.postMessage({ t: 'sync', jobs, budget: budgetChars })
  }

  search(req: SearchRequest): Promise<SearchResult> {
    return this.call<SearchResult>({ t: 'search', req })
  }

  status(): CoreStatus | undefined {
    return this.last
  }

  save(): Promise<void> {
    return this.call<void>({ t: 'save' })
  }

  clear(): Promise<void> {
    return this.call<void>({ t: 'clear' })
  }

  async stop(): Promise<void> {
    if (this.gone) return
    // Save, then end the thread (a save that hangs is cut short after 10 s).
    await Promise.race([
      this.call<void>({ t: 'stop' }).catch(() => undefined),
      new Promise((r) => setTimeout(r, 10_000))
    ])
    await this.worker.terminate().catch(() => undefined)
  }

  onStatus(cb: (s: CoreStatus) => void): void {
    this.listeners.push(cb)
  }
}
