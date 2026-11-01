// Regression tests for the PR #20 review: damaged encryption details, read
// errors, retention under the lock, restoring files that were missing,
// restored API accounts, a drive that comes back, and switching folders.

import type { Dirent, Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DamagedBackupError, newKeyEntry } from '../src/main/core/backup-crypto'
import { collectFiles, type CollectIo } from '../src/main/core/backup-files'
import { applyPendingRestore, planRestore, stageRestore } from '../src/main/core/backup-restore'
import {
  applyRetention,
  BackupBusyError,
  createSet,
  listSnapshots,
  manifestFiles,
  readSet,
  runBackup,
  SET_FILE
} from '../src/main/core/backup-store'
import { AccountsService, createAccountsStore, keyFingerprint } from '../src/main/services/accounts'
import { BackupService, createBackupStore } from '../src/main/services/backup'
import { BACKUP_SET_DIR, isBackupError } from '../src/shared/backup'
import { maskKey } from '../src/shared/usage/credits'

const FAST = { N: 2 ** 10, r: 8, p: 1 }
const encryptor = {
  available: () => true,
  encrypt: async (t: string) => Buffer.from(`dpapi:${t}`),
  decrypt: async (b: Buffer) => b.toString().slice('dpapi:'.length)
}

let root: string
let dataDir: string
let dest: string
let setDir: string
let clock: number
const now = (): number => clock

async function put(rel: string, content: string): Promise<void> {
  const p = join(dataDir, ...rel.split('/'))
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, content)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-backup-safety-'))
  dataDir = join(root, 'AppData', 'Roaming', 'ClaudeSessionDashboard')
  dest = join(root, 'OneDrive')
  setDir = join(dest, BACKUP_SET_DIR)
  clock = Date.parse('2026-11-01T12:00:00Z')
  await mkdir(dest, { recursive: true })
  await put(
    'archive/windows/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl',
    '{"type":"user","message":"secret plan"}\n'
  )
  await put(
    'metadata.json',
    JSON.stringify({ version: 1, sessions: { s1: { name: 'Checkout' } }, archive: {} })
  )
  await put('settings.json', '{"theme":"dark"}')
  await put('usage/records-2026-10.ndjson', '{"tokens":5}\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function service(opts: { dataDir?: string } = {}) {
  const dir = opts.dataDir ?? dataDir
  const store = createBackupStore(dir)
  await store.load()
  const svc = new BackupService({
    store,
    dataDir: dir,
    appVersion: '1.5.0',
    encryptor,
    now,
    kdf: FAST,
    minObjectAgeMs: 0
  })
  await svc.init()
  return { svc, store }
}

async function allText(dir: string): Promise<string> {
  let out = ''
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) out += (await readFile(join(e.parentPath, e.name))).toString('latin1')
  return out
}

describe('1. damaged encryption details never mean "not encrypted"', () => {
  it('refuses a set whose current password can’t be found or whose keys are damaged', async () => {
    const { entry } = await newKeyEntry('correct horse battery', FAST)
    const set = await createSet(setDir, new Date(clock).toISOString(), entry)
    const file = join(setDir, SET_FILE)
    const good = JSON.parse(await readFile(file, 'utf8'))

    await writeFile(file, JSON.stringify({ ...good, keys: [] }))
    await expect(readSet(setDir)).rejects.toBeInstanceOf(DamagedBackupError)
    await writeFile(file, JSON.stringify({ ...good, keys: [{ ...entry, check: 'nope' }] }))
    await expect(readSet(setDir)).rejects.toBeInstanceOf(DamagedBackupError)
    await writeFile(file, JSON.stringify({ ...good, current: 'ffffffffffffffff' }))
    await expect(readSet(setDir)).rejects.toBeInstanceOf(DamagedBackupError)
    const { current: _c, ...noCurrent } = good
    await writeFile(file, JSON.stringify(noCurrent))
    await expect(readSet(setDir)).rejects.toBeInstanceOf(DamagedBackupError)
    await writeFile(file, JSON.stringify(good))
    expect((await readSet(setDir))?.current).toBe(set.current)
  })

  it('a set that turns unencrypted behind the app pauses backups until I choose', async () => {
    const { svc } = await service()
    await svc.connect(dest, { encrypt: true, password: 'correct horse battery', remember: true })
    expect((await svc.runNow('manual')).ok).toBe(true)
    const before = await listSnapshots(setDir)

    // An old copy from a sync conflict: same set, no password.
    const file = join(setDir, SET_FILE)
    const v = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...v, current: null }))
    clock += 2 * 24 * 60 * 60_000
    const st = await svc.status()
    expect(st.paused?.reason).toBe('unencrypted')
    expect(await svc.due()).toBe(false)
    const run = await svc.runNow('manual')
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/paused/)
    expect((await listSnapshots(setDir)).snapshots).toHaveLength(before.snapshots.length)
    expect(await allText(setDir)).not.toContain('secret plan')

    // My explicit choice resumes (here: without a password).
    expect(isBackupError(await svc.setPassword(null, false))).toBe(false)
    expect((await svc.status()).paused).toBeUndefined()
    expect((await svc.runNow('manual')).ok).toBe(true)
  })
})

