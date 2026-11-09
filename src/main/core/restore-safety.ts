// The restore safety copies in `<data>/restore-backups/<time>/`: before a
// restore replaces a file, the current one is copied there (see
// backup-restore.ts). They're never removed by a restore; this cleans up old
// ones, only when asked (or, opt-in, at startup):
//
// - only folders whose name is a restore's own time stamp (e.g. 20261109T183000Z),
//   aged by that name, never by file dates;
// - the newest one always stays, however old;
// - never a link or junction (the folder itself), never anything outside
//   restore-backups, and links inside are removed as links (never followed);
// - the list is read again right before deleting, and only folders that are
//   still old enough and were in the list shown are deleted.

import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SAFETY_DIR } from './backup-restore'
import { isInside } from './safe-paths'
import type { SafetyCopy, SafetySummary } from '@shared/backup'

export type { SafetyCopy, SafetySummary }

export const SAFETY_KEEP_DAYS = 30
const DAY = 24 * 60 * 60_000
/** `stampOf` in backup-restore.ts: 2026-11-09T18:30:00.123Z → 20261109T183000Z. */
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/

/** The time a safety folder's name stands for, or undefined if it isn't one. */
export function stampTime(name: string): number | undefined {
  const m = STAMP_RE.exec(name)
  if (!m) return undefined
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  // A real date only (Date.UTC rolls 20261340 over into another month).
  const d = new Date(t)
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && d.getUTCHours() === +m[4]
    ? t
    : undefined
}

/** Size of a folder, not following links (a link counts as itself). */
async function sizeOf(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    const st = await lstat(p)
    if (st.isDirectory()) {
      const s = await sizeOf(p)
      bytes += s.bytes
      files += s.files
    } else {
      bytes += st.size
      files++
    }
  }
  return { bytes, files }
}

/** The safety copies, and which of them are older than `days` (never the newest). */
export async function listSafetyCopies(
  dataDir: string,
  now: number,
  days = SAFETY_KEEP_DAYS
): Promise<SafetySummary> {
  const root = join(dataDir, SAFETY_DIR)
  let entries: { name: string; isDirectory(): boolean }[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { copies: [], bytes: 0, other: 0, old: [], oldBytes: 0 }
    throw e
  }
  const copies: SafetyCopy[] = []
  let other = 0
  for (const e of entries) {
    const t = stampTime(e.name)
    // A link or junction is never one of ours (Dirent reports links as links).
    if (t === undefined || !e.isDirectory()) {
      other++
      continue
    }
    const s = await sizeOf(join(root, e.name))
    copies.push({ name: e.name, at: new Date(t).toISOString(), ...s })
  }
  copies.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const cutoff = now - days * DAY
  // Newest first: the first one always stays.
  const old = copies.slice(1).filter((c) => Date.parse(c.at) < cutoff)
  return {
    copies,
    bytes: copies.reduce((n, c) => n + c.bytes, 0),
    other,
    old,
    oldBytes: old.reduce((n, c) => n + c.bytes, 0)
  }
}

/**
 * Delete the safety copies named (those shown to me), but only those that are
 * still old enough now, and never the newest. Returns what was deleted.
 */
export async function deleteSafetyCopies(
  dataDir: string,
  names: readonly string[],
  now: number,
  days = SAFETY_KEEP_DAYS
): Promise<{ deleted: SafetyCopy[]; errors: string[] }> {
  const root = join(dataDir, SAFETY_DIR)
  const wanted = new Set(names)
  const { old } = await listSafetyCopies(dataDir, now, days)
  const deleted: SafetyCopy[] = []
  const errors: string[] = []
  for (const c of old) {
    if (!wanted.has(c.name)) continue
    const dir = join(root, c.name)
    try {
      // Checked again just before: a real folder, inside restore-backups.
      const st = await lstat(dir)
      if (!st.isDirectory() || st.isSymbolicLink() || !isInside(dir, root) || isInside(root, dir))
        throw new Error('not a plain folder')
      await rm(dir, { recursive: true, maxRetries: 3, retryDelay: 100 })
      deleted.push(c)
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message}`)
    }
  }
  return { deleted, errors }
}
