import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  newKeyEntry,
  objectId,
  openBuffer,
  sealBuffer,
  unlockKey,
  WrongPasswordError,
  type BackupKeys
} from '../src/main/core/backup-crypto'
import {
  collectFiles,
  isRestorablePath,
  mergeOnRestore,
  rebaseArchivePath,
  stripAccountKeys,
  targetPath
} from '../src/main/core/backup-files'
import {
  applyRetention,
  createSet,
  deleteInSet,
  listSnapshots,
  manifestFiles,
  readObjectTo,
  readSet,
  runBackup,
  type CacheEntry,
  type SetFile
} from '../src/main/core/backup-store'
import {
  applyPendingRestore,
  hasPendingRestore,
  planRestore,
  stageRestore
} from '../src/main/core/backup-restore'
import { JsonStore } from '../src/main/core/json-store'
import { BackupService, createBackupStore } from '../src/main/services/backup'
import { BACKUP_SET_DIR, isBackupError, type RestorePreview } from '../src/shared/backup'

/** Fast key derivation for tests (the app uses DEFAULT_KDF). */
const FAST = { N: 2 ** 10, r: 8, p: 1 }

let root: string
let dataDir: string
let dest: string
let setDir: string
let clock: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-backup-'))
  dataDir = join(root, 'AppData', 'Roaming', 'ClaudeSessionDashboard')
  dest = join(root, 'OneDrive')
  setDir = join(dest, BACKUP_SET_DIR)
  clock = Date.parse('2026-11-01T12:00:00Z')
  await mkdir(dest, { recursive: true })
  await seedData()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const now = (): number => clock

async function put(rel: string, content: string): Promise<void> {
  const p = join(dataDir, ...rel.split('/'))
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, content)
}

async function seedData(): Promise<void> {
  await put(
    'archive/windows/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl',
    '{"type":"user","message":"hello"}\n'
  )
  await put(
    'archive/wsl-Ubuntu-beau/e9a1b2c3-d4e5-4f60-8172-839405a6b7c8.jsonl',
    '{"type":"user","message":"orders"}\n'
  )
  await put(
    'metadata.json',
    JSON.stringify({
      version: 1,
      sessions: { s1: { name: 'Checkout redesign', tags: ['web'] } },
      archive: {}
    })
  )
  await put('settings.json', JSON.stringify({ theme: 'dark', mobile: { enabled: true } }))
  await put(
    'accounts.json',
    JSON.stringify({
      version: 1,
      accounts: [{ id: 'acct-1', nickname: 'Work', enc: 'U0VDUkVULUtFWS1DSVBIRVJURVhU' }],
      grants: [],
      admin: {}
    })
  )
  await put('limits-history.ndjson', '{"t":1}\n')
  await put('usage/records-2026-10.ndjson', '{"tokens":5}\n')
  // Never backed up:
  await put('mobile.json', '{"devices":[{"tokenHash":"abc"}]}')
  await put('backup.json', '{"remembered":{"enc":"x"}}')
  await put('cache/sessions-v6.json', '{}')
  await put('backups/settings/settings-2026.json', '{"env":{"ANTHROPIC_API_KEY":"sk-test"}}')
  await put('usage/records-2026-11.ndjson.123.ab12cd34.tmp', 'partial')
}

async function walk(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const go = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name)
      if (e.isDirectory()) await go(p)
      else
        out[relative(dir, p).split('\\').join('/')] = createHash('sha256')
          .update(await readFile(p))
          .digest('hex')
    }
  }
  await go(dir)
  return out
}

async function objectFiles(): Promise<string[]> {
  return Object.keys(await walk(join(setDir, 'objects'))).filter((k) => !k.endsWith('.tmp'))
}

async function backup(
  set: SetFile,
  keys: BackupKeys | null,
  cache: Record<string, CacheEntry> = {},
  extra: Partial<Parameters<typeof runBackup>[0]> = {}
) {
  return runBackup({
    setDir,
    set,
    keys,
    files: (await collectFiles(dataDir)).files,
    cache,
    reason: 'manual',
    now,
    ...extra
  })
}

