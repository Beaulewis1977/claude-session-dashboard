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
