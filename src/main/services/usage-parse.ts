// Reading and parsing one session file's token usage: in a worker thread in
// the app (a big rollout's JSON parse never holds up the window's IPC), or in
// this thread (tests, and when the worker can't run). Both give the same
// analysis: the worker runs this file's parseUsageFile.

import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { parseJsonl } from '@shared/jsonl'
import { analyzeUsage, type UsageContext } from '@shared/usage/parse'
import type { UsageAnalysis } from '@shared/usage/types'
import { analyzeCodexUsage } from '../providers/codex/usage'
import { noteWorker } from '../timing'
import { readCodexUsageText } from '../providers/codex/read'

export interface UsageParseJob {
  /** Whose file: Claude Code's transcript or a Codex rollout. */
  provider: 'claude' | 'codex'
  path: string
  ctx: UsageContext
}

/** One file's usage, or undefined when the file can't be read (it's tried again later). */
export async function parseUsageFile(job: UsageParseJob): Promise<UsageAnalysis | undefined> {
  let text: string
  try {
    text =
      job.provider === 'codex'
        ? await readCodexUsageText(job.path)
        : await readFile(job.path, 'utf8')
  } catch {
    return undefined
  }
  return job.provider === 'codex'
    ? analyzeCodexUsage(text, job.ctx)
    : analyzeUsage(parseJsonl(text).events, job.ctx)
}

export interface UsageParser {
  parse(job: UsageParseJob): Promise<UsageAnalysis | undefined>
  /** A run of parses (a scan) is over: what it holds can be let go soon. */
  rest?(): void
  stop(): Promise<void>
}

/** Parses in this thread. */
export class InProcessParser implements UsageParser {
  parse(job: UsageParseJob): Promise<UsageAnalysis | undefined> {
    return parseUsageFile(job)
  }
  async stop(): Promise<void> {}
}

type Reply =
  { id: number; ok: true; value?: UsageAnalysis } | { id: number; ok: false; error: string }

/** How long the thread stays with nothing to parse before it's let go (its memory with it). */
const IDLE_MS = 20_000
/** After a scan: soon (a file that changes again right away reuses the thread). */
const REST_MS = 2_000

/**
 * Parses in a worker thread, one file at a time, in the order asked. The
 * thread starts when there's a file to parse and ends after a while with
 * nothing to do (parsing big rollouts leaves a big heap behind). If it fails
 * (can't start, or stops on its own), everything is parsed in this thread
 * from then on.
 */
export class WorkerParser implements UsageParser {
  private worker?: Worker
  private broken = false
  private idle?: NodeJS.Timeout
  private seq = 0
  private waiting = new Map<
    number,
    { job: UsageParseJob; ok: (v: UsageAnalysis | undefined) => void; fail: (e: Error) => void }
  >()
  private readonly fallback = new InProcessParser()

  constructor(
    private readonly workerPath: string,
    private readonly maxHeapMb = 1024,
    private readonly idleMs = IDLE_MS,
    private readonly restMs = REST_MS
  ) {}

  private start(): Worker | undefined {
    if (this.worker || this.broken) return this.worker
    let worker: Worker
    try {
      worker = new Worker(this.workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: this.maxHeapMb }
      })
    } catch (err) {
      console.warn('usage parser thread did not start, parsing in the main thread', err)
      this.broken = true
      return undefined
    }
    worker.unref()
    noteWorker('usage parser', worker)
    worker.on('message', (m: Reply) => {
      const w = this.waiting.get(m.id)
      if (!w) return
      this.waiting.delete(m.id)
      if (m.ok) w.ok(m.value)
      else w.fail(new Error(m.error))
      this.restIfIdle()
    })
    const gone = (why: unknown): void => {
      noteWorker('usage parser', undefined)
      if (this.worker !== worker) return // let go on purpose (idle, stop)
      console.warn('usage parser thread stopped, parsing in the main thread', why)
      this.worker = undefined
      this.broken = true
      // Whatever was waiting is parsed here instead.
      const left = [...this.waiting.values()]
      this.waiting.clear()
      for (const w of left) this.fallback.parse(w.job).then(w.ok, w.fail)
    }
    worker.on('error', gone)
    worker.on('exit', (code) => gone(`exit code ${code}`))
    this.worker = worker
    return worker
  }

  /** Nothing waiting: end the thread after a while unless more comes. */
  private restIfIdle(ms = this.idleMs): void {
    if (this.waiting.size) return
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.idle = undefined
      if (this.waiting.size || !this.worker) return
      const w = this.worker
      this.worker = undefined
      void w.terminate()
    }, ms)
    this.idle.unref()
  }

  /** The scan is over: the thread (and the heap big files left in it) goes soon, not after IDLE_MS. */
  rest(): void {
    if (this.worker) this.restIfIdle(Math.min(this.restMs, this.idleMs))
  }

  /** The thread is running (tests). */
  get running(): boolean {
    return !!this.worker
  }

  parse(job: UsageParseJob): Promise<UsageAnalysis | undefined> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = undefined
    const worker = this.start()
    if (!worker) return this.fallback.parse(job)
    const id = ++this.seq
    return new Promise((ok, fail) => {
      this.waiting.set(id, { job, ok, fail })
      worker.postMessage({ id, job })
    })
  }

  async stop(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    const w = this.worker
    this.worker = undefined
    this.broken = true
    await w?.terminate()
  }
}
