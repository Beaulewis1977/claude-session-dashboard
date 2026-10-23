// Import a claude.ai data export (zip) into the app's archive as view-only
// conversations. The zip is only read (one readFile); everything written goes
// to the app's own data folder.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { convertClaudeAiExport } from '@shared/claude-ai'
import type { ImportResult } from '@shared/api'
import type { ArchiveRecord } from '@shared/types'
import { archivePathFor, sha256File } from '../core/archive'
import { writeFileAtomic, type JsonStore } from '../core/json-store'
import { assertAppDataWrite } from '../core/safe-paths'
import { listZip, readZipEntry } from '../core/zip'
import type { MetadataFile } from './store'

export const CLAUDE_AI_SOURCE = 'claude-ai'
/** Exports this big are refused (the whole zip is read into memory). */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024

/**
 * The archive files records point at, for an import to write safely. Before
 * archive names were collision-proof, two records could point at one file
 * (ids cut to the same length, or differing only in case, which Windows
 * ignores), and the file then held whichever conversation was written last.
 */
class ArchiveFiles {
  /** Lower-cased path → keys of the records pointing at it. */
  private users = new Map<string, Set<string>>()
  /** Lower-cased path → SHA-256 of the file's content (null: no file). */
  private hashes = new Map<string, string | null>()

  constructor(
    private readonly metadata: JsonStore<MetadataFile>,
    private readonly dirs: { archiveDir: string; dataDir: string }
  ) {
    for (const [k, r] of Object.entries(metadata.value.archive)) this.add(r.archivePath, k)
  }

  private add(path: string, key: string): void {
    const p = path.toLowerCase()
    this.users.set(p, (this.users.get(p) ?? new Set()).add(key))
  }

  async hash(path: string): Promise<string | null> {
    const p = path.toLowerCase()
    if (!this.hashes.has(p)) this.hashes.set(p, await sha256File(path).catch(() => null))
    return this.hashes.get(p)!
  }

  /**
   * Make `path` free for `key`'s conversation. Another record still pointing
   * at it from the old naming is moved to its own file first: with its text
   * if the file holds it, else (its text was already overwritten) to its own,
   * not yet written path, so it never shows another conversation. Returns
   * false if the file properly belongs to another record.
   */
  async clearFor(key: string, path: string): Promise<boolean> {
    for (const other of [...(this.users.get(path.toLowerCase()) ?? [])]) {
      if (other === key) continue
      const rec = this.metadata.value.archive[other]
      if (!rec) continue
      const own = archivePathFor(this.dirs.archiveDir, rec.sourceId, rec.sessionId)
      if (own.toLowerCase() === path.toLowerCase()) return false
      if (
        (await this.hash(rec.archivePath)) === rec.sha256 &&
        (await this.hash(own)) !== rec.sha256
      ) {
        assertAppDataWrite(own, this.dirs.dataDir)
        await writeFileAtomic(own, await readFile(rec.archivePath, 'utf8'), this.dirs.dataDir)
        this.hashes.set(own.toLowerCase(), rec.sha256)
      }
      this.metadata.update((d) => {
        d.archive[other] = { ...rec, archivePath: own }
      })
      this.wrote(other, rec.archivePath, own)
    }
    return true
  }

  /** Record that `key` now points at `path` (holding `sha256`, if just written). */
  wrote(key: string, from: string | undefined, path: string, sha256?: string): void {
    if (from) this.users.get(from.toLowerCase())?.delete(key)
    this.add(path, key)
    if (sha256) this.hashes.set(path.toLowerCase(), sha256)
  }
}

export async function importClaudeAiExport(
  zipPath: string,
  dirs: { archiveDir: string; dataDir: string },
  metadata: JsonStore<MetadataFile>
): Promise<ImportResult> {
  const empty = { conversations: 0, added: 0, updated: 0, unchanged: 0, skipped: 0 }
  let buf: Buffer
  try {
    const st = await stat(zipPath)
    if (st.size > MAX_ZIP_BYTES) return { ok: false, error: 'The export is too large.', ...empty }
    buf = await readFile(zipPath)
  } catch (err) {
    return { ok: false, error: `Couldn't read the file: ${(err as Error).message}`, ...empty }
  }
  let data: unknown
  try {
    const entries = listZip(buf)
    const entry =
      entries.find((e) => e.name === 'conversations.json') ??
      entries.find((e) => /(^|\/)conversations\.json$/.test(e.name))
    if (!entry)
      return {
        ok: false,
        error: 'No conversations.json in this zip. Is it a claude.ai data export?',
        ...empty
      }
    data = JSON.parse(
      readZipEntry(buf, entry)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
    )
  } catch (err) {
    return { ok: false, error: (err as Error).message, ...empty }
  }
  let converted
  try {
    converted = convertClaudeAiExport(data)
  } catch (err) {
    return { ok: false, error: (err as Error).message, ...empty }
  }
  const res: ImportResult = {
    ok: true,
    ...empty,
    conversations: converted.conversations.length,
    skipped: converted.skipped
  }
  const now = new Date().toISOString()
  const files = new ArchiveFiles(metadata, dirs)
  for (const c of converted.conversations) {
    const key = `${CLAUDE_AI_SOURCE}:${c.uuid}`
    const prev = metadata.value.archive[key]
    const sha256 = createHash('sha256').update(c.jsonl).digest('hex')
    const archivePath = archivePathFor(dirs.archiveDir, CLAUDE_AI_SOURCE, c.uuid)
    // Unchanged only if the file really holds this conversation: before
    // archive names were collision-proof, two records could share one file.
    if (
      prev?.sha256 === sha256 &&
      prev.archivePath === archivePath &&
      (await files.hash(archivePath)) === sha256
    ) {
      res.unchanged++
      continue
    }
    if (!(await files.clearFor(key, archivePath))) {
      res.skipped++
      continue
    }
    assertAppDataWrite(archivePath, dirs.dataDir)
    await writeFileAtomic(archivePath, c.jsonl, dirs.dataDir)
    const rec: ArchiveRecord = {
      sessionId: c.uuid,
      sourceId: CLAUDE_AI_SOURCE,
      sourceLabel: 'claude.ai',
      env: 'windows',
      origin: 'claude-ai',
      originalPath: `${zipPath}#conversations.json/${c.uuid}`,
      archivePath,
      size: Buffer.byteLength(c.jsonl),
      sha256,
      sourceMtimeMs: c.updatedAt ? Date.parse(c.updatedAt) : 0,
      firstArchivedAt: prev?.firstArchivedAt ?? now,
      archivedAt: now
    }
    metadata.update((d) => {
      d.archive[key] = rec
    })
    files.wrote(key, prev?.archivePath, archivePath, sha256)
    if (prev) res.updated++
    else res.added++
  }
  await metadata.flush()
  return res
}
