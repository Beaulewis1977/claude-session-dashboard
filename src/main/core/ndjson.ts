// Newline-delimited JSON files in the app's data folder: one JSON value per
// line, read defensively and written atomically (or appended).

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
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
  await mkdir(dirname(path), { recursive: true })
  await assertRealAppDataWrite(path, appDataDir)
  await appendFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

/** Files in `dir` whose names match `re`, sorted. */
export async function listFiles(dir: string, re: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => re.test(f)).sort()
  } catch {
    return []
  }
}
