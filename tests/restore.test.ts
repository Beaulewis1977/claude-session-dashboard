import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restoreIfMissing } from '../src/main/core/restore'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-restore-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('restoreIfMissing', () => {
  it('copies the archive back to its original path, creating folders', async () => {
    const archive = join(dir, 'archive', 's.jsonl')
    await mkdir(join(dir, 'archive'))
    await writeFile(archive, 'archived content')
    const original = join(dir, '.claude', 'projects', 'p', 's.jsonl')
    expect(await restoreIfMissing(archive, original)).toBe('restored')
    expect(await readFile(original, 'utf8')).toBe('archived content')
  })

  it('never overwrites an existing file', async () => {
    const archive = join(dir, 'a.jsonl')
    const original = join(dir, 'o.jsonl')
    await writeFile(archive, 'OLD ARCHIVE')
    await writeFile(original, 'LIVE FILE')
    const before = await stat(original)
    expect(await restoreIfMissing(archive, original)).toBe('already-exists')
    expect(await readFile(original, 'utf8')).toBe('LIVE FILE')
    expect((await stat(original)).mtimeMs).toBe(before.mtimeMs)
  })

  it('never overwrites an empty existing file either', async () => {
    const archive = join(dir, 'a.jsonl')
    const original = join(dir, 'o.jsonl')
    await writeFile(archive, 'data')
    await writeFile(original, '')
    expect(await restoreIfMissing(archive, original)).toBe('already-exists')
    expect(await readFile(original, 'utf8')).toBe('')
  })

  it('reports a missing archive copy and creates nothing', async () => {
    const original = join(dir, 'p', 'o.jsonl')
    expect(await restoreIfMissing(join(dir, 'nope.jsonl'), original)).toBe('archive-missing')
    await expect(stat(join(dir, 'p'))).rejects.toThrow()
  })
})
