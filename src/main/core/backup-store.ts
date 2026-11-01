// The backup set on disk: a folder of content-addressed objects and one
// manifest per snapshot.
//
//   <folder I picked>/ClaudeSessionDashboard Backup/
//     backup-set.json            which passwords exist (salt + check only), which is current
//     README.txt
//     objects/ab/ab12…            one file per distinct content (gzip, maybe encrypted)
//     snapshots/20261101T120000Z-1a2b3c4d.json   one per complete snapshot
//     lock.json                   while a backup runs
//
// Incremental: an object is named after its content, so content that is
// already in the set is never copied again; a snapshot's manifest lists every
// file and the object that holds it. Atomic: objects and manifests are
// written to a temp file and renamed into place, and a snapshot exists only
// once its manifest does. An interrupted backup leaves at most some objects
// no manifest refers to yet (the next backup reuses them; retention removes
// strays later).
//
// Every write and delete stays inside the set's folder (assertRealBackupWrite
// and deleteInSet). Retention deletes only snapshot manifests and objects no
// remaining snapshot needs, by their exact name patterns.

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import type { BackupReason } from '@shared/backup'
import {
  DamagedBackupError,
  HashTap,
  objectId,
  openBuffer,
  openObjectStreams,
  sealBuffer,
  sealStream,
  validKeyEntry,
  WrongPasswordError,
  type BackupKeys,
  type KeyEntry
} from './backup-crypto'
import type { SourceFile } from './backup-files'
import { assertRealBackupWrite, isInside, isInsideClaudeDir, UnsafeWriteError } from './safe-paths'

export const SET_FILE = 'backup-set.json'
const LOCK_FILE = 'lock.json'
const SNAPSHOT_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{8})\.json$/
const OBJECT_RE = /^[0-9a-f]{64}$/
const TMP_RE =
  /^[0-9a-f]{64}\.[0-9a-f]{8}\.tmp$|^\d{8}T\d{6}Z-[0-9a-f]{8}\.json\.[0-9a-f]{8}\.tmp$|^backup-set\.json\.[0-9a-f]{8}\.tmp$|^lock\.json\.[0-9a-f]{8}\.tmp$/
/** A lock older than this is from a backup that crashed. */
const STALE_LOCK_MS = 3 * 60 * 60_000

export interface SetFile {
  format: 'csd-backup-set'
  version: 1
  id: string
  createdAt: string
  /** The password new snapshots use; null = not encrypted. */
  current: string | null
  keys: KeyEntry[]
}

export interface ManifestFile {
  /** Path relative to the data folder (forward slashes). */
  p: string
  /** Size and modified time of the original. */
  s: number
  m: number
  /** SHA-256 of the content. */
  h: string
  /** Object name (see objectId). */
  o: string
}

export interface Manifest {
  format: 'csd-backup-snapshot'
  version: 1
  id: string
  setId: string
  createdAt: string
  appVersion?: string
  reason: BackupReason
  /** The password (key entry) it's encrypted with; null = not encrypted. */
  keyId: string | null
  fileCount: number
  totalBytes: number
  /** Every object it uses (in the clear, so retention works without the password). */
  objects: string[]
  /** Not encrypted: the file list itself. */
  files?: ManifestFile[]
  /** Encrypted: the file list, sealed (base64 envelope). */
  sealed?: string
}

export class BackupBusyError extends Error {}

const rand = (): string => randomBytes(4).toString('hex')

