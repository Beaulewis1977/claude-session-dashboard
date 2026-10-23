// Runs "Ask Claude" questions through `claude -p` on the user's subscription.
// The prompt goes on stdin; the command line holds fixed flags only, with no
// tools allowed and never --dangerously-skip-permissions. Before anything is
// sent, `claude auth status` (in the same environment) must confirm the
// subscription. Answers are kept in the app's own data folder.

import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  askCommand,
  authStatusCommand,
  buildAskPrompt,
  askEnvAllowed,
  parseAskOutput,
  subscriptionCheck,
  tooOldForAsk,
  type AskCli,
  type AskCommand,
  type AskData,
  type AskHistoryItem,
  type SubscriptionCheck
} from '@shared/ask'
import { now } from '@shared/clock'
import { JsonStore } from '../core/json-store'
import { findWindowsClaude, systemExe } from '../core/which'

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  cancelled: boolean
}

export interface RunHandle {
  done: Promise<RunResult>
  cancel(): void
}

export type AskRunner = (
  cmd: AskCommand,
  stdin: string,
  opts: { cwd: string; timeoutMs: number }
) => RunHandle

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

export const AUTH_TIMED_OUT =
  "Couldn't confirm that Claude Code would use your Claude subscription: `claude auth status` didn't finish in time. Try again."

/**
 * Environment for the CLI: only the allowlisted variables (see ASK_ENV_ALLOW),
 * so no API key, custom header, gateway or provider setting from the app's own
 * environment can change how the request is authenticated or billed.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && askEnvAllowed(k)) env[k] = v
  return env
}

/** A question from Send until it's answered; Cancel works at every step. */
interface AskRequest {
  cancelled: boolean
  /** The process running now (the subscription check, then the question). */
  handle?: RunHandle
  /** Settles when Cancel is clicked. */
  stopped: Promise<'cancelled'>
  stop: () => void
}

function newRequest(): AskRequest {
  let stop: () => void = () => undefined
  const stopped = new Promise<'cancelled'>((resolve) => (stop = () => resolve('cancelled')))
  return { cancelled: false, stopped, stop }
}

/** Spawns the CLI, writes the prompt to stdin, and kills it on timeout or cancel. */
export const spawnRunner: AskRunner = (cmd, stdin, opts) => {
  // wsl.exe by its full path (the shared command names it only).
  const command = cmd.command === 'wsl.exe' ? systemExe('wsl.exe') : cmd.command
  const child = spawn(command, cmd.args, {
    cwd: opts.cwd,
    shell: cmd.shell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv()
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let cancelled = false
  const kill = (): void => {
    if (child.exitCode !== null) return
    // A shell-wrapped .cmd needs the whole tree killed on Windows.
    if (process.platform === 'win32' && child.pid)
      execFile(
        systemExe('taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => undefined
      )
    else child.kill()
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, opts.timeoutMs)
  const done = new Promise<RunResult>((resolve) => {
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < 4_000_000) stdout += d
    })
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 200_000) stderr += d
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: stderr || err.message, code: null, timedOut, cancelled })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, timedOut, cancelled })
    })
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(stdin, 'utf8')
  return {
    done,
    cancel: () => {
      cancelled = true
      kill()
    }
  }
}

function run(cmd: string, args: string[], timeout: number): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile(cmd, args, { windowsHide: true, timeout }, (err, out) =>
      resolve(err ? undefined : String(out))
    )
  )
}

/** Windows install first, then the default WSL distro. */
export async function findClaudeCli(): Promise<AskCli | undefined> {
  if (process.platform === 'win32') {
    // By absolute path, never from the current folder (see core/which.ts).
    const path = await findWindowsClaude()
    if (path) return { kind: 'native', path, label: 'Windows' }
    const wsl = await run(systemExe('wsl.exe'), ['--', 'bash', '-lic', 'command -v claude'], 20_000)
    if (wsl?.trim()) return { kind: 'wsl', label: 'WSL (default distro)' }
    return undefined
  }
  const which = await run('sh', ['-lc', 'command -v claude'], 4000)
  return which?.trim()
    ? { kind: 'native', path: which.trim().split('\n')[0], label: 'This computer' }
    : undefined
}

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
  /** Fixtures mode: answer with a sample instead of running anything. */
  simulate?: boolean
}

export interface AskStatus {
  available: boolean
  where?: string
  simulated: boolean
}

export class AskService {
  private cli: Promise<AskCli | undefined> | undefined
  private previews = new Map<string, { question: string; prompt: string; at: number }>()
  /** Questions being answered, from the moment Send is clicked (so Cancel always works). */
  private running = new Map<string, AskRequest>()
  private authOk = new Map<string, number>()

  constructor(private readonly deps: AskServiceDeps) {}

