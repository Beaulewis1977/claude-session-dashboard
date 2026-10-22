import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  archivePathFor,
  archiveSession,
  archiveStats,
  shouldArchive
} from '../src/main/core/archive'
import { assertAppDataWrite, assertUserWrite, isInsideClaudeDir } from '../src/main/core/safe-paths'
import { JsonStore } from '../src/main/core/json-store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-archive-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('archiveSession', () => {
  it('copies, re-copies when the source grows, and keeps the larger copy when it shrinks', async () => {
    const appData = join(dir, 'appdata')
    const archiveDir = join(appData, 'archive')
    const src = join(dir, '.claude', 'projects', 'p', 's1.jsonl')
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(dir, '.claude', 'projects', 'p'), { recursive: true })
    )
    await writeFile(src, 'line1\n')
    const input = {
      sessionId: 's1',
      sourceId: 'windows',
      sourceLabel: 'Windows',
      env: 'windows' as const,
      originalPath: src,
      cwd: 'C:\\x'
    }

    const r1 = await archiveSession(input, undefined, archiveDir, appData)
    expect(r1).toBeDefined()
    expect(r1!.archivePath).toBe(archivePathFor(archiveDir, 'windows', 's1'))
    expect(r1!.size).toBe(6)
    expect(r1!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(r1!.archivePath, 'utf8')).toBe('line1\n')

    expect(await archiveSession(input, r1, archiveDir, appData)).toBeUndefined()

    await appendFile(src, 'line2\n')
    const r2 = await archiveSession(input, r1, archiveDir, appData)
    expect(r2!.size).toBe(12)
    expect(r2!.firstArchivedAt).toBe(r1!.firstArchivedAt)
    expect(await readFile(r2!.archivePath, 'utf8')).toBe('line1\nline2\n')

    await writeFile(src, 'x\n')
    expect(await archiveSession(input, r2, archiveDir, appData)).toBeUndefined()
    expect(await readFile(r2!.archivePath, 'utf8')).toBe('line1\nline2\n')

    // The source file itself is never touched.
    expect(await readFile(src, 'utf8')).toBe('x\n')
    expect(await archiveStats(archiveDir)).toEqual({ files: 1, bytes: 12 })
  })

  it('shouldArchive rules', () => {
    const rec = { size: 10 } as Parameters<typeof shouldArchive>[0]
    expect(shouldArchive(undefined, 5, false)).toBe('copy')
    expect(shouldArchive(rec, 10, false)).toBe('copy')
    expect(shouldArchive(rec, 11, true)).toBe('copy')
    expect(shouldArchive(rec, 10, true)).toBe('skip')
    expect(shouldArchive(rec, 3, true)).toBe('skip')
  })
})

describe('write guards', () => {
  it('detects .claude folders on both separators', () => {
    expect(isInsideClaudeDir('/home/me/.claude/projects/x.jsonl')).toBe(true)
    expect(isInsideClaudeDir('/home/me/.Claude/x')).toBe(true)
    expect(isInsideClaudeDir('/home/me/claude/x')).toBe(false)
  })

  it('only allows app data writes inside the app folder', () => {
    expect(() => assertAppDataWrite('/data/app/metadata.json', '/data/app')).not.toThrow()
    expect(() => assertAppDataWrite('/data/other.json', '/data/app')).toThrow()
    expect(() => assertAppDataWrite('/data/app/../app2/x', '/data/app')).toThrow()
    expect(() => assertAppDataWrite('/data/app/.claude/x', '/data/app')).toThrow()
    expect(() => assertUserWrite('/home/me/.claude/notes.md')).toThrow()
    expect(() => assertUserWrite('/home/me/notes.md')).not.toThrow()
  })
})

describe('JsonStore', () => {
  it('writes atomically and reloads', async () => {
    const path = join(dir, 'meta.json')
    const store = new JsonStore<{ n: number; list: string[] }>(path, dir, () => ({
      n: 0,
      list: []
    }))
    await store.load()
    store.update((d) => {
      d.n = 5
      d.list.push('a')
    })
    await store.flush()
    const again = new JsonStore<{ n: number; list: string[] }>(path, dir, () => ({
      n: 0,
      list: []
    }))
    expect(await again.load()).toEqual({ n: 5, list: ['a'] })
  })

  it('keeps a corrupt file aside and starts fresh', async () => {
    const path = join(dir, 'meta.json')
    await writeFile(path, '{ broken')
    const store = new JsonStore<{ n: number }>(path, dir, () => ({ n: 1 }))
    expect(await store.load()).toEqual({ n: 1 })
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).some((f) => f.startsWith('meta.json.corrupt-'))).toBe(true)
  })

  it('refuses to write outside the app folder', async () => {
    const store = new JsonStore<{ n: number }>(join(dir, '.claude', 'x.json'), dir, () => ({
      n: 1
    }))
    await expect(store.flush()).rejects.toThrow(/Refusing/)
  })
})
