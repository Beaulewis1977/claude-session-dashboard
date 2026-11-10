// Codex sessions (feature 5, Phase B): reading plain and zstd rollouts,
// parsing, thread names, metadata keys, archiving, launching, the provider
// switch and the provider on/off toggle. Runs on the sample Codex homes in
// fixtures/codex/ (scripts/make-codex-fixtures.mjs).

import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  effectiveView,
  enabledProviders,
  inProviderView,
  metaKey,
  metaKeyOf,
  sanitizeProviderToggles
} from '@shared/provider'
import { CODEX_EFFORT_LEVELS, codexModelArgs, resolveModelChoice } from '@shared/model-choice'
import type { SessionSummary } from '@shared/types'
import { createFixturesPlatform } from '../src/main/platform'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { SessionService } from '../src/main/services/sessions'
import { Launcher } from '../src/main/services/launcher'
import { ProviderRegistry } from '../src/main/providers/registry'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import {
  analyzeCodex,
  buildCodexMessages,
  patchFiles,
  rolloutIdOf
} from '../src/main/providers/codex/parse'
import {
  compactLine,
  CONTEXT_KEEP,
  isCredentialPath,
  readBytesOf,
  readCodexText
} from '../src/main/providers/codex/read'
import { CompactTextCache } from '../src/main/providers/codex/text-cache'
import { CodexNames, codexHomeIn, parseNameIndex } from '../src/main/providers/codex/sessions'
import { buildCodexLaunch, codexArgs } from '../src/main/providers/codex/launch'
import { detectCodexSource } from '../src/main/providers/codex/source'
import { remoteLaunchOptions } from '../src/main/mobile/remote-launch'
import { archiveGrowth, archiveSession } from '../src/main/core/archive'
import { applyPendingRestore, planRestore } from '../src/main/core/backup-restore'
import { mergeOnRestore } from '../src/main/core/backup-files'
import { zstdContentSize } from '../src/main/core/zstd'
import {
  isLinuxPath,
  isWindowsPath,
  mntToWindows,
  parseDefaultDistro,
  windowsPathToWsl
} from '../src/main/core/wsl'
import {
  AGENT_ENV_CHARS_REASON,
  CMD_FOLDER_REASON,
  WT_UNC_REASON,
  type LaunchTools
} from '../src/main/core/launch'

const FIXTURES = join(__dirname, '..', 'fixtures')
const CODEX = join(FIXTURES, 'codex', 'windows', 'Users', 'alex', '.codex')
const ID = {
  cli: '019a1111-0000-7000-8000-000000000001',
  desktop: '019a2222-0000-7000-8000-000000000002',
  sub: '019a3333-0000-7000-8000-000000000003',
  fork: '019a4444-0000-7000-8000-000000000004',
  old: '019a5555-0000-7000-8000-000000000005',
  gap: '019a6666-0000-7000-8000-000000000006',
  wsl: '019a7777-0000-7000-8000-000000000007',
  now: '019a8888-0000-7000-8000-000000000008'
}
const CLI_FILE = join(
  CODEX,
  'sessions',
  '2026',
  '10',
  '20',
  `rollout-2026-10-20T09-15-00-${ID.cli}.jsonl`
)
const DESKTOP_FILE = join(
  CODEX,
  'sessions',
  '2026',
  '10',
  '18',
  `rollout-2026-10-18T14-02-11-${ID.desktop}.jsonl.zst`
)

let root: string
const busy: SessionService[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-'))
})
afterEach(async () => {
  try {
    for (const s of busy.splice(0)) await s.idle()
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

async function setup(
  opts: { codexArchive?: 'off' | 'marked' | 'all'; providers?: ProviderRegistry } = {}
) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: true })
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  if (opts.codexArchive)
    settings.update((s) => {
      s.codexArchive = opts.codexArchive
    })
  await seedFixtureData(root, paths.archiveDir, metadata)
  const providers = opts.providers ?? new ProviderRegistry([claudeProvider, createCodexProvider()])
  const sessions = new SessionService(platform, paths, metadata, settings, providers)
  busy.push(sessions)
  const launcher = new Launcher(
    platform,
    sessions,
    () => 'wt',
    undefined,
    () => settings.value,
    paths.dataDir
  )
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, paths, metadata, settings, providers, layout }
}

const codexOf = (list: SessionSummary[], id: string): SessionSummary =>
  list.find((s) => s.provider === 'codex' && s.sessionId === id)!

// ---------------------------------------------------------------- reading