describe('2. read errors fail the backup instead of leaving data out', () => {
  const failing = (match: string, code: string): CollectIo => ({
    readdir: async (p) => {
      if (p.endsWith(match)) throw Object.assign(new Error('denied'), { code })
      return (await readdir(p, { withFileTypes: true })) as Dirent[]
    },
    lstat: async (p) => {
      if (p.endsWith(match)) throw Object.assign(new Error('denied'), { code })
      return (await lstat(p)) as Stats
    }
  })

  it('throws on a folder or file that exists but can’t be read', async () => {
    await expect(collectFiles(dataDir, failing('usage', 'EACCES'))).rejects.toThrow(/usage.*EACCES/)
    await expect(collectFiles(dataDir, failing('metadata.json', 'EPERM'))).rejects.toThrow(/EPERM/)
    await expect(collectFiles(dataDir, failing('6d.jsonl', 'EIO'))).rejects.toThrow(/EIO/)
    // Only "it's gone" is fine: optional files, or a file that vanished mid-listing.
    const ok = await collectFiles(dataDir, failing('6d.jsonl', 'ENOENT'))
    expect(ok.files.map((f) => f.rel)).not.toContain(
      'archive/windows/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl'
    )
  })

  it('reports files it can’t hold instead of dropping them silently', async () => {
    await put('archive/windows/.hidden', 'x')
    await put('archive/windows/_x.jsonl', 'starts with an underscore (safeSegment can make these)')
    const c = await collectFiles(dataDir)
    expect(c.skipped).toEqual(['archive/windows/.hidden'])
    expect(c.files.map((f) => f.rel)).toContain('archive/windows/_x.jsonl')
    const { svc } = await service()
    await svc.connect(dest, {})
    const run = await svc.runNow('manual')
    expect(run.ok).toBe(true)
    expect(run.error).toMatch(/1 file .*left out \(archive\/windows\/\.hidden\)/)
  })

  it('a failed read means a failed run and no new snapshot', async () => {
    const { svc } = await service()
    await svc.connect(dest, {})
    await rm(join(dataDir, 'usage'), { recursive: true })
    // "usage" is now a file: it exists but can't be read as the folder it should be.
    await writeFile(join(dataDir, 'usage'), 'x')
    const run = await svc.runNow('manual')
    expect(run.ok).toBe(false)
    expect((await listSnapshots(setDir)).snapshots).toHaveLength(0)
  })
})

