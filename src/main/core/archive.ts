// Archiving: copy each session file into the app's own folder so it survives
// Claude Code's cleanup. Nothing is ever removed from the archive.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_PROVIDER, type ProviderId } from '@shared/provider'
import type { ArchiveRecord } from '@shared/types'
import { assertAppDataWrite, assertRealAppDataWrite } from './safe-paths'
import { copyShared } from './shared-copy'
import { contentSizeOf, hasZstdMagic, isZstdPath, zstdContentSize } from './zstd'

/** ".jsonl.zst" or ".jsonl" (the archive's two kinds of copies). */
function extOf(p: string): string {
  return p.endsWith('.jsonl.zst') ? '.jsonl.zst' : p.slice(p.lastIndexOf('.'))
}

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

/** `ext`: the provider's archive extension (Claude Code: ".jsonl"). */
export function archivePathFor(
  archiveDir: string,
  sourceId: string,
  sessionId: string,
  ext = '.jsonl'
): string {
  return join(archiveDir, safeSegment(sourceId), `${archiveName(sessionId)}${ext}`)
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export interface ArchiveInput {
  /** Recorded only when it isn't Claude Code (absent means Claude Code). */
  provider?: ProviderId
  /** The archive copy's extension (default ".jsonl"). */
  ext?: string
  sessionId: string
  sourceId: string
  sourceLabel: string
  env: ArchiveRecord['env']
  distro?: string
  originalPath: string
  cwd?: string
  /**
   * The session's content size, decompressed (agents whose files may be
   * re-encoded, e.g. Codex compressing a rollout to .zst). Compared instead
   * of the file size, so a compressed file with more in it is still copied.
   */
  contentSize?: number
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
  archiveExists: boolean,
  contentSize?: number
): ArchiveDecision {
  if (!record || !archiveExists) return 'copy'
  if (contentSize !== undefined)
    return contentSize > (record.contentSize ?? record.size) ? 'copy' : 'skip'
  if (sourceSize > record.size) return 'copy'
  return 'skip'
}

/**
 * How much a copy adds to the archive (for estimates), the way archiveSession
 * writes it: the same encoding replaces the copy (it grows by the difference),
 * another encoding writes a whole new copy beside the old one.
 */
export function archiveGrowth(
  record: Pick<ArchiveRecord, 'archivePath' | 'size'> | undefined,
  sourceSize: number,
  ext?: string
): number {
  if (!record) return sourceSize
  if (ext && extOf(record.archivePath) !== ext) return sourceSize
  return Math.max(0, sourceSize - record.size)
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
  const fresh = archivePathFor(archiveDir, input.sourceId, input.sessionId, input.ext)
  // Same encoding: the same copy grows. Another encoding (a rollout Codex compressed):
  // a new copy next to it, so the old one is never overwritten.
  const sameKind = !existing || !input.ext || extOf(existing.archivePath) === input.ext
  const dest = existing && sameKind ? existing.archivePath : fresh
  const decision = shouldArchive(
    existing,
    src.size,
    await fileExists(existing?.archivePath ?? dest),
    input.contentSize
  )
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
    // A compressed copy is measured by what it holds: recompressed better, it can
    // be smaller on disk with more in it. One cut off mid-copy doesn't decode.
    const compressed = isZstdPath(dest) && (await hasZstdMagic(tmp))
    const content = compressed ? await zstdContentSize(tmp).catch(() => undefined) : undefined
    if (compressed && content === undefined) {
      await unlink(tmp)
      return undefined
    }
    // Never replace a larger archive copy with a smaller one (the file may have
    // been truncated between stat and copy).
    if (existing && dest === existing.archivePath && (await fileExists(dest))) {
      const shrank = compressed
        ? content! < (existing.contentSize ?? (await contentSizeOf(dest).catch(() => 0)))
        : copied.size < existing.size
      if (shrank) {
        await unlink(tmp)
        return undefined
      }
    }
    const sha256 = await sha256File(tmp)
    await rename(tmp, dest)
    const now = new Date().toISOString()
    return {
      ...(input.provider && input.provider !== DEFAULT_PROVIDER
        ? { provider: input.provider }
        : {}),
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      sourceLabel: input.sourceLabel,
      env: input.env,
      distro: input.distro,
      originalPath: input.originalPath,
      archivePath: dest,
      cwd: input.cwd ?? existing?.cwd,
      size: copied.size,
      // A compressed copy: what it was measured to hold (the parse may be older).
      ...((content ?? input.contentSize) !== undefined
        ? { contentSize: content ?? input.contentSize }
        : {}),
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

/** Archive copies (files with one of the providers' extensions) and their size. */
export async function archiveStats(
  dir: string,
  exts: readonly string[] = ['.jsonl']
): Promise<{ files: number; bytes: number }> {
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
      else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
        files++
        bytes += (await stat(p)).size
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}
