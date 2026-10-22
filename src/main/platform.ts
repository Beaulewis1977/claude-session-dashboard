// Everything that touches the host OS (wsl.exe, wt.exe, spawning terminals)
// goes through this adapter, so fixtures mode can run anywhere.

import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LaunchCommand } from './core/launch'
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
  hasWindowsTerminal(): Promise<boolean>
  spawnDetached(cmd: LaunchCommand): Promise<void>
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function runWsl(args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
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

export function createRealPlatform(): Platform {
  const isWindows = process.platform === 'win32'
  let wtCache: boolean | undefined
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
    async hasWindowsTerminal() {
      if (wtCache !== undefined) return wtCache
      if (!isWindows) return (wtCache = false)
      const local = process.env.LOCALAPPDATA
      if (local && (await exists(join(local, 'Microsoft', 'WindowsApps', 'wt.exe'))))
        return (wtCache = true)
      wtCache = await new Promise<boolean>((resolve) =>
        execFile('where.exe', ['wt.exe'], { windowsHide: true, timeout: 4000 }, (err) =>
          resolve(!err)
        )
      )
      return wtCache
    },
    spawnDetached(cmd) {
      return new Promise((resolve, reject) => {
        const child = spawn(cmd.command, cmd.args, {
          cwd: cmd.spawnCwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
          windowsVerbatimArguments: cmd.verbatim
        })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
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
    async hasWindowsTerminal() {
      return true
    },
    async spawnDetached() {
      // Never spawn anything in fixtures mode.
    }
  }
}