describe('3. retention and backups share one lock', () => {
  it('retention can’t run while a backup is reusing objects', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const files = (await collectFiles(dataDir)).files
    let refused: unknown
    await runBackup({
      setDir,
      set,
      keys: null,
      files,
      cache: {},
      reason: 'manual',
      owner: 'me',
      now,
      afterFile: async (i) => {
        if (i === 0)
          refused = await applyRetention(setDir, 1, { minObjectAgeMs: 0, owner: 'me' }).catch(
            (e: unknown) => e
          )
      }
    })
    // Even the same install is refused while this process holds the lock.
    expect(refused).toBeInstanceOf(BackupBusyError)
  })

  it('an object an old snapshot dropped, reused by the new one, survives the run’s own retention', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const run = async () => {
      clock += 60_000
      return runBackup({
        setDir,
        set,
        keys: null,
        files: (await collectFiles(dataDir)).files,
        cache: {},
        reason: 'manual',
        now,
        retention: { keep: 1, minObjectAgeMs: 0 }
      })
    }
    await run()
    await put('metadata.json', '{"version":1,"sessions":{"other":{}},"archive":{}}')
    await run()
    await put(
      'metadata.json',
      JSON.stringify({ version: 1, sessions: { s1: { name: 'Checkout' } }, archive: {} })
    )
    const last = await run()
    expect(last.retention?.removedSnapshots).toBe(1)
    for (const f of manifestFiles(last.manifest, null))
      await expect(lstat(join(setDir, 'objects', f.o.slice(0, 2), f.o))).resolves.toBeTruthy()
  })

  it('an object removed during the run (another PC) is written again before the snapshot counts', async () => {
    const set = await createSet(setDir, new Date(clock).toISOString())
    const first = await runBackup({
      setDir,
      set,
      keys: null,
      files: (await collectFiles(dataDir)).files,
      cache: {},
      reason: 'manual',
      now
    })
    const victim = manifestFiles(first.manifest, null)[0]!
    clock += 60_000
    const files = (await collectFiles(dataDir)).files
    const second = await runBackup({
      setDir,
      set,
      keys: null,
      files,
      cache: first.cache,
      reason: 'manual',
      now,
      afterFile: async (i) => {
        if (i === files.length - 1)
          await rm(join(setDir, 'objects', victim.o.slice(0, 2), victim.o))
      }
    })
    for (const f of manifestFiles(second.manifest, null))
      await expect(lstat(join(setDir, 'objects', f.o.slice(0, 2), f.o))).resolves.toBeTruthy()
  })
})

describe('4. files missing at preview still get the restore rules', () => {
  it('a new PC: no phone server from the old PC, archive paths moved here', async () => {
    await put(
      'settings.json',
      JSON.stringify({
        theme: 'dark',
        mobile: { enabled: true, autoStart: true },
        window: { width: 9 }
      })
    )
    await put(
      'metadata.json',
      JSON.stringify({
        version: 1,
        sessions: {},
        archive: {
          'windows:7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d': {
            size: 41,
            archivePath:
              'C:\\Users\\olduser\\AppData\\Roaming\\ClaudeSessionDashboard\\archive\\windows\\7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl'
          }
        }
      })
    )
    const set = await createSet(setDir, new Date(clock).toISOString())
    const r = await runBackup({
      setDir,
      set,
      keys: null,
      files: (await collectFiles(dataDir)).files,
      cache: {},
      reason: 'manual',
      now
    })
    const files = manifestFiles(r.manifest, null)

    const fresh = join(root, 'NewPC', 'ClaudeSessionDashboard')
    await mkdir(fresh, { recursive: true })
    const { items } = await planRestore(fresh, files)
    expect(items.find((i) => i.rel === 'settings.json')?.action).toBe('add')
    await stageRestore({
      dataDir: fresh,
      setDir,
      keys: null,
      files,
      items,
      snapshot: { id: r.manifest.id, createdAt: r.manifest.createdAt },
      now: clock
    })
    const rec = await applyPendingRestore(fresh, { archiveDir: join(fresh, 'archive'), now: clock })
    expect(rec?.error).toBeUndefined()
    const settings = JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8'))
    expect(settings).toEqual({ theme: 'dark' })
    const meta = JSON.parse(await readFile(join(fresh, 'metadata.json'), 'utf8'))
    expect(meta.archive['windows:7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'].archivePath).toBe(
      join(fresh, 'archive', 'windows', '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl')
    )
  })
})

