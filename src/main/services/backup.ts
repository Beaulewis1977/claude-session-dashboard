// Settings → Backup: scheduled, incremental, optionally encrypted backups of
// the app's own data to a folder the user picks, and restores from them.
//
// The engine is in core/backup-*.ts. This service keeps the settings and the
// last result (backup.json, never part of a backup itself), the unlocked keys
// (in memory only, or remembered with safeStorage when asked), the schedule
// (it runs while the app is open), and the restore previews.
//
// Safety: writes and deletes only inside the backup set's folder; restores
// only into the app's own data folder; no network.

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  BACKUP_SCHEDULES,
  BACKUP_SET_DIR,
  DEFAULT_KEEP,
  MAX_KEEP,
  MIN_PASSWORD,
  type BackupError,
  type BackupFolderCandidate,
  type BackupReason,
  type BackupRunSummary,
  type BackupSchedule,
  type BackupStatus,
  type RestorePreview,
  type RestoreRecord,
  type SnapshotInfo
} from '@shared/backup'
import {
  DamagedBackupError,
  DEFAULT_KDF,
  keysFromMaster,
  newKeyEntry,
  unlockKey,
  WrongPasswordError,
  type BackupKeys,
  type KeyEntry
} from '../core/backup-crypto'
import { collectFiles } from '../core/backup-files'
import {
  planRestore,
  SAFETY_DIR,
  stageRestore,
  summarize,
  type PlanItem
} from '../core/backup-restore'
import {
  applyRetention,
  BackupBusyError,
  createSet,
  listSnapshots,
  manifestFiles,
  readSet,
  runBackup,
  SET_FILE,
  setSize,
  writeSet,
  type CacheEntry,
  type Manifest,
  type ManifestFile,
  type SetFile
} from '../core/backup-store'
import { JsonStore } from '../core/json-store'
import { isInside, isInsideClaudeDir } from '../core/safe-paths'
import type { Encryptor } from './accounts'

export interface BackupFile {
  version: 1
  /** Random id of this install (for the backup folder's lock). */
  installId?: string
  /** The folder the user picked, and the set inside it. */
  destination?: string
  setDir?: string
  schedule: BackupSchedule
  keep: number
  /** "Remember on this PC": the derived key, encrypted with safeStorage (base64). */
  remembered?: { setId: string; keyId: string; enc: string }
  last?: BackupRunSummary
  lastSuccessAt?: string
  lastAttemptAt?: string
  /** Content hashes by relative path, so unchanged files aren't read again. */
  cache: Record<string, CacheEntry>
  lastRestore?: RestoreRecord
}

export function createBackupStore(dataDir: string): JsonStore<BackupFile> {
  return new JsonStore<BackupFile>(join(dataDir, 'backup.json'), dataDir, () => ({
    version: 1,
    schedule: 'daily',
    keep: DEFAULT_KEEP,
    cache: {}
  }))
}

export interface BackupDeps {
  store: JsonStore<BackupFile>
  dataDir: string
  appVersion: string
  encryptor: Encryptor
  /** Save the app's in-memory data first, so the snapshot is current. */
  beforeBackup?: () => Promise<void>
  now?: () => number
  /** Tests use cheaper key derivation. */
  kdf?: { N: number; r: number; p: number }
  /** How old unused objects must be before retention removes them. */
  minObjectAgeMs?: number
}

const DAY = 24 * 60 * 60_000
const INTERVAL: Record<BackupSchedule, number> = { off: Infinity, daily: DAY, weekly: 7 * DAY }
/** A failed scheduled backup is tried again after this long. */
const RETRY_MS = 60 * 60_000
const TICK_MS = 15 * 60_000
const PREVIEW_TTL = 30 * 60_000

const err = (error: string, needsPassword?: boolean): BackupError =>
  needsPassword ? { error, needsPassword } : { error }

function message(e: unknown): string {
  if (e instanceof WrongPasswordError) return 'Wrong password.'
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return "The backup folder can't be found. Is the drive connected?"
  if (code === 'EACCES' || code === 'EPERM')
    return "The app isn't allowed to write to the backup folder."
  if (code === 'ENOSPC') return 'The backup drive is full.'
  return (e as Error)?.message || String(e)
}