function stampOf(t: number): string {
  return new Date(t)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** Write `data` to `path` inside the set: temp file, flush, rename. */
async function writeInSet(path: string, data: Buffer | string, setDir: string): Promise<void> {
  await assertRealBackupWrite(path, setDir)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${rand()}.tmp`
  const fh = await open(tmp, 'wx')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

/**
 * The only way the app deletes anything in a backup set: a snapshot manifest,
 * an object, one of its own temp files or its lock, by exact name and folder,
 * never a link, and only where the real folder is inside the set.
 */
export async function deleteInSet(
  target: string,
  setDir: string,
  kind: 'snapshot' | 'object' | 'tmp' | 'lock'
): Promise<void> {
  const t = resolve(target)
  const set = resolve(setDir)
  const name = basename(t)
  const parent = dirname(t)
  const ok =
    kind === 'snapshot'
      ? SNAPSHOT_RE.test(name) && parent === join(set, 'snapshots')
      : kind === 'object'
        ? OBJECT_RE.test(name) && parent === join(set, 'objects', name.slice(0, 2))
        : kind === 'lock'
          ? name === LOCK_FILE && parent === set
          : TMP_RE.test(name) &&
            (parent === set ||
              parent === join(set, 'snapshots') ||
              (dirname(parent) === join(set, 'objects') && /^[0-9a-f]{2}$/.test(basename(parent))))
  if (!ok || isInsideClaudeDir(t)) throw new UnsafeWriteError(`Refusing to delete ${target}`)
  const [realParent, realSet, st] = await Promise.all([realpath(parent), realpath(set), lstat(t)])
  if (!isInside(realParent, realSet) || !st.isFile())
    throw new UnsafeWriteError(`Refusing to delete ${target}`)
  await unlink(t)
}

// ------------------------------------------------------------------ the set

export async function readSet(setDir: string): Promise<SetFile | undefined> {
  let text: string
  try {
    text = await readFile(join(setDir, SET_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  let v: SetFile
  try {
    v = JSON.parse(text) as SetFile
  } catch {
    throw new DamagedBackupError(`${SET_FILE} can't be read`)
  }
  if (v?.format !== 'csd-backup-set' || typeof v.id !== 'string')
    throw new DamagedBackupError(`${SET_FILE} isn't a backup set of this app`)
  if (v.version !== 1) throw new DamagedBackupError('Made by a newer version of the app')
  // Damaged password details are refused, never read as "not encrypted":
  // that would let the next backup write session data in the clear.
  if (!Array.isArray(v.keys) || !v.keys.every(validKeyEntry))
    throw new DamagedBackupError(`${SET_FILE} is damaged (password details can't be read)`)
  const keys = v.keys
  if (
    v.current !== null &&
    !(typeof v.current === 'string' && keys.some((k) => k.id === v.current))
  )
    throw new DamagedBackupError(`${SET_FILE} is damaged (its current password can't be found)`)
  return {
    format: v.format,
    version: 1,
    id: v.id,
    createdAt: String(v.createdAt),
    current: v.current,
    keys
  }
}

const README = `This folder holds backups made by Claude Session Dashboard
(Settings → Backup): its session archive, names, descriptions, tags, usage
history and settings. API keys are never included.

Restore from the app (Settings → Backup → Restore). Please don't rename or
edit anything here; the app checks every file when it restores.

If the backups are encrypted, they can't be read without the password.
Nobody can recover a lost password.
`

export async function createSet(setDir: string, at: string, key?: KeyEntry): Promise<SetFile> {
  const set: SetFile = {
    format: 'csd-backup-set',
    version: 1,
    id: randomBytes(8).toString('hex'),
    createdAt: at,
    current: key?.id ?? null,
    keys: key ? [key] : []
  }
  await mkdir(setDir, { recursive: true })
  await assertRealBackupWrite(join(setDir, SET_FILE), setDir)
  // Never over an existing set (created exclusively).
  const fh = await open(join(setDir, SET_FILE), 'wx')
  try {
    await fh.writeFile(JSON.stringify(set, null, 2))
    await fh.sync()
  } finally {
    await fh.close()
  }
  const readme = join(setDir, 'README.txt')
  await open(readme, 'wx')
    .then(async (f) => {
      await f.writeFile(README.replace(/\n/g, '\r\n'))
      await f.close()
    })
    .catch(() => undefined)
  return set
}

export async function writeSet(setDir: string, set: SetFile): Promise<void> {
  await writeInSet(join(setDir, SET_FILE), JSON.stringify(set, null, 2), setDir)
}

// ------------------------------------------------------------------ lock

/**
 * One backup at a time per set. A lock left by this same install (the app
 * quit or crashed mid-backup; it never runs two at once) or older than a few
 * hours is taken over; another PC's recent lock is respected.
 */
