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
// - restore-backups itself must be a real folder inside the app's data folder
//   (links followed): one that is a link or junction is never listed or cleaned;
// - the list is read again right before deleting, and only folders that are
//   still old enough and were in the list shown are deleted.

import { lstat, readdir, realpath, rm } from 'node:fs/promises'
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

const EMPTY: SafetySummary = { copies: [], bytes: 0, other: 0, old: [], oldBytes: 0 }

export const LINKED_ROOT =
  "restore-backups is a link or junction (or not a plain folder inside the app's data folder), so the app won't list or clean it up."

/**
 * restore-backups as a real folder inside the app's data folder (its real
 * path, links followed), undefined when there is none, or { refused } when it
 * is a link, a junction or leads anywhere else.
 */
async function safetyRoot(dataDir: string): Promise<string | undefined | { refused: string }> {
  const root = join(dataDir, SAFETY_DIR)
  let st
  try {
    st = await lstat(root)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { refused: LINKED_ROOT }
  const [real, base] = await Promise.all([realpath(root), realpath(dataDir)])
  if (!isInside(real, base) || isInside(base, real)) return { refused: LINKED_ROOT }
  return real
}

/** The safety copies, and which of them are older than `days` (never the newest). */
export async function listSafetyCopies(
  dataDir: string,
  now: number,
  days = SAFETY_KEEP_DAYS
): Promise<SafetySummary> {
  const root = await safetyRoot(dataDir)
  if (root === undefined) return { ...EMPTY }
  if (typeof root !== 'string') return { ...EMPTY, refused: root.refused }
  const entries = await readdir(root, { withFileTypes: true })
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
  const wanted = new Set(names)
  const { old, refused } = await listSafetyCopies(dataDir, now, days)
  if (refused) return { deleted: [], errors: [refused] }
  const deleted: SafetyCopy[] = []
  const errors: string[] = []
  for (const c of old) {
    if (!wanted.has(c.name)) continue
    try {
      // Checked again just before: restore-backups is still a real folder in
      // the data folder, and this is a real folder inside it (links followed).
      const root = await safetyRoot(dataDir)
      if (typeof root !== 'string') throw new Error(root ? root.refused : 'restore-backups is gone')
      const dir = join(root, c.name)
      const st = await lstat(dir)
      const real = st.isDirectory() && !st.isSymbolicLink() ? await realpath(dir) : undefined
      if (!real || !isInside(real, root) || isInside(root, real))
        throw new Error('not a plain folder')
      await rm(dir, { recursive: true, maxRetries: 3, retryDelay: 100 })
      deleted.push(c)
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message}`)
    }
  }
  return { deleted, errors }
}