describe('reading rollouts', () => {
  it('reads plain and zstd-compressed rollouts the same way', async () => {
    const plain = analyzeCodex(await readCodexText(CLI_FILE), ID.cli)
    expect(plain.sessionId).toBe(ID.cli)
    const zst = analyzeCodex(await readCodexText(DESKTOP_FILE), ID.desktop)
    expect(zst.sessionId).toBe(ID.desktop)
    expect(zst.cwd).toBe('C:\\Users\\alex\\code\\marketing-site')
    expect(zst.firstPrompt).toBe('Add a dark mode toggle to the header.')
    // The same text, compressed by hand, reads the same.
    const text = await readFile(CLI_FILE)
    const copy = join(root, `rollout-2026-10-20T09-15-00-${ID.cli}.jsonl.zst`)
    await writeFile(copy, zstdCompressSync(text))
    const body = (t: string): string => t.slice(t.indexOf('\n'))
    expect(body(await readCodexText(copy))).toBe(body(await readCodexText(CLI_FILE)))
    expect(await readCodexText(copy)).toMatch(/^\{"type":"csd_read_note".*"compressed":true/)
  })

  it('drops what the viewer never shows (instructions, tool lists, duplicates)', () => {
    expect(compactLine('{"timestamp":"t","type":"world_state","payload":{"full":true}}')).toBe(
      undefined
    )
    expect(
      compactLine('{"type":"event_msg","payload":{"type":"item_completed","item":{}}}')
    ).toBeUndefined()
    expect(
      compactLine('{"type":"response_item","payload":{"type":"additional_tools","tools":[]}}')
    ).toBeUndefined()
    const meta = JSON.parse(
      compactLine(
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'x', base_instructions: { text: 'long' } }
        })
      )!
    )
    expect(meta.payload).toEqual({ id: 'x' })
    const reasoning = JSON.parse(
      compactLine(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'reasoning', summary: [{ text: 's' }], encrypted_content: 'zz' }
        })
      )!
    )
    expect(reasoning.payload.encrypted_content).toBeUndefined()
    // Not JSON: kept as it is (counted as malformed later).
    expect(compactLine('not json')).toBe('not json')
  })

  it('cuts very long tool output, and says when a huge file is only partly shown', async () => {
    const big = 'y'.repeat(200_000)
    const line = JSON.parse(
      compactLine(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'c', output: big }
        })
      )!
    )
    expect(line.payload.output.length).toBeLessThan(70_000)
    expect(line.payload.output).toMatch(/cut by the dashboard/)

    const lines = [
      JSON.stringify({
        timestamp: '2026-10-01T00:00:00Z',
        ordinal: 0,
        type: 'session_meta',
        payload: { id: ID.cli, cwd: '/x' }
      })
    ]
    for (let i = 1; i <= 400; i++)
      lines.push(
        JSON.stringify({
          timestamp: `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
          ordinal: i,
          type: 'response_item',
          payload: {
            type: 'message',
            role: i % 2 ? 'user' : 'assistant',
            content: [{ type: 'input_text', text: `message ${i} ${'z'.repeat(500)}` }]
          }
        })
      )
    const file = join(root, `rollout-2026-10-01T00-00-00-${ID.cli}.jsonl`)
    await writeFile(file, lines.join('\n'))
    const a = analyzeCodex(await readCodexText(file, 20_000), ID.cli)
    expect(a.historyNote).toMatch(/may be incomplete.*very large/)
    // For showing it, reading stops at the cut: the same start, without the rest.
    const partial = await readCodexText(file, 20_000, { partial: true })
    const full = await readCodexText(file, 20_000)
    expect(partial.length).toBeLessThan(full.length + 1)
    expect(buildCodexMessages(partial)[0]).toEqual(buildCodexMessages(full)[0])
    expect(analyzeCodex(partial).historyNote).toMatch(/very large/)
    // The last activity still comes from the end of the file.
    expect(a.lastActivityAt).toBe('2026-10-01T00:06:40.000Z')
    expect(analyzeCodex(await readCodexText(file), ID.cli).historyNote).toBeUndefined()
  })

  it("keeps big rollouts' compact text in the app's cache, per file version", async () => {
    const dataDir = join(root, 'appdata')
    const cache = new CompactTextCache(join(dataDir, 'cache', 'codex'), dataDir)
    expect(() => new CompactTextCache(join(root, 'elsewhere'), dataDir)).toThrow()
    const file = join(root, `rollout-2026-10-01T00-00-00-${ID.cli}.jsonl`)
    await writeFile(file, 'v1')
    expect(await cache.get(file)).toBeUndefined()
    const st1 = await stat(file)
    await cache.put(file, st1.size, st1.mtimeMs, 'compact v1')
    expect(await cache.get(file)).toBe('compact v1')
    // The file changed: the old text isn't used, and is replaced when the new one is kept.
    await writeFile(file, 'version two')
    expect(await cache.get(file)).toBeUndefined()
    const st2 = await stat(file)
    await cache.put(file, st2.size, st2.mtimeMs, 'compact v2')
    expect(await cache.get(file)).toBe('compact v2')
    expect(await readdir(join(dataDir, 'cache', 'codex'))).toHaveLength(1)
    expect(readBytesOf('{"type":"csd_read_note","bytes":123}\n{}')).toBe(123)
  })

  it('never reads a credential file, whatever path it is given', async () => {
    expect(isCredentialPath(join(CODEX, 'auth.json'))).toBe(true)
    expect(isCredentialPath('/home/alex/.codex/auth.json')).toBe(true)
    expect(isCredentialPath(CLI_FILE)).toBe(false)
    await expect(readCodexText(join(CODEX, 'auth.json'))).rejects.toThrow(/Not a session file/)
  })

  it('knows rollout file names', () => {
    expect(rolloutIdOf(`rollout-2026-10-20T09-15-00-${ID.cli}.jsonl`)).toBe(ID.cli)
    expect(rolloutIdOf(`rollout-2026-10-20T09-15-00-${ID.cli}.jsonl.zst`)).toBe(ID.cli)
    expect(rolloutIdOf('auth.json')).toBeUndefined()
    expect(rolloutIdOf(`${ID.cli}.jsonl`)).toBeUndefined()
  })
})

// ---------------------------------------------------------------- parsing

describe('parsing', () => {
  it('reads the summary: id, folder, model, effort, git, source', async () => {
    const a = analyzeCodex(await readCodexText(CLI_FILE), ID.cli)
    expect(a).toMatchObject({
      sessionId: ID.cli,
      cwd: 'C:\\Users\\alex\\code\\shop api',
      version: '0.164.0',
      gitBranch: 'fix/checkout-totals',
      gitCommit: 'a1b2c3d4e5f6',
      gitRemote: 'https://example.com/alex/shop-api.git',
      models: ['gpt-5.5-codex'],
      effort: 'high',
      origin: { originator: 'codex_cli_rs', source: 'cli', threadSource: 'user' },
      firstPrompt:
        'The checkout total is off by one cent when a coupon is applied. Find and fix it.',
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 3,
      malformedLines: 0,
      startedAt: '2026-10-20T14:15:00.000Z'
    })
    expect(a.historyNote).toBeUndefined()
    // Context Codex adds (environment, developer instructions) is never a prompt or searched.
    expect(a.searchText).not.toMatch(/environment_context|permissions instructions/)
    expect(a.searchText).toMatch(/coupon/)
    expect(a.searchText).toMatch(/npm test -- checkout/)
  })

  it('builds the conversation: reasoning, tool calls with their output, the answer', async () => {
    const msgs = buildCodexMessages(await readCodexText(CLI_FILE))
    expect(msgs.map((m) => `${m.role}:${m.kind}`)).toEqual(['user:prompt', 'assistant:response'])
    const blocks = msgs[1].blocks
    expect(blocks.map((b) => b.type)).toEqual([
      'thinking',
      'tool_use',
      'thinking',
      'tool_use',
      'tool_use',
      'text'
    ])
    const [, test1, , edit, test2] = blocks as Extract<
      (typeof blocks)[number],
      { type: 'tool_use' }
    >[]
    expect(test1.label).toBe('shell_command: npm test -- checkout')
    expect(test1.result).toMatchObject({ isError: true })
    expect(test1.result?.text).toMatch(/FAIL/)
    expect(edit.name).toBe('apply_patch')
    expect(edit.label).toBe('apply_patch src/checkout/total.ts')
    expect(edit.result?.text).toMatch(/Success/)
    expect(test2.result).toMatchObject({ isError: false })
    expect(msgs[1].model).toBe('gpt-5.5-codex')
  })

  it("reads the older format (event_msg messages, no ordinals) and Codex's archive", async () => {
    const file = join(CODEX, 'archived_sessions', `rollout-2026-09-30T10-00-00-${ID.old}.jsonl.zst`)
    const text = await readCodexText(file)
    const a = analyzeCodex(text, ID.old)
    expect(a).toMatchObject({ models: ['gpt-5-codex'], effort: 'medium', userMessageCount: 1 })
    expect(a.historyNote).toBeUndefined()
    expect(buildCodexMessages(text).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('notes a history with gaps, and counts malformed lines', async () => {
    const file = join(
      CODEX,
      'sessions',
      '2026',
      '10',
      '15',
      `rollout-2026-10-15T11-11-11-${ID.gap}.jsonl`
    )
    const a = analyzeCodex(await readCodexText(file), ID.gap)
    expect(a.malformedLines).toBe(1)
    expect(a.historyNote).toMatch(/may be incomplete: the file skips entries in 1 place/)
  })

  it('reads subagents and forks', async () => {
    const sub = analyzeCodex(
      await readCodexText(
        join(CODEX, 'sessions', '2026', '10', '20', `rollout-2026-10-20T09-20-30-${ID.sub}.jsonl`)
      ),
      ID.sub
    )
    expect(sub.subagent).toEqual({ parentId: ID.cli, nickname: 'Scout', role: 'explorer' })
    const fork = analyzeCodex(
      await readCodexText(
        join(CODEX, 'sessions', '2026', '10', '21', `rollout-2026-10-21T08-00-00-${ID.fork}.jsonl`)
      ),
      ID.fork
    )
    // Its own meta wins over the parent's that follows it.
    expect(fork).toMatchObject({ sessionId: ID.fork, forkedFromId: ID.cli, effort: 'xhigh' })
    expect(fork.startedAt).toBe('2026-10-21T13:00:00.000Z')
  })

  it('labels the Codex product that ran it', () => {
    const label = (originator?: string, source?: string, sub = false) =>
      detectCodexSource({ origin: { originator, source }, subagent: sub ? {} : undefined }).label
    expect(label('codex_cli_rs', 'cli')).toBe('codex-cli')
    expect(label('codex-tui', 'cli')).toBe('codex-cli')
    expect(label('codex_vscode', 'vscode')).toBe('codex-vscode')
    // The desktop app records source "vscode": its originator decides.
    expect(label('Codex Desktop', 'vscode')).toBe('codex-desktop')
    expect(label('codex_work_desktop')).toBe('codex-desktop')
    expect(label('codex_exec', 'exec')).toBe('codex-exec')
    expect(label('Claude Code', 'exec')).toBe('codex-claude-code')
    expect(label('Codex Desktop', 'vscode', true)).toBe('codex-subagent')
    expect(label(undefined, undefined)).toBe('codex-unknown')
  })

  it("doesn't take context Codex wraps in a tag for a prompt", () => {
    const line = (text: string): string =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
      })
    const text = [
      line('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
      line('<recommended_plugins>\nHere is a list of plugins\n</recommended_plugins>'),
      line('Please fix <b>this</b> bug')
    ].join('\n')
    const a = analyzeCodex(text)
    expect(a.firstPrompt).toBe('Please fix <b>this</b> bug')
    expect(a.userMessageCount).toBe(1)
    expect(buildCodexMessages(text)).toHaveLength(1)
  })

  it('finds the files an apply_patch touches', () => {
    expect(
      patchFiles('*** Begin Patch\n*** Update File: a.ts\n*** Add File: b/c.ts\n*** End Patch')
    ).toEqual(['a.ts', 'b/c.ts'])
  })
})

// ------------------------------------------------------------ thread names

describe('thread names (session_index.jsonl)', () => {
  it('keeps the newest name per thread, and drops a cleared one', () => {
    const names = parseNameIndex(
      [
        '{"id":"A","thread_name":"First","updated_at":"2026-10-01T00:00:00Z"}',
        '{"id":"a","thread_name":"Renamed","updated_at":"2026-10-02T00:00:00Z"}',
        '{"id":"a","thread_name":"Older line later","updated_at":"2026-09-01T00:00:00Z"}',
        'not json',
        '{"id":"b","thread_name":"Gone","updated_at":"2026-10-01T00:00:00Z"}',
        '{"id":"b","thread_name":"","updated_at":"2026-10-03T00:00:00Z"}'
      ].join('\n')
    )
    expect(names.get('a')).toEqual({ name: 'Renamed', at: '2026-10-02T00:00:00Z' })
    expect(names.has('b')).toBe(false)
  })

  it('names sessions after their thread; a later dashboard name wins, newest wins', async () => {
    const { sessions } = await setup()
    const cli = codexOf(sessions.list(), ID.cli)
    expect(cli.title).toBe('Fix checkout totals')
    expect(cli.titleSource).toBe('claude-name')
    expect(cli.claudeName).toBe('Fix checkout totals')
    // Named, then the name cleared in Codex: back to the first prompt.
    expect(codexOf(sessions.list(), ID.gap).titleSource).toBe('first-prompt')
    expect(codexOf(sessions.list(), ID.wsl).title).toBe('Git branch in prompt')
    // My name is newer than the thread name, so it wins.
    const named = sessions.updateMeta(cli.key, { name: 'Coupon rounding bug' })!
    expect(named.title).toBe('Coupon rounding bug')
    expect(named.titleSource).toBe('name')
    // Found by its thread name too.
    expect(sessions.searchKeys('totals').map((h) => h.key)).toContain(cli.key)
  })
})

// ---------------------------------------------------------- the catalogue

describe('Codex sessions in the catalogue', () => {
  it('lists Windows and WSL Codex sessions next to Claude Code ones', async () => {
    const { sessions } = await setup()
    const list = sessions.list()
    const codex = list.filter((s) => s.provider === 'codex')
    expect(codex.map((s) => s.sessionId).sort()).toEqual(Object.values(ID).sort())
    expect(list.some((s) => s.provider === 'claude')).toBe(true)
    const wsl = codexOf(list, ID.wsl)
    expect(wsl).toMatchObject({
      env: 'wsl',
      distro: 'Ubuntu',
      sourceId: 'codex-wsl-Ubuntu-alex',
      cwd: '/home/alex/projects/dotfiles',
      source: 'codex-cli'
    })
    expect(codexOf(list, ID.desktop)).toMatchObject({
      source: 'codex-desktop',
      reasoningEffort: 'medium'
    })
    expect(codexOf(list, ID.sub)).toMatchObject({
      source: 'codex-subagent',
      subagent: { parentId: ID.cli }
    })
    expect(codexOf(list, ID.old).projectDir).toBe('archived_sessions')
    const detail = await sessions.detail(codexOf(list, ID.cli).key)
    expect(detail?.messages.length).toBe(2)
    expect(sessions.searchKeys('ThemeToggle').map((h) => h.key)).toContain(
      codexOf(list, ID.desktop).key
    )
  })

  it("keeps Codex metadata under its own keys: Claude Code's are never touched", async () => {
    expect(metaKey('claude', ID.cli)).toBe(ID.cli)
    expect(metaKey(undefined, ID.cli)).toBe(ID.cli)
    expect(metaKey('codex', ID.cli)).toBe(`codex:${ID.cli}`)
    expect(metaKeyOf({ provider: 'codex', sessionId: 'x' })).toBe('codex:x')
    const { sessions, metadata } = await setup()
    // A Claude Code entry with the same id as a Codex session (impossible in
    // practice, made up here) stays separate.
    metadata.update((d) => {
      d.sessions[ID.cli] = { name: 'A Claude Code name', tags: ['claude-tag'] }
    })
    const cli = codexOf(sessions.list(), ID.cli)
    expect(cli.meta.name).toBeUndefined()
    sessions.updateMeta(cli.key, { tags: ['codex-tag'], pinned: true, effort: 'ultra' })
    expect(metadata.value.sessions[`codex:${ID.cli}`]).toMatchObject({
      tags: ['codex-tag'],
      pinned: true,
      effort: 'ultra'
    })
    expect(metadata.value.sessions[ID.cli]).toEqual({
      name: 'A Claude Code name',
      tags: ['claude-tag']
    })
    // "ultra" is a Codex level, not a Claude Code one: refused for Claude sessions.
    const claude = sessions
      .list()
      .find((s) => s.provider === 'claude' && s.availability === 'live')!
    expect(sessions.updateMeta(claude.key, { effort: 'ultra' })?.meta.effort).toBeUndefined()
  })

  it('archives Codex sessions only as Settings say (off by default)', async () => {
    const off = await setup()
    const archived = (_s: SessionService) =>
      Object.values(off.metadata.value.archive)
        .filter((r) => r.provider === 'codex')
        .map((r) => r.sessionId)
    expect(archived(off.sessions)).toEqual([])
    const est = off.sessions.codexArchiveEstimate()
    expect(est.all.sessions).toBe(8)
    expect(est.all.newBytes).toBe(est.all.bytes)
    // Named in Codex (session_index.jsonl) counts as named: 1, 2 and 7 (6's name was cleared).
    expect(est.marked.sessions).toBe(3)
    // "Only named, pinned or tagged": those, and the one pinned here.
    off.settings.update((s) => {
      s.codexArchive = 'marked'
    })
    off.sessions.archiveWantedNow()
    off.sessions.updateMeta(codexOf(off.sessions.list(), ID.sub).key, { pinned: true })
    await off.sessions.idle()
    expect(archived(off.sessions).sort()).toEqual([ID.cli, ID.desktop, ID.sub, ID.wsl].sort())
    const rec = Object.values(off.metadata.value.archive).find((r) => r.sessionId === ID.desktop)!
    // A compressed rollout is copied as it is, in its own source's folder.
    expect(rec.archivePath).toMatch(/[\\/]archive[\\/]codex-windows[\\/].*\.jsonl\.zst$/)
    expect(off.sessions.codexArchiveEstimate()).toMatchObject({
      archived: 4,
      marked: { sessions: 4, newBytes: 0 }
    })
    // "All": every one.
    off.settings.update((s) => {
      s.codexArchive = 'all'
    })
    off.sessions.archiveWantedNow()
    await off.sessions.idle()
    expect(archived(off.sessions).sort()).toEqual(Object.values(ID).sort())
  })

  it('turning Codex off hides its sessions but keeps their metadata and archive; on brings them back', async () => {
    const { sessions, metadata, providers } = await setup({ codexArchive: 'all' })
    const cli = codexOf(sessions.list(), ID.cli)
    sessions.updateMeta(cli.key, { description: 'kept while off' })
    await sessions.idle()
    expect(providers.setEnabled({ claude: true, codex: false })).toBe(true)
    await sessions.rescan()
    expect(sessions.list().some((s) => s.provider === 'codex')).toBe(false)
    expect(sessions.payload().sources.some((s) => s.provider === 'codex')).toBe(false)
    expect(sessions.searchKeys('coupon').some((h) => h.key.startsWith('codex-'))).toBe(false)
    expect(metadata.value.sessions[`codex:${ID.cli}`]?.description).toBe('kept while off')
    expect(Object.values(metadata.value.archive).some((r) => r.provider === 'codex')).toBe(true)
    // Can't turn both off.
    expect(providers.setEnabled({ claude: false, codex: false })).toBe(false)
    expect(providers.isOn('claude')).toBe(true)
    providers.setEnabled({ claude: true, codex: true })
    await sessions.rescan()
    expect(codexOf(sessions.list(), ID.cli).meta.description).toBe('kept while off')
  })
})

// ---------------------------------------------------------------- launching

const TOOLS: LaunchTools = {
  wt: 'C:\\Users\\alex\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  cmd: 'C:\\Windows\\System32\\cmd.exe',
  wsl: 'C:\\Windows\\System32\\wsl.exe',
  codex: 'C:\\Users\\alex\\AppData\\Roaming\\npm\\codex.cmd'
}

describe('launch commands', () => {
  const base = {
    sessionId: ID.cli,
    fork: false,
    skipPermissions: false,
    terminal: 'wt' as const,
    tools: TOOLS
  }

  it('builds codex resume / fork with model, effort and the bypass flag', () => {
    expect(codexArgs({ sessionId: ID.cli, fork: false, bypass: false })).toEqual(['resume', ID.cli])
    expect(
      codexArgs({
        sessionId: ID.cli,
        fork: true,
        bypass: true,
        modelChoice: { model: 'gpt-5.5-codex', effort: 'xhigh' }
      })
    ).toEqual([
      'fork',
      '-m',
      'gpt-5.5-codex',
      '-c',
      'model_reasoning_effort=xhigh',
      '--dangerously-bypass-approvals-and-sandbox',
      ID.cli
    ])
    expect(() => codexModelArgs(undefined, 'turbo')).toThrow(/Invalid effort/)
    expect(() => codexModelArgs('-rf', undefined)).toThrow(/Invalid model/)
    expect(() => codexArgs({ sessionId: 'a b', fork: false, bypass: false })).toThrow()
    expect(() =>
      codexArgs({ sessionId: ID.cli, fork: false, bypass: true, askPermissions: true })
    ).toThrow()
  })

  it('Windows: Windows Terminal in the folder (with a space), cmd running codex by full path', () => {
    const cmd = buildCodexLaunch({
      ...base,
      env: 'windows',
      cwd: 'C:\\Users\\alex\\code\\shop api'
    })
    expect(cmd.command).toBe(TOOLS.wt)
    expect(cmd.args).toEqual([
      '-d',
      'C:\\Users\\alex\\code\\shop api',
      TOOLS.cmd,
      '/s',
      '/k',
      `set NoDefaultCurrentDirectoryInExePath=1& "${TOOLS.codex}" resume ${ID.cli}`
    ])
    expect(cmd.claudeCommand).toBe(`codex resume ${ID.cli}`)
    const ps = buildCodexLaunch({
      ...base,
      env: 'windows',
      cwd: 'C:\\Users\\alex\\code\\shop api',
      terminal: 'powershell'
    })
    expect(ps.args[2]).toContain("Set-Location -LiteralPath 'C:\\Users\\alex\\code\\shop api';")
    expect(ps.args[2]).toContain(`& '${TOOLS.codex}' resume ${ID.cli}`)
    const plain = buildCodexLaunch({ ...base, env: 'windows', cwd: 'C:\\x y', terminal: 'cmd' })
    expect(plain).toMatchObject({ command: TOOLS.cmd, spawnCwd: 'C:\\x y', verbatim: true })
  })

  it('WSL: wsl.exe --cd the folder, codex through the login shell', () => {
    const cmd = buildCodexLaunch({
      ...base,
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/alex/my projects/dotfiles',
      fork: true,
      skipPermissions: true
    })
    expect(cmd.args).toEqual([
      TOOLS.wsl,
      '-d',
      'Ubuntu',
      '--cd',
      '/home/alex/my projects/dotfiles',
      '--',
      'bash',
      '-lic',
      `command codex fork --dangerously-bypass-approvals-and-sandbox ${ID.cli}`
    ])
  })

  it('refuses what Codex sessions do not have', () => {
    expect(() =>
      buildCodexLaunch({ ...base, env: 'windows', cwd: 'C:\\x', remoteControl: {} })
    ).toThrow(/Remote Control/)
    expect(() =>
      buildCodexLaunch({ ...base, env: 'windows', cwd: 'C:\\x', apiKey: 'sk-x' })
    ).toThrow(/API account/)
    expect(() =>
      buildCodexLaunch({ ...base, env: 'windows', cwd: 'C:\\x', newSession: true })
    ).toThrow()
    expect(() =>
      buildCodexLaunch({
        ...base,
        env: 'windows',
        cwd: 'C:\\x',
        tools: { ...TOOLS, codex: undefined }
      })
    ).toThrow(/Codex wasn't found/)
  })

  it('phone launches: no Remote Control, ask before acting, never the bypass flag', () => {
    const o = remoteLaunchOptions({ key: 'k', kind: 'resume' }, 'wt', 'codex')
    expect(o).toMatchObject({ skipPermissions: false, askPermissions: true })
    expect(o.remoteControl).toBeUndefined()
    // Claude Code's are as before.
    expect(remoteLaunchOptions({ key: 'k', kind: 'resume' }, 'wt')).toMatchObject({
      remoteControl: true,
      askPermissions: true,
      skipPermissions: false
    })
    expect(
      codexArgs({ sessionId: ID.cli, fork: false, bypass: false, askPermissions: true })
    ).toEqual(['resume', '-a', 'on-request', '-s', 'workspace-write', ID.cli])
  })

  it('the launcher: Codex defaults, hidden actions and no restore into ~/.codex', async () => {
    const { sessions, launcher, settings } = await setup()
    settings.update((s) => {
      s.skipPermissionsDefault = true
      s.codexDefaultModel = 'gpt-5.5-codex'
      s.codexDefaultEffort = 'ultra'
      // Claude Code's defaults don't apply to Codex.
      s.defaultModel = 'opus'
      s.defaultEffort = 'max'
    })
    const s = codexOf(sessions.list(), ID.cli)
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: true })
    expect(p.launchError).toBeUndefined()
    // Always bound to the session's own home (a CODEX_HOME set elsewhere can't redirect it).
    const home = dirname(dirname(dirname(dirname(dirname(s.originalPath)))))
    expect(p.claudeCommand).toBe(
      `$env:CODEX_HOME = '${home}'; codex resume -m gpt-5.5-codex -c model_reasoning_effort=ultra --dangerously-bypass-approvals-and-sandbox ${ID.cli}`
    )
    expect(p.agentNote).toMatch(/^Run it in PowerShell, from /)
    expect(p.commandLine).toContain(`CODEX_HOME=${home}`)
    expect(p.terminal).toBe('wt')
    expect(p.context).toBeUndefined()
    expect(launcher.modelChoice(s)).toMatchObject({
      model: 'gpt-5.5-codex',
      effort: 'ultra',
      modelFrom: 'settings'
    })
    for (const [what, opts] of [
      ['Branch from here', { branch: { at: 'x', mode: 'include' as const } }],
      // Continue fresh is available for Codex since Phase D2 (tests/codex-d2.test.ts).
      ['Remote Control', { remoteControl: true }],
      ['Launching on API credits', { billingAccountId: 'acct-1' }],
      ['A new session in this folder', { newSession: true }]
    ] as const) {
      const r = await launcher.launch({ key: s.key, fork: false, skipPermissions: false, ...opts })
      expect(r.error).toBe(`${what} isn't available for Codex sessions.`)
    }
    // Fork works.
    expect(
      (await launcher.preview({ key: s.key, fork: true, skipPermissions: false })).claudeCommand
    ).toMatch(/; codex fork /)
    // Model and effort, project defaults: kept apart from Claude Code's.
    expect(resolveModelChoice({ effort: 'ultra' }, undefined, {}, CODEX_EFFORT_LEVELS).effort).toBe(
      'ultra'
    )
    expect(resolveModelChoice({ effort: 'ultra' }, undefined, {}).effort).toBeUndefined()
  })

  it("doesn't copy a gone rollout back into ~/.codex: it can be read, not resumed", async () => {
    const { sessions, launcher, layout } = await setup({ codexArchive: 'all' })
    const s = codexOf(sessions.list(), ID.wsl)
    await sessions.idle()
    await rm(s.originalPath)
    await sessions.rescan()
    const gone = codexOf(sessions.list(), ID.wsl)
    expect(gone.availability).toBe('archived-only')
    expect((await sessions.detail(gone.key))?.messages.length).toBeGreaterThan(0)
    const p = await launcher.preview({ key: gone.key, fork: false, skipPermissions: false })
    expect(p.willRestore).toBe(false)
    expect(p.launchError).toMatch(/doesn't copy files into Codex's folder/)
    const r = await launcher.launch({ key: gone.key, fork: false, skipPermissions: false })
    expect(r).toMatchObject({ ok: false, restored: false })
    await expect(readFile(s.originalPath)).rejects.toThrow()
    expect(layout).toBeDefined()
  })
})

