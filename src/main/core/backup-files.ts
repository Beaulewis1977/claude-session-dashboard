// What a backup holds: an allow-list of the app's own files, and how each one
// is restored.
//
// Backed up: the session archive, names/descriptions/tags (metadata.json),
// usage and limit history, Ask Claude history, the app's settings, and the
// API account labels and credit grants with the keys taken out.
//
// Not backed up (all tied to this PC, or secret): API keys (they're encrypted
// with this PC's Windows account and couldn't be used elsewhere anyway),
// paired phones and push keys (mobile.json), the status line / session alert
// / terminal access install records and their backups of Claude's and
// OpenSSH's settings, Chromium's cache, the session cache and the backup
// settings themselves.

import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isInside } from './safe-paths'

/** Top-level files, by name. */
const TOP_FILES = [
  'metadata.json',
  'settings.json',
  'accounts.json',
  'ask-history.json',
  'limits-history.ndjson'
] as const

/** Folders backed up whole (temp files aside). */
const TOP_DIRS = ['archive', 'usage'] as const

export interface SourceFile {
  /** Relative to the data folder, with forward slashes. */
  rel: string
  abs: string
  size: number
  mtimeMs: number
  /** The bytes to back up instead of the file's own (accounts.json: keys removed). */
  transform?: (data: Buffer) => Buffer
}

// The archive's file names come from safeSegment()/archiveName(): letters,
// digits, ".", "_" and "-" (a leading "_" included). No leading ".".
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,199}$/
const TEMP_RE = /\.tmp$|\.corrupt-\d+$/i

/**
 * A path from a backup's manifest that a restore may write: one of the files
 * or folders above, relative, made of plain names only (no "..", no drive or
 * root, no "\" and no ":"), so a changed or crafted manifest can't point a
 * restore anywhere else, `.claude` included.
 */
export function isRestorablePath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.length > 1000) return false
  const segs = rel.split('/')
  if (segs.some((s) => !SEGMENT_RE.test(s) || s.endsWith('.') || s.endsWith(' '))) return false
  if (segs.some((s) => s.toLowerCase() === '.claude')) return false
  if (TEMP_RE.test(rel)) return false
  if (segs.length === 1) return (TOP_FILES as readonly string[]).includes(segs[0] ?? '')
  return (TOP_DIRS as readonly string[]).includes(segs[0] ?? '') && segs.length <= 6
}

/** The absolute path for a restorable relative path, checked to stay in the data folder. */
export function targetPath(dataDir: string, rel: string): string {
  if (!isRestorablePath(rel)) throw new Error(`Not a path a restore may write: ${rel}`)
  const t = resolve(dataDir, ...rel.split('/'))
  if (!isInside(t, dataDir) || resolve(t) === resolve(dataDir))
    throw new Error(`Not a path a restore may write: ${rel}`)
  return t
}

export type FileGroup = 'archive' | 'meta' | 'settings' | 'usage' | 'accounts' | 'ask'

export const GROUP_LABELS: Record<FileGroup, string> = {
  archive: 'Session archive',
  meta: 'Names, descriptions and tags',
  usage: 'Usage and limit history',
  settings: 'App settings',
  accounts: 'API account labels and credits (no keys)',
  ask: 'Ask Claude history'
}

export function groupOf(rel: string): FileGroup {
  if (rel.startsWith('archive/')) return 'archive'
  if (rel === 'metadata.json') return 'meta'
  if (rel === 'settings.json') return 'settings'
  if (rel === 'accounts.json') return 'accounts'
  if (rel === 'ask-history.json') return 'ask'
  return 'usage'
}

/**
 * Files that only ever grow: a restore never replaces them with a smaller
 * backup copy (the copy here already holds everything plus newer lines).
 */
export function neverShrinks(rel: string): boolean {
  return rel.startsWith('archive/') || rel === 'limits-history.ndjson'
}

