// Settings → Backup: cleaning up old restore safety copies
// (`<data>/restore-backups/<time>/`). Only the app's own time-stamped folders,
// aged by their name, never the newest, never a link or junction, and only
// what was listed and confirmed.

import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteSafetyCopies, listSafetyCopies, stampTime } from '../src/main/core/restore-safety'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00Z')
let data: string
let root: string

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), 'csd-safety-'))
  root = join(data, 'restore-backups')
  await mkdir(root, { recursive: true })
})
afterEach(async () => {
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** A safety folder as a restore leaves it, `daysAgo` before NOW. */
async function copy(daysAgo: number, files: Record<string, string> = { 'metadata.json': '{}' }) {
  const name = new Date(NOW - daysAgo * DAY)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, name, rel)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, text)
  }
  return name
}

describe('restore safety copies', () => {
  it('reads time stamps the way restores write them, and nothing else', () => {
    expect(stampTime('20261109T120000Z')).toBe(NOW)
    for (const bad of ['20261340T120000Z', '20261109T120000', 'notes', '20261109T120000Z.bak'])
      expect(stampTime(bad)).toBeUndefined()
  })

  it('lists sizes, and offers only copies older than 30 days, never the newest', async () => {
    const fresh = await copy(2, { 'settings.json': 'abcd' })
    const old1 = await copy(40, { 'metadata.json': '12345', 'archive/w/s.jsonl': '123' })
    const old2 = await copy(31)
    await copy(29)
    const s = await listSafetyCopies(data, NOW)
    expect(s.copies.map((c) => c.name)).toEqual([fresh, expect.any(String), old2, old1])
    expect(s.old.map((c) => c.name)).toEqual([old2, old1])
    expect(s.old.find((c) => c.name === old1)).toMatchObject({ bytes: 8, files: 2 })
    expect(s.bytes).toBe(4 + 8 + 2 + 2)
    expect(s.oldBytes).toBe(10)
  })

  it('keeps the newest copy even when it is older than 30 days', async () => {
    const only = await copy(90)
    expect((await listSafetyCopies(data, NOW)).old).toEqual([])
    const older = await copy(120)
    const s = await listSafetyCopies(data, NOW)
    expect(s.old.map((c) => c.name)).toEqual([older])
    await deleteSafetyCopies(data, [only, older], NOW)
    expect(await readdir(root)).toEqual([only])
  })

  it('ages by the folder name, not by file dates', async () => {
    await copy(1)
    const name = await copy(45)
    // Touched today (e.g. by a sync tool): still 45 days old.
    await utimes(join(root, name), NOW / 1000, NOW / 1000)
    expect((await listSafetyCopies(data, NOW)).old.map((c) => c.name)).toEqual([name])
  })

  it('leaves folders and files that are not its own alone', async () => {
    await copy(1)
    await mkdir(join(root, 'my-notes'))
    await writeFile(join(root, '20200101T000000Z'), 'a file, not a folder')
    const s = await listSafetyCopies(data, NOW)
    expect(s.other).toBe(2)
    expect(s.old).toEqual([])
    await deleteSafetyCopies(data, ['my-notes', '20200101T000000Z'], NOW)
    expect((await readdir(root)).sort()).toEqual(
      [s.copies[0].name, '20200101T000000Z', 'my-notes'].sort()
    )
  })

  it('deletes only what was listed and is still old enough', async () => {
    await copy(1)
    const a = await copy(40)
    const b = await copy(50)
    const young = await copy(10)
    // b wasn't in the list I confirmed; young never qualifies.
    const r = await deleteSafetyCopies(data, [a, young, 'missing'], NOW)
    expect(r.deleted.map((c) => c.name)).toEqual([a])
    expect(r.errors).toEqual([])
    expect((await readdir(root)).sort()).toEqual([b, young, expect.any(String)].sort())
  })

  it('never follows or deletes a junction, and removes a link inside a copy only as a link', async () => {
    await copy(1)
    const outside = join(data, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'mine')
    const linkName = new Date(NOW - 60 * DAY)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
    try {
      await symlink(outside, join(root, linkName), 'junction')
    } catch {
      return // no junctions here (not Windows, or not allowed)
    }
    const s = await listSafetyCopies(data, NOW)
    expect(s.old.map((c) => c.name)).not.toContain(linkName)
    expect(s.other).toBe(1)
    await deleteSafetyCopies(data, [linkName], NOW)
    expect(await readdir(outside)).toEqual(['keep.txt'])

    // A junction inside an old copy: the copy goes, the junction's target stays.
    const old = await copy(70)
    await symlink(outside, join(root, old, 'link'), 'junction')
    expect((await deleteSafetyCopies(data, [old], NOW)).deleted.map((c) => c.name)).toEqual([old])
    expect(await readdir(outside)).toEqual(['keep.txt'])
  })

  it('never lists or cleans a restore-backups folder that is itself a junction', async () => {
    // Elsewhere on the disk: two old "copies" and a newer one, under the same names a
    // restore uses.
    const elsewhere = join(data, '..', `${data.split(/[\\/]/).pop()}-outside`)
    await rm(root, { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    try {
      for (const daysAgo of [1, 40, 50]) {
        const name = new Date(NOW - daysAgo * DAY)
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}/, '')
        await mkdir(join(elsewhere, name))
        await writeFile(join(elsewhere, name, 'keep.json'), 'not the app’s')
      }
      try {
        await symlink(elsewhere, root, 'junction')
      } catch {
        return // no junctions here (not Windows, or not allowed)
      }
      const s = await listSafetyCopies(data, NOW)
      expect(s).toMatchObject({
        copies: [],
        old: [],
        bytes: 0,
        refused: expect.stringMatching(/junction/)
      })
      const names = (await readdir(elsewhere)).sort()
      const r = await deleteSafetyCopies(data, names, NOW)
      expect(r.deleted).toEqual([])
      expect(r.errors).toEqual([expect.stringMatching(/junction/)])
      expect((await readdir(elsewhere)).sort()).toEqual(names)
    } finally {
      await rm(root, { force: true }).catch(() => undefined)
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('has nothing to do without a restore-backups folder', async () => {
    await rm(root, { recursive: true })
    expect(await listSafetyCopies(data, NOW)).toMatchObject({ copies: [], old: [], bytes: 0 })
    expect(await deleteSafetyCopies(data, ['20200101T000000Z'], NOW)).toEqual({
      deleted: [],
      errors: []
    })
  })
})

describe('Settings → Backup: the safety-copy cleanup', () => {
  async function service(now: () => number) {
    const { BackupService, createBackupStore } = await import('../src/main/services/backup')
    const store = createBackupStore(data)
    await store.load()
    const svc = new BackupService({
      store,
      dataDir: data,
      appVersion: '1.0.0',
      encryptor: {
        available: () => false,
        encrypt: async () => Buffer.alloc(0),
        decrypt: async () => ''
      },
      now
    })
    return { svc, store }
  }

  it('automatic cleanup is off by default and deletes nothing', async () => {
    await copy(1)
    const old = await copy(60)
    const { svc } = await service(() => NOW)
    expect((await svc.status()).autoCleanSafety).toBe(false)
    expect(await svc.autoCleanSafety()).toBeUndefined()
    expect(await readdir(root)).toContain(old)
  })

  it('once turned on, cleans up old copies at most once a day', async () => {
    let t = NOW
    await copy(1)
    const old = await copy(60)
    const { svc } = await service(() => t)
    await svc.update({ autoCleanSafety: true })
    expect(await svc.autoCleanSafety()).toMatchObject({ deleted: 1, by: 'auto' })
    expect(await readdir(root)).not.toContain(old)
    // Later the same day: it doesn't look again.
    const another = await copy(70)
    t += 3_600_000
    expect(await svc.autoCleanSafety()).toBeUndefined()
    expect(await readdir(root)).toContain(another)
    t += DAY
    expect(await svc.autoCleanSafety()).toMatchObject({ deleted: 1 })
    expect((await svc.status()).lastSafetyCleanup).toMatchObject({ deleted: 1, by: 'auto' })
  })

  it('a manual cleanup deletes the listed old copies and records it', async () => {
    const newest = await copy(5, { 'a.json': '12' })
    const old = await copy(45, { 'b.json': '1234' })
    const { svc } = await service(() => NOW)
    const listed = await svc.safetyCopies()
    expect(listed.old.map((c) => c.name)).toEqual([old])
    const r = await svc.cleanSafetyCopies(listed.old.map((c) => c.name))
    expect(r).toMatchObject({ deleted: 1, bytes: 4, by: 'manual' })
    expect(await readdir(root)).toEqual([newest])
    expect((await svc.status()).lastSafetyCleanup).toMatchObject({ deleted: 1, bytes: 4 })
  })
})
