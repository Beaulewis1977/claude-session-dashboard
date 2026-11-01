// The only ways the app writes or deletes inside a backup set, shared by the
// store (backup-store.ts) and its lock (backup-lock.ts).

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { assertRealBackupWrite, isInside, isInsideClaudeDir, UnsafeWriteError } from './safe-paths'

export const SNAPSHOT_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{8})\.json$/
export const OBJECT_RE = /^[0-9a-f]{64}$/
export const LOCK_DIR = 'lock'
export const OWNER_FILE = 'owner.json'
/** A takeover marker inside the lock folder (one per stale owner). */
export const TAKEOVER_RE = /^takeover-([0-9a-f]{16}|none)$/
export const TMP_RE =
  /^[0-9a-f]{64}\.[0-9a-f]{8}\.tmp$|^\d{8}T\d{6}Z-[0-9a-f]{8}\.json\.[0-9a-f]{8}\.tmp$|^backup-set\.json\.[0-9a-f]{8}\.tmp$|^owner\.json\.[0-9a-f]{8}\.tmp$/

export const rand = (): string => randomBytes(4).toString('hex')

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * The set's own folder must be a real folder, not a link or junction: every
 * other check trusts it as the boundary, so a redirected root would move
 * every write and delete somewhere else.
 */
export async function assertSetRoot(setDir: string): Promise<void> {
  const st = await lstat(setDir)
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new UnsafeWriteError(
      `The backup folder is a link or junction, not a real folder, so the app won't use it: ${setDir}`
    )
  if (isInsideClaudeDir(await realpath(setDir)))
    throw new UnsafeWriteError(`Refusing a backup folder inside .claude: ${setDir}`)
}

/** Write `data` to `path` inside the set: temp file, flush, rename. */
export async function writeInSet(
  path: string,
  data: Buffer | string,
  setDir: string
): Promise<void> {
  await assertSetRoot(setDir)
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

export type DeleteKind = 'snapshot' | 'object' | 'tmp' | 'lock-owner' | 'lock-dir'

const isLockDir = (dir: string, set: string): boolean => dir === join(set, LOCK_DIR)

/**
 * The only way the app deletes anything in a backup set: a snapshot manifest,
 * an object, one of its own temp files, or its own lock (the owner file, then
 * the empty lock folder), by exact name and place, never through a link, and
 * only where the real folder is inside the real set (whose root is no link).
 */
export async function deleteInSet(target: string, setDir: string, kind: DeleteKind): Promise<void> {
  const t = resolve(target)
  const set = resolve(setDir)
  const name = basename(t)
  const parent = dirname(t)
  const ok =
    kind === 'snapshot'
      ? SNAPSHOT_RE.test(name) && parent === join(set, 'snapshots')
      : kind === 'object'
        ? OBJECT_RE.test(name) && parent === join(set, 'objects', name.slice(0, 2))
        : kind === 'lock-owner'
          ? (name === OWNER_FILE || TAKEOVER_RE.test(name)) && isLockDir(parent, set)
          : kind === 'lock-dir'
            ? isLockDir(t, set)
            : TMP_RE.test(name) &&
              (parent === set ||
                parent === join(set, 'snapshots') ||
                isLockDir(parent, set) ||
                (dirname(parent) === join(set, 'objects') &&
                  /^[0-9a-f]{2}$/.test(basename(parent))))
  if (!ok || isInsideClaudeDir(t)) throw new UnsafeWriteError(`Refusing to delete ${target}`)
  await assertSetRoot(set)
  const [realParent, realSet, st] = await Promise.all([realpath(parent), realpath(set), lstat(t)])
  if (!isInside(realParent, realSet) || st.isSymbolicLink())
    throw new UnsafeWriteError(`Refusing to delete ${target}`)
  if (kind === 'lock-dir') {
    if (!st.isDirectory()) throw new UnsafeWriteError(`Refusing to delete ${target}`)
    // Never recursive: only an empty lock folder goes.
    await rmdir(t)
    return
  }
  if (!st.isFile()) throw new UnsafeWriteError(`Refusing to delete ${target}`)
  await unlink(t)
}