/** Files combined with the current copy on restore instead of replacing it. */
export function mergedOnRestore(rel: string): boolean {
  return rel === 'metadata.json' || rel === 'settings.json' || rel === 'accounts.json'
}

/** accounts.json without the (safeStorage-encrypted) API keys. */
export function stripAccountKeys(data: Buffer): Buffer {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    // Unreadable: back up nothing rather than something that may hold a key.
    return Buffer.from('{}\n')
  }
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const accounts = Array.isArray(o.accounts)
    ? o.accounts.map((a) => {
        if (!a || typeof a !== 'object') return a
        const { enc: _enc, ...rest } = a as Record<string, unknown>
        return rest
      })
    : o.accounts
  return Buffer.from(JSON.stringify({ ...o, accounts }, null, 2))
}

/** The file system calls collectFiles uses (tests pass failing ones). */
export interface CollectIo {
  readdir: (p: string) => Promise<Dirent[]>
  lstat: (p: string) => Promise<Stats>
}

const realIo: CollectIo = {
  readdir: (p) => readdir(p, { withFileTypes: true }),
  lstat: (p) => lstat(p)
}

export interface Collected {
  files: SourceFile[]
  /** Files in the backed-up folders that a backup can't hold (odd names, too deep). */
  skipped: string[]
}

const gone = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Anything but "it vanished" stops the backup: a snapshot never quietly misses data. */
function readError(rel: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException)?.code
  return new Error(
    `Couldn't read ${rel}${code ? ` (${code})` : ''}: ${(err as Error)?.message ?? err}`
  )
}

async function walk(
  abs: string,
  rel: string,
  out: Collected,
  depth: number,
  io: CollectIo
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await io.readdir(abs)
  } catch (err) {
    if (gone(err)) return
    throw readError(rel, err)
  }
  for (const e of entries) {
    const childAbs = join(abs, e.name)
    const childRel = `${rel}/${e.name}`
    // Links and junctions are never followed (they could lead out of the folder).
    if (e.isSymbolicLink()) {
      out.skipped.push(childRel)
      continue
    }
    if (e.isDirectory()) {
      if (depth < 5) await walk(childAbs, childRel, out, depth + 1, io)
      else out.skipped.push(childRel)
    } else if (e.isFile()) {
      if (TEMP_RE.test(e.name)) continue
      if (!isRestorablePath(childRel)) {
        out.skipped.push(childRel)
        continue
      }
      let st: Stats
      try {
        st = await io.lstat(childAbs)
      } catch (err) {
        if (gone(err)) continue
        throw readError(childRel, err)
      }
      if (st.isFile())
        out.files.push({ rel: childRel, abs: childAbs, size: st.size, mtimeMs: st.mtimeMs })
    }
  }
}

/**
 * Every file a backup of `dataDir` holds right now. Throws when something
 * that exists can't be read, so a backup fails instead of reporting success
 * for an incomplete snapshot (which retention could later keep in place of
 * complete ones).
 */
export async function collectFiles(dataDir: string, io: CollectIo = realIo): Promise<Collected> {
  const out: Collected = { files: [], skipped: [] }
  for (const name of TOP_FILES) {
    const abs = join(dataDir, name)
    let st: Stats
    try {
      st = await io.lstat(abs)
    } catch (err) {
      // Optional: a new install has none of these yet.
      if (gone(err)) continue
      throw readError(name, err)
    }
    if (!st.isFile()) throw new Error(`${name} in the app's data folder isn't a file`)
    out.files.push({
      rel: name,
      abs,
      size: st.size,
      mtimeMs: st.mtimeMs,
      transform: name === 'accounts.json' ? stripAccountKeys : undefined
    })
  }
  for (const d of TOP_DIRS) {
    const abs = join(dataDir, d)
    let st: Stats
    try {
      st = await io.lstat(abs)
    } catch (err) {
      if (gone(err)) continue
      throw readError(d, err)
    }
    if (!st.isDirectory()) throw new Error(`${d} in the app's data folder isn't a folder`)
    await walk(abs, d, out, 1, io)
  }
  out.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

// ------------------------------------------------------------------ merging

type Json = Record<string, unknown>

const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}

