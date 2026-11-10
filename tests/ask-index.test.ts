// Ask across sessions (roadmap #7): the index. Ranking, filters, incremental
// updates, the size budget, saving and loading, and that only session files
// are ever opened (never credentials).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decodePostings,
  encodePostings,
  INDEX_FILE,
  IndexCore,
  type IndexJob
} from '../src/main/ask-sessions/core'
import { assertSessionFile, readSessionMessages } from '../src/main/ask-sessions/read'
import { aboutPassage } from '../src/shared/ask-sessions/chunk'

let dir: string
let files: Map<string, string>
let reads: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-ask-'))
  files = new Map()
  reads = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const line = (o: unknown): string => JSON.stringify(o)

/** A Claude Code session file: alternating prompts and answers. */
function session(turns: [string, string][], start = '2026-10-14T15:00:00Z'): string {
  const t0 = Date.parse(start)
  return turns
    .flatMap(([q, a], i) => [
      line({
        type: 'user',
        uuid: `u${i}`,
        timestamp: new Date(t0 + i * 120_000).toISOString(),
        message: { role: 'user', content: q }
      }),
      line({
        type: 'assistant',
        uuid: `a${i}`,
        timestamp: new Date(t0 + i * 120_000 + 60_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: a }]
        }
      })
    ])
    .join('\n')
}

function job(key: string, text: string, p: Partial<IndexJob> = {}): IndexJob {
  const path = `C:\\Users\\alex\\.claude\\projects\\p\\${key}.jsonl`
  files.set(path, text)
  return {
    key,
    order: p.order ?? Date.parse('2026-10-14T16:00:00Z'),
    start: p.start ?? Date.parse('2026-10-14T15:00:00Z'),
    content: { path, provider: 'claude', rev: `${text.length}` },
    meta: p.meta ?? {
      rev: key,
      passages: [aboutPassage({ title: `Session ${key}`, project: 'acme' })]
    },
    ...p
  }
}

function core(over: Partial<ConstructorParameters<typeof IndexCore>[0]> = {}): IndexCore {
  return new IndexCore({
    dir,
    minReindexMs: 0,
    saveDelayMs: 60_000,
    yieldNow: async () => undefined,
    read: {
      readText: async (p) => {
        reads.push(p)
        const t = files.get(p)
        if (t === undefined) throw new Error('missing')
        return t
      }
    },
    ...over
  })
}

async function built(c: IndexCore, jobs: IndexJob[], budget?: number): Promise<IndexCore> {
  await c.load()
  c.sync(jobs, budget)
  await c.idle()
  return c
}

const search = (
  c: IndexCore,
  query: string,
  more: Partial<Parameters<IndexCore['search']>[0]> = {}
) => c.search({ query, limit: 20, perSession: 4, ...more })

describe('ranking', () => {
  it('finds the passage with the rarer, more specific words first', async () => {
    const c = await built(core(), [
      job('s1', session([['the build is slow', 'Caching node_modules fixed the slow build.']])),
      job(
        's2',
        session([
          ['fix the WSL path bug', 'The wslpath mapping was applied twice; fixed in wsl.ts.']
        ])
      ),
      job('s3', session([['write docs', 'Docs about the path of the build output.']]))
    ])
    const r = search(c, 'where did I fix the WSL path bug')
    expect(r.hits[0].key).toBe('s2')
    expect(r.hits[0].msgIds).toEqual(['u0', 'a0'])
    expect(r.hits[0].text).toContain('wsl.ts')
    expect(r.matched).toBeGreaterThanOrEqual(2)
  })

  it('finds a file by its name', async () => {
    const c = await built(core(), [
      job('a', session([['edit bridge.ts', 'Changed src/main/services/bridge.ts']])),
      job('b', session([['the bridge over the river', 'A bridge is a structure.']]))
    ])
    expect(search(c, 'bridge.ts')!.hits[0].key).toBe('a')
  })

  it('filters by session and by date; at most N per session; neighbours merged into one snippet', async () => {
    const turns: [string, string][] = Array.from({ length: 6 }, (_, i) => [
      `cookie question ${i}`,
      `cookie answer ${i} ${'x '.repeat(400)}`
    ])
    const c = await built(core(), [
      job('big', session(turns)),
      job('other', session([['cookie?', 'cookie answer']], '2026-09-01T10:00:00Z'))
    ])
    expect(search(c, 'cookie', { allowed: ['other'] }).hits.every((h) => h.key === 'other')).toBe(
      true
    )
    const sept = search(c, 'cookie', {
      from: Date.parse('2026-09-01T00:00:00Z'),
      to: Date.parse('2026-09-02T00:00:00Z')
    })
    expect(sept.hits.map((h) => h.key)).toEqual(['other'])
    const capped = search(c, 'cookie', { perSession: 2, allowed: ['big'] })
    expect(capped.hits.length).toBeLessThanOrEqual(2)
    expect(capped.hits.some((h) => h.msgIds.length > 2)).toBe(true)
  })

  it("a fork's copy of its parent's passage is returned once, from the older session", async () => {
    const text = session([['unique zebrafish question', 'unique zebrafish answer']])
    const c = await built(core(), [
      job('fork', text, { start: Date.parse('2026-10-20T00:00:00Z') }),
      job('parent', text, { start: Date.parse('2026-10-01T00:00:00Z') })
    ])
    const r = search(c, 'zebrafish')
    expect(r.hits.filter((h) => h.kind === 'turn').map((h) => h.key)).toEqual(['parent'])
  })
})

