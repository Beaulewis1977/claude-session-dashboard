// Continue fresh: the handoff file a new session starts from. It lives in the
// app's own data folder (`handoffs\<new-session-id>.md`), is created
// exclusively (never overwrites anything) and is never written anywhere else,
// `.claude` included.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertAppDataWrite, assertRealAppDataWrite } from './safe-paths'
import { isValidSessionId } from './launch'

export function handoffDir(dataDir: string): string {
  return join(dataDir, 'handoffs')
}

export function handoffPath(dataDir: string, newSessionId: string): string {
  if (!isValidSessionId(newSessionId)) throw new Error(`Invalid session id: ${newSessionId}`)
  return join(handoffDir(dataDir), `${newSessionId}.md`)
}

/** Write a new handoff file. Throws (EEXIST) if one is already there: nothing is overwritten. */
export async function writeHandoff(
  dataDir: string,
  newSessionId: string,
  text: string
): Promise<string> {
  const path = handoffPath(dataDir, newSessionId)
  assertAppDataWrite(path, dataDir)
  // Checked before the folder is made, so nothing is created beyond a link.
  await assertRealAppDataWrite(path, dataDir)
  await mkdir(handoffDir(dataDir), { recursive: true })
  await assertRealAppDataWrite(path, dataDir)
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
  return path
}
