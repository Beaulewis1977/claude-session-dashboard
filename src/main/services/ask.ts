// Runs "Ask Claude" questions through `claude -p` on the user's subscription.
// The prompt goes on stdin; the command line holds fixed flags only, with no
// tools allowed and never --dangerously-skip-permissions. Before anything is
// sent, `claude auth status` (in the same environment) must confirm the
// subscription (see print-runner.ts, shared with session summaries). Answers
// are kept in the app's own data folder.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  askCommand,
  buildAskPrompt,
  parseAskOutput,
  tooOldForAsk,
  type AskCli,
  type AskData,
  type AskHistoryItem,
  type SubscriptionCheck
} from '@shared/ask'
import { now } from '@shared/clock'
import { JsonStore } from '../core/json-store'
import { PrintRunner, type PrintRequest } from './print-runner'
import { type AskRunner } from './cli-process'

export {
  AUTH_TIMED_OUT,
  childEnv,
  findClaudeCli,
  spawnRunner,
  type AskRunner,
  type RunHandle,
  type RunResult
} from './cli-process'

export interface AskHistoryFile {
  version: 1
  items: AskHistoryItem[]
}

export function createAskStore(dataDir: string): JsonStore<AskHistoryFile> {
  return new JsonStore<AskHistoryFile>(join(dataDir, 'ask-history.json'), dataDir, () => ({
    version: 1,
    items: []
  }))
}

const MAX_HISTORY = 200
const PREVIEW_TTL = 30 * 60_000

export interface AskServiceDeps {
  store: JsonStore<AskHistoryFile>
  dataDir: string
  /** Aggregates for the prompt (computed fresh for each question). */
  data: () => Promise<AskData>
  timeoutSec: () => number
  findCli?: () => Promise<AskCli | undefined>
  runner?: AskRunner
  /** Would this CLI run on the subscription? (Default: `claude auth status`.) */
  checkAuth?: (cli: AskCli, cwd: string) => Promise<SubscriptionCheck>
  /** Share one runner (and its CLI lookup and subscription check) with summaries. */
  printRunner?: PrintRunner
  /** Fixtures mode: answer with a sample instead of running anything. */
  simulate?: boolean
}

export interface AskStatus {
  available: boolean
  where?: string
  simulated: boolean
}

export class AskService {
  private readonly cli: PrintRunner
  private previews = new Map<string, { question: string; prompt: string; at: number }>()
  /** Questions being answered, from the moment Send is clicked (so Cancel always works). */
  private running = new Map<string, PrintRequest>()

  constructor(private readonly deps: AskServiceDeps) {
    this.cli =
      deps.printRunner ??
      new PrintRunner({ findCli: deps.findCli, runner: deps.runner, checkAuth: deps.checkAuth })
  }

  async status(): Promise<AskStatus> {
    if (this.deps.simulate)
      return { available: true, where: 'Sample answers (fixtures mode)', simulated: true }
    const cli = await this.cli.findCli()
    return { available: !!cli, where: cli?.label, simulated: false }
  }

  /** Exactly what would be sent for a question. */
  async preview(question: string): Promise<{ id: string; prompt: string; bytes: number }> {
    const prompt = buildAskPrompt(question, await this.deps.data())
    const id = randomBytes(8).toString('hex')
    const t = Date.now()
    for (const [k, v] of this.previews) if (t - v.at > PREVIEW_TTL) this.previews.delete(k)
    this.previews.set(id, { question, prompt, at: t })
    return { id, prompt, bytes: Buffer.byteLength(prompt) }
  }

  history(): AskHistoryItem[] {
    return [...this.deps.store.value.items].sort((a, b) => b.at - a.at)
  }

  cancel(id: string): void {
    const r = this.running.get(id)
    if (r) this.cli.cancel(r)
  }

  /** Run a previewed prompt (so what was shown is what is sent). */
  async run(previewId: string): Promise<AskHistoryItem> {
    const p = this.previews.get(previewId)
    if (!p) throw new Error('This preview has expired. Ask again.')
    this.previews.delete(previewId)
    const req = this.cli.newRequest()
    this.running.set(previewId, req)
    const started = Date.now()
    const base = {
      id: previewId,
      at: now(),
      question: p.question,
      sentBytes: Buffer.byteLength(p.prompt)
    }
    let item: AskHistoryItem
    try {
      item = await this.answer(p.question, p.prompt, req, base, started)
    } finally {
      this.running.delete(previewId)
    }
    this.deps.store.update((d) => {
      d.items = [item, ...d.items].slice(0, MAX_HISTORY)
    })
    return item
  }

  private async answer(
    question: string,
    prompt: string,
    req: PrintRequest,
    base: Pick<AskHistoryItem, 'id' | 'at' | 'question' | 'sentBytes'>,
    started: number
  ): Promise<AskHistoryItem> {
    const stopped = (where: string, error: string): AskHistoryItem => ({
      ...base,
      ok: false,
      answer: '',
      error,
      durationMs: Date.now() - started,
      where
    })
    if (this.deps.simulate) {
      await this.cli.until(req, new Promise((r) => setTimeout(r, 900)))
      if (req.cancelled) return stopped('Sample answer (fixtures mode)', 'Cancelled.')
      return {
        ...base,
        ok: true,
        answer: sampleAnswer(question),
        durationMs: Date.now() - started,
        where: 'Sample answer (fixtures mode)'
      }
    }
    // Every wait ends as soon as Cancel is clicked, and nothing is sent after that.
    const out = await this.cli.run(req, prompt, {
      cwd: join(this.deps.dataDir, 'ask'),
      timeoutMs: this.deps.timeoutSec() * 1000,
      command: askCommand
    })
    if (out.kind === 'cancelled') return stopped(out.where, 'Cancelled.')
    if (out.kind === 'refused')
      return out.noCli
        ? { ...stopped(out.where, out.error), durationMs: 0 }
        : stopped(out.where, out.error)
    const res = out.result
    const parsed = parseAskOutput(res.stdout, res.stderr, res.code)
    return {
      ...base,
      ok: parsed.ok && !res.timedOut && !res.cancelled,
      answer: parsed.answer,
      error: res.cancelled
        ? 'Cancelled.'
        : res.timedOut
          ? `No answer after ${this.deps.timeoutSec()} seconds. Try again, or raise the timeout in Settings.`
          : !parsed.ok && tooOldForAsk(res.stderr)
            ? 'This version of Claude Code is too old for Ask Claude, which runs it in safe mode with none of your settings. Update it with `claude update`, then try again.'
            : parsed.error,
      costUsd: parsed.costUsd,
      durationMs: Date.now() - started,
      where: out.where
    }
  }
}

function sampleAnswer(q: string): string {
  return [
    `**Sample answer** — fixtures mode doesn't run Claude. On your computer, this question ("${q}") goes to \`claude -p\` with the numbers shown in the preview.`,
    '',
    '- Your 5-hour windows since Oct 1 buy about **0.8×** the work per 1% of your September baseline.',
    "- That's a lasting dip, but it stays above the flag line (0.67×), so the verdict is **Normal**.",
    '- Opus 5.5 became your main model on Sep 29, which shifts the token mix; one price per model family keeps that from reading as a cut.',
    '',
    'Confidence: medium — 40+ windows on each side, little usage from elsewhere.'
  ].join('\n')
}
