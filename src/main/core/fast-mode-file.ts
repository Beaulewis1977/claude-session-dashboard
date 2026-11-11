// Claude Code's fast mode at launch: `claude --settings <file>`, where the
// file is the app's own `launch\fast-mode.json` in its data folder. It holds
// only {"fastMode": true}, so the session gets fast mode and every other
// setting stays the user's own (Claude Code merges `--settings` over them,
// key by key). It's checked before every use and written again (temp file +
// rename) when it's missing or anything else is in it. Nothing is written into
// `.claude`: Claude Code reads the file, the app never edits Claude's settings.

import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAST_MODE_FILE, FAST_MODE_SETTINGS } from '@shared/model-choice'
import { writeFileAtomic } from './json-store'

export function fastModeFilePath(dataDir: string): string {
  return join(dataDir, 'launch', FAST_MODE_FILE)
}

/** The file, with exactly the fast-mode setting in it; its Windows path. */
export async function ensureFastModeFile(dataDir: string): Promise<string> {
  const path = fastModeFilePath(dataDir)
  const ok = await lstat(path)
    .then(async (st) => st.isFile() && (await readFile(path, 'utf8')) === FAST_MODE_SETTINGS)
    .catch(() => false)
  // A link, a folder or other content is replaced by the app's own file (the
  // rename replaces a link itself, never what it points to).
  if (!ok) await writeFileAtomic(path, FAST_MODE_SETTINGS, dataDir)
  return path
}