describe('what a backup holds', () => {
  it('collects the archive, metadata, usage and settings, but no secrets or PC-only files', async () => {
    const rels = (await collectFiles(dataDir)).files.map((f) => f.rel)
    expect(rels).toEqual([
      'accounts.json',
      'archive/windows/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl',
      'archive/wsl-Ubuntu-beau/e9a1b2c3-d4e5-4f60-8172-839405a6b7c8.jsonl',
      'limits-history.ndjson',
      'metadata.json',
      'settings.json',
      'usage/records-2026-10.ndjson'
    ])
  })

  it('takes the API keys out of accounts.json', () => {
    const out = JSON.parse(
      stripAccountKeys(
        Buffer.from(JSON.stringify({ accounts: [{ id: 'a', nickname: 'n', enc: 'secret' }] }))
      ).toString()
    )
    expect(out.accounts).toEqual([{ id: 'a', nickname: 'n' }])
    expect(stripAccountKeys(Buffer.from('not json')).toString()).toBe('{}\n')
  })

  it('only restores plain relative paths of the allowed files', () => {
    expect(isRestorablePath('metadata.json')).toBe(true)
    expect(isRestorablePath('archive/windows/x.jsonl')).toBe(true)
    for (const bad of [
      '../.claude/settings.json',
      'archive/../../.claude/projects/p/x.jsonl',
      'archive/.claude/x.jsonl',
      '/etc/passwd',
      'C:/Users/beau/.claude/settings.json',
      'C:\\x',
      'archive\\windows\\x.jsonl',
      'mobile.json',
      'backup.json',
      'backups/settings/x.json',
      'usage/x.tmp',
      'archive/windows/x.jsonl:stream',
      ''
    ])
      expect(isRestorablePath(bad), bad).toBe(false)
    expect(() => targetPath(dataDir, '../.claude/settings.json')).toThrow()
  })
})

describe('incremental backups', () => {
  it('copies unchanged content once, and only the changed file the next time', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r1 = await backup(set, null)
    expect(r1.manifest.fileCount).toBe(7)
    expect(r1.added).toBe(7)
    const objects1 = await objectFiles()
    expect(objects1).toHaveLength(7)
    const before = await walk(join(setDir, 'objects'))

    clock += 60_000
    const r2 = await backup(set, null, r1.cache)
    expect(r2.added).toBe(0)
    expect(r2.addedBytes).toBe(0)
    // Not one object file was rewritten.
    expect(await walk(join(setDir, 'objects'))).toEqual(before)

    clock += 60_000
    await put(
      'metadata.json',
      JSON.stringify({ version: 1, sessions: { s1: { name: 'Renamed' } }, archive: {} })
    )
    const r3 = await backup(set, null, r2.cache)
    expect(r3.added).toBe(1)
    expect(await objectFiles()).toHaveLength(8)
    expect((await listSnapshots(setDir)).snapshots.map((s) => s.id)).toEqual([
      r3.manifest.id,
      r2.manifest.id,
      r1.manifest.id
    ])
    // Every snapshot lists every file.
    expect(manifestFiles(r3.manifest, null).map((f) => f.p)).toHaveLength(7)
  })

  it('reuses the cached hash without reading the file when size and time match', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r1 = await backup(set, null)
    const rel = 'limits-history.ndjson'
    // A cache entry that lies about the content: trusted only because size and time match.
    const fake = {
      ...r1.cache,
      [rel]: { ...r1.cache[rel], h: r1.cache['metadata.json'].h } as CacheEntry
    }
    const r2 = await backup(set, null, fake)
    expect(manifestFiles(r2.manifest, null).find((f) => f.p === rel)?.h).toBe(
      r1.cache['metadata.json'].h
    )
    // A changed time means it's read again.
    await utimes(join(dataDir, rel), new Date(clock + 5000), new Date(clock + 5000))
    const r3 = await backup(set, null, fake)
    expect(manifestFiles(r3.manifest, null).find((f) => f.p === rel)?.h).toBe(r1.cache[rel].h)
  })

  it('stores content compressed, named by its hash', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r = await backup(set, null)
    const f = manifestFiles(r.manifest, null).find((x) => x.p === 'metadata.json')
    expect(f?.o).toBe(f?.h)
    const raw = await readFile(join(setDir, 'objects', f!.o.slice(0, 2), f!.o))
    expect(raw.subarray(0, 4).toString()).toBe('CSDB')
    expect(gunzipSync(raw.subarray(6)).toString()).toContain('Checkout redesign')
  })
})