describe('5. a restored API account gets its key back without losing its history', () => {
  const KEY = 'sk-ant-api03-SampleKeyForTests_0123456789abcdef'

  it('adding the same key again reconnects it to the restored account', async () => {
    const store = createAccountsStore(dataDir)
    await store.load()
    store.update((d) => {
      d.accounts.push({
        id: 'acct-restored',
        nickname: 'Work',
        kind: 'standard',
        masked: maskKey(KEY),
        createdAt: '2026-10-01T00:00:00Z',
        // Backups keep the key's fingerprint (never the key).
        fp: keyFingerprint(KEY)
      } as never)
      d.grants.push({
        id: 'g1',
        accountId: 'acct-restored',
        amountUsd: 50,
        receivedAt: '2026-10-01T00:00:00'
      })
    })
    const svc = new AccountsService(store, encryptor, {
      fetcher: async () => {
        throw new Error('no network')
      },
      userAgent: 't',
      refreshMinutes: () => 0
    })
    expect(svc.list()[0]?.needsKey).toBe(true)
    expect(await svc.keyFor('acct-restored')).toBeUndefined()

    const res = await svc.add('Work laptop', KEY)
    expect(res.error).toBeUndefined()
    expect(res.account?.id).toBe('acct-restored')
    expect(svc.list()).toHaveLength(1)
    expect(svc.list()[0]?.needsKey).toBeUndefined()
    expect(await svc.keyFor('acct-restored')).toBe(KEY)
    expect(svc.grants()[0]?.accountId).toBe('acct-restored')
    // Now it's there: a second add is still refused.
    expect((await svc.add('again', KEY)).error).toMatch(/already added/)
  })
})

describe('6. a remembered password works once the drive comes back', () => {
  it('unlocks on the next check without asking', async () => {
    const first = await service()
    let svc = first.svc
    const store = first.store
    await svc.connect(dest, { encrypt: true, password: 'correct horse battery', remember: true })
    expect((await svc.runNow('manual')).ok).toBe(true)
    await store.flush()

    // App starts while the drive is unplugged.
    await rename(dest, `${dest}-unplugged`)
    svc = (await service()).svc
    expect((await svc.status()).available).toBe(false)
    clock += 2 * 24 * 60 * 60_000
    expect(await svc.due()).toBe(false)

    await rename(`${dest}-unplugged`, dest)
    expect(await svc.due()).toBe(true)
    expect((await svc.status()).locked).toBe(false)
    expect((await svc.runNow('scheduled')).ok).toBe(true)
  })
})

describe('7. a newly chosen folder gets its first backup soon', () => {
  it('doesn’t inherit the old folder’s last backup time', async () => {
    const { svc } = await service()
    await svc.connect(dest, {})
    expect((await svc.runNow('manual')).ok).toBe(true)
    expect(await svc.due()).toBe(false)

    const other = join(root, 'ExternalDrive')
    await mkdir(other, { recursive: true })
    await svc.connect(other, {})
    const st = await svc.status()
    expect(st.last).toBeUndefined()
    expect(st.lastSuccessAt).toBeUndefined()
    expect(await svc.due()).toBe(true)

    // Re-connecting the same folder keeps its history.
    expect((await svc.runNow('manual')).ok).toBe(true)
    await svc.connect(other, {})
    expect(await svc.due()).toBe(false)
  })
})

// ---------------------------------------------------------------- re-review

