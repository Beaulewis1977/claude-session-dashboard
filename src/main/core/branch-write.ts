// Writing a branch's new session file.
//
// The only other write under `.claude` besides restore.ts (and the opt-in
// status line installer): it only ever creates a file that doesn't exist yet
// (`wx`), next to the session it was branched from. Nothing is changed or deleted.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid } from '@shared/jsonl'
import { assertBranchWrite } from './safe-paths'

export function branchFilePath(projectDir: string, sessionId: string): string {
  if (!isUuid(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  return join(projectDir, `${sessionId}.jsonl`)
}

/** Create `<projectDir>/<sessionId>.jsonl`. Fails (EEXIST) if it already exists. */
export async function writeNewSessionFile(
  projectDir: string,
  sessionId: string,
  content: string
): Promise<string> {
  const target = branchFilePath(projectDir, sessionId)
  assertBranchWrite(target, projectDir)
  await mkdir(projectDir, { recursive: true })
  await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
  return target
}