// ------------------------------------------------------------- the switch

describe('the All / Claude / Codex switch', () => {
  const c = { provider: 'claude' as const }
  const x = { provider: 'codex' as const }
  it('filters by provider', () => {
    expect(inProviderView('all', c) && inProviderView('all', x)).toBe(true)
    expect(inProviderView('claude', c)).toBe(true)
    expect(inProviderView('claude', x)).toBe(false)
    expect(inProviderView('codex', x)).toBe(true)
    // No provider field: Claude Code.
    expect(inProviderView('claude', {})).toBe(true)
    expect(inProviderView('codex', {})).toBe(false)
  })

  it('a view of a provider that is off shows all; at least one provider stays on', () => {
    expect(effectiveView('codex', { claude: true, codex: false })).toBe('all')
    expect(effectiveView('codex', { claude: true, codex: true })).toBe('codex')
    expect(sanitizeProviderToggles({ claude: false, codex: false })).toEqual({
      claude: true,
      codex: false
    })
    expect(sanitizeProviderToggles(undefined)).toEqual({ claude: true, codex: true })
    expect(enabledProviders({ claude: false, codex: true })).toEqual(['codex'])
  })
})

// ------------------------------------------------------- review fixes (PR 28)

describe('review fixes', () => {
  it('archives a compressed rollout with more in it than its plain copy (to a new copy)', async () => {
    const dataDir = join(root, 'data')
    const archiveDir = join(dataDir, 'archive')
    const plain = join(root, `rollout-2026-10-01T00-00-00-${ID.cli}.jsonl`)
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `{"type":"event_msg","n":${i}}`).join('\n') + '\n'
    await writeFile(plain, lines(50))
    const base = {
      provider: 'codex' as const,
      sessionId: ID.cli,
      sourceId: 'codex-windows',
      sourceLabel: 'Windows',
      env: 'windows' as const
    }
    const first = await archiveSession(
      { ...base, ext: '.jsonl', originalPath: plain, contentSize: (await stat(plain)).size },
      undefined,
      archiveDir,
      dataDir
    )
    expect(first).toMatchObject({ contentSize: (await stat(plain)).size })
    // Codex compressed it, with more turns: smaller on disk, more content.
    const zst = `${plain}.zst`
    const more = Buffer.from(lines(80))
    await writeFile(zst, zstdCompressSync(more))
    expect((await stat(zst)).size).toBeLessThan(first!.size)
    const second = await archiveSession(
      { ...base, ext: '.jsonl.zst', originalPath: zst, contentSize: more.length },
      first,
      archiveDir,
      dataDir
    )
    expect(second?.archivePath).toMatch(/\.jsonl\.zst$/)
    expect(second?.contentSize).toBe(more.length)
    // The older plain copy is still there, untouched.
    expect(await readFile(first!.archivePath, 'utf8')).toBe(lines(50))
    // Same content again: nothing copied.
    expect(
      await archiveSession(
        { ...base, ext: '.jsonl.zst', originalPath: zst, contentSize: more.length },
        second,
        archiveDir,
        dataDir
      )
    ).toBeUndefined()
  })

  it("launches Codex in the session's own home: its WSL user, or CODEX_HOME for an added folder", () => {
    const base = {
      sessionId: ID.cli,
      fork: false,
      skipPermissions: false,
      terminal: 'wt' as const,
      tools: TOOLS
    }
    const wsl = buildCodexLaunch({
      ...base,
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/ann/x',
      wslUser: 'ann'
    })
    expect(wsl.args.slice(0, 6)).toEqual([TOOLS.wsl, '-d', 'Ubuntu', '-u', 'ann', '--cd'])
    const wslHome = buildCodexLaunch({
      ...base,
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/ann/x',
      agentEnv: { CODEX_HOME: '/data/my codex' }
    })
    expect(wslHome.args.at(-1)).toBe(`CODEX_HOME='/data/my codex' command codex resume ${ID.cli}`)
    const win = buildCodexLaunch({
      ...base,
      env: 'windows',
      cwd: 'C:\\x',
      agentEnv: { CODEX_HOME: 'D:\\Other Codex' }
    })
    // Set in cmd itself, so it holds in a Windows Terminal window that was already open.
    expect(win.terminal).toBe('wt')
    expect(win.args.at(-1)).toBe(
      `set NoDefaultCurrentDirectoryInExePath=1& set "CODEX_HOME=D:\\Other Codex"& "${TOOLS.codex}" resume ${ID.cli}`
    )
    const winPs = buildCodexLaunch({
      ...base,
      env: 'windows',
      cwd: 'C:\\x',
      terminal: 'powershell',
      agentEnv: { CODEX_HOME: 'D:\\Other Codex' }
    })
    expect(winPs.args[2]).toContain("$env:CODEX_HOME = 'D:\\Other Codex';")
    expect(() =>
      buildCodexLaunch({ ...base, env: 'wsl', distro: 'Ubuntu', cwd: '/x', wslUser: 'a b' })
    ).toThrow(/WSL user/)
    expect(() =>
      buildCodexLaunch({ ...base, env: 'windows', cwd: 'C:\\x', agentEnv: { CODEX_HOME: 'rel"x' } })
    ).toThrow()
  })

  it('a provider turned off is left out at once, before the rescan', async () => {
    const { sessions, providers } = await setup()
    const key = codexOf(sessions.list(), ID.cli).key
    providers.setEnabled({ claude: true, codex: false })
    expect(() => sessions.list()).not.toThrow()
    expect(sessions.list().some((s) => s.provider === 'codex')).toBe(false)
    expect(sessions.get(key)).toBeUndefined()
    expect(await sessions.detail(key)).toBeNull()
    expect(() => sessions.payload()).not.toThrow()
  })

  it('a queued copy checks the setting again when its turn comes', async () => {
    const { sessions, settings, metadata } = await setup()
    settings.update((s) => {
      s.codexArchive = 'all'
    })
    sessions.archiveWantedNow()
    settings.update((s) => {
      s.codexArchive = 'off'
    })
    await sessions.idle()
    expect(Object.values(metadata.value.archive).some((r) => r.provider === 'codex')).toBe(false)
  })

  it('keeps prompts that look like XML, and long messages whole', () => {
    const msg = (role: string, text: string): string =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role, content: [{ type: 'input_text', text }] }
      })
    const long = 'x'.repeat(200_000)
    const text = [msg('user', '<question>What does this mean?</question>'), msg('assistant', long)]
      .map((l) => compactLine(l)!)
      .join('\n')
    const a = analyzeCodex(text)
    expect(a.firstPrompt).toBe('<question>What does this mean?</question>')
    const blocks = buildCodexMessages(text)[1].blocks
    expect(blocks[0]).toEqual({ type: 'text', text: long })
  })

  it('follows a rollout that moved with the same size and time', async () => {
    const { sessions, layout } = await setup()
    const s = codexOf(sessions.list(), ID.gap)
    const home = join(layout.sourcesDir, 'windows', 'Users', 'alex', '.codex')
    const moved = join(home, 'archived_sessions', `rollout-2026-10-15T11-11-11-${ID.gap}.jsonl`)
    const st = await stat(s.originalPath)
    await rename(s.originalPath, moved)
    await utimes(moved, st.atime, st.mtime)
    await sessions.rescan()
    const after = codexOf(sessions.list(), ID.gap)
    expect(after.filePath).toBe(moved)
    expect((await sessions.detail(after.key))?.messages.length).toBeGreaterThan(0)
  })
})

