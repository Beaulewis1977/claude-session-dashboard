// The backup set's lock and the guarantees around it (PR #20 re-review):
// atomic claims, no takeover of a live holder, leases for other PCs, one
// winner among racing takers, fencing, and retention failing closed.

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectFiles } from '../src/main/core/backup-files'
import { deleteInSet } from '../src/main/core/backup-fs'
import {
  acquireLock,
  BackupBusyError,
  REMOTE_LEASE_MS,
  UNREADABLE_GRACE_MS
} from '../src/main/core/backup-lock'
import { applyRetention, createSet, listSnapshots, runBackup } from '../src/main/core/backup-store'
import { assertRealBackupWrite } from '../src/main/core/safe-paths'
import { BACKUP_SET_DIR } from '../src/shared/backup'

let root: string
let dataDir: string
let setDir: string
const lockDir = (): string => join(setDir, 'lock')
const owner = (): string => join(lockDir(), 'owner.json')
const now = (): number => Date.now()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-lock-'))
  dataDir = join(root, 'data')
  setDir = join(root, 'dest', BACKUP_SET_DIR)
  await mkdir(join(dataDir, 'archive', 'windows'), { recursive: true })
  await writeFile(join(dataDir, 'metadata.json'), '{"version":1,"sessions":{},"archive":{}}')
  await writeFile(join(dataDir, 'archive', 'windows', 'a.jsonl'), '{"type":"user"}\n')
  await createSet(setDir, new Date().toISOString())
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fakeLock(o: object, ageMs = 0): Promise<void> {
  await mkdir(lockDir(), { recursive: true })
  await writeFile(owner(), JSON.stringify(o))
  if (ageMs) {
    const t = new Date(Date.now() - ageMs)
    await utimes(owner(), t, t)
    await utimes(lockDir(), t, t)
  }
}
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
/** A PID that can't be a running process (Windows PIDs are multiples of 4). */
const DEAD_PID = 2 ** 22 + 7

describe('claiming the lock', () => {
  it('a lock folder whose owner file isn’t written yet is busy, not stale', async () => {
    await mkdir(lockDir())
    await expect(acquireLock(setDir, 'me')).rejects.toBeInstanceOf(BackupBusyError)
    // Abandoned long ago without an owner file: taken over.
    const t = new Date(Date.now() - UNREADABLE_GRACE_MS - 60_000)
    await utimes(lockDir(), t, t)
    const l = await acquireLock(setDir, 'me')
    await l.release()
  })

  it('never takes over a live process on this PC, however old its lock looks', async () => {
    await fakeLock({ nonce: 'a'.repeat(16), owner: 'me', pid: process.pid, at: ago(48 * 3600_000) })
    await expect(acquireLock(setDir, 'me')).rejects.toThrow(/already running on this PC/)
    // Another live process of this install (e.g. one that's still finishing).
    await fakeLock({
      nonce: 'b'.repeat(16),
      owner: 'me',
      pid: process.ppid,
      at: ago(48 * 3600_000)
    })
    await expect(acquireLock(setDir, 'me')).rejects.toThrow(/already running on this PC/)
    // Its process has ended (the app quit or crashed mid-backup): taken over.
    await fakeLock({ nonce: 'c'.repeat(16), owner: 'me', pid: DEAD_PID, at: ago(1000) })
    const l = await acquireLock(setDir, 'me')
    await l.release()
  })

  it('respects another PC’s lock until its lease runs out', async () => {
    await fakeLock({
      nonce: 'd'.repeat(16),
      owner: 'other-pc',
      pid: process.pid,
      at: ago(REMOTE_LEASE_MS - 60_000)
    })
    await expect(acquireLock(setDir, 'me')).rejects.toThrow(/Another backup/)
    await fakeLock({
      nonce: 'e'.repeat(16),
      owner: 'other-pc',
      pid: 1,
      at: ago(REMOTE_LEASE_MS + 60_000)
    })
    const l = await acquireLock(setDir, 'me')
    await l.release()
  })

  it('a running holder renews its lease, so a long backup keeps its lock', async () => {
    const l = await acquireLock(setDir, 'me', { heartbeatMs: 40 })
    const o = JSON.parse(await readFile(owner(), 'utf8'))
    // Pretend the last renewal was long ago...
    await writeFile(owner(), JSON.stringify({ ...o, at: ago(REMOTE_LEASE_MS + 60_000) }))
    await new Promise((r) => setTimeout(r, 200))
    // ...the heartbeat has renewed it: another PC still sees it as busy.
    expect(Date.now() - Date.parse(JSON.parse(await readFile(owner(), 'utf8')).at)).toBeLessThan(
      5000
    )
    await expect(acquireLock(setDir, 'other-pc')).rejects.toBeInstanceOf(BackupBusyError)
    await l.release()
    // Released: gone, and a late renewal never brings it back.
    await new Promise((r) => setTimeout(r, 120))
    await expect(stat(lockDir())).rejects.toThrow()
  })

  it('of two takers of one stale lock, exactly one wins', async () => {
    for (let round = 0; round < 5; round++) {
      await fakeLock({
        nonce: 'f'.repeat(16),
        owner: 'gone-pc',
        pid: 1,
        at: ago(REMOTE_LEASE_MS * 2)
      })
      const results = await Promise.allSettled([
        acquireLock(setDir, 'pc-a'),
        acquireLock(setDir, 'pc-b'),
        acquireLock(setDir, 'pc-c')
      ])
      const won = results.filter((r) => r.status === 'fulfilled')
      expect(won).toHaveLength(1)
      for (const r of results)
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(BackupBusyError)
      await (
        won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>
      ).value.release()
    }
    // Nothing left behind but the set's own files.
    expect((await readdir(setDir)).filter((n) => n.startsWith('lock'))).toEqual([])
  })
})