async function acquireLock(setDir: string, owner?: string): Promise<string> {
  // Locks are about real time (never the app's display clock).
  const now = Date.now()
  const path = join(setDir, LOCK_FILE)
  const nonce = randomBytes(8).toString('hex')
  const body = JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, nonce, owner })
  await assertRealBackupWrite(path, setDir)
  try {
    const fh = await open(path, 'wx')
    await fh.writeFile(body)
    await fh.close()
    return nonce
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  let at = 0
  let mine = false
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as {
      at: string
      owner?: string
      pid?: number
    }
    at = Date.parse(v.at) || 0
    // This install's lock from a process that has ended (the app quit or
    // crashed mid-backup). Never one this process holds right now.
    mine = !!owner && v.owner === owner && v.pid !== process.pid && !alive(v.pid)
  } catch {
    // Unreadable: treat as stale.
  }
  if (!mine && now - at < STALE_LOCK_MS)
    throw new BackupBusyError('Another backup into this folder is running right now.')
  await writeInSet(path, body, setDir)
  return nonce
}

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function releaseLock(setDir: string, nonce: string): Promise<void> {
  const path = join(setDir, LOCK_FILE)
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as { nonce?: string }
    if (v.nonce === nonce) await deleteInSet(path, setDir, 'lock')
  } catch {
    // Gone already.
  }
}

// ------------------------------------------------------------------ objects

const objectPath = (setDir: string, id: string): string =>
  join(setDir, 'objects', id.slice(0, 2), id)

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function hashFile(f: SourceFile): Promise<{ sha: string; size: number }> {
  const hash = createHash('sha256')
  if (f.transform) {
    const data = f.transform(await readFile(f.abs))
    return { sha: hash.update(data).digest('hex'), size: data.length }
  }
  let size = 0
  for await (const chunk of createReadStream(f.abs)) {
    hash.update(chunk as Buffer)
    size += (chunk as Buffer).length
  }
  return { sha: hash.digest('hex'), size }
}

/**
 * Copy one file into the set as an object. Returns its content hash as
 * written (the file may have changed since it was hashed) and the bytes the
 * new object takes, or 0 when that content was there already.
 */
async function writeObject(
  f: SourceFile,
  setDir: string,
  keys: BackupKeys | null
): Promise<{ sha: string; size: number; id: string; stored: number }> {
  const tap = new HashTap()
  const placeholder = randomBytes(32).toString('hex')
  const shard = join(setDir, 'objects', placeholder.slice(0, 2))
  const tmp = join(shard, `${placeholder}.${rand()}.tmp`)
  await assertRealBackupWrite(tmp, setDir)
  await mkdir(shard, { recursive: true })
  try {
    const input = f.transform
      ? Readable.from([f.transform(await readFile(f.abs))])
      : createReadStream(f.abs)
    const out = createWriteStream(tmp, { flags: 'wx' })
    await pipeline(input, tap, createGzip(), sealStream(keys), out)
    const fh = await open(tmp, 'r+')
    await fh.sync()
    await fh.close()
    const sha = tap.digest()
    const id = objectId(sha, keys)
    const dest = objectPath(setDir, id)
    if (await exists(dest)) {
      await deleteInSet(tmp, setDir, 'tmp')
      return { sha, size: tap.bytes, id, stored: 0 }
    }
    const stored = (await stat(tmp)).size
    await assertRealBackupWrite(dest, setDir)
    await mkdir(dirname(dest), { recursive: true })
    await rename(tmp, dest)
    return { sha, size: tap.bytes, id, stored }
  } catch (err) {
    await deleteInSet(tmp, setDir, 'tmp').catch(() => undefined)
    throw err
  }
}

/**
 * Restore one file from the set into `dest` (a temp file the caller owns),
 * checking that the content is exactly what the manifest says.
 */