// ------------------------------------------------------- second review

describe('second review fixes', () => {
  it('a provider turned off while a file is being read keeps nothing of it', async () => {
    const codex = createCodexProvider()
    const providers = new ProviderRegistry([claudeProvider, codex])
    const { sessions } = await setup({ providers })
    const s = codexOf(sessions.list(), ID.cli)
    await writeFile(s.originalPath, (await readFile(s.originalPath, 'utf8')) + '\n')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const read = codex.readText
    codex.readText = async (path, purpose) => {
      await gate
      return read(path, purpose)
    }
    const pending = sessions.fileChanged(s.sourceId, s.originalPath)
    await new Promise((r) => setTimeout(r, 30))
    providers.setEnabled({ claude: true, codex: false })
    sessions.dropDisabled()
    release()
    await expect(pending).resolves.toBeUndefined()
    expect(sessions.list().some((x) => x.provider === 'codex')).toBe(false)
    // A rescan while it's off doesn't look it up either.
    await expect(sessions.rescan()).resolves.toBeUndefined()
    providers.setEnabled({ claude: true, codex: true })
    await sessions.rescan()
    expect(codexOf(sessions.list(), ID.cli)).toBeDefined()
  })

  it("doesn't reuse compact text an older reader cached", async () => {
    const dataDir = join(root, 'data')
    const dir = join(dataDir, 'cache', 'codex')
    const file = join(root, `rollout-2026-10-01T00-00-00-${ID.cli}.jsonl`)
    await writeFile(file, 'x')
    const st = await stat(file)
    const old = new CompactTextCache(dir, dataDir, 1)
    await old.put(file, st.size, st.mtimeMs, 'CUT BY AN OLDER READER')
    expect(await old.get(file)).toBe('CUT BY AN OLDER READER')
    // The first PR build's names had no version at all.
    const prefix = createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 20)
    await writeFile(join(dir, `${prefix}-${st.size}-${Math.round(st.mtimeMs)}.jsonl`), 'LEGACY')
    await writeFile(join(dir, 'not-ours.txt'), 'kept')
    const cur = new CompactTextCache(dir, dataDir)
    expect(await cur.get(file)).toBeUndefined()
    // Swept: only the cache's own older copies (by their name pattern).
    expect(await readdir(dir)).toEqual(['not-ours.txt'])
    await cur.put(file, st.size, st.mtimeMs, 'WHOLE')
    expect(await cur.get(file)).toBe('WHOLE')
  })

  it('tells what I typed from context by what the rollout records, not by the tag', () => {
    const item = (text: string, meta?: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
          ...(meta ? { internal_chat_message_metadata_passthrough: meta } : {})
        }
      })
    const text = [
      // No provenance: only Codex's own tags are context.
      item('<recommended_plugins>\nplugins\n</recommended_plugins>'),
      item('<user_input>Build the app</user_input>'),
      // Provenance: the rollout says who wrote it, whatever it looks like.
      item('<send_user_message_question_reply>Yes</send_user_message_question_reply>', {
        content_item_kinds: ['user.text'],
        content_item_metadata: [{ provenance: { type: 'user' } }]
      }),
      item('Looks like a prompt', { content_item_kinds: ['goal.internal_context'] }),
      item('<environment_context>pasted</environment_context>', {
        content_item_kinds: ['user.text']
      }),
      item('From the harness', {
        content_item_kinds: ['user.text'],
        content_item_metadata: [{ provenance: { type: 'harness' } }]
      })
    ].join('\n')
    const a = analyzeCodex(text)
    expect(a.firstPrompt).toBe('<user_input>Build the app</user_input>')
    expect(a.userMessageCount).toBe(3)
    const shown = buildCodexMessages(text).map((m) => (m.blocks[0] as { text: string }).text)
    expect(shown).toEqual([
      '<user_input>Build the app</user_input>',
      '<send_user_message_question_reply>Yes</send_user_message_question_reply>',
      '<environment_context>pasted</environment_context>'
    ])
  })

  it('estimates an encoding change as a whole new copy', () => {
    const rec = { archivePath: join(root, 'a.jsonl'), size: 100 }
    expect(archiveGrowth(undefined, 40)).toBe(40)
    expect(archiveGrowth(rec, 40, '.jsonl.zst')).toBe(40)
    expect(archiveGrowth(rec, 120, '.jsonl')).toBe(20)
    expect(archiveGrowth(rec, 90, '.jsonl')).toBe(0)
  })

  it('checks CODEX_HOME for what Windows Terminal and cmd would change', () => {
    const base = { sessionId: ID.cli, fork: false, skipPermissions: false, tools: TOOLS }
    const wt = buildCodexLaunch({
      ...base,
      terminal: 'wt',
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/ann/x',
      agentEnv: { CODEX_HOME: '/data/a;b' }
    })
    expect(wt).toMatchObject({ terminal: 'powershell', terminalReason: AGENT_ENV_CHARS_REASON })
    const cmd = buildCodexLaunch({
      ...base,
      terminal: 'cmd',
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/ann/x',
      agentEnv: { CODEX_HOME: '/data/50%codex!' }
    })
    expect(cmd).toMatchObject({ terminal: 'powershell', terminalReason: AGENT_ENV_CHARS_REASON })
    // Inside PowerShell's single-quoted string, bash's quotes are doubled.
    expect(cmd.args[2]).toContain("CODEX_HOME=''/data/50%codex!''")
    const plain = buildCodexLaunch({
      ...base,
      terminal: 'wt',
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/ann/x',
      agentEnv: { CODEX_HOME: '/data/codex' }
    })
    expect(plain.terminal).toBe('wt')
  })

  it('the copied codex command carries its home and says where to run it', () => {
    const base = { sessionId: ID.cli, fork: false, skipPermissions: false, tools: TOOLS }
    const wsl = buildCodexLaunch({
      ...base,
      terminal: 'wt',
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/ann/x',
      wslUser: 'ann',
      agentEnv: { CODEX_HOME: '/data/my codex' }
    })
    expect(wsl.claudeCommand).toBe(`CODEX_HOME='/data/my codex' command codex resume ${ID.cli}`)
    expect(wsl.agentNote).toBe('Run it in WSL (Ubuntu) as ann, from /home/ann/x')
    const win = buildCodexLaunch({
      ...base,
      terminal: 'wt',
      env: 'windows',
      cwd: 'C:\\x',
      agentEnv: { CODEX_HOME: 'D:\\Other Codex' }
    })
    expect(win.claudeCommand).toBe(`$env:CODEX_HOME = 'D:\\Other Codex'; codex resume ${ID.cli}`)
    expect(win.agentNote).toBe('Run it in PowerShell, from C:\\x')
    // The usual home: the bare command, as before.
    const usual = buildCodexLaunch({ ...base, terminal: 'wt', env: 'windows', cwd: 'C:\\x' })
    expect(usual.claudeCommand).toBe(`codex resume ${ID.cli}`)
    expect(usual.agentNote).toBeUndefined()
  })

  it("a late unlink for the old path doesn't drop a rollout that moved", async () => {
    const { sessions, layout } = await setup()
    const s = codexOf(sessions.list(), ID.gap)
    const home = join(layout.sourcesDir, 'windows', 'Users', 'alex', '.codex')
    const moved = join(home, 'archived_sessions', `rollout-2026-10-15T11-11-11-${ID.gap}.jsonl`)
    await rename(s.originalPath, moved)
    // The add for the new path is handled first, then the unlink for the old one.
    await sessions.fileChanged(s.sourceId, moved)
    await sessions.fileChanged(s.sourceId, s.originalPath)
    expect(codexOf(sessions.list(), ID.gap)).toMatchObject({
      filePath: moved,
      availability: 'live'
    })
    // A real unlink of the file it follows still counts.
    await rm(moved)
    await sessions.fileChanged(s.sourceId, moved)
    expect(codexOf(sessions.list(), ID.gap)?.availability ?? 'gone').not.toBe('live')
  })
})