describe('interrupted backups', () => {
  it('a crash part way through leaves no snapshot, and the next backup completes', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const first = await backup(set, null)
    await put('archive/windows/new-session.jsonl', '{"type":"user"}\n')
    await put('metadata.json', '{"version":1,"sessions":{},"archive":{}}')
    clock += 60_000
    await expect(
      backup(set, null, first.cache, {
        afterFile: (i) => {
          if (i === 2) throw new Error('power cut')
        }
      })
    ).rejects.toThrow('power cut')
    // Only the complete snapshot counts; the lock was released.
    const list = await listSnapshots(setDir)
    expect(list.snapshots.map((s) => s.id)).toEqual([first.manifest.id])
    expect(list.damaged).toEqual([])
    await expect(stat(join(setDir, 'lock.json'))).rejects.toThrow()

    clock += 60_000
    const again = await backup(set, null, first.cache)
    expect((await listSnapshots(setDir)).snapshots).toHaveLength(2)
    expect(manifestFiles(again.manifest, null).map((f) => f.p)).toContain(
      'archive/windows/new-session.jsonl'
    )
  })

  it('ignores a half-written manifest (locking is covered in backup-lock.test.ts)', async () => {
    await createSet(setDir, new Date(clock).toISOString())
    await mkdir(join(setDir, 'snapshots'), { recursive: true })
    await writeFile(
      join(setDir, 'snapshots', '20261101T115900Z-0000abcd.json'),
      '{"format":"csd-backup-snap'
    )
    await writeFile(join(setDir, 'snapshots', '20261101T115900Z-0000abcd.json.12345678.tmp'), '{')
    const list = await listSnapshots(setDir)
    expect(list.snapshots).toEqual([])
    expect(list.damaged).toEqual(['20261101T115900Z-0000abcd.json'])
  })
})

describe('encryption', () => {
  it('round-trips with the right password and refuses a wrong one', async () => {
    const { entry, keys } = await newKeyEntry('correct horse battery', FAST)
    const set = await createSet(setDir, new Date(clock).toISOString(), entry)
    const r = await backup(set, keys)
    expect(r.manifest.keyId).toBe(entry.id)
    expect(r.manifest.files).toBeUndefined()
    // Nothing in the set is readable without the key: no names, no paths, no content.
    const all = await walk(setDir)
    for (const p of Object.keys(all)) {
      const text = (await readFile(join(setDir, p))).toString('latin1')
      expect(text).not.toContain('Checkout redesign')
      expect(text).not.toContain('7f3c9a12')
      expect(text).not.toContain('orders')
    }
    expect(await readSet(setDir)).toMatchObject({ current: entry.id })
    expect(JSON.stringify(await readSet(setDir))).not.toContain('correct horse')

    const unlocked = await unlockKey(entry, 'correct horse battery')
    const files = manifestFiles(r.manifest, unlocked.keys)
    const meta = files.find((f) => f.p === 'metadata.json')!
    expect(meta.o).toBe(objectId(meta.h, keys))
    const out = join(root, 'restored.json')
    await readObjectTo(setDir, meta, unlocked.keys, out)
    expect(await readFile(out, 'utf8')).toBe(await readFile(join(dataDir, 'metadata.json'), 'utf8'))

    await expect(unlockKey(entry, 'wrong password!')).rejects.toBeInstanceOf(WrongPasswordError)
    expect(() => manifestFiles(r.manifest, null)).toThrow(WrongPasswordError)
  })

  it('detects a changed object or manifest', async () => {
    const { entry, keys } = await newKeyEntry('correct horse battery', FAST)
    const set = await createSet(setDir, new Date(clock).toISOString(), entry)
    const r = await backup(set, keys)
    const f = manifestFiles(r.manifest, keys).find((x) => x.p === 'settings.json')!
    const p = join(setDir, 'objects', f.o.slice(0, 2), f.o)
    const buf = await readFile(p)
    buf[buf.length - 20] ^= 1
    await writeFile(p, buf)
    await expect(readObjectTo(setDir, f, keys, join(root, 'out'))).rejects.toThrow(
      /changed or damaged/
    )
    await expect(stat(join(root, 'out'))).rejects.toThrow()

    const sealed = Buffer.from(r.manifest.sealed!, 'base64')
    sealed[sealed.length - 1] ^= 1
    expect(() =>
      manifestFiles({ ...r.manifest, sealed: sealed.toString('base64') }, keys)
    ).toThrow()
    // A sealed list moved to another snapshot's manifest is refused.
    const other = sealBuffer(Buffer.from(JSON.stringify({ id: 'x', files: [] })), keys)
    expect(() => manifestFiles({ ...r.manifest, sealed: other.toString('base64') }, keys)).toThrow()
    expect(openBuffer(sealBuffer(Buffer.from('hi'), keys), keys).toString()).toBe('hi')
  })
})

