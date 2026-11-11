// The usage parser (a worker thread in the app) gives exactly what the
// providers' own reading and parsing give, and parses in this thread when the
// worker can't run.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJsonl } from '@shared/jsonl'
import { analyzeUsage } from '@shared/usage/parse'
import { analyzeCodexUsage } from '../src/main/providers/codex/usage'
import { readCodexUsageText } from '../src/main/providers/codex/read'
import { InProcessParser, WorkerParser, type UsageParseJob } from '../src/main/services/usage-parse'
import { FIXTURES } from './helpers'

async function files(dir: string, re: RegExp): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile() && re.test(e.name)) out.push(join(e.parentPath, e.name))
  return out.sort()
}

const ctx = (path: string) => ({
  key: `windows:${path.split(/[\\/]/).pop()}`,
  project: 'acme-web',
  env: 'windows' as const,
  file: path.split(/[\\/]/).pop(),
  lineageRoot: 'root',
  source: 'codex-windows'
})

describe('usage parser', () => {
  it('parses Claude Code transcripts and Codex rollouts as the providers do', async () => {
    const parser = new InProcessParser()
    const claude = await files(join(FIXTURES, 'windows'), /\.jsonl$/)
    const codex = await files(join(FIXTURES, 'codex'), /^rollout-.*\.jsonl(\.zst)?$/)
    expect(claude.length).toBeGreaterThan(3)
    expect(codex.length).toBeGreaterThan(3)
    for (const path of claude) {
      const want = analyzeUsage(parseJsonl(await readFile(path, 'utf8')).events, ctx(path))
      expect(await parser.parse({ provider: 'claude', path, ctx: ctx(path) })).toEqual(want)
    }
    for (const path of codex) {
      const want = analyzeCodexUsage(await readCodexUsageText(path), ctx(path))
      expect(await parser.parse({ provider: 'codex', path, ctx: ctx(path) })).toEqual(want)
    }
  })

  it('says undefined for a file it cannot read (tried again later)', async () => {
    const parser = new InProcessParser()
    const job: UsageParseJob = {
      provider: 'claude',
      path: join(FIXTURES, 'nope.jsonl'),
      ctx: ctx('x')
    }
    expect(await parser.parse(job)).toBeUndefined()
    expect(await parser.parse({ ...job, provider: 'codex' })).toBeUndefined()
  })

  it('parses in this thread when its worker cannot start', async () => {
    const parser = new WorkerParser(join(FIXTURES, 'no-such-worker.js'))
    const path = (await files(join(FIXTURES, 'windows'), /\.jsonl$/))[0]
    const want = analyzeUsage(parseJsonl(await readFile(path, 'utf8')).events, ctx(path))
    expect(await parser.parse({ provider: 'claude', path, ctx: ctx(path) })).toEqual(want)
    // Later files too.
    expect(await parser.parse({ provider: 'claude', path, ctx: ctx(path) })).toEqual(want)
    await parser.stop()
  })
})

describe('usage parser thread', () => {
  it('starts when there is a file, ends when idle, and starts again', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'csd-parser-'))
    try {
      // A stand-in thread that answers every job with an empty analysis.
      const path = join(dir, 'worker.mjs')
      await writeFile(
        path,
        "import { parentPort } from 'node:worker_threads'\n" +
          "parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, ok: true, value: { records: [], turns: [], limitHits: [], usageReadings: [], file: m.job.path } }))\n"
      )
      const parser = new WorkerParser(path, 128, 50)
      const job: UsageParseJob = { provider: 'claude', path: 'a.jsonl', ctx: ctx('a') }
      expect(parser.running).toBe(false)
      expect(await parser.parse(job)).toMatchObject({ file: 'a.jsonl' })
      expect(parser.running).toBe(true)
      await expect.poll(() => parser.running, { timeout: 3000 }).toBe(false)
      expect(await parser.parse({ ...job, path: 'b.jsonl' })).toMatchObject({ file: 'b.jsonl' })
      await parser.stop()
      expect(parser.running).toBe(false)

      // After a scan (rest), it goes after the short wait, not the idle one.
      const scan = new WorkerParser(path, 128, 60_000, 50)
      expect(await scan.parse(job)).toMatchObject({ file: 'a.jsonl' })
      expect(scan.running).toBe(true)
      scan.rest()
      await expect.poll(() => scan.running, { timeout: 3000 }).toBe(false)
      // A file asked for before it went keeps it.
      expect(await scan.parse(job)).toMatchObject({ file: 'a.jsonl' })
      scan.rest()
      const p = scan.parse({ ...job, path: 'c.jsonl' })
      expect(await p).toMatchObject({ file: 'c.jsonl' })
      await scan.stop()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
