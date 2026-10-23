// Everything that touches the host OS (wsl.exe, wt.exe, spawning terminals)
// goes through this adapter, so fixtures mode can run anywhere.

import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { nativeArgs, type LaunchCommand, type LaunchTools } from './core/launch'
import {
  fileExists as exists,
  findOnPath,
  findWindowsClaude,
  findWindowsTerminal,
  systemExe,
  systemRoot
} from './core/which'
import { parseDistroList, wslRoots } from './core/wsl'

export interface Platform {
  fixtures: boolean
  /** True when launching terminals is really possible (Windows, not fixtures). */
  canLaunch: boolean
  /** Home folder of the Windows user (holds `.claude`). */
  windowsHome: string
  /** Undefined means WSL is not available on this machine. */
  listDistros(): Promise<string[] | undefined>
  /** Undefined means the running state is unknown. */
  listRunningDistros(): Promise<string[] | undefined>
  /** Candidate host paths for a distro's filesystem root, preferred first. */
  distroRoots(distro: string): string[]
  pathExists(p: string): Promise<boolean>
  /** Absolute paths of the terminal, shells and Claude Code (never looked up in a project folder). */
  launchTools(): Promise<LaunchTools>
  spawnDetached(cmd: LaunchCommand): Promise<void>
  /** Output of `ccusage daily --json`, or undefined if ccusage isn't installed. */
  runCcusage(): Promise<string | undefined>
  /** Git Bash (Claude Code on Windows runs status line commands with it when installed). */
  gitBash(): Promise<string | undefined>
}

function runWsl(args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      systemExe('wsl.exe'),
      args,
      { encoding: 'buffer', windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        // `wsl -l --running` exits non-zero when nothing is running.
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') resolve(undefined)
        else resolve(stdout ?? Buffer.alloc(0))
      }
    )
  })
}

/** Windows Terminal opens its own window: start it straight from the app. */
function spawnWindow(cmd: LaunchCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.spawnCwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: cmd.verbatim,
      // The API key (if any) lives only in this child's environment.
      env: cmd.env ? { ...process.env, ...cmd.env } : undefined
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Runs in a hidden PowerShell: starts $env:CSD_LAUNCH_FILE through the shell,
 * like the Run box does, in a new console window of its own.
 */
const OPEN_CONSOLE = [
  "$ErrorActionPreference = 'Stop'",
  '$i = New-Object System.Diagnostics.ProcessStartInfo',
  '$i.FileName = $env:CSD_LAUNCH_FILE',
  '$i.Arguments = $env:CSD_LAUNCH_ARGS',
  'if ($env:CSD_LAUNCH_DIR) { $i.WorkingDirectory = $env:CSD_LAUNCH_DIR }',
  '$i.UseShellExecute = $true',
  // Not passed on to the terminal.
  'Remove-Item Env:CSD_LAUNCH_* -ErrorAction SilentlyContinue',
  '[void][System.Diagnostics.Process]::Start($i)'
].join('; ')

/**
 * Open cmd or PowerShell in a new console window. Started straight from the
 * app they'd get none: Electron has no console to share, a detached child
 * gets none of its own, and its input would be the app's (nothing), so it
 * would exit at once. A hidden PowerShell opens them through the shell
 * instead: they get their own window, keep running after the app quits, and
 * inherit the environment (with the API key, if any). The program, its
 * arguments and the folder reach that PowerShell only as environment
 * variables, so nothing reads them as a script.
 */
function openConsole(cmd: LaunchCommand): Promise<void> {
  const args = nativeArgs(cmd)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...cmd.env,
    CSD_LAUNCH_FILE: cmd.command,
    CSD_LAUNCH_ARGS: args
  }
  if (cmd.spawnCwd) env.CSD_LAUNCH_DIR = cmd.spawnCwd
  const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command', OPEN_CONSOLE],
      { env, windowsHide: true, timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr).trim() || err.message))
        else resolve()
      }
    )
  })
}

