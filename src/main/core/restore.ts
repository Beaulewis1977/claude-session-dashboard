// Restoring an archived session file to its original location.
//
// This is the only place where the app writes under a `.claude` directory.
// It only ever creates a file that is missing; it never overwrites.

import { constants } from 'node:fs'
import { access, copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type RestoreOutcome = 'restored' | 'already-exists' | 'archive-missing'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function restoreIfMissing(
  archivePath: string,
  originalPath: string
): Promise<RestoreOutcome> {
  if (await exists(originalPath)) return 'already-exists'
  if (!(await exists(archivePath))) return 'archive-missing'
  await mkdir(dirname(originalPath), { recursive: true })
  try {
    // COPYFILE_EXCL makes the copy fail if the target appeared in the meantime.
    await copyFile(archivePath, originalPath, constants.COPYFILE_EXCL)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'already-exists'
    throw err
  }
  return 'restored'
}
