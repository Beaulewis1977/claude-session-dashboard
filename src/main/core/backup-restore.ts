// Restoring a snapshot into the app's own data folder (never into `.claude`).
//
// 1. Preview: compare the snapshot with the data folder, file by file.
// 2. Stage: decrypt and check every file that changes into
//    `<data>/restore-pending/`, then write its plan (last, so a half-staged
//    restore is never applied).
// 3. The app restarts. Before anything else loads (see index.ts),
//    applyPendingRestore moves each current file it replaces into
//    `<data>/restore-backups/<time>/` (the "back up the current data first"
//    step) and puts the restored one in its place. Nothing runs during the
//    swap that could write the old data back.
//
// A restore never deletes a file: files that aren't in the snapshot stay.
// Session archive copies are never replaced by a smaller backup copy.

import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { RestoreAction, RestoreGroup, RestoreRecord } from '@shared/backup'
import type { BackupKeys } from './backup-crypto'
import {
  GROUP_LABELS,
  groupOf,
  isRestorablePath,
  mergedOnRestore,
  mergeOnRestore,
  neverShrinks,
  stripAccountKeys,
  targetPath,
  type FileGroup
} from './backup-files'
import { readObjectTo, type ManifestFile } from './backup-store'
import { writeFileAtomic } from './json-store'
import { assertRealAppDataWrite, isInside, UnsafeWriteError } from './safe-paths'

export const PENDING_DIR = 'restore-pending'
export const SAFETY_DIR = 'restore-backups'
const PLAN_FILE = 'plan.json'

export interface PlanItem {
  rel: string
  action: RestoreAction
  /** SHA-256 of the backup's content. */
  sha256: string
  size: number
  note?: string
}

