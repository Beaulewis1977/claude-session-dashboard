// Starting the Claude Code CLI for `claude -p` runs (Ask Claude, summaries):
// where it is, the allowlisted environment it gets, and the process itself
// (prompt on stdin, killed on timeout or Cancel).

import { execFile, spawn } from 'node:child_process'
import { askEnvAllowed, type AskCli, type AskCommand } from '@shared/ask'
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