function parse(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

/**
 * An archive record's path on this PC: a backup from another PC (or another
 * Windows user) has paths under that PC's data folder.
 */
export function rebaseArchivePath(p: unknown, archiveDir: string): unknown {
  if (typeof p !== 'string') return p
  if (isInside(p, archiveDir)) return p
  const segs = p.split(/[\\/]+/)
  const i = segs.map((s) => s.toLowerCase()).lastIndexOf('archive')
  if (i < 0) return p
  const rest = segs.slice(i + 1)
  if (!rest.length || !isRestorablePath(['archive', ...rest].join('/'))) return p
  return join(archiveDir, ...rest)
}

/** Settings that belong to this PC: never taken from a backup. */
const PC_SETTINGS = ['window', 'miniMeter', 'mobile']

/**
 * The file a restore writes for a merged file: the backup's version, with the
 * parts that belong to this PC (or were added here since) kept.
 */
export function mergeOnRestore(
  rel: string,
  backupText: string,
  currentText: string | undefined,
  ctx: { archiveDir: string }
): string {
  const b = parse(backupText)
  if (!b) throw new Error(`${rel} in the backup can't be read`)
  const c = parse(currentText)
  if (rel === 'settings.json') {
    const out: Json = { ...b }
    for (const k of PC_SETTINGS) {
      if (c && k in c) out[k] = c[k]
      // The phone companion is never switched on by a restore.
      else delete out[k]
    }
    return JSON.stringify(out, null, 2)
  }
  if (rel === 'accounts.json') {
    const cur = obj(c)
    const curAccounts = Array.isArray(cur.accounts) ? (cur.accounts as Json[]) : []
    const keyOf = new Map(curAccounts.map((a) => [obj(a).id, obj(a).enc]))
    const restored = (Array.isArray(b.accounts) ? (b.accounts as Json[]) : []).map((a) => {
      const { enc: _ignored, ...rest } = obj(a)
      const enc = keyOf.get(rest.id)
      return typeof enc === 'string' ? { ...rest, enc } : rest
    })
    const ids = new Set(restored.map((a) => a.id))
    const grantsB = Array.isArray(b.grants) ? (b.grants as Json[]) : []
    const grantIds = new Set(grantsB.map((g) => obj(g).id))
    const grantsC = (Array.isArray(cur.grants) ? (cur.grants as Json[]) : []).filter(
      (g) => !grantIds.has(obj(g).id)
    )
    return JSON.stringify(
      {
        ...b,
        // Keys added on this PC since the backup stay.
        accounts: [...restored, ...curAccounts.filter((a) => !ids.has(obj(a).id))],
        grants: [...grantsB, ...grantsC],
        admin: { ...obj(cur.admin), ...obj(b.admin) }
      },
      null,
      2
    )
  }
  if (rel === 'metadata.json') {
    const cur = obj(c)
    const archive: Json = { ...obj(cur.archive) }
    for (const [k, v] of Object.entries(obj(b.archive))) {
      const rec: Json = {
        ...obj(v),
        archivePath: rebaseArchivePath(obj(v).archivePath, ctx.archiveDir)
      }
      const here = obj(archive[k])
      // Keep whichever record goes with the larger copy (see neverShrinks).
      if (!(k in archive) || Number(rec.size ?? 0) > Number(here.size ?? 0)) archive[k] = rec
    }
    return JSON.stringify(
      {
        ...cur,
        ...b,
        sessions: { ...obj(cur.sessions), ...obj(b.sessions) },
        archive,
        claudeNamesSince: b.claudeNamesSince ?? cur.claudeNamesSince
      },
      null,
      2
    )
  }
  throw new Error(`${rel} isn't merged`)
}
