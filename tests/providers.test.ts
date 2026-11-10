// The provider layer: the registry, the Claude Code provider's contract (it is
// exactly the existing Claude modules), stored data staying as it was, and the
// generic services working with another provider (a stand-in, not Codex).

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBranchFile, planBranch } from '@shared/branch'
import { analyzeEvents, buildMessages, parseJsonl } from '@shared/jsonl'
import { parseHookEvent, parseRunningFile } from '@shared/live'
import { DEFAULT_PROVIDER, isProviderId, providerOf } from '@shared/provider'
import { handoffPrompt } from '@shared/summary'
import { parseBridgePayload } from '@shared/usage/bridge'
import { analyzeUsage } from '@shared/usage/parse'
import type { SourceInfo } from '@shared/types'
import { archivePathFor, archiveSession, archiveStats } from '../src/main/core/archive'
import { claudeArgs, claudeCommandLine, type ModelChoice } from '../src/main/core/launch'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { claudeProvider } from '../src/main/providers/claude'
import {
  catalogueProviders,
  defaultProviders,
  ProviderRegistry,
  sessionProvider
} from '../src/main/providers/registry'
import type { CliInput, SessionProvider } from '../src/main/providers/types'
import { envPaths } from '../src/main/services/bridge'
import { Launcher } from '../src/main/services/launcher'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { FIXTURES, read, SESSIONS, TOOLS } from './helpers'

const SAFARI = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'

let root: string
let busy: SessionService[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-providers-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

async function setup(
  providers?: ProviderRegistry,
  opts: { codexArchive?: 'off' | 'marked' | 'all' } = {}
) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
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
  const sessions = new SessionService(platform, paths, metadata, settings, providers)
  busy.push(sessions)
  const launcher = new Launcher(platform, sessions, () => 'wt')
  await sessions.start()
  await sessions.idle()
  await metadata.flush()
  return { sessions, launcher, paths, metadata }
}

describe('provider ids', () => {
  it('reads a missing provider as Claude Code, as all data stored before providers', () => {
    expect(DEFAULT_PROVIDER).toBe('claude')
    expect(providerOf(undefined)).toBe('claude')
    expect(providerOf({})).toBe('claude')
    expect(providerOf({ provider: 'codex' })).toBe('codex')
    expect(isProviderId('claude')).toBe(true)
    expect(isProviderId('codex')).toBe(true)
    expect(isProviderId('gpt')).toBe(false)
    expect(isProviderId(undefined)).toBe(false)
  })
})

describe('ProviderRegistry', () => {
  it('knows Claude Code by default, and nothing it was not given', () => {
    const r = defaultProviders()
    expect(r.all().map((p) => p.id)).toEqual(['claude'])
    expect(r.of(undefined)).toBe(claudeProvider)
    expect(r.of({ provider: 'claude' })).toBe(claudeProvider)
    expect(r.find({ provider: 'codex' })).toBeUndefined()
    expect(() => r.of({ provider: 'codex' })).toThrow(/Unknown provider: codex/)
  })

  it('refuses no providers, and the same provider twice', () => {
    expect(() => new ProviderRegistry([])).toThrow()
    expect(() => new ProviderRegistry([claudeProvider, claudeProvider])).toThrow(/twice/)
  })

  it('gives catalogue stand-ins without providers Claude Code', () => {
    expect(
      catalogueProviders({})
        .all()
        .map((p) => p.id)
    ).toEqual(['claude'])
    const s = { key: 'windows:x', sourceId: 'windows' }
    expect(sessionProvider({}, s)).toBe(claudeProvider)
    const other: SessionProvider = { ...claudeProvider, id: 'codex' }
    const reg = new ProviderRegistry([other])
    expect(sessionProvider({ providers: reg }, { ...s, provider: 'codex' })).toBe(other)
    // A catalogue that knows its sessions answers itself.
    expect(sessionProvider({ providerOf: () => other }, s)).toBe(other)
  })
})