export function cleanKeep(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(MAX_KEEP, Math.max(1, Math.round(v)))
}

export class BackupService extends EventEmitter<{ changed: [] }> {
  private readonly keys = new Map<string, BackupKeys>()
  private running: Promise<BackupRunSummary> | undefined
  private progress: { done: number; total: number } | undefined
  private restoring = false
  private counts:
    { at: number; setDir: string; snapshots: number; damaged: number; bytes?: number } | undefined
  private previews = new Map<
    string,
    {
      manifest: Manifest
      files: ManifestFile[]
      items: PlanItem[]
      keys: BackupKeys | null
      expires: number
    }
  >()
  private timer: NodeJS.Timeout | undefined
  private firstTick: NodeJS.Timeout | undefined
  private lastProgressEmit = 0

  constructor(private readonly deps: BackupDeps) {
    super()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get file(): BackupFile {
    return this.deps.store.value
  }

  private installId(): string {
    let id = this.file.installId
    if (!id) {
      id = randomBytes(8).toString('hex')
      const v = id
      this.deps.store.update((f) => {
        f.installId = v
      })
    }
    return id
  }

  private canRemember(): boolean {
    try {
      return this.deps.encryptor.available()
    } catch {
      return false
    }
  }

  /** Load a remembered key (if it still fits the set). */
  async init(): Promise<void> {
    const r = this.file.remembered
    const setDir = this.file.setDir
    if (!r || !setDir) return
    try {
      const set = await readSet(setDir)
      const entry = set?.keys.find((k) => k.id === r.keyId)
      if (!set || set.id !== r.setId || !entry) return
      const master = Buffer.from(
        this.deps.encryptor.decrypt(Buffer.from(r.enc, 'base64')),
        'base64'
      )
      this.keys.set(entry.id, keysFromMaster(entry, master))
    } catch {
      // The drive isn't there yet, or the remembered key no longer fits.
    }
  }

  start(): void {
    this.stop()
    this.firstTick = setTimeout(() => void this.tick(), 2 * 60_000)
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.firstTick.unref?.()
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstTick) clearTimeout(this.firstTick)
    this.timer = this.firstTick = undefined
  }

  /** Wait for a backup in progress (at quit). */
  async idle(): Promise<void> {
    await this.running?.catch(() => undefined)
  }

  /** Is a scheduled backup due now? */
  async due(): Promise<boolean> {
    const f = this.file
    if (f.schedule === 'off' || !f.setDir || this.running || this.restoring) return false
    const t = this.now()
    const lastOk = Date.parse(f.lastSuccessAt ?? '') || 0
    // A quarter of an hour early is fine (the check runs every 15 minutes).
    if (t - lastOk < INTERVAL[f.schedule] - TICK_MS) return false
    const lastTry = Date.parse(f.lastAttemptAt ?? '') || 0
    if (f.last && !f.last.ok && t - lastTry < RETRY_MS) return false
    const set = await readSet(f.setDir).catch(() => undefined)
    if (!set) return false
    if (set.current && !this.keys.has(set.current)) return false
    return true
  }

  async tick(): Promise<void> {
    if (await this.due()) await this.runNow('scheduled')
  }

  // ------------------------------------------------------------- status

  private async refreshCounts(setDir: string, force = false): Promise<void> {
    const c = this.counts
    if (!force && c && c.setDir === setDir && (this.running || this.now() - c.at < 30_000)) return
    const list = await listSnapshots(setDir)
    this.counts = {
      at: this.now(),
      setDir,
      snapshots: list.snapshots.length,
      damaged: list.damaged.length,
      bytes: await setSize(setDir).catch(() => undefined)
    }
  }

