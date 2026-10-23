// Copying files that Claude Code may be writing to at the same moment.
//
// fs.copyFile uses CopyFileW on Windows, which opens the source without
// sharing it for writing: if Claude Code appends to a session while the app
// archives it, Claude Code's write can fail (EBUSY). A read stream opens the
// file the way any reader does (shared for reading, writing and deleting), so
// the app never gets in Claude Code's way.

import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

/** Copy `src` to `dest` (created or replaced), never locking `src` against writers. */
export async function copyShared(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createWriteStream(dest))
}