// -------------------------------------------------------- third review

/** Plain text that hardly compresses, and text that compresses to almost nothing. */
const noisy = (n: number): Buffer =>
  Buffer.from(Array.from({ length: n }, (_, i) => ((i * 2654435761) % 4093).toString(36)).join(''))
const repetitive = (n: number): Buffer => Buffer.from('x'.repeat(n))

describe('third review fixes', () => {
  it('restore picks the copy that holds more, by content, and keeps the record with it', async () => {
    const dataDir = join(root, 'data')
    const archiveDir = join(dataDir, 'archive')
    const plain = join(archiveDir, 'w', `${ID.cli}.jsonl`)
    await mkdir(dirname(plain), { recursive: true })
    await writeFile(plain, noisy(20_000))
    const plainSize = (await stat(plain)).size
    const recFor = (path: string, size: number, contentSize: number) => ({
      provider: 'codex',
      sessionId: ID.cli,
      sourceId: 'w',
      archivePath: path,
      size,
      contentSize
    })
    await writeFile(
      join(dataDir, 'metadata.json'),
      JSON.stringify({
        version: 1,
        sessions: {},
        archive: { k: recFor(plain, plainSize, plainSize) }
      })
    )
    // The backup: a compressed copy with more in it, much smaller on disk.
    const more = repetitive(plainSize * 3)
    const zst = zstdCompressSync(more)
    expect(zst.length).toBeLessThan(plainSize)
    const pending = join(dataDir, 'restore-pending', 'files')
    await mkdir(join(pending, 'archive', 'w'), { recursive: true })
    await writeFile(join(pending, 'archive', 'w', `${ID.cli}.jsonl.zst`), zst)
    const zstPath = join(archiveDir, 'w', `${ID.cli}.jsonl.zst`)
    await writeFile(
      join(pending, 'metadata.json'),
      JSON.stringify({
        version: 1,
        sessions: {},
        archive: { k: recFor(zstPath, zst.length, more.length) }
      })
    )
    await writeFile(
      join(dataDir, 'restore-pending', 'plan.json'),
      JSON.stringify({
        snapshotId: 's',
        snapshotCreatedAt: 's',
        // The metadata first in the plan: the archive copies are still applied first.
        items: [
          { rel: 'metadata.json', action: 'merge', sha256: 'x', size: 1 },
          { rel: `archive/w/${ID.cli}.jsonl.zst`, action: 'add', sha256: 'x', size: zst.length }
        ]
      })
    )
    const rec = await applyPendingRestore(dataDir, { archiveDir, now: Date.now() })
    expect(rec?.error).toBeUndefined()
    const meta = JSON.parse(await readFile(join(dataDir, 'metadata.json'), 'utf8'))
    expect(meta.archive.k).toMatchObject({ archivePath: zstPath, contentSize: more.length })
    // The older plain copy stays.
    expect((await stat(plain)).size).toBe(plainSize)

    // By content in the merge, and never a record whose copy isn't there.
    const merged = (backupRec: object, exists: boolean): unknown =>
      JSON.parse(
        mergeOnRestore(
          'metadata.json',
          JSON.stringify({ version: 1, sessions: {}, archive: { k: backupRec } }),
          JSON.stringify({ version: 1, sessions: {}, archive: { k: recFor(plain, 100, 100) } }),
          { archiveDir, exists: () => exists }
        )
      ).archive.k
    expect(merged(recFor(zstPath, 10, 500), true)).toMatchObject({ archivePath: zstPath })
    expect(merged(recFor(zstPath, 10, 500), false)).toMatchObject({ archivePath: plain })
    expect(merged(recFor(zstPath, 900, 50), true)).toMatchObject({ archivePath: plain })
  })

  it('restore compares compressed copies by what they hold, not their size on disk', async () => {
    const dataDir = join(root, 'data')
    const rel = `archive/w/${ID.cli}.jsonl.zst`
    const target = join(dataDir, 'archive', 'w', `${ID.cli}.jsonl.zst`)
    await mkdir(dirname(target), { recursive: true })
    const here = zstdCompressSync(noisy(20_000))
    await writeFile(target, here)
    // Preview: can't be told from sizes, so it's decided when restoring.
    const { items } = await planRestore(dataDir, [{ p: rel, s: 10, m: 0, h: 'other', o: 'o' }])
    expect(items[0]).toMatchObject({ action: 'replace', note: expect.stringMatching(/holds more/) })
    const stageAndApply = async (backup: Buffer): Promise<void> => {
      const staged = join(
        dataDir,
        'restore-pending',
        'files',
        'archive',
        'w',
        `${ID.cli}.jsonl.zst`
      )
      await mkdir(dirname(staged), { recursive: true })
      await writeFile(staged, backup)
      await writeFile(
        join(dataDir, 'restore-pending', 'plan.json'),
        JSON.stringify({
          snapshotId: 's',
          snapshotCreatedAt: 's',
          items: [{ rel, action: 'replace', sha256: 'x', size: backup.length }]
        })
      )
      await applyPendingRestore(dataDir, { archiveDir: join(dataDir, 'archive'), now: Date.now() })
    }
    // Smaller on disk but holding more: restored.
    const better = zstdCompressSync(repetitive(200_000))
    expect(better.length).toBeLessThan(here.length)
    await stageAndApply(better)
    expect(await readFile(target)).toEqual(better)
    // Bigger on disk but holding less: the copy here stays.
    const worse = zstdCompressSync(noisy(5_000))
    await stageAndApply(Buffer.concat([worse, Buffer.alloc(0)]))
    expect(await readFile(target)).toEqual(better)
  })

  it('a better-compressed rollout with more in it updates its compressed archive copy', async () => {
    const dataDir = join(root, 'data')
    const archiveDir = join(dataDir, 'archive')
    const src = join(root, `rollout-2026-10-01T00-00-00-${ID.cli}.jsonl.zst`)
    const first = noisy(20_000)
    await writeFile(src, zstdCompressSync(first))
    const base = {
      provider: 'codex' as const,
      ext: '.jsonl.zst',
      sessionId: ID.cli,
      sourceId: 'w',
      sourceLabel: 'Windows',
      env: 'windows' as const,
      originalPath: src
    }
    const a = await archiveSession(
      { ...base, contentSize: first.length },
      undefined,
      archiveDir,
      dataDir
    )
    expect(a?.contentSize).toBe(first.length)
    const more = repetitive(first.length * 2)
    await writeFile(src, zstdCompressSync(more))
    expect((await stat(src)).size).toBeLessThan(a!.size)
    const b = await archiveSession({ ...base, contentSize: more.length }, a, archiveDir, dataDir)
    expect(b).toMatchObject({ archivePath: a!.archivePath, contentSize: more.length })
    // A copy cut off mid-way never replaces it.
    const whole = zstdCompressSync(repetitive(first.length * 3))
    await writeFile(src, whole.subarray(0, whole.length - 4))
    expect(
      await archiveSession({ ...base, contentSize: first.length * 3 }, b, archiveDir, dataDir)
    ).toBeUndefined()
    expect(await zstdContentSize(b!.archivePath)).toBe(more.length)
  })

  it('keeps hidden context short so it never fills the size budget', () => {
    const big = 'C'.repeat(100_000)
    const line = compactLine(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: `<recommended_plugins>${big}</recommended_plugins>` },
            { type: 'input_text', text: big }
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['plugins.recommendations', 'user.text']
          }
        }
      })
    )!
    const kept = JSON.parse(line).payload.content
    expect(kept[0].text.length).toBeLessThan(CONTEXT_KEEP + 100)
    expect(kept[1].text).toBe(big)
    const dev = compactLine(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: big }]
        }
      })
    )!
    expect(JSON.parse(dev).payload.content[0].text.length).toBeLessThan(CONTEXT_KEEP + 100)
    const answer = compactLine(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: big }]
        }
      })
    )!
    expect(JSON.parse(answer).payload.content[0].text).toBe(big)
  })

  it('keeps older event messages next to newer items, without doubling either', () => {
    const ev = (type: string, message: string): string =>
      JSON.stringify({ type: 'event_msg', payload: { type, message } })
    const item = (role: string, text: string): string =>
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
        }
      })
    const text = [
      // Older turns: events only.
      ev('user_message', 'old prompt'),
      ev('agent_message', 'old answer'),
      // Newer turns: items, with the same message as an event too.
      item('user', 'new prompt'),
      ev('user_message', 'new prompt'),
      item('assistant', 'new answer'),
      ev('agent_message', 'new answer')
    ].join('\n')
    const texts = buildCodexMessages(text).map((m) => (m.blocks[0] as { text: string }).text)
    expect(texts).toEqual(['old prompt', 'old answer', 'new prompt', 'new answer'])
    const a = analyzeCodex(text)
    expect([a.userMessageCount, a.assistantMessageCount]).toEqual([2, 2])
    expect(a.searchText).toContain('old answer')
  })

  it('binds CODEX_HOME for auto-discovered homes too (Windows and WSL)', () => {
    const p = createCodexProvider()
    const win = p.launch.target!({
      id: 'codex-windows',
      label: 'Windows',
      env: 'windows',
      kind: 'auto',
      status: 'ok',
      sessionCount: 0,
      projectsDir: 'C:\\Users\\alex\\.codex\\sessions'
    })
    expect(win).toEqual({ agentEnv: { CODEX_HOME: 'C:\\Users\\alex\\.codex' } })
    const wsl = p.launch.target!({
      id: 'codex-wsl',
      label: 'WSL',
      env: 'wsl',
      distro: 'Ubuntu',
      user: 'ann',
      kind: 'auto',
      status: 'ok',
      sessionCount: 0,
      projectsDir: '\\\\wsl.localhost\\Ubuntu\\home\\ann\\.codex\\sessions'
    })
    expect(wsl).toEqual({ wslUser: 'ann', agentEnv: { CODEX_HOME: '/home/ann/.codex' } })
  })

  it('prompts and answers come first in the search text, and a cut is said', () => {
    const ev = (type: string, message: string): string =>
      JSON.stringify({ type: 'event_msg', payload: { type, message } })
    const reasoning = JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'r'.repeat(600_000) }] }
    })
    const text = [
      reasoning,
      reasoning,
      ev('user_message', 'early prompt'),
      ev('agent_message', `${'a'.repeat(300_000)} needle`)
    ].join('\n')
    const a = analyzeCodex(text)
    expect(a.searchText).toContain('needle')
    expect(a.searchPartial).toBe(true)
    expect(analyzeCodex(ev('user_message', 'short')).searchPartial).toBeUndefined()
  })

  it("the archive estimate adds nothing to backups for what's already archived", async () => {
    const { sessions } = await setup({ codexArchive: 'all' })
    const est = sessions.codexArchiveEstimate()
    expect(est.all.sessions).toBeGreaterThan(0)
    expect(est.all.bytes).toBeGreaterThan(0)
    expect(est.all).toMatchObject({ newBytes: 0, backupBytes: 0 })
  })
})

