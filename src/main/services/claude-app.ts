// "Open in: Claude desktop app" (Windows, desktop only): runs the user's own
// Claude Code with fixed arguments, `claude --desktop --resume <id>`, which
// hands the session to the Claude desktop app and exits. `--desktop` refuses
// to run with redirected output, so it gets its own console, hidden (started
// by PowerShell's Start-Process; its inputs only as environment variables,
// never as script text). No terminal shows; it's ended if it doesn't finish.
// Whether the desktop app is installed: its `claude:` link handler in the
// registry (`reg query`, read only). Nothing of the desktop app's data is read
// or written by the dashboard.

import { execFile } from 'node:child_process'
import { claudeAppArgs } from '@shared/claude-app'
import { REMOTE_CONTROL_UNSET_ENV } from '../core/launch'
import { win32 } from 'node:path'
import { systemExe, systemRoot } from '../core/which'

export interface ClaudeAppFactsNow {
  installed: boolean
  version?: string
}

export interface ClaudeAppRun {
  ok: boolean
  /** What Claude Code printed (cut short), for the error message. */
  output: string
}

export interface ClaudeAppLauncher {
  /** Is the desktop app installed, and which Claude Code is on PATH (cached briefly). */
  facts(claudePath: string | undefined): Promise<ClaudeAppFactsNow>
  /** Run `claude --desktop --resume <id> [--fork-session]` in the session's folder. */
  open(claudePath: string, cwd: string, sessionId: string, fork: boolean): Promise<ClaudeAppRun>
}

const FACTS_MS = 60_000
/** How long the hand-over may take before it's ended (it normally takes a few seconds). */
export const HANDOFF_WAIT_MS = 40_000

/**
 * Starts Claude Code in a hidden console of its own, waits for it, returns its
 * exit code (124: it didn't finish and was ended, with every process it started). Inputs come only from the
 * environment: CSD_CLAUDE (absolute path), CSD_ARGS (fixed flags and a checked
 * session id, space-separated), CSD_CWD, CSD_WAIT_MS.
 */
export const HANDOFF_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = Start-Process -FilePath $env:CSD_CLAUDE -ArgumentList ($env:CSD_ARGS -split " ") -WorkingDirectory $env:CSD_CWD -WindowStyle Hidden -PassThru',
  '$null = $p.Handle',
  // Ended with everything it started (an npm claude.cmd runs node under cmd.exe).
  'if (-not $p.WaitForExit([int]$env:CSD_WAIT_MS)) { & (Join-Path $env:SystemRoot "System32\\taskkill.exe") /PID $p.Id /T /F | Out-Null; exit 124 }',
  'exit $p.ExitCode'
].join('; ')

/** `reg query HKCR\claude /v "URL Protocol"`: exit code 0 when the desktop app registered its links. */
function protocolRegistered(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) =>
    execFile(
      systemExe('reg.exe'),
      ['query', 'HKCR\\claude', '/v', 'URL Protocol'],
      { windowsHide: true, timeout: 8000 },
      (err) => resolve(!err)
    )
  )
}

/** The environment without API keys: the desktop app uses its own sign-in. */
function env(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const k of REMOTE_CONTROL_UNSET_ENV) delete out[k]
  return out
}

function run(
  claude: string,
  args: string[],
  opts: { cwd?: string; timeout: number }
): Promise<{ code: number | null; out: string }> {
  // A .cmd shim needs the shell; the arguments are fixed flags and a checked id.
  const shell = /\.(cmd|bat)$/i.test(claude)
  return new Promise((resolve) =>
    execFile(
      shell ? `"${claude}"` : claude,
      args,
      {
        windowsHide: true,
        timeout: opts.timeout,
        shell,
        cwd: opts.cwd,
        env: env(),
        maxBuffer: 256 * 1024
      },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : null
          : 0
        resolve({
          code,
          out: `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim().slice(0, 600)
        })
      }
    )
  )
}

export function claudeAppLauncher(): ClaudeAppLauncher {
  let cached: { key: string; at: number; facts: ClaudeAppFactsNow } | undefined
  return {
    async facts(claudePath) {
      const key = claudePath ?? ''
      if (cached && cached.key === key && Date.now() - cached.at < FACTS_MS) return cached.facts
      const [installed, ver] = await Promise.all([
        protocolRegistered(),
        claudePath
          ? run(claudePath, ['--version'], { timeout: 20_000 })
          : Promise.resolve(undefined)
      ])
      const facts = { installed, version: ver?.out.match(/\d+\.\d+\.\d+/)?.[0] }
      cached = { key, at: Date.now(), facts }
      return facts
    },
    async open(claudePath, cwd, sessionId, fork) {
      const args = claudeAppArgs(sessionId, fork)
      const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const code = await new Promise<number | null>((resolve) =>
        execFile(
          ps,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            HANDOFF_SCRIPT
          ],
          {
            windowsHide: true,
            timeout: HANDOFF_WAIT_MS + 15_000,
            env: {
              ...env(),
              CSD_CLAUDE: claudePath,
              CSD_ARGS: args.join(' '),
              CSD_CWD: cwd,
              CSD_WAIT_MS: String(HANDOFF_WAIT_MS)
            }
          },
          (err) =>
            resolve(
              err
                ? typeof (err as { code?: unknown }).code === 'number'
                  ? (err as { code: number }).code
                  : null
                : 0
            )
        )
      )
      return {
        ok: code === 0,
        output:
          code === 124
            ? "It didn't finish in time and was stopped."
            : code === 0
              ? ''
              : `It exited with code ${code ?? 'unknown'}. Run claude ${args.join(' ')} in a terminal in that folder to see why.`
      }
    }
  }
}
