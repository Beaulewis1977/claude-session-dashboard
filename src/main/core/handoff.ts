// Continue fresh: the handoff file a new session starts from. It lives in the
// app's own data folder (`handoffs\<new-session-id>.md` for Claude Code,
// `handoffs\codex\<handoff-id>.md` for Codex, which picks its new session's id
// itself), is created exclusively (never overwrites anything) and is never
// written anywhere else, `.claude` and `.codex` included.

import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProviderId } from '@shared/provider'
import { assertAppDataWrite, assertRealAppDataWrite } from './safe-paths'
import { isValidSessionId } from './launch'

export function handoffDir(dataDir: string): string {
  return join(dataDir, 'handoffs')
}

/** Codex handoffs: a folder of their own (cleaned up by the same rules). */
export function codexHandoffDir(dataDir: string): string {
  return join(handoffDir(dataDir), 'codex')
}

export function handoffPath(
  dataDir: string,
  newSessionId: string,
  provider: ProviderId = 'claude'
): string {
  if (!isValidSessionId(newSessionId)) throw new Error(`Invalid session id: ${newSessionId}`)
  const dir = provider === 'codex' ? codexHandoffDir(dataDir) : handoffDir(dataDir)
  return join(dir, `${newSessionId}.md`)
}

/** Write a new handoff file. Throws (EEXIST) if one is already there: nothing is overwritten. */
export async function writeHandoff(
  dataDir: string,
  newSessionId: string,
  text: string,
  provider: ProviderId = 'claude'
): Promise<string> {
  const path = handoffPath(dataDir, newSessionId, provider)
  assertAppDataWrite(path, dataDir)
  // Checked before the folder is made, so nothing is created beyond a link.
  await assertRealAppDataWrite(path, dataDir)
  await mkdir(dirname(path), { recursive: true })
  await assertRealAppDataWrite(path, dataDir)
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
  return path
}

// ------------------------------------------------------------- clean-up
//
// Handoff files are never deleted on their own. Settings → Summaries shows
// their total size, and "Clean up handoffs older than 30 days" (after asking)
// deletes only the app's own handoff files: `<uuid>.md` directly inside
// `handoffs\` and `handoffs\codex\`, never a link, a folder or any other file.

export const HANDOFF_CLEANUP_DAYS = 30

const HANDOFF_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i

export interface HandoffStats {
  files: number
  bytes: number
  /** Of those, older than the clean-up age. */
  old: { files: number; bytes: number }
}

interface HandoffFile {
  path: string
  bytes: number
  mtimeMs: number
}

async function handoffFiles(dataDir: string): Promise<HandoffFile[]> {
  const out: HandoffFile[] = []
  for (const dir of [handoffDir(dataDir), codexHandoffDir(dataDir)]) {
    let names: string[]
    try {
      // The folder itself must be a real folder, not a link out of the data folder.
      const st = await lstat(dir)
      if (!st.isDirectory()) continue
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!HANDOFF_FILE_RE.test(name)) continue
      const path = join(dir, name)
      try {
        const st = await lstat(path)
        if (st.isFile()) out.push({ path, bytes: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // gone meanwhile
      }
    }
  }
  return out
}

export async function handoffStats(dataDir: string, now = Date.now()): Promise<HandoffStats> {
  const cutoff = now - HANDOFF_CLEANUP_DAYS * 86_400_000
  const files = await handoffFiles(dataDir)
  const old = files.filter((f) => f.mtimeMs < cutoff)
  return {
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    old: { files: old.length, bytes: old.reduce((n, f) => n + f.bytes, 0) }
  }
}

/** Delete handoff files older than the clean-up age (asked for in Settings). Returns how many. */
export async function cleanupHandoffs(
  dataDir: string,
  now = Date.now()
): Promise<{ deleted: number; bytes: number }> {
  const cutoff = now - HANDOFF_CLEANUP_DAYS * 86_400_000
  let deleted = 0
  let bytes = 0
  for (const f of await handoffFiles(dataDir)) {
    if (f.mtimeMs >= cutoff) continue
    // Through no link: the real path must still be in the app's data folder.
    await assertRealAppDataWrite(f.path, dataDir)
    try {
      await unlink(f.path)
      deleted++
      bytes += f.bytes
    } catch {
      // in use or gone: left alone
    }
  }
  return { deleted, bytes }
}