// ------------------------------------------- sessions run in the other environment

describe('a session whose folder belongs to the other environment', () => {
  const XID = {
    mnt: '019a8888-0000-7000-8000-000000000008',
    home: '019a9999-0000-7000-8000-000000000009',
    win: '019aaaaa-0000-7000-8000-00000000000a',
    wslMnt: '019abbbb-0000-7000-8000-00000000000b',
    wslGone: '019acccc-0000-7000-8000-00000000000c'
  }
  const rollout = (id: string, cwd: string, originator: string): string =>
    [
      JSON.stringify({
        timestamp: '2026-10-22T10:00:00.000Z',
        type: 'session_meta',
        payload: { id, cwd, originator, source: 'vscode', cli_version: '0.164.0' }
      }),
      JSON.stringify({
        timestamp: '2026-10-22T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Configure Reddit subreddit' }]
        }
      })
    ].join('\n') + '\n'
  const homeOf = (s: SessionSummary): string =>
    dirname(dirname(dirname(dirname(dirname(s.originalPath)))))
  const base = { fork: false, skipPermissions: false }
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  /** The Codex desktop app's WSL sessions in the Windows home, and the reverse. */
  async function crossSetup() {
    const t = await setup()
    const winHome = homeOf(codexOf(t.sessions.list(), ID.cli))
    const wslHome = homeOf(codexOf(t.sessions.list(), ID.wsl))
    const day = (home: string): string => join(home, 'sessions', '2026', '10', '22')
    await mkdir(day(winHome), { recursive: true })
    await mkdir(day(wslHome), { recursive: true })
    const add = (home: string, id: string, cwd: string, originator: string, n: number) =>
      writeFile(
        join(day(home), `rollout-2026-10-22T10-0${n}-00-${id}.jsonl`),
        rollout(id, cwd, originator)
      )
    await add(winHome, XID.mnt, '/mnt/c/Users/alex/code/reddit', 'Codex Desktop', 1)
    await add(winHome, XID.home, '/home/alex/notes', 'Codex Desktop', 2)
    await add(wslHome, XID.win, 'C:\\Users\\alex\\code\\win', 'codex-tui', 3)
    // A WSL session on a Windows drive (not under the sample distro root, as from
    // \\wsl.localhost, which can't show drive mounts), and one whose folder is gone.
    await add(wslHome, XID.wslMnt, '/mnt/c/Users/alex/Documents/notes', 'codex-tui', 4)
    await add(wslHome, XID.wslGone, '/home/alex/removed-project', 'codex-tui', 5)
    await mkdir(join(t.layout.sourcesDir, 'wsl', 'Ubuntu', 'home', 'alex', 'notes'), {
      recursive: true
    })
    await t.sessions.rescan()
    return { ...t, winHome, wslHome }
  }

  it('maps paths between WSL and Windows, and reads the default distro', () => {
    expect(mntToWindows('/mnt/c/Users/alex/code/reddit')).toBe('C:\\Users\\alex\\code\\reddit')
    expect(mntToWindows('/mnt/d')).toBe('D:\\')
    expect(mntToWindows('/home/alex')).toBeUndefined()
    expect(mntToWindows('/mnt/wsl/x')).toBeUndefined()
    expect(windowsPathToWsl('C:\\Users\\alex\\code\\win')).toBe('/mnt/c/Users/alex/code/win')
    expect([isLinuxPath('/mnt/c/x'), isLinuxPath('C:\\x'), isLinuxPath('//server/x')]).toEqual([
      true,
      false,
      false
    ])
    expect([
      isWindowsPath('C:\\x'),
      isWindowsPath('\\\\wsl.localhost\\U\\x'),
      isWindowsPath('/x')
    ]).toEqual([true, true, false])
    const listV = Buffer.from(
      '  NAME              STATE           VERSION\r\n* Ubuntu-24.04      Running         2\r\n  docker-desktop    Running         2\r\n',
      'utf16le'
    )
    expect(parseDefaultDistro(listV)).toBe('Ubuntu-24.04')
    expect(
      parseDefaultDistro(Buffer.from('  NAME STATE\r\n  Debian Stopped\r\n', 'utf16le'))
    ).toBeUndefined()
  })

  it('a /mnt/c folder in the Windows .codex resumes with Windows Codex in C:\\…, never in WSL', async () => {
    const { sessions, launcher, winHome } = await crossSetup()
    const s = codexOf(sessions.list(), XID.mnt)
    expect(s.env).toBe('windows')
    const p = await launcher.preview({ key: s.key, ...base })
    expect(p.launchError).toBeUndefined()
    expect(p.placement).toMatchObject({
      kind: 'translated',
      runIn: 'windows',
      cwd: 'C:\\Users\\alex\\code\\reddit',
      appLink: true
    })
    expect(p.cwd).toBe('C:\\Users\\alex\\code\\reddit')
    expect(p.terminal).toBe('wt')
    // Codex runs where its .codex is: CODEX_HOME is that Windows folder, no wsl.exe.
    // The translated folder is given to Codex too (-C), or it asks which folder to use.
    expect(p.claudeCommand).toMatch(
      new RegExp(
        `^\\$env:CODEX_HOME = '${esc(winHome)}'; codex resume -C '?C:\\\\Users\\\\alex\\\\code\\\\reddit'? ${XID.mnt}$`
      )
    )
    expect(p.commandLine).not.toContain('wsl.exe')
    const r = await launcher.launch({ key: s.key, ...base })
    expect(r).toMatchObject({ ok: true, simulated: true })
    expect(r.commandLine).toContain('C:\\Users\\alex\\code\\reddit')
  })

  it('a Linux-only folder in the Windows .codex is not resumed unless opted in', async () => {
    const { sessions, launcher } = await crossSetup()
    const s = codexOf(sessions.list(), XID.home)
    const p = await launcher.preview({ key: s.key, ...base })
    expect(p.placement).toMatchObject({
      kind: 'wsl-only',
      cwd: '/home/alex/notes',
      distro: 'Ubuntu',
      distros: ['Ubuntu', 'Debian'],
      appLink: true
    })
    expect(p.launchError).toMatch(/Linux-only folder/)
    const r = await launcher.launch({ key: s.key, ...base })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Linux-only folder/)
  })

  it('opted in, Windows Codex runs in the WSL folder, always asking (never bypass)', async () => {
    const { sessions, launcher } = await crossSetup()
    const s = codexOf(sessions.list(), XID.home)
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\alex\\notes'
    // Bypass asked for: still off.
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: true,
      wslFolder: true
    })
    expect(p.launchError).toBeUndefined()
    expect(p.placement).toMatchObject({
      kind: 'wsl-only',
      optedIn: true,
      askForced: true,
      cwd: unc
    })
    expect(p.cwd).toBe(unc)
    // cmd (and so Windows Terminal) can't start in a \\… folder: PowerShell.
    expect(p.terminal).toBe('powershell')
    expect(p.terminalReason).toBe(WT_UNC_REASON)
    // Read-only sandbox: Codex has no policy that asks before every command.
    expect(p.claudeCommand).toContain('-a on-request -s read-only')
    expect(p.claudeCommand).toContain('-C ')
    expect(p.claudeCommand).not.toContain('dangerously')
    expect(p.commandLine).not.toContain('dangerously')
    const debian = await launcher.preview({
      key: s.key,
      ...base,
      wslFolder: true,
      distro: 'Debian'
    })
    expect(debian.cwd).toBe('\\\\wsl.localhost\\Debian\\home\\alex\\notes')
    const r = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: true,
      wslFolder: true
    })
    expect(r).toMatchObject({ ok: true, simulated: true })
    expect(r.commandLine).not.toContain('dangerously')
    // Never from a phone, even if asked.
    const phone = await launcher.launch(
      { key: s.key, ...base, wslFolder: true },
      { via: 'phone', device: 'Phone' }
    )
    expect(phone.ok).toBe(false)
    expect(phone.error).toMatch(/Linux-only folder/)
  })

  it('Continue fresh into a Linux-only folder keeps the forced read-only sandbox (never bypass)', async () => {
    const { sessions, launcher } = await crossSetup()
    const s = codexOf(sessions.list(), XID.home)
    sessions.setAiSummary(s.key, {
      done: ['Notes'],
      files: [],
      decisions: [],
      todos: [],
      pickUp: 'Go on.',
      generatedAt: '2026-10-22T11:00:00.000Z',
      messageCount: 1
    })
    // Not opted in: the dialog gets the same placement (opt-in, distros) and guidance as Resume.
    const p0 = await launcher.preview({ key: s.key, ...base, continueFresh: {} })
    expect(p0.placement).toMatchObject({ kind: 'wsl-only', distros: ['Ubuntu', 'Debian'] })
    expect(p0.launchError).toMatch(/Linux-only folder/)
    const r0 = await launcher.launch({ key: s.key, ...base, continueFresh: {} })
    expect(r0.ok).toBe(false)
    expect(r0.error).toMatch(/Linux-only folder/)
    // Opted in, bypass asked for: still read-only, asking, never the bypass flag.
    const opts = {
      key: s.key,
      fork: false,
      skipPermissions: true,
      wslFolder: true,
      continueFresh: {}
    }
    const p = await launcher.preview(opts)
    expect(p.continueError).toBeUndefined()
    expect(p.launchError).toBeUndefined()
    expect(p.placement).toMatchObject({ optedIn: true, askForced: true })
    expect(p.claudeCommand).toContain('-a on-request -s read-only')
    expect(p.claudeCommand).toContain('Read the handoff file')
    expect(p.claudeCommand).not.toContain('dangerously')
    expect(p.commandLine).not.toContain('dangerously')
    const r = await launcher.launch(opts)
    expect(r.ok).toBe(true)
    expect(r.commandLine).toContain('-s read-only')
    expect(r.commandLine).not.toContain('dangerously')
  })

  it('a Windows folder in a WSL .codex resumes in WSL, in /mnt/c/…', async () => {
    const { sessions, launcher } = await crossSetup()
    const s = codexOf(sessions.list(), XID.win)
    expect(s.env).toBe('wsl')
    const p = await launcher.preview({ key: s.key, ...base })
    expect(p.launchError).toBeUndefined()
    expect(p.placement).toMatchObject({
      kind: 'translated',
      runIn: 'wsl',
      cwd: '/mnt/c/Users/alex/code/win'
    })
    expect(p.placement?.appLink).toBeUndefined()
    expect(p.cwdExists).toBe(true)
    expect(p.commandLine).toContain('--cd /mnt/c/Users/alex/code/win')
    expect(p.claudeCommand).toMatch(/command codex resume -C '?\/mnt\/c\/Users\/alex\/code\/win'? /)
  })

  it('a WSL /mnt/c folder counts as there when Windows has it (\\\\wsl.localhost hides drive mounts)', async () => {
    const { sessions, launcher } = await crossSetup()
    const drive = await launcher.preview({ key: codexOf(sessions.list(), XID.wslMnt).key, ...base })
    expect(drive.placement).toBeUndefined()
    expect(drive.cwdExists).toBe(true)
    const gone = await launcher.preview({ key: codexOf(sessions.list(), XID.wslGone).key, ...base })
    expect(gone.cwdExists).toBe(false)
  })

  it('"Open terminal here" opens a Linux folder in WSL', async () => {
    const { sessions, launcher } = await crossSetup()
    const r = await launcher.openShell(codexOf(sessions.list(), XID.home).key)
    expect(r).toMatchObject({ ok: true, simulated: true })
    expect(r.commandLine).toContain('-d Ubuntu')
    expect(r.commandLine).toContain('/home/alex/notes')
  })

  it('without WSL, a /mnt/c folder still resumes on Windows; a Linux-only folder says why not', async () => {
    const { sessions, settings, layout } = await crossSetup()
    const noWsl = {
      ...createFixturesPlatform(layout.fixturesDir, layout.sourcesDir),
      listDistros: async () => [],
      defaultDistro: async () => undefined
    }
    const launcher = new Launcher(
      noWsl,
      sessions,
      () => 'wt',
      undefined,
      () => settings.value
    )
    // No WSL to confirm what /mnt/c/… is: never guessed, a folder has to be chosen.
    const key = codexOf(sessions.list(), XID.mnt).key
    const onDrive = await launcher.preview({ key, ...base })
    expect(onDrive.placement).toMatchObject({ runIn: 'windows', needsFolder: true })
    expect(onDrive.launchError).toMatch(/couldn't confirm/)
    const chosen = await launcher.preview({
      key,
      ...base,
      cwdOverride: 'C:\\Users\\alex\\code\\reddit'
    })
    expect(chosen.launchError).toBeUndefined()
    expect(chosen.claudeCommand).toContain('-C ')
    const linuxOnly = await launcher.preview({
      key: codexOf(sessions.list(), XID.home).key,
      ...base,
      wslFolder: true
    })
    expect(linuxOnly.launchError).toMatch(/No WSL distro/)
  })

  it('sessions whose folder matches their .codex are placed as before', async () => {
    const { sessions, launcher } = await crossSetup()
    for (const id of [ID.cli, ID.wsl]) {
      const p = await launcher.preview({ key: codexOf(sessions.list(), id).key, ...base })
      expect(p.placement).toBeUndefined()
    }
  })

  it('passes a translated folder with -C, and refuses one that could read as an option', () => {
    expect(codexArgs({ sessionId: ID.cli, fork: false, bypass: false, cd: 'C:\\x y' })).toEqual([
      'resume',
      '-C',
      'C:\\x y',
      ID.cli
    ])
    expect(() => codexArgs({ sessionId: ID.cli, fork: false, bypass: false, cd: '-rf' })).toThrow()
    expect(() => codexArgs({ sessionId: ID.cli, fork: false, bypass: false, cd: 'a\nb' })).toThrow()
  })

  it('opens the Codex app only with its own thread link', () => {
    const p = createCodexProvider()
    expect(p.launch.appLink?.(ID.cli)).toBe(`codex://threads/${ID.cli}`)
    expect(p.launch.appLink?.('not-an-id')).toBeUndefined()
  })
})