describe('incremental updates', () => {
  it('reads only what changed; meta changes need no read; removed sessions leave', async () => {
    const c = await built(core(), [
      job('a', session([['alpha', 'one']])),
      job('b', session([['beta', 'two']]))
    ])
    expect(reads).toHaveLength(2)
    reads = []
    c.sync([job('a', session([['alpha', 'one']])), job('b', session([['beta', 'two']]))])
    await c.idle()
    expect(reads).toEqual([])
    // A new name: no file read, and it's found by it.
    c.sync([
      job('a', session([['alpha', 'one']]), {
        meta: { rev: 'a2', passages: [aboutPassage({ title: 'Renamed kiwi' })] }
      }),
      job(
        'b',
        session([
          ['beta', 'two'],
          ['gamma', 'three']
        ])
      )
    ])
    await c.idle()
    expect(reads).toHaveLength(1)
    expect(search(c, 'kiwi').hits[0]).toMatchObject({ key: 'a', kind: 'about' })
    expect(search(c, 'gamma').hits[0].key).toBe('b')
    c.sync([
      job(
        'b',
        session([
          ['beta', 'two'],
          ['gamma', 'three']
        ])
      )
    ])
    await c.idle()
    expect(search(c, 'alpha').hits).toEqual([])
    expect(c.status().sessions).toBe(1)
  })

  it('keeps what was indexed when a file can no longer be read', async () => {
    const c = await built(core(), [job('a', session([['durian', 'fruit']]))])
    const gone = job(
      'a',
      session([
        ['durian', 'fruit'],
        ['more', 'text']
      ])
    )
    files.delete(gone.content!.path)
    c.sync([gone])
    await c.idle()
    expect(search(c, 'durian').hits).toHaveLength(1)
  })

  it('reads a growing session again at most every minReindexMs', async () => {
    let t = Date.parse('2026-11-10T12:00:00Z')
    const c = await built(core({ minReindexMs: 30_000, now: () => t }), [
      job('live', session([['first', 'answer']]))
    ])
    reads = []
    t += 1000
    c.sync([
      job(
        'live',
        session([
          ['first', 'answer'],
          ['second', 'answer']
        ])
      )
    ])
    await c.idle()
    expect(reads).toEqual([])
    expect(search(c, 'second').hits).toEqual([])
    await c.stop()
  })
})

describe('size budget', () => {
  it('leaves the oldest sessions out past the budget, and says since when', async () => {
    const big = (w: string): string => session([[w, `${w} `.repeat(300)]])
    const c = await built(
      core(),
      [
        job('old', big('ancient'), { order: Date.parse('2026-01-01T00:00:00Z') }),
        job('mid', big('middle'), { order: Date.parse('2026-06-01T00:00:00Z') }),
        job('new', big('recent'), { order: Date.parse('2026-11-01T00:00:00Z') })
      ],
      4500
    )
    expect(search(c, 'recent').hits).toHaveLength(1)
    expect(search(c, 'ancient').hits).toEqual([])
    const st = c.status()
    expect(st.skipped).toBeGreaterThanOrEqual(1)
    expect(st.since).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'))
    expect(st.chars).toBeLessThanOrEqual(4500)
  })
})