async function sha256Of(path: string, rel: string): Promise<string> {
  const hash = createHash('sha256')
  if (rel === 'accounts.json')
    return hash.update(stripAccountKeys(await readFile(path))).digest('hex')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** What restoring these files would do to the data folder. */
export async function planRestore(
  dataDir: string,
  files: ManifestFile[],
  cache: Record<string, { s: number; m: number; h: string }> = {}
): Promise<{ items: PlanItem[]; skipped: string[] }> {
  const items: PlanItem[] = []
  const skipped: string[] = []
  for (const f of files) {
    if (!isRestorablePath(f.p)) {
      skipped.push(f.p)
      continue
    }
    const target = targetPath(dataDir, f.p)
    const st = await lstat(target).catch(() => undefined)
    const base = { rel: f.p, sha256: f.h, size: f.s }
    if (!st) {
      items.push({ ...base, action: 'add' })
      continue
    }
    if (!st.isFile()) {
      skipped.push(f.p)
      continue
    }
    const c = cache[f.p]
    const here =
      c && c.s === st.size && c.m === st.mtimeMs && f.p !== 'accounts.json'
        ? c.h
        : await sha256Of(target, f.p)
    if (here === f.h) items.push({ ...base, action: 'same' })
    else if (mergedOnRestore(f.p)) items.push({ ...base, action: 'merge' })
    else if (neverShrinks(f.p) && st.size >= f.s)
      items.push({ ...base, action: 'keep', note: 'The copy here is newer' })
    else items.push({ ...base, action: 'replace' })
  }
  return { items, skipped }
}

const ORDER: FileGroup[] = ['archive', 'meta', 'usage', 'settings', 'accounts', 'ask']

export function summarize(items: PlanItem[]): RestoreGroup[] {
  const groups = new Map<FileGroup, RestoreGroup>()
  for (const it of items) {
    const g = groupOf(it.rel)
    let r = groups.get(g)
    if (!r) {
      r = {
        key: g,
        label: GROUP_LABELS[g],
        add: 0,
        replace: 0,
        merge: 0,
        keep: 0,
        same: 0,
        examples: []
      }
      groups.set(g, r)
    }
    r[it.action]++
    if (it.action !== 'same' && r.examples.length < 6)
      r.examples.push({ path: it.rel, action: it.action, note: it.note })
  }
  return ORDER.filter((g) => groups.has(g)).map((g) => groups.get(g) as RestoreGroup)
}

const writes = (a: RestoreAction): boolean => a === 'add' || a === 'replace' || a === 'merge'

/**
 * Decrypt and check the files that change into the data folder's
 * restore-pending folder, then write the plan. Throws (and leaves no plan)
 * when any file can't be restored, so a restore is all or nothing.
 */
export async function stageRestore(o: {
  dataDir: string
  setDir: string
  keys: BackupKeys | null
  files: ManifestFile[]
  items: PlanItem[]
  snapshot: { id: string; createdAt: string }
  now: number
}): Promise<number> {
  const pending = join(o.dataDir, PENDING_DIR)
  await removePending(o.dataDir)
  const byPath = new Map(o.files.map((f) => [f.p, f]))
  const todo = o.items.filter((i) => writes(i.action))
  try {
    for (const it of todo) {
      const f = byPath.get(it.rel)
      if (!f) throw new Error(`Not in the snapshot: ${it.rel}`)
      const dest = join(pending, 'files', ...targetRel(it.rel))
      await assertRealAppDataWrite(dest, o.dataDir)
      await mkdir(dirname(dest), { recursive: true })
      await readObjectTo(o.setDir, f, o.keys, dest)
    }
    const plan = {
      version: 1,
      snapshotId: o.snapshot.id,
      snapshotCreatedAt: o.snapshot.createdAt,
      stagedAt: new Date(o.now).toISOString(),
      items: todo
    }
    await writeFileAtomic(join(pending, PLAN_FILE), JSON.stringify(plan, null, 2), o.dataDir)
  } catch (err) {
    await removePending(o.dataDir).catch(() => undefined)
    throw err
  }
  return todo.length
}

function targetRel(rel: string): string[] {
  if (!isRestorablePath(rel)) throw new UnsafeWriteError(`Not a path a restore may write: ${rel}`)
  return rel.split('/')
}

/** Remove the app's own staging folder (exactly `<data>/restore-pending`, never through a link). */
export async function removePending(dataDir: string): Promise<void> {
  const pending = join(dataDir, PENDING_DIR)
  const st = await lstat(pending).catch(() => undefined)
  if (!st) return
  if (!st.isDirectory()) throw new UnsafeWriteError(`Not the app's restore folder: ${pending}`)
  const [real, base] = await Promise.all([realpath(pending), realpath(dataDir)])
  if (resolve(real) !== resolve(join(base, PENDING_DIR)))
    throw new UnsafeWriteError(`Not the app's restore folder: ${pending}`)
  await rm(pending, { recursive: true, force: true })
}

export async function hasPendingRestore(dataDir: string): Promise<boolean> {
  return stat(join(dataDir, PENDING_DIR, PLAN_FILE)).then(
    () => true,
    () => false
  )
}

function stampOf(t: number): string {
  return new Date(t)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** Keep a copy of the current file (the restored one then replaces it in one rename). */
async function keepCopy(target: string, safety: string, dataDir: string): Promise<void> {
  await assertRealAppDataWrite(safety, dataDir)
  await mkdir(dirname(safety), { recursive: true })
  await copyFile(target, safety, constants.COPYFILE_EXCL)
}

/**
 * Finish a staged restore. Runs at startup before any of the app's data is
 * loaded. Returns what happened, or undefined when nothing was pending.
 */
export async function applyPendingRestore(
  dataDir: string,
  opts: { archiveDir: string; now: number }
): Promise<RestoreRecord | undefined> {
  const pending = join(dataDir, PENDING_DIR)
  let plan: { snapshotId: string; snapshotCreatedAt: string; items: PlanItem[] }
  try {
    plan = JSON.parse(await readFile(join(pending, PLAN_FILE), 'utf8')) as typeof plan
  } catch {
    // Staging that never finished: nothing to apply.
    await removePending(dataDir).catch(() => undefined)
    return undefined
  }
  const safetyDir = join(dataDir, SAFETY_DIR, stampOf(opts.now))
  const record: RestoreRecord = {
    at: new Date(opts.now).toISOString(),
    snapshotId: String(plan.snapshotId),
    snapshotCreatedAt: String(plan.snapshotCreatedAt),
    written: 0,
    safetyDir
  }
  const errors: string[] = []
  for (const it of Array.isArray(plan.items) ? plan.items : []) {
    try {
      if (!writes(it.action)) continue
      const target = targetPath(dataDir, it.rel)
      const staged = join(pending, 'files', ...targetRel(it.rel))
      if (!isInside(staged, pending)) throw new UnsafeWriteError(it.rel)
      await assertRealAppDataWrite(target, dataDir)
      const cur = await lstat(target).catch(() => undefined)
      const stagedSt = await stat(staged)
      // It may have grown since the preview: still never replace with a smaller copy.
      if (cur?.isFile() && neverShrinks(it.rel) && cur.size >= stagedSt.size) continue
      if (it.action === 'merge') {
        const current = cur?.isFile() ? await readFile(target, 'utf8') : undefined
        const merged = mergeOnRestore(it.rel, await readFile(staged, 'utf8'), current, {
          archiveDir: opts.archiveDir
        })
        if (cur?.isFile()) await keepCopy(target, join(safetyDir, ...targetRel(it.rel)), dataDir)
        await writeFileAtomic(target, merged, dataDir)
      } else {
        if (cur?.isFile()) await keepCopy(target, join(safetyDir, ...targetRel(it.rel)), dataDir)
        await mkdir(dirname(target), { recursive: true })
        await rename(staged, target)
      }
      record.written++
    } catch (err) {
      errors.push(`${it.rel}: ${(err as Error).message}`)
    }
  }
  if (errors.length)
    record.error = `${errors.length} file${errors.length === 1 ? '' : 's'} couldn't be restored (${errors.slice(0, 3).join('; ')})`
  await removePending(dataDir).catch(() => undefined)
  return record
}
