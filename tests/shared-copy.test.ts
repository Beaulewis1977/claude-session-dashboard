import { randomBytes } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyShared } from '../src/main/core/shared-copy'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-copy-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('copyShared', () => {
  it('copies byte for byte and replaces the destination', async () => {
    const src = join(dir, 'session.jsonl')
    const dest = join(dir, 'copy.jsonl')
    const data = Buffer.concat([randomBytes(3 * 1024 * 1024), Buffer.from('\n{"é":"✓"}\n')])
    await writeFile(src, data)
    await writeFile(dest, 'old')
    await copyShared(src, dest)
    expect((await readFile(dest)).equals(data)).toBe(true)
  })

  it('lets Claude Code keep appending to the file while it is being copied', async () => {
    const src = join(dir, 'session.jsonl')
    await writeFile(src, Buffer.alloc(8 * 1024 * 1024, 'a'))
    const copying = copyShared(src, join(dir, 'copy.jsonl'))
    // A writer during the copy must succeed (on Windows, fs.copyFile would refuse it).
    await appendFile(src, '{"type":"user"}\n')
    await copying
    expect((await readFile(src, 'utf8')).endsWith('{"type":"user"}\n')).toBe(true)
  })
})
