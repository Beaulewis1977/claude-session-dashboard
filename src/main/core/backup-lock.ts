// One writer at a time in a backup set: backups and retention take this lock.
//
// - Claimed with mkdir (atomic on every file system, FAT and exFAT drives
//   included): exactly one of two racing claimers gets the folder. A folder
//   whose owner file isn't readable yet is being set up: busy, not stale.
// - Never taken from a live process on this PC (its process is checked), and
//   a running backup renews its lease every minute, however long it takes.
// - Another PC's lock is respected until its lease runs out (30 minutes
//   without a renewal).
// - A stale lock is taken over in place: a taker creates
//   `lock/takeover-<stale owner>` exclusively (only one taker can, for a
//   given stale owner), checks the stale owner is still the one there, then
//   replaces the owner file. A fresh lock someone else claimed meanwhile has
//   another owner, so it is never taken.
// - Fencing: before saving a snapshot or deleting anything, the holder checks
//   the lock is still its own, and stops if not.
//
// A synced cloud folder can't give real mutual exclusion between two PCs
// (each has its own copy for a while); the backup set also records the one
// install that may write to it (see services/backup.ts).

import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertSetRoot,
  deleteInSet,
  LOCK_DIR,
  OWNER_FILE,
  rand,
  TAKEOVER_RE,
  TMP_RE
} from './backup-fs'
import { assertRealBackupWrite } from './safe-paths'

export class BackupBusyError extends Error {}

const HEARTBEAT_MS = 60_000
/** Another install's lock is abandoned this long after its last renewal. */
export const REMOTE_LEASE_MS = 30 * 60_000
/** A lock folder without a readable owner file is still being set up for this long. */
export const UNREADABLE_GRACE_MS = 10 * 60_000

interface Owner {
  nonce: string
  owner?: string
  pid?: number
  at: string
}

export interface LockHandle {
  nonce: string
  /** Throws BackupBusyError unless this lock is still the set's lock (fencing). */
  assertHeld(): Promise<void>
  release(): Promise<void>
}

export function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readOwner(dir: string): Promise<Owner | undefined> {
  try {
    const v = JSON.parse(await readFile(join(dir, OWNER_FILE), 'utf8')) as Owner
    return v && typeof v.nonce === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Write the owner file into an existing lock folder (never creating the
 * folder: a renewal after the lock was released or moved must not bring it
 * back).
 */
async function writeOwner(dir: string, setDir: string, o: Owner): Promise<void> {
  const path = join(dir, OWNER_FILE)
  await assertRealBackupWrite(path, setDir)
  const tmp = `${path}.${rand()}.tmp`
  const fh = await open(tmp, 'wx')
  try {
    await fh.writeFile(JSON.stringify(o))
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

/** Remove the app's lock folder: its owner, takeover and temp files, then the empty folder. */
export async function removeLockDir(dir: string, setDir: string): Promise<void> {
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (n === OWNER_FILE || TAKEOVER_RE.test(n))
      await deleteInSet(join(dir, n), setDir, 'lock-owner')
    else if (TMP_RE.test(n)) await deleteInSet(join(dir, n), setDir, 'tmp')
  }
  await deleteInSet(dir, setDir, 'lock-dir')
}

type Verdict = { busy: string } | { stale: string | null } | { gone: true }

async function judge(dir: string, owner: string | undefined): Promise<Verdict> {
  const now = Date.now()
  const o = await readOwner(dir)
  if (!o) {
    const st = await stat(dir).catch(() => undefined)
    if (!st) return { gone: true }
    if (now - st.mtimeMs < UNREADABLE_GRACE_MS)
      return { busy: 'Another backup into this folder is starting right now.' }
    return { stale: null }
  }
  if (owner && o.owner === owner) {
    // This install. Never take a lock from a process that is still running.
    if (o.pid === process.pid || alive(o.pid))
      return { busy: 'A backup into this folder is already running on this PC.' }
    return { stale: o.nonce }
  }
  const at = Date.parse(o.at) || 0
  if (now - at < REMOTE_LEASE_MS)
    return {
      busy: `Another backup into this folder is running (last active ${new Date(at).toLocaleString()}).`
    }
  return { stale: o.nonce }
}

export async function acquireLock(
  setDir: string,
  owner?: string,
  /** Tests: renew faster. */
  opts: { heartbeatMs?: number } = {}
): Promise<LockHandle> {
  await assertSetRoot(setDir)
  const dir = join(setDir, LOCK_DIR)
  await assertRealBackupWrite(dir, setDir)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await mkdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const v = await judge(dir, owner)
      if ('gone' in v) continue
      if ('busy' in v) throw new BackupBusyError(v.busy)
      // Take the stale lock over in place. Only one taker can create the
      // takeover marker for this stale owner.
      const marker = join(dir, `takeover-${v.stale ?? 'none'}`)
      await assertRealBackupWrite(marker, setDir)
      try {
        await (await open(marker, 'wx')).close()
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue // released meanwhile: claim it normally
        if (code === 'EEXIST')
          throw new BackupBusyError('Another backup into this folder is taking it over right now.')
        throw err
      }
      // Still the very lock judged stale? (Not one claimed fresh meanwhile.)
      const still = await readOwner(dir)
      if ((still?.nonce ?? null) !== v.stale) {
        await deleteInSet(marker, setDir, 'lock-owner').catch(() => undefined)
        throw new BackupBusyError('Another backup into this folder started right now.')
      }
      const me = newOwner(owner)
      await writeOwner(dir, setDir, me)
      return handle(dir, setDir, me, opts.heartbeatMs ?? HEARTBEAT_MS)
    }
    const me = newOwner(owner)
    try {
      await writeOwner(dir, setDir, me)
    } catch (err) {
      await removeLockDir(dir, setDir).catch(() => undefined)
      throw err
    }
    return handle(dir, setDir, me, opts.heartbeatMs ?? HEARTBEAT_MS)
  }
  throw new BackupBusyError('Another backup into this folder is running right now.')
}

function newOwner(owner: string | undefined): Owner {
  return {
    nonce: randomBytes(8).toString('hex'),
    owner,
    pid: process.pid,
    at: new Date().toISOString()
  }
}

function handle(dir: string, setDir: string, me: Owner, every: number): LockHandle {
  let renewing: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    renewing = (async () => {
      const o = await readOwner(dir)
      if (o?.nonce === me.nonce)
        await writeOwner(dir, setDir, { ...me, at: new Date().toISOString() })
    })().catch(() => undefined)
  }, every)
  timer.unref?.()
  return {
    nonce: me.nonce,
    async assertHeld() {
      const o = await readOwner(dir)
      if (o?.nonce !== me.nonce)
        throw new BackupBusyError(
          'This backup lost its lock on the backup folder (another backup took over), so it stopped before saving or deleting anything.'
        )
    },
    async release() {
      clearInterval(timer)
      await renewing
      const o = await readOwner(dir)
      if (o?.nonce === me.nonce) await removeLockDir(dir, setDir).catch(() => undefined)
    }
  }
}