describe('retention', () => {
  it('keeps the last N snapshots and removes only unused objects inside the set', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    // Files of mine next to and inside the backup set: never touched.
    await writeFile(join(dest, 'my-notes.txt'), 'mine')
    await writeFile(join(setDir, 'something-else.txt'), 'mine too')
    await mkdir(join(setDir, 'objects', 'zz'), { recursive: true })
    await writeFile(join(setDir, 'objects', 'zz', 'keep.bin'), 'x')
    const ids: string[] = []
    let cache: Record<string, CacheEntry> = {}
    for (let i = 0; i < 5; i++) {
      clock += 60_000
      await put('metadata.json', JSON.stringify({ version: 1, sessions: { n: i }, archive: {} }))
      const r = await backup(set, null, cache)
      cache = r.cache
      ids.unshift(r.manifest.id)
    }
    expect(await objectFiles()).toHaveLength(6 + 5 + 1)
    const res = await applyRetention(setDir, 3, { minObjectAgeMs: 0 })
    expect(res.removedSnapshots).toBe(2)
    expect(res.removedObjects).toBe(2)
    expect((await listSnapshots(setDir)).snapshots.map((s) => s.id)).toEqual(ids.slice(0, 3))
    // Every remaining snapshot can still be restored in full.
    for (const s of (await listSnapshots(setDir)).snapshots)
      for (const f of manifestFiles(s, null))
        await expect(stat(join(setDir, 'objects', f.o.slice(0, 2), f.o))).resolves.toBeTruthy()
    expect(await readFile(join(dest, 'my-notes.txt'), 'utf8')).toBe('mine')
    expect(await readFile(join(setDir, 'something-else.txt'), 'utf8')).toBe('mine too')
    expect(await readFile(join(setDir, 'objects', 'zz', 'keep.bin'), 'utf8')).toBe('x')
  })

  it('leaves unused objects alone while a snapshot can’t be read, or while they are new', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r1 = await backup(set, null)
    clock += 60_000
    await put('metadata.json', '{"version":1,"sessions":{"x":{}},"archive":{}}')
    await backup(set, null, r1.cache)
    await writeFile(join(setDir, 'snapshots', '20261101T000000Z-deadbeef.json'), 'syncing…')
    const res = await applyRetention(setDir, 1, { minObjectAgeMs: 0 })
    expect(res.removedSnapshots).toBe(1)
    expect(res.removedObjects).toBe(0)
    expect(res.skippedObjects).toMatch(/couldn't be read/)

    await rm(join(setDir, 'snapshots', '20261101T000000Z-deadbeef.json'))
    // Just written: kept for now (another PC may still be writing its snapshot).
    expect((await applyRetention(setDir, 1)).removedObjects).toBe(0)
    expect((await applyRetention(setDir, 1, { minObjectAgeMs: 0 })).removedObjects).toBe(1)
  })

  it('deletes nothing but its own files, by exact name, in the set', async () => {
    await createSet(setDir, new Date(clock).toISOString())
    await writeFile(join(dest, 'photo.jpg'), 'x')
    const outsideObj = join(dest, 'objects', 'ab', 'ab'.padEnd(64, '0'))
    await mkdir(join(outsideObj, '..'), { recursive: true })
    await writeFile(outsideObj, 'x')
    await expect(deleteInSet(join(dest, 'photo.jpg'), setDir, 'object')).rejects.toThrow(/Refusing/)
    await expect(deleteInSet(outsideObj, setDir, 'object')).rejects.toThrow(/Refusing/)
    await expect(deleteInSet(join(setDir, 'backup-set.json'), setDir, 'snapshot')).rejects.toThrow(
      /Refusing/
    )
    await expect(deleteInSet(join(setDir, 'README.txt'), setDir, 'tmp')).rejects.toThrow(/Refusing/)
    expect(await readFile(outsideObj, 'utf8')).toBe('x')
  })

  it('never deletes through a link out of the set', async () => {
    await createSet(setDir, new Date(clock).toISOString())
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    const victim = join(elsewhere, '20261101T000000Z-0000abcd.json')
    await writeFile(victim, '{}')
    try {
      await symlink(elsewhere, join(setDir, 'snapshots'), 'junction')
    } catch {
      return // links not allowed here
    }
    await expect(
      deleteInSet(join(setDir, 'snapshots', '20261101T000000Z-0000abcd.json'), setDir, 'snapshot')
    ).rejects.toThrow(/Refusing/)
    expect(await readFile(victim, 'utf8')).toBe('{}')
  })
})