  async status(): Promise<AskStatus> {
    if (this.deps.simulate)
      return { available: true, where: 'Sample answers (fixtures mode)', simulated: true }
    const cli = await this.findCli()
    return { available: !!cli, where: cli?.label, simulated: false }
  }

  private findCli(): Promise<AskCli | undefined> {
    if (!this.cli) {
      this.cli = (this.deps.findCli ?? findClaudeCli)()
      // Look again next time if nothing was found (it may get installed).
      void this.cli.then((c) => {
        if (!c) this.cli = undefined
      })
    }
    return this.cli
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
    if (!r) return
    r.cancelled = true
    r.handle?.cancel()
    r.stop()
  }

  /** Wait for `p`, or stop waiting as soon as the request is cancelled. */
  private until<T>(req: AskRequest, p: Promise<T>): Promise<T | 'cancelled'> {
    return Promise.race([p, req.stopped])
  }

  /** `claude auth status` in the same environment the question runs in (a confirmed answer is kept 5 minutes). */
  private async checkAuth(
    cli: AskCli,
    cwd: string,
    req: AskRequest
  ): Promise<SubscriptionCheck | 'cancelled'> {
    const key = `${cli.kind}|${cli.path ?? ''}|${cli.distro ?? ''}`
    const at = this.authOk.get(key)
    if (at && Date.now() - at < 5 * 60_000) return { ok: true, method: 'cached' }
    let res: SubscriptionCheck | 'cancelled'
    if (this.deps.checkAuth) res = await this.until(req, this.deps.checkAuth(cli, cwd))
    else {
      // Registered like the question itself, so Cancel stops this process too.
      const handle = (this.deps.runner ?? spawnRunner)(authStatusCommand(cli), '', {
        cwd,
        timeoutMs: 30_000
      })
      req.handle = handle
      const out = await this.until(req, handle.done)
      req.handle = undefined
      // Only a check that ran to the end counts: output printed before a
      // timeout or a failure proves nothing.
      res =
        out === 'cancelled' || out.cancelled
          ? 'cancelled'
          : out.timedOut
            ? { ok: false, reason: AUTH_TIMED_OUT }
            : subscriptionCheck(out.stdout, out.code)
    }
    if (res !== 'cancelled') {
      if (res.ok) this.authOk.set(key, Date.now())
      else this.authOk.delete(key)
    }
    return res
  }

  /** Run a previewed prompt (so what was shown is what is sent). */
  async run(previewId: string): Promise<AskHistoryItem> {
    const p = this.previews.get(previewId)
    if (!p) throw new Error('This preview has expired. Ask again.')
    this.previews.delete(previewId)
    const req = newRequest()
    this.running.set(previewId, req)
    const started = Date.now()
    const base = {
      id: previewId,
      at: now(),
      question: p.question,
      sentBytes: Buffer.byteLength(p.prompt)
    }
    const stopped = (where: string, error: string): AskHistoryItem => ({
      ...base,
      ok: false,
      answer: '',
      error,
      durationMs: Date.now() - started,
      where
    })
    let item: AskHistoryItem
    try {
      item = await this.answer(p.question, p.prompt, req, base, started, stopped)
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
    req: AskRequest,
    base: Pick<AskHistoryItem, 'id' | 'at' | 'question' | 'sentBytes'>,
    started: number,
    stopped: (where: string, error: string) => AskHistoryItem
  ): Promise<AskHistoryItem> {
    if (this.deps.simulate) {
      await this.until(req, new Promise((r) => setTimeout(r, 900)))
      if (req.cancelled) return stopped('Sample answer (fixtures mode)', 'Cancelled.')
      return {
        ...base,
        ok: true,
        answer: sampleAnswer(question),
        durationMs: Date.now() - started,
        where: 'Sample answer (fixtures mode)'
      }
    }
    // Every wait below ends as soon as Cancel is clicked, and nothing is sent after that.
    const found = await this.until(req, this.findCli())
    if (found === 'cancelled' || req.cancelled) return stopped('—', 'Cancelled.')
    const cli = found
    if (!cli)
      return {
        ...stopped(
          '—',
          "Claude Code wasn't found on Windows or in WSL. Install it, then try again."
        ),
        durationMs: 0
      }
    const cwd = join(this.deps.dataDir, 'ask')
    await mkdir(cwd, { recursive: true })
    if (req.cancelled) return stopped(cli.label, 'Cancelled.')
    const auth = await this.checkAuth(cli, cwd, req)
    if (auth === 'cancelled' || req.cancelled) return stopped(cli.label, 'Cancelled.')
    if (!auth.ok) return stopped(cli.label, auth.reason)
    const handle = (this.deps.runner ?? spawnRunner)(askCommand(cli), prompt, {
      cwd,
      timeoutMs: this.deps.timeoutSec() * 1000
    })
    req.handle = handle
    const done = await this.until(req, handle.done)
    if (done === 'cancelled') return stopped(cli.label, 'Cancelled.')
    const res = done
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
      where: cli.label
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