describe('Claude Code provider: exactly the Claude modules', () => {
  const p = claudeProvider

  it('can do everything Claude Code can', () => {
    expect(p.id).toBe('claude')
    expect(p.productName).toBe('Claude Code')
    expect(Object.values(p.capabilities).every(Boolean)).toBe(true)
    expect(p.archiveExt).toBe('.jsonl')
    expect(p.limits).toBeDefined()
    expect(p.live).toBeDefined()
  })

  it('recognises session files only', () => {
    const file = join('C:', 'p', 'C--code-app', SAFARI + '.jsonl')
    expect(p.sessionFileOf(file)).toEqual({ sessionId: SAFARI, projectDir: 'C--code-app' })
    expect(p.sessionFileOf(join('p', 'C--code-app', 'notes.txt'))).toBeUndefined()
    expect(p.sessionFileOf(join('p', 'C--code-app', '.hidden.jsonl'))).toBeUndefined()
    expect(p.projectDirOf(file)).toBe('C--code-app')
  })

  it('parses, builds messages and search text like shared/jsonl', () => {
    const text = read(SESSIONS.safari)
    const file = {
      path: SESSIONS.safari,
      projectDir: 'C--Users-beau-code-acme-web',
      sessionId: SAFARI,
      size: text.length
    }
    const src = { id: 'windows', label: 'Windows', env: 'windows' as const }
    const { base, searchText } = p.parseSession(text, file, src)
    const { events } = parseJsonl(text)
    expect(base.key).toBe('windows:' + SAFARI)
    expect(base).not.toHaveProperty('provider')
    expect(searchText).toBe(analyzeEvents(events, { sessionId: SAFARI }).searchText)
    expect(p.searchText(text)).toBe(analyzeEvents(events).searchText)
    expect(p.buildMessages(text, base)).toEqual(buildMessages(events, base.cwd))
    expect(p.messageStarts(text).length).toBeGreaterThan(0)
  })

  it('builds the same claude command line as core/launch', () => {
    const model: ModelChoice = { model: 'opus', effort: 'high' }
    const cases: CliInput[] = [
      { sessionId: SAFARI, skipPermissions: true, fork: false },
      { sessionId: SAFARI, skipPermissions: false, fork: true },
      { sessionId: SAFARI, skipPermissions: false, fork: false, newSession: true },
      { sessionId: SAFARI, skipPermissions: false, fork: false, askPermissions: true },
      { sessionId: SAFARI, skipPermissions: true, fork: false, remoteControl: { name: 'x' } },
      { sessionId: SAFARI, skipPermissions: true, fork: false, modelChoice: model }
    ]
    for (const c of cases) {
      const args = claudeArgs(
        c.sessionId,
        c.skipPermissions,
        c.fork,
        c.newSession,
        c.remoteControl,
        c.askPermissions === true,
        c.modelChoice
      )
      expect(p.launch.commandLine(c)).toBe(claudeCommandLine(args))
    }
    expect(p.launch.cliMissing('windows', TOOLS)).toBe(false)
    expect(p.launch.cliMissing('windows', { ...TOOLS, claude: undefined })).toBe(true)
    // WSL runs `claude` from the login shell's PATH.
    expect(p.launch.cliMissing('wsl', { ...TOOLS, claude: undefined })).toBe(false)
    const handoff = 'C:\\data\\handoffs\\a.md'
    expect(p.launch.handoffPrompt(handoff)).toEqual(handoffPrompt(handoff))
  })

  it('plans and writes branches like shared/branch', () => {
    const text = read(SESSIONS.safari)
    const { events } = parseJsonl(text)
    const msgs = buildMessages(events)
    const at = msgs[Math.floor(msgs.length / 2)].id
    const plan = p.branching.plan(text, at, 'include')
    const want = planBranch(events, at, 'include')
    expect(plan.ok && want.ok).toBe(true)
    if (!plan.ok || !want.ok) return
    const { build, ...fields } = plan
    expect(fields).toEqual(want)
    const id = '0d1e2f3a-4b5c-4d6e-8f70-81920a1b2c3d'
    expect(build(id, SAFARI)).toBe(buildBranchFile(events, want, id, SAFARI))
    expect(p.branching.plan(text, 'no-such-message', 'include').ok).toBe(false)
  })

  it('reads usage, live files and limit readings with the shared readers', () => {
    const text = read(SESSIONS.safari)
    const ctx = {
      key: 'windows:' + SAFARI,
      project: 'acme-web',
      env: 'windows' as const,
      timeZone: 'UTC'
    }
    expect(p.usage.analyze(text, ctx)).toEqual(analyzeUsage(parseJsonl(text).events, ctx))
    const meta = { ts: 1, source: 'windows' }
    const running = JSON.stringify({ pid: 4242, sessionId: SAFARI, status: 'busy' })
    expect(p.live!.parseRunning(running)).toEqual(parseRunningFile(running))
    const hook = JSON.stringify({ session_id: SAFARI, hook_event_name: 'Stop' })
    expect(p.live!.parseHook(hook, meta)).toEqual(parseHookEvent(hook, meta))
    const status = JSON.stringify({
      session_id: SAFARI,
      rate_limits: { five_hour: { used_percentage: 40, resets_at: 2_000_000_000 } }
    })
    expect(p.limits!.parseReading(status, meta)).toEqual(parseBridgePayload(status, meta))
    const src: SourceInfo = {
      id: 'windows',
      label: 'Windows',
      env: 'windows',
      kind: 'auto',
      status: 'ok',
      projectsDir: join('C:', 'h', '.claude', 'projects'),
      sessionCount: 0,
      claudeSettingsPath: join('C:', 'h', '.claude', 'settings.json')
    }
    const e = envPaths(src)!
    expect(p.limits!.bridge(src)).toEqual({ home: e.home, bridgeDir: e.bridgeDir })
    expect(p.live!.dirs(src)).toMatchObject({
      home: e.home,
      sessionsDir: join('C:', 'h', '.claude', 'sessions')
    })
    expect(p.live!.hooksPossible(src)).toBe(true)
    expect(p.live!.hooksPossible({ ...src, kind: 'custom' })).toBe(false)
  })
})