describe('restore', () => {
  const claudeHome = (): string => join(root, 'Users', 'beau', '.claude')

  async function seedClaude(): Promise<void> {
    await mkdir(join(claudeHome(), 'projects', 'C--code'), { recursive: true })
    await writeFile(join(claudeHome(), 'settings.json'), '{"cleanupPeriodDays":30}')
    await writeFile(join(claudeHome(), 'projects', 'C--code', 's.jsonl'), '{"type":"user"}\n')
  }

  it('plans adds, replacements, merges and never shrinks the archive', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r = await backup(set, null)
    const files = manifestFiles(r.manifest, null)
    // Here since the backup: one archive copy grew, one is gone, settings changed.
    await put(
      'archive/windows/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl',
      '{"type":"user","message":"hello"}\n{"more":1}\n'
    )
    await rm(
      join(dataDir, 'archive', 'wsl-Ubuntu-beau', 'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8.jsonl')
    )
    await put('settings.json', '{"theme":"light"}')
    await put('usage/records-2026-10.ndjson', '{"tokens":1}\n')
    const { items } = await planRestore(dataDir, files)
    const by = Object.fromEntries(items.map((i) => [i.rel, i.action]))
    expect(by).toEqual({
      'accounts.json': 'same',
      'archive/windows/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl': 'keep',
      'archive/wsl-Ubuntu-beau/e9a1b2c3-d4e5-4f60-8172-839405a6b7c8.jsonl': 'add',
      'limits-history.ndjson': 'same',
      'metadata.json': 'same',
      'settings.json': 'merge',
      'usage/records-2026-10.ndjson': 'replace'
    })
  })

  it('restores only into the data folder, keeps a copy of what it replaces, and never touches .claude', async () => {
    await seedClaude()
    const claudeBefore = await walk(claudeHome())
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r = await backup(set, null)
    const files = manifestFiles(r.manifest, null)
    // Lose some data after the backup.
    await rm(join(dataDir, 'archive'), { recursive: true })
    await put(
      'metadata.json',
      JSON.stringify({ version: 1, sessions: { s2: { name: 'New here' } }, archive: {} })
    )
    await put('usage/records-2026-10.ndjson', 'damaged')
    const { items } = await planRestore(dataDir, files)
    const written = await stageRestore({
      dataDir,
      setDir,
      keys: null,
      files,
      items,
      snapshot: { id: r.manifest.id, createdAt: r.manifest.createdAt },
      now: clock
    })
    expect(written).toBe(4)
    expect(await hasPendingRestore(dataDir)).toBe(true)
    const setBefore = await walk(setDir)

    const rec = await applyPendingRestore(dataDir, {
      archiveDir: join(dataDir, 'archive'),
      now: clock
    })
    expect(rec?.written).toBe(4)
    expect(rec?.error).toBeUndefined()
    expect(await hasPendingRestore(dataDir)).toBe(false)
    expect(
      await readFile(
        join(dataDir, 'archive', 'windows', '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl'),
        'utf8'
      )
    ).toContain('hello')
    const meta = JSON.parse(await readFile(join(dataDir, 'metadata.json'), 'utf8'))
    expect(meta.sessions).toEqual({
      s2: { name: 'New here' },
      s1: { name: 'Checkout redesign', tags: ['web'] }
    })
    expect(await readFile(join(dataDir, 'usage', 'records-2026-10.ndjson'), 'utf8')).toBe(
      '{"tokens":5}\n'
    )
    // The replaced files were kept first.
    expect(await readFile(join(rec!.safetyDir, 'usage', 'records-2026-10.ndjson'), 'utf8')).toBe(
      'damaged'
    )
    expect(
      JSON.parse(await readFile(join(rec!.safetyDir, 'metadata.json'), 'utf8')).sessions.s2
    ).toBeTruthy()
    expect(relative(dataDir, rec!.safetyDir).startsWith('restore-backups')).toBe(true)
    // Nothing in .claude or the backup folder changed; files not in the backup stayed.
    expect(await walk(claudeHome())).toEqual(claudeBefore)
    expect(await walk(setDir)).toEqual(setBefore)
    expect(await readFile(join(dataDir, 'mobile.json'), 'utf8')).toContain('tokenHash')
  })

  it('refuses a crafted snapshot that points outside the data folder (.claude included)', async () => {
    await seedClaude()
    const claudeBefore = await walk(claudeHome())
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r = await backup(set, null)
    const good = manifestFiles(r.manifest, null)[0]!
    const evil = [
      { ...good, p: '../../../Users/beau/.claude/settings.json' },
      { ...good, p: join(claudeHome(), 'settings.json') },
      { ...good, p: 'archive/../../../../Users/beau/.claude/projects/C--code/s.jsonl' }
    ]
    const { items, skipped } = await planRestore(dataDir, evil)
    expect(items).toEqual([])
    expect(skipped).toHaveLength(3)
    // Even a plan written by hand can't reach it.
    await mkdir(join(dataDir, 'restore-pending', 'files'), { recursive: true })
    await writeFile(
      join(dataDir, 'restore-pending', 'plan.json'),
      JSON.stringify({
        snapshotId: 'x',
        snapshotCreatedAt: 'x',
        items: evil.map((e) => ({ rel: e.p, action: 'replace', sha256: e.h, size: 1 }))
      })
    )
    const rec = await applyPendingRestore(dataDir, {
      archiveDir: join(dataDir, 'archive'),
      now: clock
    })
    expect(rec?.written).toBe(0)
    expect(rec?.error).toMatch(/3 files/)
    expect(await walk(claudeHome())).toEqual(claudeBefore)
  })

  it('a half-staged restore (no plan) is discarded, not applied', async () => {
    await mkdir(join(dataDir, 'restore-pending', 'files'), { recursive: true })
    await writeFile(join(dataDir, 'restore-pending', 'files', 'metadata.json'), '{}')
    const before = await readFile(join(dataDir, 'metadata.json'), 'utf8')
    expect(
      await applyPendingRestore(dataDir, { archiveDir: join(dataDir, 'archive'), now: clock })
    ).toBeUndefined()
    expect(await readFile(join(dataDir, 'metadata.json'), 'utf8')).toBe(before)
    await expect(stat(join(dataDir, 'restore-pending'))).rejects.toThrow()
  })

  it('merges: keeps this PC’s keys, window and phone settings; rebases archive paths', () => {
    const settings = JSON.parse(
      mergeOnRestore(
        'settings.json',
        '{"theme":"dark","mobile":{"enabled":true},"window":{"width":1}}',
        '{"theme":"light","window":{"width":2}}',
        {
          archiveDir: 'C:\\Users\\new\\AppData\\Roaming\\ClaudeSessionDashboard\\archive'
        }
      )
    )
    expect(settings).toEqual({ theme: 'dark', window: { width: 2 } })

    const accounts = JSON.parse(
      mergeOnRestore(
        'accounts.json',
        JSON.stringify({
          accounts: [{ id: 'a', nickname: 'Old name' }],
          grants: [{ id: 'g1' }],
          admin: {}
        }),
        JSON.stringify({
          accounts: [
            { id: 'a', nickname: 'x', enc: 'KEY-A' },
            { id: 'b', enc: 'KEY-B' }
          ],
          grants: [{ id: 'g2' }]
        }),
        { archiveDir: '/x' }
      )
    )
    expect(accounts.accounts).toEqual([
      { id: 'a', nickname: 'Old name', enc: 'KEY-A' },
      { id: 'b', enc: 'KEY-B' }
    ])
    expect(accounts.grants).toEqual([{ id: 'g1' }, { id: 'g2' }])

    const archiveDir = join(dataDir, 'archive')
    expect(
      rebaseArchivePath(
        'C:\\Users\\old\\AppData\\Roaming\\ClaudeSessionDashboard\\archive\\windows\\s.jsonl',
        archiveDir
      )
    ).toBe(join(archiveDir, 'windows', 's.jsonl'))
    expect(
      rebaseArchivePath(
        'C:\\Users\\old\\AppData\\Roaming\\ClaudeSessionDashboard\\archive\\..\\..\\x',
        archiveDir
      )
    ).toBe('C:\\Users\\old\\AppData\\Roaming\\ClaudeSessionDashboard\\archive\\..\\..\\x')
    const meta = JSON.parse(
      mergeOnRestore(
        'metadata.json',
        JSON.stringify({
          version: 1,
          sessions: {},
          archive: { k: { size: 10, archivePath: '/old/archive/windows/s.jsonl' } }
        }),
        JSON.stringify({
          version: 1,
          sessions: {},
          archive: { k: { size: 20, archivePath: join(archiveDir, 'windows', 's.jsonl') } }
        }),
        { archiveDir }
      )
    )
    expect(meta.archive.k.size).toBe(20)
  })
})