// ------------------------------------------------------- fourth review

describe('fourth review fixes', () => {
  const base = { fork: false, skipPermissions: false }

  it('a WSL folder run from Windows is read-only unless approved (no false "every command")', () => {
    expect(
      codexArgs({
        sessionId: ID.cli,
        fork: false,
        bypass: false,
        askPermissions: true,
        readOnly: true
      })
    ).toEqual(['resume', '-a', 'on-request', '-s', 'read-only', ID.cli])
    expect(
      codexArgs({ sessionId: ID.cli, fork: false, bypass: false, askPermissions: true })
    ).toEqual(['resume', '-a', 'on-request', '-s', 'workspace-write', ID.cli])
  })

  it('a /mnt folder that WSL says is a Linux folder is never taken for C:\\…', async () => {
    const t = await setup()
    const winHome = dirname(
      dirname(dirname(dirname(dirname(codexOf(t.sessions.list(), ID.cli).originalPath))))
    )
    const id = '019adddd-0000-7000-8000-00000000000d'
    const day = join(winHome, 'sessions', '2026', '10', '24')
    await mkdir(day, { recursive: true })
    await writeFile(
      join(day, `rollout-2026-10-24T10-00-00-${id}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: '/mnt/c/project', originator: 'Codex Desktop' }
      }) + '\n'
    )
    await t.sessions.rescan()
    // A custom wsl.conf: drives mounted elsewhere, so /mnt/c is a Linux folder.
    const customMounts = {
      ...createFixturesPlatform(t.layout.fixturesDir, t.layout.sourcesDir),
      wslWindowsPath: async (distro: string, p: string) =>
        `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`
    }
    const launcher = new Launcher(
      customMounts,
      t.sessions,
      () => 'wt',
      undefined,
      () => t.settings.value
    )
    const p = await launcher.preview({ key: codexOf(t.sessions.list(), id).key, ...base })
    expect(p.placement?.kind).toBe('wsl-only')
    expect(p.cwd).not.toBe('C:\\project')
  })

  it('pairs an older event with its item only when they are next to each other', () => {
    const ev = (type: string, message: string): string =>
      JSON.stringify({ type: 'event_msg', payload: { type, message } })
    const item = (role: string, text: string): string =>
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
        }
      })
    const filler = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'reasoning', summary: [{ text: `r${i}` }] }
      })
    )
    const text = [
      ev('user_message', 'yes'), // an older, event-only turn
      ev('agent_message', 'done'),
      ...filler,
      item('user', 'yes'), // a later, separate turn with the same text
      ev('user_message', 'yes'), // ... and its own event copy, right next to it
      item('assistant', 'ok')
    ].join('\n')
    const texts = buildCodexMessages(text)
      .filter((m) => m.role === 'user')
      .map((m) => (m.blocks[0] as { text: string }).text)
    expect(texts).toEqual(['yes', 'yes'])
  })

  it('a folder chosen in the dialog is given to Codex with -C', async () => {
    const { sessions, launcher } = await setup()
    const p = await launcher.preview({
      key: codexOf(sessions.list(), ID.cli).key,
      ...base,
      cwdOverride: 'C:\\Users\\alex\\code\\elsewhere'
    })
    expect(p.claudeCommand).toMatch(/resume -C '?C:\\Users\\alex\\code\\elsewhere'? /)
  })

  it('a -C folder cmd would expand (% or !) makes the launch use PowerShell', () => {
    const cmd = buildCodexLaunch({
      sessionId: ID.cli,
      fork: false,
      skipPermissions: false,
      terminal: 'cmd',
      tools: TOOLS,
      env: 'windows',
      cwd: 'C:\\work\\%USERNAME%',
      passCwd: true
    })
    expect(cmd).toMatchObject({ terminal: 'powershell', terminalReason: CMD_FOLDER_REASON })
    // Without -C the folder never reaches cmd's parser (cmd starts in it).
    const plain = buildCodexLaunch({
      sessionId: ID.cli,
      fork: false,
      skipPermissions: false,
      terminal: 'cmd',
      tools: TOOLS,
      env: 'windows',
      cwd: 'C:\\work\\%USERNAME%'
    })
    expect(plain.terminal).toBe('cmd')
  })

  it('the copied Windows command quotes its arguments for PowerShell', () => {
    const cmd = buildCodexLaunch({
      sessionId: ID.cli,
      fork: false,
      skipPermissions: false,
      terminal: 'powershell',
      tools: TOOLS,
      env: 'windows',
      cwd: "C:\\Users\\alex\\it's here",
      passCwd: true,
      agentEnv: { CODEX_HOME: 'C:\\Users\\alex\\.codex' }
    })
    expect(cmd.claudeCommand).toBe(
      `$env:CODEX_HOME = 'C:\\Users\\alex\\.codex'; codex resume -C 'C:\\Users\\alex\\it''s here' ${ID.cli}`
    )
  })

  it('keeps images only as their type (no image data in the compact text)', () => {
    const data = `data:image/png;base64,${'A'.repeat(200_000)}`
    const line = compactLine(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look at this' },
            { type: 'input_image', image_url: data }
          ]
        }
      })
    )!
    expect(line.length).toBeLessThan(1000)
    expect(JSON.parse(line).payload.content[1]).toEqual({ type: 'input_image' })
    const blocks = buildCodexMessages(line)[0].blocks
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
    const ev = compactLine(
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'hi', images: [data] }
      })
    )!
    expect(ev.length).toBeLessThan(1000)
  })

  it('an older, slower read of a rollout never replaces a newer one', async () => {
    const codex = createCodexProvider()
    const providers = new ProviderRegistry([claudeProvider, codex])
    const { sessions } = await setup({ providers })
    const s = codexOf(sessions.list(), ID.cli)
    const read = codex.readText
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    codex.readText = async (path, purpose) => {
      const n = ++calls
      const text = await read(path, purpose)
      if (n === 1) {
        await gate
        // The older read: one more message than the file has now.
        return (
          text +
          '\n' +
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'STALE PROMPT' }]
            }
          })
        )
      }
      return text
    }
    const fresh = s.messageCount
    await writeFile(s.originalPath, (await readFile(s.originalPath, 'utf8')) + '\n')
    const older = sessions.fileChanged(s.sourceId, s.originalPath)
    await new Promise((r) => setTimeout(r, 30))
    await writeFile(s.originalPath, (await readFile(s.originalPath, 'utf8')) + '\n')
    await sessions.fileChanged(s.sourceId, s.originalPath)
    release()
    await older
    expect(codexOf(sessions.list(), ID.cli).messageCount).toBe(fresh)
  })

  it('the archive estimate counts a record whose copy is gone as not archived', async () => {
    const { sessions, metadata } = await setup({ codexArchive: 'all' })
    const before = sessions.codexArchiveEstimate()
    expect(before.all.newBytes).toBe(0)
    const rec = Object.values(metadata.value.archive).find((r) => r.provider === 'codex')!
    await rm(rec.archivePath)
    const after = sessions.codexArchiveEstimate()
    expect(after.all.newBytes).toBeGreaterThan(0)
    expect(after.archived).toBe(before.archived - 1)
  })

  it('a restart re-reads only Codex sessions whose thread name changed since they were indexed', async () => {
    const t = await setup()
    await t.sessions.saveCache()
    const named = t.sessions.list().filter((s) => s.provider === 'codex' && s.claudeName)
    expect(named.length).toBeGreaterThan(0)
    // The app starts again on the same data, counting reads for the search index.
    const views: string[] = []
    const codex = createCodexProvider()
    const read = codex.readText.bind(codex)
    codex.readText = (p, purpose) => {
      if (purpose === 'view') views.push(p)
      return read(p, purpose)
    }
    const again = new SessionService(
      createFixturesPlatform(t.layout.fixturesDir, t.layout.sourcesDir),
      t.paths,
      t.metadata,
      t.settings,
      new ProviderRegistry([claudeProvider, codex])
    )
    busy.push(again)
    await again.start()
    await again.idle()
    await new Promise((r) => setTimeout(r, 200))
    // Every name is "new" to the restarted app, but none changed: nothing is read again.
    expect(views).toEqual([])
    const first = named[0]
    expect(again.searchKeys(first.claudeName!).map((h) => h.key)).toContain(first.key)

    // Renamed in Codex: only that session is read again, and found by its new name.
    const home = dirname(dirname(dirname(dirname(dirname(first.originalPath)))))
    await writeFile(
      join(home, 'session_index.jsonl'),
      (await readFile(join(home, 'session_index.jsonl'), 'utf8')) +
        JSON.stringify({
          id: first.sessionId,
          thread_name: 'Zebra renamed',
          updated_at: '2026-10-30T10:00:00Z'
        }) +
        '\n'
    )
    await again.pollSource(first.sourceId)
    await expect.poll(() => views.length).toBe(1)
    expect(views[0]).toBe(first.filePath)
    await expect
      .poll(() => again.searchKeys('Zebra renamed').map((h) => h.key))
      .toContain(first.key)
  })

  it('the same Codex name given again later counts as a change (newest wins)', async () => {
    const home = join(root, 'names-home')
    await mkdir(home, { recursive: true })
    const index = (at: string): string =>
      JSON.stringify({ id: ID.cli, thread_name: 'Fix login', updated_at: at }) + '\n'
    await writeFile(join(home, 'session_index.jsonl'), index('2026-10-20T10:00:00Z'))
    const names = new CodexNames()
    await names.refresh('codex-windows', home)
    await writeFile(join(home, 'session_index.jsonl'), index('2026-10-22T10:00:00Z') + '\n')
    expect(await names.refresh('codex-windows', home)).toEqual([ID.cli.toLowerCase()])
  })
})

// -------------------------------------------------------- fifth review

describe('fifth review fixes', () => {
  const base = { fork: false, skipPermissions: false }
  const homeOfS = (s: SessionSummary): string =>
    dirname(dirname(dirname(dirname(dirname(s.originalPath)))))
  async function withDesktopSession(cwd: string, id: string) {
    const t = await setup()
    const winHome = homeOfS(codexOf(t.sessions.list(), ID.cli))
    const day = join(winHome, 'sessions', '2026', '10', '25')
    await mkdir(day, { recursive: true })
    await writeFile(
      join(day, `rollout-2026-10-25T10-00-00-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd, originator: 'Codex Desktop' } }) +
        '\n'
    )
    await t.sessions.rescan()
    return t
  }

  it('translates a /mnt folder only when every distro agrees on the Windows folder', async () => {
    const id = '019aeeee-0000-7000-8000-00000000000e'
    const t = await withDesktopSession('/mnt/c/project', id)
    // Ubuntu mounts drives as usual; Debian has /mnt/c as a Linux folder.
    const disagree = {
      ...createFixturesPlatform(t.layout.fixturesDir, t.layout.sourcesDir),
      wslWindowsPath: async (distro: string, p: string) =>
        distro === 'Ubuntu'
          ? 'C:\\project'
          : `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`
    }
    const launcher = new Launcher(
      disagree,
      t.sessions,
      () => 'wt',
      undefined,
      () => t.settings.value
    )
    const p = await launcher.preview({ key: codexOf(t.sessions.list(), id).key, ...base })
    expect(p.placement?.needsFolder).toBe(true)
    expect(p.launchError).toMatch(/distros disagree/)
    // Both agree (the sample platform): translated.
    const agreed = await t.launcher.preview({ key: codexOf(t.sessions.list(), id).key, ...base })
    expect(agreed.placement).toMatchObject({ kind: 'translated', cwd: 'C:\\project' })
  })

  it("doesn't pair an older prompt with a later one across a reply", () => {
    const ev = (type: string, message: string): string =>
      JSON.stringify({ type: 'event_msg', payload: { type, message } })
    const item = (role: string, text: string): string =>
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role,
          content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
        }
      })
    const text = [
      ev('user_message', 'yes'),
      ev('agent_message', 'ok'),
      item('user', 'yes'),
      ev('user_message', 'yes'),
      item('assistant', 'done')
    ].join('\n')
    const users = buildCodexMessages(text)
      .filter((m) => m.role === 'user')
      .map((m) => (m.blocks[0] as { text: string }).text)
    expect(users).toEqual(['yes', 'yes'])
  })

  it('a rollout deleted during a read stays gone', async () => {
    const codex = createCodexProvider()
    const providers = new ProviderRegistry([claudeProvider, codex])
    const { sessions } = await setup({ providers })
    const s = codexOf(sessions.list(), ID.gap)
    const read = codex.readText
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    codex.readText = async (path, purpose) => {
      const text = await read(path, purpose)
      await gate
      return text
    }
    await writeFile(s.originalPath, (await readFile(s.originalPath, 'utf8')) + '\n')
    const inFlight = sessions.fileChanged(s.sourceId, s.originalPath)
    await new Promise((r) => setTimeout(r, 30))
    await rm(s.originalPath)
    await sessions.fileChanged(s.sourceId, s.originalPath)
    release()
    await inFlight
    expect(codexOf(sessions.list(), ID.gap)?.availability ?? 'gone').not.toBe('live')
  })

  it('recognises a Codex home by its contents (~/.codex2), never a Claude folder', async () => {
    const home2 = join(root, 'u', '.codex2')
    await mkdir(join(home2, 'sessions', '2026', '10'), { recursive: true })
    expect(await codexHomeIn(home2)).toBe(home2)
    const claude = join(root, 'u', '.claude')
    await mkdir(join(claude, 'sessions'), { recursive: true })
    expect(await codexHomeIn(claude)).toBeUndefined()
  })

  it('checks a WSL folder inside the distro, as the user Codex runs as', async () => {
    const t = await setup()
    const calls: (string | undefined)[][] = []
    const spy = {
      ...createFixturesPlatform(t.layout.fixturesDir, t.layout.sourcesDir),
      wslCanRead: async (distro: string, p: string, user?: string) => {
        calls.push([distro, p, user])
        return true
      }
    }
    const launcher = new Launcher(
      spy,
      t.sessions,
      () => 'wt',
      undefined,
      () => t.settings.value
    )
    const s = codexOf(t.sessions.list(), ID.wsl)
    const p = await launcher.preview({ key: s.key, ...base, cwdOverride: '/home/alex/private' })
    expect(p.cwdExists).toBe(true)
    expect(calls).toContainEqual([s.distro, '/home/alex/private', 'alex'])
  })

  it('a rollout cut at the reading limit counts as only partly searchable', async () => {
    const text = await readCodexText(CLI_FILE, 400)
    expect(analyzeCodex(text).searchPartial).toBe(true)
    expect(analyzeCodex(await readCodexText(CLI_FILE)).searchPartial).toBeUndefined()
  })

  it('turning a provider off updates the list at once', async () => {
    const { sessions, providers } = await setup()
    let changed = 0
    sessions.on('changed', () => changed++)
    providers.setEnabled({ claude: true, codex: false })
    sessions.dropDisabled()
    expect(changed).toBe(1)
    expect(sessions.list().some((x) => x.provider === 'codex')).toBe(false)
  })
})

