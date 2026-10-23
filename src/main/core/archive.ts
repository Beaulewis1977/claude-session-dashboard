// Archiving: copy each session file into the app's own folder so it survives
// Claude Code's cleanup. Nothing is ever removed from the archive.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ArchiveRecord } from '@shared/types'
import { assertAppDataWrite, assertRealAppDataWrite } from './safe-paths'
import { copyShared } from './shared-copy'

export function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || '_'
}

/**
 * The archive file name for a session id. A plain lower-case id (every
 * Claude Code session id) is used as it is. Any other id (one that would be
 * cut short or have characters replaced, or with capitals, which Windows
 * doesn't tell apart) gets a hash of the whole id, so two ids never share a
 * file. Only hashed names contain a ".", so they can't match a plain one.
 */
export function archiveName(sessionId: string): string {
  if (/^[a-z0-9][a-z0-9_-]{0,99}$/.test(sessionId)) return sessionId
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
  return `${safeSegment(sessionId).slice(0, 60)}.${hash}`
}

export function archivePathFor(archiveDir: string, sourceId: string, sessionId: string): string {
  return join(archiveDir, safeSegment(sourceId), `${archiveName(sessionId)}.jsonl`)
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface ArchiveInput {
  sessionId: string
  sourceId: string
  sourceLabel: string
  env: ArchiveRecord['env']
  distro?: string
  originalPath: string
  cwd?: string
}

export type ArchiveDecision = 'copy' | 'skip'

/**
 * Decide whether to (re-)copy. We copy when there is no archive copy yet, when
 * the archive copy has gone missing, or when the source has grown. A source that
 * shrank or was rewritten is not copied, so the archive never loses data.
 */
export function shouldArchive(
  record: ArchiveRecord | undefined,
  sourceSize: number,
  archiveExists: boolean
): ArchiveDecision {
  if (!record || !archiveExists) return 'copy'
  if (sourceSize > record.size) return 'copy'
  return 'skip'
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function archiveSession(
  input: ArchiveInput,
  existing: ArchiveRecord | undefined,
  archiveDir: string,
  appDataDir: string
): Promise<ArchiveRecord | undefined> {
  const src = await stat(input.originalPath)
  const dest = existing?.archivePath ?? archivePathFor(archiveDir, input.sourceId, input.sessionId)
  const decision = shouldArchive(existing, src.size, await fileExists(dest))
  if (decision === 'skip') {
    // Keep the record's descriptive fields fresh without touching the copy.
    if (existing && input.cwd && existing.cwd !== input.cwd) return { ...existing, cwd: input.cwd }
    return undefined
  }
  assertAppDataWrite(dest, appDataDir)
  await assertRealAppDataWrite(dest, appDataDir)
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  // Claude Code may be appending to the session right now: don't lock it.
  await copyShared(input.originalPath, tmp)
  try {
    const copied = await stat(tmp)
    // Never replace a larger archive copy with a smaller one (the file may have
    // been truncated between stat and copy).
    if (existing && copied.size < existing.size && (await fileExists(dest))) {
      await unlink(tmp)
      return undefined
    }
    const sha256 = await sha256File(tmp)
    await rename(tmp, dest)
    const now = new Date().toISOString()
    return {
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel,
      env: input.env,
      distro: input.distro,
      originalPath: input.originalPath,
      archivePath: dest,
      cwd: input.cwd ?? existing?.cwd,
      size: copied.size,
      sha256,
      sourceMtimeMs: src.mtimeMs,
      firstArchivedAt: existing?.firstArchivedAt ?? now,
      archivedAt: now
    }
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

export async function archiveStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (d: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        files++
        bytes += (await stat(p)).size
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}
