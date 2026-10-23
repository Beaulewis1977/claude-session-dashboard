// Write guard. The app never writes into a `.claude` directory, except for
// restoring a missing session file (see restore.ts, which never overwrites).

import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export function isInsideClaudeDir(p: string): boolean {
  return resolve(p)
    .split(/[\\/]+/)
    .some((seg) => seg.toLowerCase() === '.claude')
}

export function isInside(child: string, parent: string): boolean {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export class UnsafeWriteError extends Error {}

/** Throws unless `target` is inside the app's own data directory. */
export function assertAppDataWrite(target: string, appDataDir: string): void {
  if (isInsideClaudeDir(target) || !isInside(target, appDataDir)) {
    throw new UnsafeWriteError(`Refusing to write outside the app data folder: ${target}`)
  }
}

/**
 * `assertAppDataWrite`, then the same check on the real folder, with links
 * followed: a junction or symbolic link inside the app's folder can't lead a
 * write outside it. Call it once the target's folder exists.
 */
export async function assertRealAppDataWrite(target: string, appDataDir: string): Promise<void> {
  assertAppDataWrite(target, appDataDir)
  const [dir, base, st] = await Promise.all([
    realpath(dirname(target)),
    realpath(appDataDir),
    lstat(target).catch(() => undefined)
  ])
  if (!isInside(dir, base) || st?.isSymbolicLink()) {
    throw new UnsafeWriteError(`Refusing to write outside the app data folder: ${target}`)
  }
}

/** Throws if a user-chosen export target is inside a `.claude` directory. */
export function assertUserWrite(target: string): void {
  if (isInsideClaudeDir(target)) {
    throw new UnsafeWriteError(`Refusing to write inside a .claude folder: ${target}`)
  }
}

const BRIDGE_DIR = '.claude-session-dashboard'

/**
 * Exception #1 (Phase 5): the opt-in status line installer may write exactly
 * one kind of file inside `.claude`: `<home>/.claude/settings.json`.
 */
export function assertClaudeSettingsWrite(target: string): void {
  const parts = resolve(target).split(/[\\/]+/)
  const name = parts[parts.length - 1]?.toLowerCase()
  const parent = parts[parts.length - 2]?.toLowerCase()
  if (
    parent !== '.claude' ||
    !(name === 'settings.json' || /^settings\.json\.csd-[0-9a-f]+\.tmp$/.test(name ?? ''))
  ) {
    throw new UnsafeWriteError(
      `Refusing to write anything in .claude except settings.json: ${target}`
    )
  }
}

/** The bridge's own folder in each Claude home: `<home>/.claude-session-dashboard`. */
export function assertBridgeWrite(target: string): void {
  const segs = resolve(target)
    .split(/[\\/]+/)
    .map((s) => s.toLowerCase())
  if (isInsideClaudeDir(target) || !segs.includes(BRIDGE_DIR)) {
    throw new UnsafeWriteError(`Refusing to write outside the bridge folder: ${target}`)
  }
}

const SESSION_UUID_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/**
 * Exception #3 ("Branch from here"): the app may add one new session file,
 * `<uuid>.jsonl`, directly in the project folder of the session it branches
 * from. The file is created exclusively, so nothing existing is ever changed.
 */
export function assertBranchWrite(target: string, projectDir: string): void {
  const t = resolve(target)
  const parts = t.split(/[\\/]+/)
  const name = parts[parts.length - 1] ?? ''
  const dir = parts.slice(0, -1).join(sep).toLowerCase()
  const expected = resolve(projectDir)
    .split(/[\\/]+/)
    .join(sep)
    .toLowerCase()
  if (dir !== expected || !SESSION_UUID_FILE_RE.test(name)) {
    throw new UnsafeWriteError(
      `Refusing to write anything but a new session file in ${projectDir}: ${target}`
    )
  }
}