describe('every session carries its provider; stored data stays as it was', () => {
  it('tags sessions and sources with Claude Code without writing it anywhere', async () => {
    const { sessions, paths } = await setup()
    const list = sessions.list()
    expect(list.length).toBeGreaterThan(5)
    expect(list.every((s) => s.provider === 'claude')).toBe(true)
    expect(sessions.payload().sources.every((s) => s.provider === 'claude')).toBe(true)
    // Not in the app's metadata or the session cache: their format is unchanged.
    expect(await readFile(paths.metadataFile, 'utf8')).not.toContain('"provider"')
    await sessions.saveCache()
    const cache = await readFile(join(paths.dataDir, 'cache', 'sessions-v13.json'), 'utf8')
    expect(cache).not.toContain('"provider"')
    // Archive copies where they always were.
    const rec = sessions.archiveRecord('windows:' + SAFARI)!
    expect(rec.archivePath).toBe(archivePathFor(paths.archiveDir, 'windows', SAFARI))
    expect(rec).not.toHaveProperty('provider')
  })

  it('leaves an archive record of a provider this version lacks alone', async () => {
    const paths = appPaths(fixturesLayout(root).dataDir)
    const metadata = createMetadataStore(paths)
    await metadata.load()
    const archivePath = join(paths.archiveDir, 'codex-windows', 'later.jsonl')
    const rec = {
      provider: 'codex' as const,
      sessionId: 'later',
      sourceId: 'codex-windows',
      sourceLabel: 'Windows',
      env: 'windows' as const,
      originalPath: join(root, 'gone', 'later.jsonl'),
      archivePath,
      size: 3,
      sha256: '',
      sourceMtimeMs: 0,
      firstArchivedAt: '2026-10-01T00:00:00.000Z',
      archivedAt: '2026-10-01T00:00:00.000Z'
    }
    metadata.update((d) => {
      d.archive['codex-windows:later'] = rec
    })
    await metadata.flush()
    await mkdir(join(paths.archiveDir, 'codex-windows'), { recursive: true })
    await writeFile(archivePath, '{}\n')
    const { sessions, metadata: again } = await setup()
    expect(sessions.get('codex-windows:later')).toBeUndefined()
    expect(again.value.archive['codex-windows:later']).toEqual(rec)
    expect(await readFile(archivePath, 'utf8')).toBe('{}\n')
  })

  it('records the provider only for sessions that are not Claude Code', async () => {
    const original = join(root, 'src', 'a.jsonl')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(original, '{"type":"user"}\n')
    const dataDir = join(root, 'appdata')
    const archiveDir = join(dataDir, 'archive')
    const base = {
      sessionId: 'a',
      sourceId: 's',
      sourceLabel: 'S',
      env: 'windows' as const,
      originalPath: original
    }
    const claude = await archiveSession(
      { ...base, provider: 'claude' },
      undefined,
      archiveDir,
      dataDir
    )
    expect(claude).not.toHaveProperty('provider')
    expect(claude!.archivePath).toBe(join(archiveDir, 's', 'a.jsonl'))
    const other = await archiveSession(
      { ...base, sessionId: 'b', provider: 'codex', ext: '.jsonl.zst' },
      undefined,
      archiveDir,
      dataDir
    )
    expect(other).toMatchObject({
      provider: 'codex',
      archivePath: join(archiveDir, 's', 'b.jsonl.zst')
    })
    expect(await archiveStats(archiveDir)).toMatchObject({ files: 1 })
    expect(await archiveStats(archiveDir, ['.jsonl', '.jsonl.zst'])).toMatchObject({ files: 2 })
  })
})