describe('BackupService', () => {
  const encryptor = {
    available: () => true,
    encrypt: async (t: string) => Buffer.from(`dpapi:${t}`),
    decrypt: async (b: Buffer) => b.toString().slice('dpapi:'.length)
  }

  async function service() {
    const store = createBackupStore(dataDir)
    await store.load()
    const svc = new BackupService({
      store,
      dataDir,
      appVersion: '1.5.0',
      encryptor,
      now,
      kdf: FAST,
      minObjectAgeMs: 0
    })
    await svc.init()
    return { svc, store }
  }

  it('refuses folders inside .claude or the app’s own data folder', async () => {
    const { svc } = await service()
    await mkdir(join(root, '.claude', 'x'), { recursive: true })
    expect((await svc.candidate(join(root, '.claude', 'x'))).error).toMatch(/\.claude/)
    expect((await svc.candidate(join(dataDir, 'archive'))).error).toMatch(/data folder/)
    expect((await svc.candidate(join(root, 'nope'))).error).toMatch(/can't be found/)
    expect(await svc.candidate(dest)).toEqual({ folder: dest, setDir })
  })

  it('backs up on schedule, remembers the password only when asked, and restores', async () => {
    let { svc, store } = await service()
    const st = await svc.connect(dest, { encrypt: true, password: 'short' })
    expect(isBackupError(st) && st.error).toMatch(/at least 8/)
    const ok = await svc.connect(dest, {
      encrypt: true,
      password: 'correct horse battery',
      remember: false
    })
    expect(isBackupError(ok)).toBe(false)
    expect(await svc.due()).toBe(true)
    const run = await svc.runNow('scheduled')
    expect(run).toMatchObject({ ok: true, files: 7, added: 7, encrypted: true })
    expect(await svc.due()).toBe(false)
    clock += 24 * 60 * 60_000
    expect(await svc.due()).toBe(true)
    // The password itself is never written anywhere.
    expect(JSON.stringify(store.value)).not.toContain('correct horse')
    await store.flush()

    // After a restart the password isn't known (not remembered): no scheduled backup.
    ;({ svc, store } = await service())
    expect((await svc.status()).locked).toBe(true)
    expect(await svc.due()).toBe(false)
    expect(await svc.unlock('wrong password', true)).toMatchObject({ needsPassword: true })
    expect(await svc.unlock('correct horse battery', true)).toMatchObject({
      locked: false,
      remembered: true
    })
    await store.flush()
    expect(await readFile(join(dataDir, 'backup.json'), 'utf8')).not.toContain('correct horse')

    // Remembered: unlocked after a restart.
    ;({ svc } = await service())
    expect((await svc.status()).locked).toBe(false)

    // Restore after losing names.
    await put('metadata.json', '{"version":1,"sessions":{},"archive":{}}')
    const snaps = await svc.snapshots()
    expect(Array.isArray(snaps) && snaps).toHaveLength(1)
    const preview = (await svc.preview((snaps as { id: string }[])[0]!.id)) as RestorePreview
    expect(preview.changes).toBe(1)
    expect(preview.groups.find((g) => g.key === 'meta')).toMatchObject({ merge: 1 })
    expect(await svc.restore(preview.token)).toEqual({ ok: true, written: 1 })
    // A backup waits until the app has restarted.
    expect((await svc.runNow('manual')).ok).toBe(false)
    const rec = await applyPendingRestore(dataDir, {
      archiveDir: join(dataDir, 'archive'),
      now: clock
    })
    expect(
      JSON.parse(await readFile(join(dataDir, 'metadata.json'), 'utf8')).sessions.s1.name
    ).toBe('Checkout redesign')
    svc.recordRestore(rec!)
    expect((await svc.status()).lastRestore?.written).toBe(1)
  })

  it('a changed password needs the older one for older snapshots; retention keeps N', async () => {
    const { svc, store } = await service()
    await svc.connect(dest, {})
    await svc.update({ keep: 2 })
    expect(store.value.keep).toBe(2)
    for (let i = 0; i < 3; i++) {
      clock += 60_000
      await put('metadata.json', JSON.stringify({ version: 1, sessions: { i }, archive: {} }))
      expect((await svc.runNow('manual')).ok).toBe(true)
    }
    expect((await svc.snapshots()) as unknown[]).toHaveLength(2)
    await svc.setPassword('first password', false)
    clock += 60_000
    expect((await svc.runNow('manual')).encrypted).toBe(true)
    await svc.setPassword('second password', false)
    clock += 60_000
    await svc.runNow('manual')
    const snaps = (await svc.snapshots()) as {
      id: string
      olderPassword: boolean
      encrypted: boolean
    }[]
    expect(snaps.map((s) => [s.encrypted, s.olderPassword])).toEqual([
      [true, false],
      [true, true]
    ])
    // A fresh start knows neither password.
    const fresh = new BackupService({ store, dataDir, appVersion: '1', encryptor, now, kdf: FAST })
    expect(await fresh.preview(snaps[1]!.id)).toMatchObject({ needsPassword: true })
    expect(await fresh.preview(snaps[1]!.id, 'second password')).toMatchObject({
      needsPassword: true
    })
    expect(await fresh.preview(snaps[1]!.id, 'first password')).toMatchObject({
      snapshotId: snaps[1]!.id
    })
  })

  it('reports a missing drive instead of failing silently, and stops using a folder without deleting it', async () => {
    const { svc } = await service()
    await svc.connect(dest, {})
    await rm(dest, { recursive: true, force: true })
    const st = await svc.status()
    expect(st.available).toBe(false)
    expect(st.unavailableReason).toMatch(/drive/)
    const run = await svc.runNow('manual')
    expect(run.ok).toBe(false)
    // Tried again after an hour, not every 15 minutes.
    expect(await svc.due()).toBe(false)
    await mkdir(dest, { recursive: true })
    await svc.connect(dest, {})
    await svc.runNow('manual')
    const before = await walk(dest)
    expect((await svc.disconnect()).setDir).toBeUndefined()
    expect(await walk(dest)).toEqual(before)
  })
})

describe('JsonStore stays the only writer of backup.json', () => {
  it('is in the data folder and not part of a backup', async () => {
    const s = new JsonStore(join(dataDir, 'backup.json'), dataDir, () => ({}))
    await s.load()
    expect((await collectFiles(dataDir)).files.some((f) => f.rel === 'backup.json')).toBe(false)
  })
})