  async status(): Promise<BackupStatus> {
    const f = this.file
    const base: BackupStatus = {
      destination: f.destination,
      setDir: f.setDir,
      available: false,
      schedule: f.schedule,
      keep: f.keep,
      encrypted: false,
      locked: false,
      remembered: false,
      canRemember: this.canRemember(),
      running: !!this.running,
      progress: this.running ? this.progress : undefined,
      last: f.last,
      lastSuccessAt: f.lastSuccessAt,
      snapshotCount: 0,
      damagedCount: 0,
      lastRestore: f.lastRestore
    }
    if (f.schedule !== 'off' && f.setDir) {
      const lastOk = Date.parse(f.lastSuccessAt ?? '') || 0
      base.nextDueAt = new Date(Math.max(this.now(), lastOk + INTERVAL[f.schedule])).toISOString()
    }
    if (!f.setDir) return base
    let set: SetFile | undefined
    try {
      set = await readSet(f.setDir)
    } catch (e) {
      return { ...base, unavailableReason: message(e) }
    }
    if (!set)
      return {
        ...base,
        unavailableReason: "The backup folder can't be found. Is the drive connected?"
      }
    await this.refreshCounts(f.setDir).catch(() => undefined)
    const c = this.counts?.setDir === f.setDir ? this.counts : undefined
    return {
      ...base,
      available: true,
      encrypted: !!set.current,
      locked: !!set.current && !this.keys.has(set.current),
      remembered:
        !!set.current && f.remembered?.setId === set.id && f.remembered.keyId === set.current,
      snapshotCount: c?.snapshots ?? 0,
      damagedCount: c?.damaged ?? 0,
      setBytes: c?.bytes
    }
  }

  // ------------------------------------------------------------- folder

  /** Where the set goes for a picked folder, or why that folder can't be used. */
  private async setDirFor(folder: string): Promise<{ setDir: string } | BackupError> {
    if (!folder || !isAbsolute(folder)) return err('Choose a folder.')
    let real: string
    try {
      real = await realpath(folder)
      if (!(await stat(real)).isDirectory()) return err('That isn’t a folder.')
    } catch {
      return err("That folder can't be found.")
    }
    const dataReal = await realpath(this.deps.dataDir).catch(() => this.deps.dataDir)
    for (const p of [folder, real]) {
      if (isInsideClaudeDir(p)) return err('Choose a folder outside Claude Code’s .claude folder.')
      if (isInside(p, this.deps.dataDir) || isInside(p, dataReal))
        return err('Choose a folder outside the app’s own data folder.')
    }
    const own =
      basename(resolve(folder)).toLowerCase() === BACKUP_SET_DIR.toLowerCase() ||
      (await stat(join(folder, SET_FILE)).then(
        () => true,
        () => false
      ))
    const setDir = own ? resolve(folder) : join(resolve(folder), BACKUP_SET_DIR)
    if (isInside(this.deps.dataDir, setDir))
      return err('Choose a folder outside the app’s own data folder.')
    return { setDir }
  }

  async candidate(folder: string): Promise<BackupFolderCandidate> {
    const r = await this.setDirFor(folder)
    if ('error' in r) return { folder, setDir: '', error: r.error }
    try {
      const set = await readSet(r.setDir)
      if (!set) return { folder, setDir: r.setDir }
      const list = await listSnapshots(r.setDir)
      return {
        folder,
        setDir: r.setDir,
        existing: {
          snapshots: list.snapshots.length,
          encrypted: !!set.current,
          createdAt: set.createdAt
        }
      }
    } catch (e) {
      return { folder, setDir: r.setDir, error: message(e) }
    }
  }

