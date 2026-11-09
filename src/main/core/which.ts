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

/**
 * The first `<dir>\<name><ext>` that exists, searching PATH's absolute folders
 * only, in PATH order. Every candidate is checked at once (one at a time, each
 * check waited its turn behind the app's other file work: the startup scan
 * keeps Node's few file threads busy, and a PATH of 60 folders took seconds),
 * and it answers as soon as a match and every check before it are in.
 */
export async function findOnPath(
  name: string,
  exts: string[],
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = fileExists
): Promise<string | undefined> {
  const candidates = pathDirs(env.PATH ?? env.Path).flatMap((dir) =>
    exts.map((ext) => win32.join(dir, name + ext))
  )
  const checks = candidates.map((p) => exists(p).catch(() => false))
  // In PATH order: done as soon as a match and every check before it have
  // answered. Later ones (e.g. an offline network folder further down PATH)
  // aren't waited for.
  for (let i = 0; i < checks.length; i++) if (await checks[i]) return candidates[i]
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

/**
 * Codex on Windows: what typing `codex` would run (npm's codex.cmd shim, or
 * a codex.exe on PATH), else npm's usual global folder. The desktop app's own
 * copies under ~/.codex are never used.
 */
export async function findWindowsCodex(
  env: NodeJS.ProcessEnv = process.env,
  exists: Exists = fileExists
): Promise<string | undefined> {
  const onPath = await findOnPath('codex', ['.exe', '.bat', '.cmd'], env, exists)
  if (onPath) return onPath
  const npm = env.APPDATA && win32.join(env.APPDATA, 'npm', 'codex.cmd')
  if (npm && isAbsoluteWindowsPath(npm) && (await exists(npm))) return npm
  return undefined
}