export async function readObjectTo(
  setDir: string,
  file: ManifestFile,
  keys: BackupKeys | null,
  dest: string
): Promise<void> {
  if (!OBJECT_RE.test(file.o)) throw new DamagedBackupError('A backup file name is invalid')
  const path = objectPath(setDir, file.o)
  if (!(await exists(path)))
    throw new DamagedBackupError(
      `A file of this snapshot is missing from the backup folder (${file.p})`
    )
  const [body, decipher] = await openObjectStreams(path, keys)
  const tap = new HashTap()
  try {
    const out = createWriteStream(dest, { flags: 'wx' })
    if (decipher) await pipeline(body, decipher, createGunzip(), tap, out)
    else await pipeline(body, createGunzip(), tap, out)
  } catch (err) {
    await unlink(dest).catch(() => undefined)
    if (err instanceof WrongPasswordError) throw err
    throw new DamagedBackupError(`A backup file was changed or damaged (${file.p})`)
  }
  const sha = tap.digest()
  if (sha !== file.h || objectId(sha, keys) !== file.o) {
    await unlink(dest).catch(() => undefined)
    throw new DamagedBackupError(`A backup file doesn't match its snapshot (${file.p})`)
  }
}

// ------------------------------------------------------------------ manifests

function validManifest(v: unknown, name: string): v is Manifest {
  const m = v as Manifest
  const match = SNAPSHOT_RE.exec(name)
  return (
    !!m &&
    !!match &&
    m.format === 'csd-backup-snapshot' &&
    m.version === 1 &&
    m.id === name.slice(0, -'.json'.length) &&
    typeof m.createdAt === 'string' &&
    !Number.isNaN(Date.parse(m.createdAt)) &&
    Array.isArray(m.objects) &&
    m.objects.every((o) => typeof o === 'string' && OBJECT_RE.test(o)) &&
    (m.keyId === null || typeof m.keyId === 'string') &&
    (m.keyId === null ? Array.isArray(m.files) : typeof m.sealed === 'string')
  )
}

export interface SnapshotList {
  snapshots: Manifest[]
  /** Manifest files that couldn't be read (being synced, or damaged). */
  damaged: string[]
}

export async function listSnapshots(setDir: string): Promise<SnapshotList> {
  const dir = join(setDir, 'snapshots')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { snapshots: [], damaged: [] }
  }
  const snapshots: Manifest[] = []
  const damaged: string[] = []
  for (const name of names) {
    if (!SNAPSHOT_RE.test(name)) continue
    try {
      const v: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))
      if (validManifest(v, name)) snapshots.push(v)
      else damaged.push(name)
    } catch {
      damaged.push(name)
    }
  }
  snapshots.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1)
  )
  return { snapshots, damaged }
}

export function manifestFiles(m: Manifest, keys: BackupKeys | null): ManifestFile[] {
  let files: unknown
  if (m.keyId === null) files = m.files
  else {
    if (!keys || keys.keyId !== m.keyId) throw new WrongPasswordError()
    const inner = JSON.parse(
      openBuffer(Buffer.from(m.sealed ?? '', 'base64'), keys).toString('utf8')
    ) as {
      id?: string
      files?: unknown
    }
    // A sealed list copied from another snapshot is refused.
    if (inner.id !== m.id) throw new DamagedBackupError('A snapshot was changed or damaged')
    files = inner.files
  }
  if (!Array.isArray(files)) throw new DamagedBackupError('A snapshot was changed or damaged')
  const out: ManifestFile[] = []
  for (const f of files as ManifestFile[]) {
    if (
      !f ||
      typeof f.p !== 'string' ||
      typeof f.h !== 'string' ||
      !/^[0-9a-f]{64}$/.test(f.h) ||
      typeof f.o !== 'string' ||
      !OBJECT_RE.test(f.o) ||
      typeof f.s !== 'number'
    )
      throw new DamagedBackupError('A snapshot was changed or damaged')
    out.push({ p: f.p, s: f.s, m: Number(f.m) || 0, h: f.h, o: f.o })
  }
  return out
}

// ------------------------------------------------------------------ backup

export interface CacheEntry {
  s: number
  m: number
  h: string
}