  /**
   * Use this folder for backups. A new set is created (encrypted when a
   * password is given); an existing one is joined, and its password checked
   * when given.
   */
  async connect(
    folder: string,
    opts: { encrypt?: boolean; password?: string; remember?: boolean }
  ): Promise<BackupStatus | BackupError> {
    const r = await this.setDirFor(folder)
    if ('error' in r) return r
    try {
      let set = await readSet(r.setDir)
      if (!set) {
        if (opts.encrypt) {
          if (!opts.password || opts.password.length < MIN_PASSWORD)
            return err(`Use a password of at least ${MIN_PASSWORD} characters.`)
          const k = await newKeyEntry(
            opts.password,
            this.deps.kdf ?? DEFAULT_KDF,
            new Date(this.now()).toISOString()
          )
          set = await createSet(r.setDir, new Date(this.now()).toISOString(), k.entry)
          this.keys.set(k.entry.id, k.keys)
          if (opts.remember) this.remember(set, k.entry, k.master)
        } else set = await createSet(r.setDir, new Date(this.now()).toISOString())
      } else if (set.current && opts.password) {
        const entry = set.keys.find((k) => k.id === set?.current) as KeyEntry
        const k = await unlockKey(entry, opts.password)
        this.keys.set(entry.id, k.keys)
        if (opts.remember) this.remember(set, entry, k.master)
      }
      const setId = set.id
      this.deps.store.update((f) => {
        f.destination = resolve(folder)
        f.setDir = r.setDir
        if (f.remembered && f.remembered.setId !== setId) delete f.remembered
      })
      await this.deps.store.flush()
      await this.refreshCounts(r.setDir, true).catch(() => undefined)
      this.emit('changed')
      return this.status()
    } catch (e) {
      return err(message(e))
    }
  }

  /** Stop backing up to this folder. Nothing in it is deleted. */
  async disconnect(): Promise<BackupStatus> {
    this.deps.store.update((f) => {
      delete f.destination
      delete f.setDir
      delete f.remembered
    })
    this.keys.clear()
    this.counts = undefined
    await this.deps.store.flush()
    this.emit('changed')
    return this.status()
  }

  async update(patch: { schedule?: unknown; keep?: unknown }): Promise<BackupStatus> {
    this.deps.store.update((f) => {
      if (BACKUP_SCHEDULES.includes(patch.schedule as BackupSchedule))
        f.schedule = patch.schedule as BackupSchedule
      const keep = cleanKeep(patch.keep)
      if (keep) f.keep = keep
    })
    await this.deps.store.flush()
    this.emit('changed')
    return this.status()
  }

  // ------------------------------------------------------------- passwords

  private remember(set: SetFile, entry: KeyEntry, master: Buffer): void {
    if (!this.canRemember())
      throw new Error("This PC can't protect a saved password, so it wasn't saved.")
    const enc = this.deps.encryptor.encrypt(master.toString('base64')).toString('base64')
    this.deps.store.update((f) => {
      f.remembered = { setId: set.id, keyId: entry.id, enc }
    })
  }

  private async currentSet(): Promise<{ setDir: string; set: SetFile } | BackupError> {
    const setDir = this.file.setDir
    if (!setDir) return err('Choose a backup folder first.')
    try {
      const set = await readSet(setDir)
      if (!set) return err("The backup folder can't be found. Is the drive connected?")
      return { setDir, set }
    } catch (e) {
      return err(message(e))
    }
  }

  /**
   * Turn encryption on, change the password (a new key; older snapshots keep
   * needing the old one), or turn it off (password null) for new snapshots.
   */
  async setPassword(
    password: string | null,
    remember: boolean
  ): Promise<BackupStatus | BackupError> {
    const c = await this.currentSet()
    if ('error' in c) return c
    if (this.running) return err('Wait for the backup that’s running to finish.')
    const { setDir, set } = c
    try {
      if (password === null) {
        set.current = null
        await writeSet(setDir, set)
        this.deps.store.update((f) => {
          delete f.remembered
        })
      } else {
        if (password.length < MIN_PASSWORD)
          return err(`Use a password of at least ${MIN_PASSWORD} characters.`)
        const k = await newKeyEntry(
          password,
          this.deps.kdf ?? DEFAULT_KDF,
          new Date(this.now()).toISOString()
        )
        set.keys.push(k.entry)
        set.current = k.entry.id
        await writeSet(setDir, set)
        this.keys.set(k.entry.id, k.keys)
        this.deps.store.update((f) => {
          delete f.remembered
        })
        if (remember) this.remember(set, k.entry, k.master)
      }
      await this.deps.store.flush()
      this.emit('changed')
      return this.status()
    } catch (e) {
      return err(message(e))
    }
  }