describe('the folder’s set can’t change behind the app', () => {
  it('a different set put in the folder pauses backups until I explicitly use it', async () => {
    const { svc } = await service()
    await svc.connect(dest, { encrypt: true, password: 'correct horse battery', remember: true })
    expect((await svc.runNow('manual')).ok).toBe(true)
    // Swapped for a different, unencrypted set (same folder).
    await rm(setDir, { recursive: true, force: true })
    await createSet(setDir, new Date(clock).toISOString())
    const st = await svc.status()
    expect(st.paused?.reason).toBe('replaced')
    expect(await svc.due()).toBe(false)
    const run = await svc.runNow('manual')
    expect(run.ok).toBe(false)
    expect(run.error).toMatch(/replaced/)
    // Reselecting the folder doesn't quietly accept it...
    expect(await svc.connect(dest, {})).toMatchObject({ changed: 'replaced' })
    expect((await svc.status()).paused?.reason).toBe('replaced')
    // ...an explicit choice does.
    expect(isBackupError(await svc.connect(dest, { accept: true }))).toBe(false)
    expect((await svc.runNow('manual')).ok).toBe(true)
  })

  it('a downgraded set stays paused across stop-using and reselecting', async () => {
    const { svc } = await service()
    await svc.connect(dest, { encrypt: true, password: 'correct horse battery', remember: true })
    expect((await svc.runNow('manual')).ok).toBe(true)
    const file = join(setDir, SET_FILE)
    await writeFile(
      file,
      JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), current: null })
    )
    await svc.disconnect()
    const again = await svc.connect(dest, {})
    expect(again).toMatchObject({ changed: 'unencrypted' })
    expect((await listSnapshots(setDir)).snapshots).toHaveLength(1)
    expect(await allText(setDir)).not.toContain('secret plan')
  })

  it('backup files without a readable set file are never started over', async () => {
    const { svc } = await service()
    await svc.connect(dest, { encrypt: true, password: 'correct horse battery', remember: true })
    expect((await svc.runNow('manual')).ok).toBe(true)
    await rm(join(setDir, SET_FILE))
    const st = await svc.status()
    expect(st.available).toBe(false)
    expect(st.unavailableReason).toMatch(/backup-set\.json is missing/)
    expect((await svc.runNow('manual')).ok).toBe(false)
    expect((await svc.candidate(dest)).error).toMatch(/won’t start a new backup set/)
    // Not even when I ask for no encryption: no plaintext set over them.
    expect(await svc.connect(dest, { encrypt: false })).toMatchObject({
      error: expect.stringMatching(/won’t start/)
    })
    await expect(readFile(join(setDir, SET_FILE))).rejects.toThrow()
    await expect(createSet(setDir, new Date(clock).toISOString())).rejects.toThrow(/won’t start/)
  })

  it('a backup folder that is a junction is refused', async () => {
    const { svc } = await service()
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    try {
      await symlink(elsewhere, setDir, 'junction')
    } catch {
      return
    }
    expect((await svc.candidate(dest)).error).toMatch(/link or junction/)
    expect(await svc.connect(dest, {})).toMatchObject({
      error: expect.stringMatching(/link or junction/)
    })
    expect(await readdir(elsewhere)).toEqual([])
  })
})

describe('one PC writes to a set', () => {
  it('another install restores but doesn’t back up until it takes over', async () => {
    const a = await service()
    await a.svc.connect(dest, {})
    expect((await a.svc.runNow('manual')).ok).toBe(true)

    const otherData = join(root, 'OtherPC', 'ClaudeSessionDashboard')
    await mkdir(otherData, { recursive: true })
    await writeFile(join(otherData, 'metadata.json'), '{"version":1,"sessions":{},"archive":{}}')
    const b = await service({ dataDir: otherData })
    await b.svc.connect(dest, {})
    expect((await b.svc.status()).paused?.reason).toBe('other-writer')
    expect(await b.svc.due()).toBe(false)
    expect((await b.svc.runNow('manual')).ok).toBe(false)
    // Restoring from it still works.
    const snaps = (await b.svc.snapshots()) as { id: string }[]
    expect(await b.svc.preview(snaps[0]!.id)).toMatchObject({ snapshotId: snaps[0]!.id })

    expect(isBackupError(await b.svc.takeOver())).toBe(false)
    expect((await b.svc.runNow('manual')).ok).toBe(true)
    // The first PC stops at its next backup.
    expect((await a.svc.status()).paused?.reason).toBe('other-writer')
    expect((await a.svc.runNow('manual')).ok).toBe(false)
  })
})

describe('restore previews', () => {
  it('an unknown or invalid preview token gets a clear message', async () => {
    const { svc } = await service()
    await svc.connect(dest, {})
    expect(await svc.restore('f'.repeat(32))).toEqual({
      error: "That restore preview isn't valid. Start a new preview"
    })
  })
})