export function createRealPlatform(): Platform {
  const isWindows = process.platform === 'win32'
  let wtCache: string | null | undefined
  let claudeCache: string | undefined
  return {
    fixtures: false,
    canLaunch: isWindows,
    windowsHome: homedir(),
    async listDistros() {
      if (!isWindows) return undefined
      const out = await runWsl(['-l', '-q'])
      return out ? parseDistroList(out) : undefined
    },
    async listRunningDistros() {
      if (!isWindows) return undefined
      const out = await runWsl(['-l', '--running', '-q'])
      if (!out) return undefined
      // When nothing runs, wsl prints a sentence instead of names.
      return parseDistroList(out).filter((n) => !/\s/.test(n))
    },
    distroRoots: (distro) => wslRoots(distro),
    pathExists: exists,
    async launchTools() {
      const tools: LaunchTools = {
        cmd: systemExe('cmd.exe'),
        powershell: win32.join(
          systemRoot(),
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        ),
        wsl: systemExe('wsl.exe')
      }
      if (!isWindows) return tools
      if (wtCache === undefined) wtCache = (await findWindowsTerminal()) ?? null
      tools.wt = wtCache ?? undefined
      // Look again if Claude Code wasn't found, or isn't where it was.
      if (!claudeCache || !(await exists(claudeCache))) claudeCache = await findWindowsClaude()
      tools.claude = claudeCache
      return tools
    },
    spawnDetached(cmd) {
      return cmd.terminal === 'wt' ? spawnWindow(cmd) : openConsole(cmd)
    },
    async gitBash() {
      if (!isWindows) return undefined
      const candidates = [
        process.env.CLAUDE_CODE_GIT_BASH_PATH,
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        join(
          process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'Git',
          'bin',
          'bash.exe'
        ),
        process.env.LOCALAPPDATA &&
          join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      ]
      for (const c of candidates) if (c && (await exists(c))) return c
      const git = await findOnPath('git', ['.exe'])
      // ...\Git\cmd\git.exe → ...\Git\bin\bash.exe
      const bash = git ? join(git, '..', '..', 'bin', 'bash.exe') : undefined
      return bash && (await exists(bash)) ? bash : undefined
    },
    runCcusage() {
      return new Promise((resolve) => {
        // Fixed arguments only; `shell` lets Windows find the npm `ccusage.cmd` shim.
        // cmd.exe skips the current folder (NoDefaultCurrentDirectoryInExePath, set at startup).
        execFile(
          'ccusage',
          ['daily', '--json'],
          {
            windowsHide: true,
            timeout: 120_000,
            maxBuffer: 64 * 1024 * 1024,
            shell: isWindows
          },
          (err, stdout) => {
            if (err && !stdout) resolve(undefined)
            else resolve(String(stdout))
          }
        )
      })
    }
  }
}

/**
 * Fixtures mode: the "Windows home" and the WSL distros are folders under
 * `.fixtures-data/sources`, and launching only shows the command.
 */
export function createFixturesPlatform(fixturesDir: string, sourcesDir: string): Platform {
  return {
    fixtures: true,
    canLaunch: false,
    windowsHome: join(sourcesDir, 'windows', 'Users', 'beau'),
    async listDistros() {
      return parseDistroList(await readFile(join(fixturesDir, 'wsl-list.utf16')))
    },
    async listRunningDistros() {
      return parseDistroList(await readFile(join(fixturesDir, 'wsl-list-running.utf16')))
    },
    distroRoots: (distro) => [join(sourcesDir, 'wsl', distro)],
    async pathExists(p) {
      // Sample cwds are Windows/Linux paths that don't exist here. Pretend they
      // do, except the archived prototype, to demo the "folder missing" flow.
      if (/old-prototype/.test(p)) return false
      if (p.startsWith(sourcesDir)) return exists(p)
      return true
    },
    async launchTools() {
      // Typical Windows paths, for the commands shown; nothing is started.
      return {
        wt: 'C:\\Users\\beau\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
        powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        cmd: 'C:\\Windows\\System32\\cmd.exe',
        wsl: 'C:\\Windows\\System32\\wsl.exe',
        claude: 'C:\\Users\\beau\\.local\\bin\\claude.exe'
      }
    },
    async spawnDetached() {
      // Never spawn anything in fixtures mode.
    },
    async runCcusage() {
      return undefined
    },
    async gitBash() {
      return undefined
    }
  }
}
