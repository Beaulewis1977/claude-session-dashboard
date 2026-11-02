// Claude Code's extra usage files: subagent transcripts next to the session.

import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Subagent transcripts live next to the session: `<project>/<session-id>/subagents/*.jsonl`. */
export async function listSubagentFiles(
  sessionFile: string,
  sessionId: string
): Promise<{ path: string; size: number }[]> {
  const dir = join(dirname(sessionFile), sessionId, 'subagents')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: { path: string; size: number }[] = []
  for (const n of names.sort()) {
    if (!n.endsWith('.jsonl')) continue
    try {
      const st = await stat(join(dir, n))
      if (st.isFile()) out.push({ path: join(dir, n), size: st.size })
    } catch {
      // vanished
    }
  }
  return out
}

/** Their archive copies go next to the session's archive copy, in the same layout. */
export function subagentArchiveDir(archivePath: string, sessionId: string): string {
  return join(dirname(archivePath), sessionId, 'subagents')
}