describe('background re-reads and idle()', () => {
  it('idle() waits for a renamed thread to be read again, so nothing saves after a test ends', async () => {
    const t = await setup()
    const first = t.sessions.list().find((s) => s.provider === 'codex' && s.claudeName)!
    const home = dirname(dirname(dirname(dirname(dirname(first.originalPath)))))
    await writeFile(
      join(home, 'session_index.jsonl'),
      (await readFile(join(home, 'session_index.jsonl'), 'utf8')) +
        JSON.stringify({
          id: first.sessionId,
          thread_name: 'Okapi renamed',
          updated_at: '2026-10-30T10:00:00Z'
        }) +
        '\n'
    )
    // The rename is read again in the background: idle() waits for it.
    await t.sessions.pollSource(first.sourceId)
    await t.sessions.idle()
    expect(t.sessions.searchKeys('Okapi renamed').map((h) => h.key)).toContain(first.key)
    // And the cache was saved then: no save is left waiting to land later.
    const internals = t.sessions as unknown as { cacheTimer?: unknown; cacheDirty: boolean }
    expect(internals.cacheTimer).toBeUndefined()
    expect(internals.cacheDirty).toBe(false)
    // An edit here reads the session again in the background too.
    t.sessions.updateMeta(first.key, { description: 'Okapi notes' })
    await t.sessions.idle()
    expect(t.sessions.searchKeys('Okapi notes').map((h) => h.key)).toContain(first.key)
    expect(internals.cacheTimer).toBeUndefined()
  })
})
