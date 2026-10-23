// Finding the programs the app starts, always by absolute path.
//
// Windows looks in the current folder before PATH (cmd.exe, CreateProcess and
// libuv all do), so a file in a project folder could stand in for a program
// the app runs there. The app never looks in the current folder: system
// programs come from System32, everything else from the absolute folders on
// PATH.

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { win32 } from 'node:path'

export type Exists = (p: string) => Promise<boolean>

/** `access`, not `stat`: stat fails on app execution aliases such as wt.exe. */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** `C:\…` or `\\server\share\…`; never relative, drive-relative or rooted on the current drive. */
export function isAbsoluteWindowsPath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p)
}

/** The Windows folder (holds System32). */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  for (const v of [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR])
    if (v && isAbsoluteWindowsPath(v)) return v
  return 'C:\\Windows'
}

/** A program in System32, e.g. `cmd.exe`. */
export function systemExe(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemRoot(env), 'System32', name)
}

/** The absolute folders on a PATH value, in order. Relative entries are dropped. */
export function pathDirs(pathVar: string | undefined): string[] {
  return (pathVar ?? '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(isAbsoluteWindowsPath)
}

/** The first `<dir>\<name><ext>` that exists, searching PATH's absolute folders only. */
export async function findOnPath(
  name: string,
  exts: string[],
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = fileExists
): Promise<string | undefined> {
  for (const dir of pathDirs(env.PATH ?? env.Path))
    for (const ext of exts) {
      const p = win32.join(dir, name + ext)
      if (await exists(p)) return p
    }
  return undefined
}

/** Windows Terminal: its app execution alias, else wt.exe on PATH. */
export async function findWindowsTerminal(
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = fileExists
): Promise<string | undefined> {
  const local = env.LOCALAPPDATA
  if (local && isAbsoluteWindowsPath(local)) {
    const alias = win32.join(local, 'Microsoft', 'WindowsApps', 'wt.exe')
    if (await exists(alias)) return alias
  }
  return findOnPath('wt', ['.exe'], env, exists)
}

/**
 * Claude Code on Windows: what typing `claude` would run (claude.exe from the
 * native installer, or npm's claude.cmd shim), else the usual install places
 * in case it was installed after the app started.
 */
export async function findWindowsClaude(
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = fileExists
): Promise<string | undefined> {
  const onPath = await findOnPath('claude', ['.exe', '.bat', '.cmd'], env, exists)
  if (onPath) return onPath
  const candidates = [
    env.USERPROFILE && win32.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'),
    env.APPDATA && win32.join(env.APPDATA, 'npm', 'claude.cmd')
  ]
  for (const c of candidates) if (c && isAbsoluteWindowsPath(c) && (await exists(c))) return c
  return undefined
}
