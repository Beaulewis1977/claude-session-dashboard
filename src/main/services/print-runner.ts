// Runs `claude -p` on the user's subscription, for Ask Claude and session
// summaries alike: finds the CLI (Windows first, then WSL), confirms with
// `claude auth status` (in the same environment) that it would use the Claude
// subscription, then runs one fixed command with the prompt on stdin. Every
// step can be cancelled, and nothing is started after Cancel.

import { mkdir } from 'node:fs/promises'
import {
  authStatusCommand,
  subscriptionCheck,
  type AskCli,
  type AskCommand,
  type SubscriptionCheck
} from '@shared/ask'
import {
  AUTH_TIMED_OUT,
  findClaudeCli,
  spawnRunner,
  type AskRunner,
  type RunHandle,
  type RunResult
} from './cli-process'

export interface PrintRunnerDeps {
  findCli?: () => Promise<AskCli | undefined>
  runner?: AskRunner
  /** Would this CLI run on the subscription? (Default: `claude auth status`.) */
  checkAuth?: (cli: AskCli, cwd: string) => Promise<SubscriptionCheck>
}

/** One run from the click until it's done; Cancel works at every step. */
export interface PrintRequest {
  cancelled: boolean
  /** The process running now (the subscription check, then the prompt). */
  handle?: RunHandle
  /** Settles when Cancel is clicked. */
  stopped: Promise<'cancelled'>
  stop: () => void
}

export type PrintOutcome =
  | { kind: 'cancelled'; where: string }
  /** Nothing was sent: no CLI, or not the subscription. */
  | { kind: 'refused'; where: string; error: string; noCli?: boolean }
  | { kind: 'done'; where: string; cli: AskCli; result: RunResult }

export const NO_CLI = "Claude Code wasn't found on Windows or in WSL. Install it, then try again."

export class PrintRunner {
  private cli: Promise<AskCli | undefined> | undefined
  private authOk = new Map<string, number>()

  constructor(private readonly deps: PrintRunnerDeps = {}) {}

  findCli(): Promise<AskCli | undefined> {
    if (!this.cli) {
      this.cli = (this.deps.findCli ?? findClaudeCli)()
      // Look again next time if nothing was found (it may get installed).
      void this.cli.then((c) => {
        if (!c) this.cli = undefined
      })
    }
    return this.cli
  }

  newRequest(): PrintRequest {
    let stop: () => void = () => undefined
    const stopped = new Promise<'cancelled'>((resolve) => (stop = () => resolve('cancelled')))
    return { cancelled: false, stopped, stop }
  }

  cancel(req: PrintRequest): void {
    req.cancelled = true
    req.handle?.cancel()
    req.stop()
  }

  /** Wait for `p`, or stop waiting as soon as the request is cancelled. */
  until<T>(req: PrintRequest, p: Promise<T>): Promise<T | 'cancelled'> {
    return Promise.race([p, req.stopped])
  }

  /** `claude auth status` in the same environment the prompt runs in (a confirmed answer is kept 5 minutes). */
  private async checkAuth(
    cli: AskCli,
    cwd: string,
    req: PrintRequest
  ): Promise<SubscriptionCheck | 'cancelled'> {
    const key = `${cli.kind}|${cli.path ?? ''}|${cli.distro ?? ''}`
    const at = this.authOk.get(key)
    if (at && Date.now() - at < 5 * 60_000) return { ok: true, method: 'cached' }
    let res: SubscriptionCheck | 'cancelled'
    if (this.deps.checkAuth) res = await this.until(req, this.deps.checkAuth(cli, cwd))
    else {
      // Registered like the prompt itself, so Cancel stops this process too.
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

  /**
   * Find the CLI, confirm the subscription, then run `command(cli)` with
   * `prompt` on stdin in `cwd` (the app's own folder).
   */
  async run(
    req: PrintRequest,
    prompt: string,
    opts: { cwd: string; timeoutMs: number; command: (cli: AskCli) => AskCommand }
  ): Promise<PrintOutcome> {
    const found = await this.until(req, this.findCli())
    if (found === 'cancelled' || req.cancelled) return { kind: 'cancelled', where: '—' }
    const cli = found
    if (!cli) return { kind: 'refused', where: '—', error: NO_CLI, noCli: true }
    await mkdir(opts.cwd, { recursive: true })
    if (req.cancelled) return { kind: 'cancelled', where: cli.label }
    const auth = await this.checkAuth(cli, opts.cwd, req)
    if (auth === 'cancelled' || req.cancelled) return { kind: 'cancelled', where: cli.label }
    if (!auth.ok) return { kind: 'refused', where: cli.label, error: auth.reason }
    let command: AskCommand
    try {
      command = opts.command(cli)
    } catch (err) {
      return { kind: 'refused', where: cli.label, error: (err as Error).message }
    }
    const handle = (this.deps.runner ?? spawnRunner)(command, prompt, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs
    })
    req.handle = handle
    const done = await this.until(req, handle.done)
    if (done === 'cancelled') return { kind: 'cancelled', where: cli.label }
    return { kind: 'done', where: cli.label, cli, result: done }
  }
}