export interface RunOptions {
  setDir: string
  set: SetFile
  /** The current password's keys, or null when the set isn't encrypted. */
  keys: BackupKeys | null
  files: SourceFile[]
  /** Content hashes from earlier runs, by relative path (size + modified time must match). */
  cache: Record<string, CacheEntry>
  reason: BackupReason
  appVersion?: string
  /** This install (see acquireLock). */
  owner?: string
  now: () => number
  onProgress?: (done: number, total: number) => void
  /** Tests: called after each object, to simulate a crash part way through. */
  afterFile?: (index: number) => void | Promise<void>
  /** Remove old snapshots while still holding the lock (see applyRetention). */
  retention?: { keep: number; minObjectAgeMs?: number }
}

export interface RunResult {
  manifest: Manifest
  added: number
  addedBytes: number
  cache: Record<string, CacheEntry>
  retention?: RetentionResult
  retentionError?: string
}

export async function runBackup(o: RunOptions): Promise<RunResult> {
  if ((o.set.current ?? null) !== (o.keys?.keyId ?? null)) throw new WrongPasswordError()
  const nonce = await acquireLock(o.setDir, o.owner)
  try {
    await cleanTemp(o.setDir)
    const cache: Record<string, CacheEntry> = {}
    const entries: ManifestFile[] = []
    let added = 0
    let addedBytes = 0
    let i = 0
    const sourceOf = new Map<string, SourceFile>()
    for (const f of o.files) {
      let sha: string | undefined
      let size = f.size
      const c = o.cache[f.rel]
      if (!f.transform && c && c.s === f.size && c.m === f.mtimeMs) sha = c.h
      if (!sha) {
        try {
          ;({ sha, size } = await hashFile(f))
        } catch (err) {
          // Gone since the folder was listed: not part of this snapshot.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw err
        }
      }
      let id = objectId(sha, o.keys)
      if (!(await exists(objectPath(o.setDir, id)))) {
        let w
        try {
          w = await writeObject(f, o.setDir, o.keys)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw err
        }
        ;({ sha, size, id } = w)
        if (w.stored) {
          added++
          addedBytes += w.stored
        }
      }
      if (!f.transform && size === f.size) cache[f.rel] = { s: f.size, m: f.mtimeMs, h: sha }
      entries.push({ p: f.rel, s: size, m: f.mtimeMs, h: sha, o: id })
      sourceOf.set(f.rel, f)
      await o.afterFile?.(i)
      i++
      o.onProgress?.(i, o.files.length)
    }
    // Last check before the snapshot counts: every object it names is there
    // (another PC sharing a synced folder may have removed an old one).
    for (const e of entries) {
      if (await exists(objectPath(o.setDir, e.o))) continue
      const src = sourceOf.get(e.p) as SourceFile
      const w = await writeObject(src, o.setDir, o.keys)
      if (w.stored) {
        added++
        addedBytes += w.stored
      }
      Object.assign(e, { s: w.size, h: w.sha, o: w.id })
      if (cache[e.p]) cache[e.p] = { ...(cache[e.p] as CacheEntry), h: w.sha }
    }
    const t = o.now()
    const snapId = `${stampOf(t)}-${rand()}`
    const manifest: Manifest = {
      format: 'csd-backup-snapshot',
      version: 1,
      id: snapId,
      setId: o.set.id,
      createdAt: new Date(t).toISOString(),
      appVersion: o.appVersion,
      reason: o.reason,
      keyId: o.keys?.keyId ?? null,
      fileCount: entries.length,
      totalBytes: entries.reduce((n, e) => n + e.s, 0),
      objects: [...new Set(entries.map((e) => e.o))].sort()
    }
    if (o.keys)
      manifest.sealed = sealBuffer(
        Buffer.from(JSON.stringify({ id: snapId, files: entries })),
        o.keys
      ).toString('base64')
    else manifest.files = entries
    // The snapshot counts from here on, and only if this write completes.
    await writeInSet(
      join(o.setDir, 'snapshots', `${snapId}.json`),
      JSON.stringify(manifest),
      o.setDir
    )
    const result: RunResult = { manifest, added, addedBytes, cache }
    // Still under the lock, so no other backup can be reusing an object
    // that retention is about to remove.
    if (o.retention) {
      try {
        result.retention = await retainLocked(o.setDir, o.retention.keep, o.retention)
      } catch (err) {
        result.retentionError = (err as Error).message
      }
    }
    return result
  } finally {
    await releaseLock(o.setDir, nonce)
  }
}

