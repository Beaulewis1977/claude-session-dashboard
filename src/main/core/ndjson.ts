// Newline-delimited JSON files in the app's data folder: one JSON value per
// line, read defensively and written atomically (or appended).

import { appendFile, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from './json-store'
import { assertAppDataWrite, assertRealAppDataWrite } from './safe-paths'

export async function readNdjson<T>(path: string): Promise<T[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) continue
    try {
      out.push(JSON.parse(l) as T)
    } catch {
      // A torn last line (e.g. power loss during an append) is skipped.
    }
  }
  return out
}

export async function writeNdjson(
  path: string,
  rows: unknown[],
  appDataDir: string
): Promise<void> {
  const body = rows.map((r) => JSON.stringify(r)).join('\n')
  await writeFileAtomic(path, body ? body + '\n' : '', appDataDir)
}

export async function appendNdjson(
  path: string,
  rows: unknown[],
  appDataDir: string
): Promise<void> {
  if (!rows.length) return
  assertAppDataWrite(path, appDataDir)
  await assertRealAppDataWrite(path, appDataDir)
  await mkdir(dirname(path), { recursive: true })
  // A torn last line (power loss mid-append) would swallow the first new row:
  // end it first, so only the torn line is lost when the file is read.
  const lead = (await endsWithNewline(path)) ? '' : '\n'
  await appendFile(path, lead + rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

/** True for a missing or empty file, or one whose last byte is a newline. */
async function endsWithNewline(path: string): Promise<boolean> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return true
  }
  try {
    const { size } = await fh.stat()
    if (size === 0) return true
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    await fh.close()
  }
}

/** Files in `dir` whose names match `re`, sorted. */
export async function listFiles(dir: string, re: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => re.test(f)).sort()
  } catch {
    return []
  }
}
