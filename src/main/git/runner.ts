// The only place the app starts git or gh (a test checks that). Every
// argument list goes through the read-only guard first (@shared/git/guard),
// and each process is:
// - started without a shell, from an argument array, never from the project
//   folder (git is found by absolute path on PATH; `-C <dir>` names the repo);
// - limited: at most two at once, below-normal priority, a timeout, and a cap
//   on the output kept (the process is stopped when it's reached);
// - given an environment without the app's own GIT_* variables (a GIT_DIR
//   would point git somewhere else), with optional locks off (git then never
//   rewrites the index for a read), no transport allowed (a partial clone can't
//   fetch a missing object, whatever git version) and no prompts.
// WSL repos run the distro's own git through wsl.exe (`-e`, no shell).

import { spawn } from 'node:child_process'
import { constants, setPriority } from 'node:os'
import { assertReadOnlyGh, assertReadOnlyGit } from '@shared/git/guard'
import { findOnPath, fileExists, systemExe } from '../core/which'
import { isValidDistroName } from '../core/wsl'

export type GitEnv = { kind: 'windows' } | { kind: 'wsl'; distro: string; user?: string }

export function envKey(env: GitEnv): string {
  return env.kind === 'windows' ? 'windows' : `wsl:${env.distro}${env.user ? `:${env.user}` : ''}`
}

export function envLabel(env: GitEnv): string {
  return env.kind === 'windows' ? 'Windows' : `WSL: ${env.distro}`
}

export interface RunOptions {
  timeoutMs?: number
  /** Output kept; the process is stopped once it's passed (`truncated`). */
  maxBytes?: number
}

export interface RunOutput {
  stdout: string
  stderr: string
  code: number | null
  truncated: boolean
  timedOut: boolean
  /** The program couldn't be started (not installed). */
  missing: boolean
}

export interface ProcessRunner {
  git(env: GitEnv, args: string[], opts?: RunOptions): Promise<RunOutput>
  gh(args: string[], opts?: RunOptions): Promise<RunOutput>
}

/** Variables git and gh get on top of the app's own (minus every GIT_* / GH_HOST / GH_REPO). */
export const GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
  // A partial clone would otherwise fetch a missing object (and write it, and run
  // maintenance) when a read needs it. The read fails instead.
  GIT_NO_LAZY_FETCH: '1',
  // Not every git honours GIT_NO_LAZY_FETCH (upstream 2.43 and older, unless patched),
  // so no transport is allowed at all ("none" names none): any fetch git tries, a lazy
  // one too, fails before it connects. Every git that can lazy-fetch knows this variable
  // (it's older than partial clones).
  GIT_ALLOW_PROTOCOL: 'none',
  LC_ALL: 'C'
}

export const GH_ENV: Record<string, string> = {
  // gh otherwise checks GitHub for a newer version of itself now and then.
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  GH_PROMPT_DISABLED: '1',
  GH_SPINNER_DISABLED: '1',
  GH_PAGER: '',
  NO_COLOR: '1',
  CLICOLOR: '0'
}

export function childEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    const u = k.toUpperCase()
    if (u.startsWith('GIT_') || u === 'GH_HOST' || u === 'GH_REPO' || u === 'GH_PAGER') continue
    out[k] = v
  }
  return { ...out, ...extra }
}

const LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/i

/** The wsl.exe arguments that run git in a distro (no shell; `env` sets git's variables). */
export function wslGitArgs(env: Extract<GitEnv, { kind: 'wsl' }>, args: string[]): string[] {
  if (!isValidDistroName(env.distro)) throw new Error('Not a WSL distro name')
  if (env.user !== undefined && !LINUX_USER.test(env.user)) throw new Error('Not a Linux user name')
  return [
    '-d',
    env.distro,
    ...(env.user ? ['-u', env.user] : []),
    '-e',
    'env',
    ...Object.entries(GIT_ENV).map(([k, v]) => `${k}=${v}`),
    'git',
    ...args
  ]
}

class Gate {
  private active = 0
  private waiting: (() => void)[] = []
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

function runProcess(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  opts: RunOptions
): Promise<RunOutput> {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024
  const timeoutMs = opts.timeoutMs ?? 30_000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve({
        stdout: '',
        stderr: '',
        code: null,
        truncated: false,
        timedOut: false,
        missing: true
      })
      return
    }
    const out: Buffer[] = []
    let outBytes = 0
    let err = ''
    let truncated = false
    let timedOut = false
    let missing = false
    const stop = (): void => {
      if (child.exitCode === null) child.kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    child.once('spawn', () => {
      try {
        if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        // Not allowed here: it runs at normal priority.
      }
    })
    child.stdout.on('data', (d: Buffer) => {
      if (truncated) return
      if (outBytes + d.length > maxBytes) {
        out.push(d.subarray(0, maxBytes - outBytes))
        outBytes = maxBytes
        truncated = true
        stop()
        return
      }
      out.push(d)
      outBytes += d.length
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (err.length < 20_000) err += d
    })
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: err,
        code,
        truncated,
        timedOut,
        missing
      })
    }
    child.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') missing = true
      err ||= e.message
      // A process that never started has no 'close' to wait for.
      if (child.pid === undefined) finish(null)
    })
    child.once('close', (code) => finish(code))
  })
}

/** git for Windows: on PATH, else where its installer puts it. */
async function findWindowsGit(): Promise<string | undefined> {
  const onPath = await findOnPath('git', ['.exe'])
  if (onPath) return onPath
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs`
  ]
  for (const r of roots) {
    const p = r && `${r}\\Git\\cmd\\git.exe`
    if (p && (await fileExists(p))) return p
  }
  return undefined
}

export function createProcessRunner(opts: { cwd: string }): ProcessRunner {
  const gate = new Gate(2)
  const isWindows = process.platform === 'win32'
  let gitPath: Promise<string | undefined> | undefined
  let ghPath: Promise<string | undefined> | undefined
  const notFound: RunOutput = {
    stdout: '',
    stderr: '',
    code: null,
    truncated: false,
    timedOut: false,
    missing: true
  }
  return {
    async git(env, args, o = {}) {
      assertReadOnlyGit(args)
      return gate.run(async () => {
        if (env.kind === 'wsl') {
          if (!isWindows) return notFound
          return runProcess(
            systemExe('wsl.exe'),
            wslGitArgs(env, args),
            childEnv(process.env, {}),
            opts.cwd,
            o
          )
        }
        gitPath ??= isWindows ? findWindowsGit() : Promise.resolve('git')
        const file = await gitPath
        if (!file) {
          gitPath = undefined
          return notFound
        }
        return runProcess(file, args, childEnv(process.env, GIT_ENV), opts.cwd, o)
      })
    },
    async gh(args, o = {}) {
      assertReadOnlyGh(args)
      return gate.run(async () => {
        ghPath ??= isWindows ? findOnPath('gh', ['.exe']) : Promise.resolve('gh')
        const file = await ghPath
        if (!file) {
          ghPath = undefined
          return notFound
        }
        return runProcess(file, args, childEnv(process.env, GH_ENV), opts.cwd, o)
      })
    }
  }
}
