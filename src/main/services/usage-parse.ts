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

/**
 * Parses in a worker thread, one file at a time, in the order asked. If the
 * thread stops (or can't start), the rest is parsed in this thread.
 */
export class WorkerParser implements UsageParser {
  private worker?: Worker
  private seq = 0
  private waiting = new Map<
    number,
    { job: UsageParseJob; ok: (v: UsageAnalysis | undefined) => void; fail: (e: Error) => void }
  >()
  private readonly fallback = new InProcessParser()

  constructor(workerPath: string, maxHeapMb = 1024) {
    try {
      this.worker = new Worker(workerPath, {
        resourceLimits: { maxOldGenerationSizeMb: maxHeapMb }
      })
    } catch (err) {
      console.warn('usage parser thread did not start, parsing in the main thread', err)
      return
    }
    this.worker.unref()
    this.worker.on('message', (m: Reply) => {
      const w = this.waiting.get(m.id)
      if (!w) return
      this.waiting.delete(m.id)
      if (m.ok) w.ok(m.value)
      else w.fail(new Error(m.error))
    })
    const gone = (why: unknown): void => {
      if (!this.worker) return
      console.warn('usage parser thread stopped, parsing in the main thread', why)
      this.worker = undefined
      // Whatever was waiting is parsed here instead.
      const left = [...this.waiting.values()]
      this.waiting.clear()
      for (const w of left) this.fallback.parse(w.job).then(w.ok, w.fail)
    }
    this.worker.on('error', gone)
    this.worker.on('exit', (code) => gone(`exit code ${code}`))
  }

  parse(job: UsageParseJob): Promise<UsageAnalysis | undefined> {
    const worker = this.worker
    if (!worker) return this.fallback.parse(job)
    const id = ++this.seq
    return new Promise((ok, fail) => {
      this.waiting.set(id, { job, ok, fail })
      worker.postMessage({ id, job })
    })
  }

  async stop(): Promise<void> {
    const w = this.worker
    this.worker = undefined
    await w?.terminate()
  }
}
