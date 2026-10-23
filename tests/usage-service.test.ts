import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { parseCcusageDaily } from '../src/main/ipc-usage'
import { createFixturesPlatform } from '../src/main/platform'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { UsageService, usagePaths } from '../src/main/services/usage'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import { FIXTURES, line } from './helpers'

let root: string
/** Services with background work (archive copies, usage files) to finish before cleanup. */
let busy: { idle(): Promise<void> }[] = []

async function setup(usageHistory = false) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { usageHistory })
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(platform, paths, metadata, settings)
  busy.push(sessions)
  await sessions.start()
  await sessions.idle()
  const make = () => {
    const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
      weekStart: 'monday',
      prices: DEFAULT_PRICES
    }))
    busy.push(usage)
    return usage
  }
  return { sessions, layout, paths, make }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-usage-'))
})
afterEach(async () => {
  // fileChanged() queues an archive copy in the background: let it finish
  // before the folder goes, or Windows can refuse to remove it (ENOTEMPTY).
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('UsageService', () => {
  it('parses every session once, persists monthly files and reloads them', async () => {
    const { make, paths } = await setup()
    const usage = make()
    await usage.start()
    await usage.idle()
    const count = usage.allRecords().length
    expect(count).toBeGreaterThan(20)
    const files = await readdir(join(paths.dataDir, 'usage'))
    expect(files).toEqual(expect.arrayContaining(['index.json', 'records-2026-10.ndjson']))
    // The archived-only session from August is counted too.
    expect(
      usage.allRecords().some((r) => r.key === 'windows:9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b')
    ).toBe(true)

    const again = make()
    await again.start()
    expect(again.allRecords()).toHaveLength(count)
    expect(again.status().files).toBe(usage.status().files)
  })

  it('counts responses copied into a forked session only once', async () => {
    const { make, layout, sessions } = await setup()
    const usage = make()
    await usage.start()
    await usage.idle()
    const before = usage.allRecords().length
    const src = join(
      layout.sourcesDir,
      'windows/Users/beau/.claude/projects/C--Users-beau-code-acme-web/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl'
    )
    const fork = src.replace(
      '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
      '11111111-2222-4333-8444-555555555555'
    )
    await writeFile(fork, await readFile(src, 'utf8'))
    await sessions.fileChanged('windows', fork)
    await usage.sync()
    expect(usage.allRecords()).toHaveLength(before)
  })

  it('picks up new responses incrementally when a session grows', async () => {
    const { make, layout, sessions } = await setup()
    const usage = make()
    await usage.start()
    await usage.idle()
    const before = usage.allRecords().length
    const file = join(
      layout.sourcesDir,
      'wsl/Ubuntu/home/beau/.claude/projects/-home-beau-dotfiles/5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a.jsonl'
    )
    await appendFile(
      file,
      line({
        type: 'assistant',
        timestamp: '2026-10-22T15:00:00Z',
        requestId: 'req_new',
        message: {
          id: 'msg_new',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 1, output_tokens: 2 }
        }
      }) + '\n'
    )
    await sessions.fileChanged('wsl-Ubuntu-beau', file)
    await usage.sync()
    expect(usage.allRecords()).toHaveLength(before + 1)
    expect(
      usage.sessionUsage('wsl-Ubuntu-beau:5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a').responses
    ).toBeGreaterThan(1)
  })

  it('reads subagent transcripts next to the session and archives them', async () => {
    const { make, layout, paths } = await setup()
    const dir = join(
      layout.sourcesDir,
      'windows/Users/beau/.claude/projects/C--Users-beau-code-acme-web/7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d/subagents'
    )
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'agent-a1.jsonl'),
      line({
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-10-21T13:05:00Z',
        requestId: 'req_sub',
        message: {
          id: 'msg_sub',
          model: 'claude-haiku-5-5',
          usage: { input_tokens: 5, output_tokens: 7 }
        }
      }) + '\n'
    )
    const usage = make()
    await usage.start()
    await usage.idle()
    const sub = usage.allRecords().find((r) => r.id === 'msg_sub:req_sub')
    expect(sub?.key).toBe('windows:7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d')
    const copy = join(
      paths.archiveDir,
      'windows',
      '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
      'subagents',
      'agent-a1.jsonl'
    )
    expect(await readFile(copy, 'utf8')).toContain('msg_sub')
  })

  it('recalculates from scratch', async () => {
    const { make } = await setup()
    const usage = make()
    await usage.start()
    const n = usage.allRecords().length
    await usage.recalculate()
    expect(usage.allRecords()).toHaveLength(n)
  })

  it('replaces records from an older parser session by session, keeping orphans', async () => {
    const { make, paths } = await setup()
    const usage = make()
    await usage.start()
    await usage.idle()
    const n = usage.allRecords().length
    const live = usage.allRecords()[0]
    const dir = join(paths.dataDir, 'usage')
    const idx = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
    await writeFile(join(dir, 'index.json'), JSON.stringify({ ...idx, version: 1 }))
    const old = (id: string, key: string) =>
      JSON.stringify({ ...live, id, key, mid: undefined, sid: undefined, aka: undefined })
    // An old-style id for a session that still exists, and one whose file is gone.
    await appendFile(
      join(dir, 'records-2026-10.ndjson'),
      `${old('msg_old_style', live.key)}\n${old('msg_orphan', 'windows:gone')}\n`
    )
    const again = make()
    await again.start()
    await again.idle()
    const ids = again.allRecords().map((r) => r.id)
    expect(ids).not.toContain('msg_old_style')
    expect(ids).toContain('msg_orphan')
    expect(ids).toHaveLength(n + 1)
  })

  it('loads the generated usage history for fixtures mode', async () => {
    const { make } = await setup(true)
    const usage = make()
    await usage.start()
    const r = usage.report({ period: 'week' })
    expect(r.models).toEqual(
      expect.arrayContaining(['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])
    )
    expect(r.series.length).toBeGreaterThanOrEqual(13)
    expect(usage.limitHits().length).toBeGreaterThan(0)
    expect(usage.allTurns().length).toBeGreaterThan(300)
  })
})

describe('ccusage comparison', () => {
  it('reads `ccusage daily --json` output', () => {
    const m = parseCcusageDaily(
      JSON.stringify({
        daily: [
          { date: '2026-10-21', totalTokens: 1200 },
          {
            date: '2026-10-22',
            inputTokens: 1,
            outputTokens: 2,
            cacheCreationTokens: 3,
            cacheReadTokens: 4
          }
        ]
      })
    )
    expect([...m]).toEqual([
      ['2026-10-21', 1200],
      ['2026-10-22', 10]
    ])
  })
})