describe('saving', () => {
  it('saves through a temp file and loads back the same answers without reading sessions again', async () => {
    const a = await built(core(), [
      job('a', session([['papaya question', 'papaya answer']])),
      job('b', session([['mango', 'x']]))
    ])
    await a.save()
    const saved = JSON.parse(await readFile(join(dir, INDEX_FILE), 'utf8')) as { v: number }
    expect(saved.v).toBe(1)
    reads = []
    const b = core()
    await b.load()
    expect(search(b, 'papaya').hits[0].key).toBe('a')
    b.sync([
      job('a', session([['papaya question', 'papaya answer']])),
      job('b', session([['mango', 'x']]))
    ])
    await b.idle()
    expect(reads).toEqual([])
    expect(b.status().passages).toBe(a.status().passages)
  })

  it('ignores a damaged or older saved index (and builds again)', async () => {
    await writeFile(join(dir, INDEX_FILE), '{"v":0}')
    const c = await built(core(), [job('a', session([['lychee', 'x']]))])
    expect(search(c, 'lychee').hits).toHaveLength(1)
    await writeFile(join(dir, INDEX_FILE), 'not json')
    const d = core()
    await d.load()
    expect(d.status().passages).toBe(0)
  })

  it('postings round-trip through their encoding', () => {
    const p = [0, 1, 5, 3, 130, 1, 20_000, 7, 3_000_000, 2]
    expect(decodePostings(encodePostings(p))).toEqual(p)
  })

  it('clear() deletes only its own saved index', async () => {
    const c = await built(core(), [job('a', session([['x', 'y']]))])
    await c.save()
    await writeFile(join(dir, 'other.json'), '{}')
    await c.clear()
    await expect(readFile(join(dir, INDEX_FILE))).rejects.toThrow()
    await expect(readFile(join(dir, 'other.json'), 'utf8')).resolves.toBe('{}')
  })
})

describe('only session files are opened', () => {
  it.each([
    'C:\\Users\\alex\\.claude\\.credentials.json',
    'C:\\Users\\alex\\.codex\\auth.json',
    'C:\\Users\\alex\\AppData\\Roaming\\Claude\\local-agent-mode-sessions\\x\\.claude\\.credentials.json',
    '/home/alex/.ssh/id_ed25519.pem',
    '/home/alex/tokens.jsonl',
    '/home/alex/secret-notes.jsonl',
    'C:\\x\\..\\..\\Windows\\win.ini',
    '/home/alex/.claude/projects/p/notes.txt',
    ''
  ])('refuses %s before touching it', async (path) => {
    expect(() => assertSessionFile(path)).toThrow('Not a session file')
    const opened: string[] = []
    await expect(
      readSessionMessages(
        { path, provider: path.includes('codex') ? 'codex' : 'claude' },
        {
          readText: async (p) => (opened.push(p), ''),
          readCodex: async (p) => (opened.push(p), ''),
          cachedCodex: async (p) => (opened.push(p), undefined)
        }
      )
    ).rejects.toThrow()
    expect(opened).toEqual([])
  })

  it('reads Claude Code sessions and Codex rollouts', async () => {
    expect(() =>
      assertSessionFile(
        'C:\\Users\\alex\\.claude\\projects\\p\\7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl'
      )
    ).not.toThrow()
    expect(() =>
      assertSessionFile(
        '\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\sessions\\2026\\10\\01\\rollout-2026-10-01T10-00-00-01a0.jsonl.zst'
      )
    ).not.toThrow()
    // Any case, as the session scan accepts it on Windows; credential shapes still refused.
    expect(() => assertSessionFile('C:\\Users\\alex\\.claude\\projects\\p\\S.JSONL')).not.toThrow()
    expect(() =>
      assertSessionFile('C:\\Users\\alex\\.codex\\sessions\\rollout-2026-x.Jsonl.ZST')
    ).not.toThrow()
    expect(() => assertSessionFile('C:\\Users\\alex\\.claude\\TOKENS.JSONL')).toThrow()
    expect(() => assertSessionFile('C:\\Users\\alex\\.codex\\AUTH.JSON')).toThrow()
    const msgs = await readSessionMessages(
      { path: 'C:\\p\\s.jsonl', provider: 'claude' },
      { readText: async () => session([['hello', 'world']]) }
    )
    expect(msgs.map((m) => m.id)).toEqual(['u0', 'a0'])
  })
})
