// "Open in: Claude desktop app" (Windows, desktop only): runs the user's own
// Claude Code with fixed arguments, `claude --desktop --resume <id>`, which
// hands the session to the Claude desktop app and exits. No terminal opens.
// Whether the desktop app is installed: its `claude:` link handler in the
// registry (`reg query`, read only). Nothing of the desktop app's data is read
// or written by the dashboard.

import { execFile } from 'node:child_process'
import { claudeAppArgs } from '@shared/claude-app'
import { REMOTE_CONTROL_UNSET_ENV } from '../core/launch'
import { systemExe } from '../core/which'

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
const RUN_TIMEOUT_MS = 45_000

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
      const r = await run(claudePath, claudeAppArgs(sessionId, fork), {
        cwd,
        timeout: RUN_TIMEOUT_MS
      })
      return { ok: r.code === 0, output: r.out }
    }
  }
}
