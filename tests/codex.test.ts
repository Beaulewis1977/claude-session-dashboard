// Codex sessions (feature 5, Phase B): reading plain and zstd rollouts,
// parsing, thread names, metadata keys, archiving, launching, the provider
// switch and the provider on/off toggle. Runs on the sample Codex homes in
// fixtures/codex/ (scripts/make-codex-fixtures.mjs).

import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  isCredentialPath,
  readBytesOf,
  readCodexText
} from '../src/main/providers/codex/read'
import { CompactTextCache } from '../src/main/providers/codex/text-cache'
import { parseNameIndex } from '../src/main/providers/codex/sessions'
import { buildCodexLaunch, codexArgs } from '../src/main/providers/codex/launch'
import { detectCodexSource } from '../src/main/providers/codex/source'
import { remoteLaunchOptions } from '../src/main/mobile/remote-launch'
import { archiveSession } from '../src/main/core/archive'
import type { LaunchTools } from '../src/main/core/launch'

const FIXTURES = join(__dirname, '..', 'fixtures')
const CODEX = join(FIXTURES, 'codex', 'windows', 'Users', 'beau', '.codex')
const ID = {
  cli: '019a1111-0000-7000-8000-000000000001',
  desktop: '019a2222-0000-7000-8000-000000000002',
  sub: '019a3333-0000-7000-8000-000000000003',
  fork: '019a4444-0000-7000-8000-000000000004',
  old: '019a5555-0000-7000-8000-000000000005',
  gap: '019a6666-0000-7000-8000-000000000006',
  wsl: '019a7777-0000-7000-8000-000000000007'
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
  for (const s of busy.splice(0)) await s.idle()
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
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
    () => settings.value
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
    expect(zst.cwd).toBe('C:\\Users\\beau\\code\\marketing-site')
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
    expect(isCredentialPath('/home/beau/.codex/auth.json')).toBe(true)
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
      cwd: 'C:\\Users\\beau\\code\\shop api',
      version: '0.164.0',
      gitBranch: 'fix/checkout-totals',
      gitCommit: 'a1b2c3d4e5f6',
      gitRemote: 'https://example.com/beau/shop-api.git',
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
      sourceId: 'codex-wsl-Ubuntu-beau',
      cwd: '/home/beau/projects/dotfiles',
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
    expect(est.all.sessions).toBe(7)
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
  wt: 'C:\\Users\\beau\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  cmd: 'C:\\Windows\\System32\\cmd.exe',
  wsl: 'C:\\Windows\\System32\\wsl.exe',
  codex: 'C:\\Users\\beau\\AppData\\Roaming\\npm\\codex.cmd'
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
      cwd: 'C:\\Users\\beau\\code\\shop api'
    })
    expect(cmd.command).toBe(TOOLS.wt)
    expect(cmd.args).toEqual([
      '-d',
      'C:\\Users\\beau\\code\\shop api',
      TOOLS.cmd,
      '/s',
      '/k',
      `set NoDefaultCurrentDirectoryInExePath=1& "${TOOLS.codex}" resume ${ID.cli}`
    ])
    expect(cmd.claudeCommand).toBe(`codex resume ${ID.cli}`)
    const ps = buildCodexLaunch({
      ...base,
      env: 'windows',
      cwd: 'C:\\Users\\beau\\code\\shop api',
      terminal: 'powershell'
    })
    expect(ps.args[2]).toContain("Set-Location -LiteralPath 'C:\\Users\\beau\\code\\shop api';")
    expect(ps.args[2]).toContain(`& '${TOOLS.codex}' resume ${ID.cli}`)
    const plain = buildCodexLaunch({ ...base, env: 'windows', cwd: 'C:\\x y', terminal: 'cmd' })
    expect(plain).toMatchObject({ command: TOOLS.cmd, spawnCwd: 'C:\\x y', verbatim: true })
  })

  it('WSL: wsl.exe --cd the folder, codex through the login shell', () => {
    const cmd = buildCodexLaunch({
      ...base,
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/beau/my projects/dotfiles',
      fork: true,
      skipPermissions: true
    })
    expect(cmd.args).toEqual([
      TOOLS.wsl,
      '-d',
      'Ubuntu',
      '--cd',
      '/home/beau/my projects/dotfiles',
      '--',
      'bash',
      '-lic',
      `codex fork --dangerously-bypass-approvals-and-sandbox ${ID.cli}`
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
    expect(p.claudeCommand).toBe(
      `codex resume -m gpt-5.5-codex -c model_reasoning_effort=ultra --dangerously-bypass-approvals-and-sandbox ${ID.cli}`
    )
    expect(p.context).toBeUndefined()
    expect(launcher.modelChoice(s)).toMatchObject({
      model: 'gpt-5.5-codex',
      effort: 'ultra',
      modelFrom: 'settings'
    })
    for (const [what, opts] of [
      ['Branch from here', { branch: { at: 'x', mode: 'include' as const } }],
      ['Continue fresh', { continueFresh: {} }],
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
    ).toMatch(/^codex fork /)
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
    expect(wslHome.args.at(-1)).toBe(`CODEX_HOME='/data/my codex' codex resume ${ID.cli}`)
    const win = buildCodexLaunch({
      ...base,
      env: 'windows',
      cwd: 'C:\\x',
      agentEnv: { CODEX_HOME: 'D:\\Other Codex' }
    })
    expect(win.terminal).toBe('powershell')
    expect(win.args[2]).toContain("$env:CODEX_HOME = 'D:\\Other Codex';")
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
    const home = join(layout.sourcesDir, 'windows', 'Users', 'beau', '.codex')
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