  /** Enter the current password (for scheduled backups, until the app closes or for good). */
  async unlock(password: string, remember: boolean): Promise<BackupStatus | BackupError> {
    const c = await this.currentSet()
    if ('error' in c) return c
    const entry = c.set.keys.find((k) => k.id === c.set.current)
    if (!entry) return err('These backups aren’t encrypted.')
    try {
      const k = await unlockKey(entry, password)
      this.keys.set(entry.id, k.keys)
      if (remember) this.remember(c.set, entry, k.master)
      await this.deps.store.flush()
      this.emit('changed')
      return this.status()
    } catch (e) {
      return err(message(e), e instanceof WrongPasswordError)
    }
  }

  /** Forget the saved password (it stays unlocked until the app closes). */
  async forget(): Promise<BackupStatus> {
    this.deps.store.update((f) => {
      delete f.remembered
    })
    await this.deps.store.flush()
    this.emit('changed')
    return this.status()
  }

  // ------------------------------------------------------------- backup

  runNow(reason: BackupReason): Promise<BackupRunSummary> {
    if (this.running) return this.running
    if (this.restoring)
      return Promise.resolve(
        this.failed(reason, this.now(), 'A restore is waiting for the app to restart.', false)
      )
    this.progress = undefined
    this.running = this.doRun(reason).finally(() => {
      this.running = undefined
      this.progress = undefined
      this.emit('changed')
    })
    this.emit('changed')
    return this.running
  }

  private failed(reason: BackupReason, t0: number, error: string, record = true): BackupRunSummary {
    const s: BackupRunSummary = {
      at: new Date(this.now()).toISOString(),
      ok: false,
      reason,
      error,
      files: 0,
      bytes: 0,
      added: 0,
      addedBytes: 0,
      durationMs: this.now() - t0
    }
    if (record)
      this.deps.store.update((f) => {
        f.last = s
        f.lastAttemptAt = s.at
      })
    return s
  }

  private async doRun(reason: BackupReason): Promise<BackupRunSummary> {
    const t0 = this.now()
    const c = await this.currentSet()
    if ('error' in c) return this.failed(reason, t0, c.error)
    const { setDir, set } = c
    const keys = set.current ? this.keys.get(set.current) : null
    if (set.current && !keys)
      return this.failed(reason, t0, 'Enter the backup password to back up.')
    try {
      await this.deps.beforeBackup?.().catch(() => undefined)
      const files = await collectFiles(this.deps.dataDir)
      const r = await runBackup({
        setDir,
        set,
        keys: keys ?? null,
        files,
        cache: this.file.cache,
        reason,
        appVersion: this.deps.appVersion,
        owner: this.installId(),
        now: () => this.now(),
        onProgress: (done, total) => {
          this.progress = { done, total }
          const t = Date.now()
          if (t - this.lastProgressEmit > 250 || done === total) {
            this.lastProgressEmit = t
            this.emit('changed')
          }
        }
      })
      let pruned: number | undefined
      let note: string | undefined
      try {
        const ret = await applyRetention(setDir, this.file.keep, {
          minObjectAgeMs: this.deps.minObjectAgeMs
        })
        pruned = ret.removedSnapshots
        note = ret.skippedObjects
      } catch (e) {
        note = `Old snapshots weren't removed: ${message(e)}`
      }
      const summary: BackupRunSummary = {
        at: r.manifest.createdAt,
        ok: true,
        reason,
        snapshotId: r.manifest.id,
        files: r.manifest.fileCount,
        bytes: r.manifest.totalBytes,
        added: r.added,
        addedBytes: r.addedBytes,
        durationMs: this.now() - t0,
        pruned,
        encrypted: !!keys,
        error: note
      }
      this.deps.store.update((f) => {
        f.cache = r.cache
        f.last = summary
        f.lastSuccessAt = summary.at
        f.lastAttemptAt = summary.at
      })
      await this.deps.store.flush().catch(() => undefined)
      await this.refreshCounts(setDir, true).catch(() => undefined)
      return summary
    } catch (e) {
      const s = this.failed(
        reason,
        t0,
        e instanceof BackupBusyError ? e.message : `Backup failed: ${message(e)}`
      )
      await this.deps.store.flush().catch(() => undefined)
      return s
    }
  }

  // ------------------------------------------------------------- restore