describe('restored API accounts: exact keys only, histories kept together', () => {
  const K1 = 'sk-ant-api03-FirstKeyAAAAAAAAAAAAAAAA_same'
  // Same prefix and last 4 characters: the same mask as K1.
  const K2 = 'sk-ant-api03-SecondKeyBBBBBBBBBBBBBBBB_same'

  async function accounts(seed: (d: ReturnType<typeof createAccountsStore>['value']) => void) {
    const store = createAccountsStore(dataDir)
    await store.load()
    store.update(seed)
    const merges: [string, string][] = []
    const svc = new AccountsService(store, encryptor, {
      fetcher: async () => {
        throw new Error('no network')
      },
      userAgent: 't',
      refreshMinutes: () => 0,
      onMerge: (from, to) => {
        merges.push([from, to])
      }
    })
    await svc.init()
    return { svc, store, merges }
  }

  const acct = (o: Record<string, unknown>) =>
    ({ kind: 'standard', masked: maskKey(K1), createdAt: '2026-10-01T00:00:00Z', ...o }) as never

  it('a key already added before the restore is merged into the restored account', async () => {
    expect(maskKey(K1)).toBe(maskKey(K2))
    const enc = (await encryptor.encrypt(K1)).toString('base64')
    const { svc, merges } = await accounts((d) => {
      // Added on this PC before restoring (its own id), then the restored one.
      d.accounts.push(acct({ id: 'acct-here', nickname: 'New', enc }))
      d.accounts.push(acct({ id: 'acct-old', nickname: 'Work', fp: keyFingerprint(K1) }))
      d.grants.push({
        id: 'g-old',
        accountId: 'acct-old',
        amountUsd: 50,
        receivedAt: '2026-10-01T00:00:00'
      })
      d.grants.push({
        id: 'g-here',
        accountId: 'acct-here',
        amountUsd: 5,
        receivedAt: '2026-11-01T00:00:00'
      })
    })
    // Adding it again is refused, and points to Reconnect.
    expect((await svc.add('x', K1)).error).toMatch(/Reconnect key/)
    const r = await svc.reconnect('acct-old', K1)
    expect(r.error).toBeUndefined()
    expect(svc.list().map((a) => a.id)).toEqual(['acct-old'])
    expect(await svc.keyFor('acct-old')).toBe(K1)
    expect(svc.grants().map((g) => g.accountId)).toEqual(['acct-old', 'acct-old'])
    expect(merges).toEqual([['acct-here', 'acct-old']])
  })

  it('a different key with the same mask is never attached to restored history', async () => {
    const { svc } = await accounts((d) => {
      d.accounts.push(acct({ id: 'acct-old', nickname: 'Work', fp: keyFingerprint(K1) }))
    })
    expect((await svc.reconnect('acct-old', K2)).error).toMatch(/isn’t the key this account used/)
    const added = await svc.add('Other', K2)
    expect(added.account?.id).not.toBe('acct-old')
    expect(svc.list().find((a) => a.id === 'acct-old')?.needsKey).toBe(true)
    // The right key reconnects it.
    expect((await svc.reconnect('acct-old', K1)).account?.id).toBe('acct-old')
  })

  it('an account restored without a fingerprint is only reconnected by choosing it', async () => {
    const { svc } = await accounts((d) => {
      d.accounts.push(acct({ id: 'acct-legacy', nickname: 'Old' }))
    })
    // Adding a key with that mask doesn't attach it (it could be K2).
    const added = await svc.add('New', K2)
    expect(added.account?.id).not.toBe('acct-legacy')
    expect(svc.list().find((a) => a.id === 'acct-legacy')?.needsKey).toBe(true)
    // Choosing the account and giving a matching key does.
    expect((await svc.reconnect('acct-legacy', K1)).account?.id).toBe('acct-legacy')
  })

  it('keys saved before fingerprints get one at startup (never the key itself)', async () => {
    const enc = (await encryptor.encrypt(K1)).toString('base64')
    const { store } = await accounts((d) => {
      d.accounts.push(acct({ id: 'acct-1', nickname: 'Mine', enc }))
    })
    expect((store.value.accounts[0] as { fp?: string }).fp).toBe(keyFingerprint(K1))
    expect(JSON.stringify(store.value)).not.toContain(K1)
  })
})