describe('fencing', () => {
  it('a backup whose lock was taken stops before saving its snapshot', async () => {
    const set = (await import('../src/main/core/backup-store')).readSet
    const s = (await set(setDir))!
    const files = (await collectFiles(dataDir)).files
    await expect(
      runBackup({
        setDir,
        set: s,
        keys: null,
        files,
        cache: {},
        reason: 'manual',
        owner: 'me',
        now,
        afterFile: async (i) => {
          if (i !== files.length - 1) return
          // Another backup took the lock over meanwhile.
          await rm(lockDir(), { recursive: true })
          await fakeLock({
            nonce: '9'.repeat(16),
            owner: 'other-pc',
            pid: 1,
            at: new Date().toISOString()
          })
        }
      })
    ).rejects.toThrow(/lost its lock/)
    expect((await listSnapshots(setDir)).snapshots).toEqual([])
    // It didn't remove the other backup's lock on its way out.
    expect(JSON.parse(await readFile(owner(), 'utf8')).nonce).toBe('9'.repeat(16))
  })

  it('retention and a backup never run at once', async () => {
    const l = await acquireLock(setDir, 'me')
    await expect(
      applyRetention(setDir, 1, { minObjectAgeMs: 0, owner: 'me' })
    ).rejects.toBeInstanceOf(BackupBusyError)
    await l.release()
  })
})

describe('retention fails closed', () => {
  async function twoSnapshots(): Promise<string[]> {
    const { readSet } = await import('../src/main/core/backup-store')
    const s = (await readSet(setDir))!
    await runBackup({
      setDir,
      set: s,
      keys: null,
      files: (await collectFiles(dataDir)).files,
      cache: {},
      reason: 'manual',
      now
    })
    await writeFile(
      join(dataDir, 'metadata.json'),
      '{"version":1,"sessions":{"x":{}},"archive":{}}'
    )
    await runBackup({
      setDir,
      set: s,
      keys: null,
      files: (await collectFiles(dataDir)).files,
      cache: {},
      reason: 'manual',
      now
    })
    return (await readdir(join(setDir, 'objects'), { recursive: true })).filter((n) =>
      /[0-9a-f]{64}$/.test(n)
    )
  }

  it('if the snapshots can’t be listed, nothing is deleted', async () => {
    const objects = await twoSnapshots()
    // The snapshots folder can't be read as a folder (here: replaced by a file).
    await rename(join(setDir, 'snapshots'), join(root, 'snapshots-elsewhere'))
    await writeFile(join(setDir, 'snapshots'), 'not a folder')
    await expect(listSnapshots(setDir)).rejects.toThrow()
    await expect(applyRetention(setDir, 1, { minObjectAgeMs: 0 })).rejects.toThrow()
    const after = (await readdir(join(setDir, 'objects'), { recursive: true })).filter((n) =>
      /[0-9a-f]{64}$/.test(n)
    )
    expect(after.sort()).toEqual(objects.sort())
  })

  it('with no snapshot left to check against, no object is deleted', async () => {
    const objects = await twoSnapshots()
    await rename(join(setDir, 'snapshots'), join(root, 'snapshots-elsewhere'))
    const r = await applyRetention(setDir, 1, { minObjectAgeMs: 0 })
    expect(r.removedObjects).toBe(0)
    expect(r.skippedObjects).toMatch(/no snapshot/)
    const after = (await readdir(join(setDir, 'objects'), { recursive: true })).filter((n) =>
      /[0-9a-f]{64}$/.test(n)
    )
    expect(after.sort()).toEqual(objects.sort())
  })
})

describe('a linked set root is never trusted', () => {
  it('refuses writes and deletes when the set folder is a junction', async () => {
    const elsewhere = join(root, 'elsewhere')
    await mkdir(join(elsewhere, 'snapshots'), { recursive: true })
    const victim = join(elsewhere, 'snapshots', '20261101T000000Z-0000abcd.json')
    await writeFile(victim, '{}')
    const linked = join(root, 'dest2', BACKUP_SET_DIR)
    await mkdir(join(root, 'dest2'), { recursive: true })
    try {
      await symlink(elsewhere, linked, 'junction')
    } catch {
      return // links not allowed here
    }
    await expect(
      deleteInSet(join(linked, 'snapshots', '20261101T000000Z-0000abcd.json'), linked, 'snapshot')
    ).rejects.toThrow()
    await expect(
      assertRealBackupWrite(join(linked, 'snapshots', 'x.json'), linked)
    ).rejects.toThrow(/link/)
    await expect(acquireLock(linked, 'me')).rejects.toThrow(/link or junction/)
    await expect(applyRetention(linked, 1, { minObjectAgeMs: 0 })).rejects.toThrow(
      /link or junction/
    )
    expect(await readFile(victim, 'utf8')).toBe('{}')
    expect(await readdir(elsewhere)).toEqual(['snapshots'])
  })
})