/** The app's own temp files older than a day (from a crash). */
async function cleanTemp(setDir: string): Promise<void> {
  // File times are the real clock's.
  const now = Date.now()
  const dirs = [setDir, join(setDir, 'snapshots')]
  const objects = join(setDir, 'objects')
  for (const d of await readdir(objects).catch(() => [] as string[]))
    if (/^[0-9a-f]{2}$/.test(d)) dirs.push(join(objects, d))
  for (const d of dirs) {
    for (const n of await readdir(d).catch(() => [] as string[])) {
      if (!TMP_RE.test(n)) continue
      const p = join(d, n)
      const st = await stat(p).catch(() => undefined)
      if (st && now - st.mtimeMs > 24 * 60 * 60_000)
        await deleteInSet(p, setDir, 'tmp').catch(() => undefined)
    }
  }
}

// ------------------------------------------------------------------ retention

export interface RetentionResult {
  removedSnapshots: number
  removedObjects: number
  /** Unused objects weren't removed (a snapshot couldn't be read). */
  skippedObjects?: string
}

/**
 * Keep the newest `keep` snapshots and delete older ones; then delete
 * objects no remaining snapshot uses, if they're older than `minObjectAgeMs`
 * (so another PC's backup into the same synced folder, still writing, keeps
 * its new objects). Nothing outside the set is touched.
 */
export async function applyRetention(
  setDir: string,
  keep: number,
  opts: { minObjectAgeMs?: number; protect?: string[]; owner?: string } = {}
): Promise<RetentionResult> {
  // The same lock as a backup: never while a backup may be reusing objects.
  const nonce = await acquireLock(setDir, opts.owner)
  try {
    return await retainLocked(setDir, keep, opts)
  } finally {
    await releaseLock(setDir, nonce)
  }
}

async function retainLocked(
  setDir: string,
  keep: number,
  opts: { minObjectAgeMs?: number; protect?: string[] }
): Promise<RetentionResult> {
  const keepN = Math.max(1, Math.floor(keep))
  const { snapshots, damaged } = await listSnapshots(setDir)
  const protect = new Set(opts.protect ?? [])
  const old = snapshots.slice(keepN).filter((s) => !protect.has(s.id))
  for (const s of old)
    await deleteInSet(join(setDir, 'snapshots', `${s.id}.json`), setDir, 'snapshot')
  const result: RetentionResult = { removedSnapshots: old.length, removedObjects: 0 }
  if (damaged.length) {
    result.skippedObjects = `${damaged.length} snapshot file${damaged.length === 1 ? '' : 's'} couldn't be read`
    return result
  }
  const gone = new Set(old.map((s) => s.id))
  const used = new Set<string>()
  for (const s of snapshots) if (!gone.has(s.id)) for (const id of s.objects) used.add(id)
  const minAge = opts.minObjectAgeMs ?? 12 * 60 * 60_000
  const objects = join(setDir, 'objects')
  for (const d of await readdir(objects).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue
    for (const n of await readdir(join(objects, d)).catch(() => [] as string[])) {
      if (!OBJECT_RE.test(n) || !n.startsWith(d) || used.has(n)) continue
      const p = join(objects, d, n)
      const st = await stat(p).catch(() => undefined)
      if (!st || Date.now() - st.mtimeMs < minAge) continue
      await deleteInSet(p, setDir, 'object')
      result.removedObjects++
    }
  }
  return result
}

/** Total size of the set's objects and manifests. */
export async function setSize(setDir: string): Promise<number> {
  let bytes = 0
  const add = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile()) bytes += (await stat(join(d, e.name)).catch(() => ({ size: 0 }))).size
      else if (e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name)) await add(join(d, e.name))
    }
  }
  await add(join(setDir, 'objects'))
  await add(join(setDir, 'snapshots'))
  return bytes
}
