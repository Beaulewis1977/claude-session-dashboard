// Import a claude.ai data export (zip) into the app's archive as view-only
// conversations. The zip is only read (one readFile); everything written goes
// to the app's own data folder.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { convertClaudeAiExport } from '@shared/claude-ai'
import type { ImportResult } from '@shared/api'
import type { ArchiveRecord } from '@shared/types'
import { archivePathFor } from '../core/archive'
import { writeFileAtomic, type JsonStore } from '../core/json-store'
import { assertAppDataWrite } from '../core/safe-paths'
import { listZip, readZipEntry } from '../core/zip'
import type { MetadataFile } from './store'

export const CLAUDE_AI_SOURCE = 'claude-ai'
/** Exports this big are refused (the whole zip is read into memory). */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
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
  // Which record owns each archive file (Windows paths ignore case).
  const owners = new Map<string, string>()
  for (const [k, r] of Object.entries(metadata.value.archive))
    owners.set(r.archivePath.toLowerCase(), k)
  for (const c of converted.conversations) {
    const key = `${CLAUDE_AI_SOURCE}:${c.uuid}`
    const prev = metadata.value.archive[key]
    const sha256 = createHash('sha256').update(c.jsonl).digest('hex')
    const archivePath = archivePathFor(dirs.archiveDir, CLAUDE_AI_SOURCE, c.uuid)
    // Records from before archive names were collision-proof may point at a
    // shared file: those are written again under their own name.
    if (
      prev?.sha256 === sha256 &&
      prev.archivePath === archivePath &&
      (await exists(archivePath))
    ) {
      res.unchanged++
      continue
    }
    // Never overwrite another conversation's copy.
    const owner = owners.get(archivePath.toLowerCase())
    if (owner !== undefined && owner !== key) {
      res.skipped++
      continue
    }
    owners.set(archivePath.toLowerCase(), key)
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
    if (prev) res.updated++
    else res.added++
  }
  await metadata.flush()
  return res
}
