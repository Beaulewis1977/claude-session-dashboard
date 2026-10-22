// Write guard. The app never writes into a `.claude` directory, except for
// restoring a missing session file (see restore.ts, which never overwrites).

import { resolve, sep } from 'node:path'

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