describe('the generic services with another provider (a stand-in)', () => {
  /** Claude Code's file format under another id and name, that can't fork or branch. */
  const standIn: SessionProvider = {
    ...claudeProvider,
    id: 'codex',
    productName: 'Stand-in agent',
    capabilities: {
      ...claudeProvider.capabilities,
      fork: false,
      branch: false,
      remoteControl: false
    },
    async detectSources(platform, opts) {
      return (await claudeProvider.detectSources(platform, opts))
        .filter((s) => s.id === 'windows')
        .map((s) => ({ ...s, id: 'other-windows', provider: 'codex' as const }))
    }
  }

  it('tags, archives and refuses by the provider', async () => {
    const { sessions, launcher, paths } = await setup(new ProviderRegistry([standIn]), {
      codexArchive: 'all'
    })
    const s = sessions.get('other-windows:' + SAFARI)!
    expect(s.provider).toBe('codex')
    const live = sessions.list().filter((x) => x.availability === 'live')
    expect(live.length).toBeGreaterThan(0)
    expect(live.every((x) => x.provider === 'codex')).toBe(true)
    // Archived under its own source, with the provider recorded.
    expect(sessions.archiveRecord(s.key)).toMatchObject({
      provider: 'codex',
      archivePath: archivePathFor(paths.archiveDir, 'other-windows', SAFARI)
    })

    const refused = (what: string): string => `${what} isn't available for Stand-in agent sessions.`
    const fork = await launcher.preview({ key: s.key, fork: true, skipPermissions: false })
    expect(fork.launchError).toBe(refused('Fork'))
    expect(await launcher.launch({ key: s.key, fork: true, skipPermissions: false })).toMatchObject(
      {
        ok: false,
        error: refused('Fork')
      }
    )
    expect(
      await launcher.launch({
        key: s.key,
        fork: false,
        skipPermissions: false,
        remoteControl: true
      })
    ).toMatchObject({ ok: false, error: refused('Remote Control') })
    const msgs = (await sessions.detail(s.key))!.messages
    const branch = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      branch: { at: msgs[2].id, mode: 'include' }
    })
    expect(branch.branchError).toBe(refused('Branch from here'))
    // Resume works (this stand-in builds Claude Code's command).
    const resume = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(resume.launchError).toBeUndefined()
    expect(resume.claudeCommand.endsWith('--resume ' + SAFARI)).toBe(true)
  })
})