  async snapshots(): Promise<SnapshotInfo[] | BackupError> {
    const c = await this.currentSet()
    if ('error' in c) return c
    const list = await listSnapshots(c.setDir)
    return list.snapshots.map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      reason: m.reason,
      appVersion: m.appVersion,
      files: m.fileCount,
      bytes: m.totalBytes,
      encrypted: m.keyId !== null,
      olderPassword: m.keyId !== null && m.keyId !== c.set.current,
      unlocked: m.keyId === null || this.keys.has(m.keyId)
    }))
  }

  /** What restoring this snapshot would change (nothing changes yet). */
  async preview(snapshotId: string, password?: string): Promise<RestorePreview | BackupError> {
    const c = await this.currentSet()
    if ('error' in c) return c
    try {
      const list = await listSnapshots(c.setDir)
      const m = list.snapshots.find((s) => s.id === snapshotId)
      if (!m) return err('That snapshot isn’t in the backup folder any more.')
      let keys: BackupKeys | null = null
      if (m.keyId) {
        keys = this.keys.get(m.keyId) ?? null
        if (!keys) {
          if (!password)
            return err(
              m.keyId === c.set.current
                ? 'Enter the backup password.'
                : 'This snapshot was made with an older password. Enter that password.',
              true
            )
          const entry = c.set.keys.find((k) => k.id === m.keyId)
          if (!entry)
            return err('The backup folder no longer has this snapshot’s password details.')
          keys = (await unlockKey(entry, password)).keys
          this.keys.set(entry.id, keys)
        }
      }
      const files = manifestFiles(m, keys)
      const { items, skipped } = await planRestore(this.deps.dataDir, files, this.file.cache)
      const token = randomBytes(16).toString('hex')
      const t = this.now()
      for (const [k, p] of this.previews) if (p.expires < t) this.previews.delete(k)
      this.previews.set(token, { manifest: m, files, items, keys, expires: t + PREVIEW_TTL })
      const notes = [
        'Files that aren’t in this snapshot stay as they are. Nothing is deleted.',
        'Session archive copies are never replaced by a smaller (older) backup copy.',
        'API keys are never in a backup; keys saved on this PC stay. Paired phones, the phone companion and the status line / session alert / terminal setup aren’t changed.',
        'The app restarts to finish the restore.'
      ]
      if (skipped.length)
        notes.unshift(
          `${skipped.length} file${skipped.length === 1 ? '' : 's'} in the snapshot can’t be restored and will be skipped.`
        )
      return {
        token,
        snapshotId: m.id,
        createdAt: m.createdAt,
        groups: summarize(items),
        changes: items.filter(
          (i) => i.action === 'add' || i.action === 'replace' || i.action === 'merge'
        ).length,
        safetyDir: join(this.deps.dataDir, SAFETY_DIR),
        notes
      }
    } catch (e) {
      if (e instanceof WrongPasswordError) return err('Wrong password.', true)
      if (e instanceof DamagedBackupError) return err(e.message)
      return err(message(e))
    }
  }

  /** Stage a previewed restore; the app then restarts to finish it. */
  async restore(token: string): Promise<{ ok: true; written: number } | BackupError> {
    const p = this.previews.get(token)
    if (!p || p.expires < this.now())
      return err('That preview has expired. Choose the snapshot again.')
    if (this.running) return err('Wait for the backup that’s running to finish.')
    const c = await this.currentSet()
    if ('error' in c) return c
    this.restoring = true
    try {
      const written = await stageRestore({
        dataDir: this.deps.dataDir,
        setDir: c.setDir,
        keys: p.keys,
        files: p.files,
        items: p.items,
        snapshot: { id: p.manifest.id, createdAt: p.manifest.createdAt },
        now: this.now()
      })
      this.previews.delete(token)
      return { ok: true, written }
    } catch (e) {
      this.restoring = false
      return err(`Couldn’t restore: ${message(e)}`)
    }
  }

  /** Called at startup with what applyPendingRestore did. */
  recordRestore(r: RestoreRecord): void {
    this.deps.store.update((f) => {
      f.lastRestore = r
      // The data changed under the hash cache.
      f.cache = {}
    })
  }
}
