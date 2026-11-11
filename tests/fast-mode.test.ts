// Fast mode as a launch option: the flags per agent and platform, where the
// choice comes from (session → project → Settings), which models hide it,
// the app's own --settings file, Codex's model list, and every launch path
// (desktop, copied command, WSL, Remote Control, phone, API billing).

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLaunchCommand, claudeArgs, type LaunchInput } from '../src/main/core/launch'
import { codexArgs, codexContinueArgs } from '../src/main/providers/codex/launch'
import { CodexFastModels, fastModelsFrom } from '../src/main/providers/codex/fast-models'
import { ensureFastModeFile, fastModeFilePath } from '../src/main/core/fast-mode-file'
import { prepareFixtures, seedFixtureData, fixturesLayout } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { Launcher } from '../src/main/services/launcher'
import { SessionService } from '../src/main/services/sessions'
import { ProviderRegistry } from '../src/main/providers/registry'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import { codexHomeOf } from '../src/main/providers/codex/sessions'
import {
  appPaths,
  cleanMetaPatch,
  createMetadataStore,
  createSettingsStore
} from '../src/main/services/store'
import { remoteLaunchOptions, RemoteLauncher } from '../src/main/mobile/remote-launch'
import { phoneMetaPatch, phoneSettingsPatch } from '../src/main/mobile/rpc'
import {
  choiceLabel,
  claudeFastArgs,
  codexModelArgs,
  FAST_MODE_SETTINGS,
  fastSupport,
  launchModel,
  projectModelKey,
  promoteToProject,
  resolveModelChoice,
  sanitizeProjectModels,
  withFastSupport
} from '@shared/model-choice'
import { CLAUDE_FAST_API, CLAUDE_FAST_CREDITS, fastNotes } from '@shared/fast-notes'
import { MOBILE_SAFE_SETTINGS } from '@shared/mobile'
import { analyzeEvents, buildMessages, parseJsonl } from '@shared/jsonl'
import { planBranch } from '@shared/branch'
import { analyzeCodex } from '../src/main/providers/codex/parse'
import { FIXTURES, TOOLS } from './helpers'

const ID = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const FILE = 'C:\\Users\\alex\\AppData\\Roaming\\ClaudeSessionDashboard\\launch\\fast-mode.json'
const SPACES_FILE =
  'C:\\Users\\Alex Smith\\AppData\\Roaming\\ClaudeSessionDashboard\\launch\\fast-mode.json'
const SPACES = 'C:\\Users\\alex\\My Projects\\desktop app'

const launch = (o: Partial<LaunchInput> & Pick<LaunchInput, 'env' | 'cwd' | 'terminal'>) =>
  buildLaunchCommand({ sessionId: ID, fork: false, skipPermissions: false, tools: TOOLS, ...o })

describe('fast-mode flags', () => {
  it('Claude Code: --settings with the app file, before --resume and the other flags', () => {
    expect(
      claudeArgs(ID, true, true, false, undefined, false, {
        model: 'opus',
        effort: 'high',
        fast: true,
        fastSettingsFile: FILE
      })
    ).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
      '--settings',
      FILE,
      '--resume',
      ID,
      '--dangerously-skip-permissions',
      '--fork-session'
    ])
    // Off / unset: nothing.
    expect(claudeArgs(ID, false, false, false, undefined, false, { fast: false })).toEqual([
      '--resume',
      ID
    ])
    // New session, Remote Control + the asking mode (phone launches) first.
    expect(
      claudeArgs(ID, false, false, true, { name: 'My session' }, true, {
        fast: true,
        fastSettingsFile: FILE
      })
    ).toEqual([
      '--remote-control',
      'My session',
      '--permission-mode',
      'default',
      '--settings',
      FILE
    ])
  })

  it('Continue fresh: the first message stays first', () => {
    const args = claudeArgs(
      'x',
      false,
      false,
      false,
      undefined,
      false,
      { fast: true, fastSettingsFile: FILE },
      { newSessionId: ID, prompt: '@C:\\x\\handoffs\\a.md' }
    )
    expect(args[0]).toBe('@C:\\x\\handoffs\\a.md')
    expect(args.slice(1, 3)).toEqual(['--settings', FILE])
    expect(args).toContain('--session-id')
  })

  it('refuses a missing or unsafe settings path', () => {
    expect(() => claudeFastArgs(undefined)).toThrow(/isn't ready/)
    for (const bad of ['-x', 'C:\\a"b\\f.json', 'C:\\a&b\\f.json', 'C:\\%TEMP%\\f.json', 'a;b'])
      expect(() => claudeFastArgs(bad), bad).toThrow(/safely/)
    expect(claudeFastArgs(SPACES_FILE)).toEqual(['--settings', SPACES_FILE])
    expect(() => claudeArgs(ID, false, false, false, undefined, false, { fast: true })).toThrow()
  })

  it('Codex: -c service_tier=fast after the model and effort', () => {
    expect(codexModelArgs('gpt-6-sol', 'high', true)).toEqual([
      '-m',
      'gpt-6-sol',
      '-c',
      'model_reasoning_effort=high',
      '-c',
      'service_tier=fast'
    ])
    expect(codexModelArgs(undefined, undefined, false)).toEqual([])
    expect(
      codexArgs({ sessionId: ID, fork: false, bypass: false, modelChoice: { fast: true } })
    ).toEqual(['resume', '-c', 'service_tier=fast', ID])
    expect(
      codexArgs({ sessionId: ID, fork: true, bypass: true, modelChoice: { fast: true } })
    ).toEqual(['fork', '-c', 'service_tier=fast', '--dangerously-bypass-approvals-and-sandbox', ID])
    const cont = codexContinueArgs({
      prompt: 'Read C:\\x\\handoffs\\codex\\a.md',
      bypass: false,
      modelChoice: { fast: true }
    })
    expect(cont.slice(0, 2)).toEqual(['-c', 'service_tier=fast'])
    expect(cont[cont.length - 1]).toBe('Read C:\\x\\handoffs\\codex\\a.md')
  })
})

describe('fast-mode launch commands per terminal', () => {
  const fast = { fast: true, fastSettingsFile: SPACES_FILE }

  it('Windows Terminal + cmd: the path with spaces is quoted for cmd', () => {
    const c = launch({ env: 'windows', cwd: SPACES, terminal: 'wt', modelChoice: fast })
    expect(c.claudeArgs).toEqual(['--settings', SPACES_FILE, '--resume', ID])
    expect(c.args.join(' ')).toContain(`--settings "${SPACES_FILE}" --resume ${ID}`)
    expect(c.claudeCommand).toBe(`claude --settings '${SPACES_FILE}' --resume ${ID}`)
  })

  it('PowerShell and cmd', () => {
    for (const terminal of ['powershell', 'cmd'] as const) {
      const c = launch({ env: 'windows', cwd: SPACES, terminal, modelChoice: fast })
      expect(c.commandLine, terminal).toContain('--settings')
      expect(c.commandLine, terminal).toContain('fast-mode.json')
    }
  })

  it('WSL: the file as the distro sees it, quoted for bash', () => {
    const linux =
      '/mnt/c/Users/Alex Smith/AppData/Roaming/ClaudeSessionDashboard/launch/fast-mode.json'
    for (const terminal of ['wt', 'powershell', 'cmd'] as const) {
      const c = launch({
        env: 'wsl',
        distro: 'Ubuntu',
        cwd: '/home/alex/my app',
        terminal,
        modelChoice: { fast: true, fastSettingsFile: linux }
      })
      expect(c.claudeCommand, terminal).toBe(`claude --settings '${linux}' --resume ${ID}`)
      expect(c.command, terminal).not.toBe('')
    }
  })
})

describe('where the fast-mode choice comes from', () => {
  const cwd = 'C:\\Code\\App'
  const win = { env: 'windows' as const, cwd }
  const key = cwd.toLowerCase()

  it('session → project → Settings; "off" stops the search', () => {
    expect(resolveModelChoice({ fast: 'on' }, win, { defaultFast: 'off' })).toMatchObject({
      fast: true,
      fastFrom: 'session'
    })
    expect(
      resolveModelChoice({}, win, { projectModels: { [key]: { fast: 'on' } }, defaultFast: 'off' })
    ).toMatchObject({ fast: true, fastFrom: 'project' })
    expect(resolveModelChoice({}, win, { defaultFast: 'on' })).toMatchObject({
      fast: true,
      fastFrom: 'settings'
    })
    // An explicit Off on the session beats an On project default.
    const off = resolveModelChoice({ fast: 'off' }, win, {
      projectModels: { [key]: { fast: 'on' } },
      defaultFast: 'on'
    })
    expect(off.fast).toBeUndefined()
    expect(off.fastFrom).toBe('session')
    // A project Off beats Settings' On.
    expect(
      resolveModelChoice({}, win, { projectModels: { [key]: { fast: 'off' } }, defaultFast: 'on' })
        .fast
    ).toBeUndefined()
    // Nothing set (or Settings off): no fast mode, from nowhere.
    const none = resolveModelChoice({}, win, {})
    expect(none.fast).toBeUndefined()
    expect(none.fastFrom).toBeUndefined()
    expect(resolveModelChoice({}, win, { defaultFast: 'off' }).fast).toBeUndefined()
    // Junk is skipped.
    expect(resolveModelChoice({ fast: 'yes' }, win, { defaultFast: 'on' })).toMatchObject({
      fast: true,
      fastFrom: 'settings'
    })
  })

  it('saving: metadata, project defaults, promote, phone', () => {
    expect(cleanMetaPatch({ fast: 'on' })).toEqual({ fast: 'on' })
    expect(cleanMetaPatch({ fast: 'maybe' as never })).toEqual({ fast: undefined })
    expect(cleanMetaPatch({ fast: '' as never })).toEqual({ fast: undefined })
    expect(sanitizeProjectModels({ 'C:\\A': { fast: 'on' }, 'C:\\B': { fast: 'x' } })).toEqual({
      'c:\\a': { fast: 'on' }
    })
    expect(promoteToProject({ model: 'opus' }, { fast: 'on' })).toEqual({
      model: 'opus',
      fast: 'on'
    })
    expect(phoneMetaPatch({ fast: 'on', path: 'x' })).toEqual({ fast: 'on' })
    expect(MOBILE_SAFE_SETTINGS).toContain('defaultFast')
    expect(phoneSettingsPatch({ defaultFast: 'on', codexDefaultFast: 'on' })).toEqual({
      defaultFast: 'on'
    })
    expect(choiceLabel({ model: 'opus', effort: 'high', fast: true })).toBe('Opus · High · Fast')
    expect(choiceLabel({ fast: true })).toBe('Fast')
  })
})

describe('which models show fast mode', () => {
  it('Claude: Fable 5.2, Opus 5.5 and Opus 5 (and their aliases), nothing else', () => {
    for (const m of [
      'opus',
      'fable',
      'opus[1m]',
      'claude-opus-5-5',
      'claude-opus-5-5[1m]',
      'claude-fable-5-2',
      'claude-opus-5',
      'claude-opus-5-20260301'
    ])
      expect(fastSupport('claude', m), m).toBe('yes')
    for (const m of [
      'sonnet',
      'haiku',
      'opusplan',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'us.anthropic.claude-opus-5-5-v1:0'
    ])
      expect(fastSupport('claude', m), m).toBe('no')
    expect(fastSupport('claude', undefined)).toBe('unknown')
    expect(fastSupport('claude', 'default')).toBe('unknown')
  })

  it("Codex: the models whose entry in Codex's list offers Fast; unknown without the list", () => {
    expect(fastSupport('codex', 'gpt-6-sol', ['gpt-6-sol'])).toBe('yes')
    expect(fastSupport('codex', 'gpt-5.3-codex-spark', ['gpt-6-sol'])).toBe('no')
    expect(fastSupport('codex', 'gpt-6-sol', null)).toBe('unknown')
  })

  it('the model a launch runs on, and dropping fast where it has none', () => {
    expect(launchModel({ model: 'opus' }, { models: ['sonnet'] })).toBe('opus')
    expect(launchModel({}, { models: ['opus', 'sonnet'] })).toBe('sonnet')
    expect(launchModel({}, { models: ['opus'] }, true)).toBeUndefined()
    // opus → sonnet → opus: `models` lists each once (first seen), the last reply was opus.
    expect(launchModel({}, { models: ['opus', 'sonnet'], lastModel: 'opus' })).toBe('opus')
    expect(launchModel({}, { models: ['opus'], lastModel: 'opus' }, true)).toBeUndefined()
    const r = { fast: true, fastFrom: 'settings' as const }
    expect(withFastSupport(r, 'no').fast).toBeUndefined()
    expect(withFastSupport(r, 'unknown').fast).toBe(true)
    expect(withFastSupport(r, 'yes').fast).toBe(true)
  })

  it('the last model is the last reply, not the last new model', () => {
    const reply = (model: string, i: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `u${i}`,
        sessionId: 's',
        timestamp: `2026-11-10T10:0${i}:00Z`,
        message: { id: `m${i}`, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
        ...extra
      })
    const text = [
      reply('claude-opus-5-5', 1),
      reply('claude-sonnet-5-5', 2),
      reply('claude-opus-5-5', 3),
      // A subagent's reply in the main file never counts as the session's model.
      reply('claude-haiku-5-5', 4, { isSidechain: true })
    ].join('\n')
    const a = analyzeEvents(parseJsonl(text).events)
    expect(a.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(a.lastModel).toBe('claude-opus-5-5')
    expect(fastSupport('claude', launchModel({}, a))).toBe('yes')

    const turn = (model: string, i: number) =>
      JSON.stringify({
        timestamp: `2026-11-10T10:0${i}:00Z`,
        type: 'turn_context',
        payload: { model, cwd: 'C:\\x' }
      })
    const c = analyzeCodex(
      [
        JSON.stringify({
          timestamp: '2026-11-10T10:00:00Z',
          type: 'session_meta',
          payload: { id: '019a0000-0000-7000-8000-000000000001', cwd: 'C:\\x' }
        }),
        turn('gpt-6-sol', 1),
        turn('gpt-5.3-codex-spark', 2),
        turn('gpt-6-sol', 3)
      ].join('\n')
    )
    expect(c.models).toEqual(['gpt-6-sol', 'gpt-5.3-codex-spark'])
    expect(c.lastModel).toBe('gpt-6-sol')
  })

  it('a branch plan names the model of the last reply it keeps', () => {
    const ev = (o: Record<string, unknown>) => JSON.stringify({ sessionId: 's', ...o })
    const text = [
      ev({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-11-10T10:00:00Z',
        message: { role: 'user', content: 'a' }
      }),
      ev({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-11-10T10:00:01Z',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'x' }]
        }
      }),
      ev({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        timestamp: '2026-11-10T10:01:00Z',
        message: { role: 'user', content: 'b' }
      }),
      ev({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        timestamp: '2026-11-10T10:01:01Z',
        message: {
          id: 'm2',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: 'y' }]
        }
      })
    ].join('\n')
    const events = parseJsonl(text).events
    const msgs = buildMessages(events).filter((m) => m.role === 'assistant')
    const first = planBranch(events, msgs[0].id, 'include')
    expect(first).toMatchObject({ ok: true, lastModel: 'claude-opus-5-5' })
    const all = planBranch(events, msgs[1].id, 'include')
    expect(all).toMatchObject({ ok: true, lastModel: 'claude-sonnet-5-5' })
    // Nothing but the first prompt kept: no reply, no model.
    const before = planBranch(events, msgs[0].id, 'before')
    expect(before.ok && before.lastModel).toBeFalsy()
  })

  it("keeps each Codex home's list apart; an unreadable one stays unknown", async () => {
    const a = join(root, 'home-a')
    const b = join(root, 'home-b')
    await mkdir(a, { recursive: true })
    await writeFile(
      join(a, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-6-sol', service_tiers: [{ id: 'priority' }] }] })
    )
    const reader = new CodexFastModels(() => [
      { sourceId: 'win', home: a },
      { sourceId: 'wsl', home: b }
    ])
    expect(reader.latest()).toBeNull()
    expect(await reader.get()).toEqual({ win: ['gpt-6-sol'], wsl: null })
    expect(fastSupport('codex', 'gpt-6-sol', reader.latest()!.wsl)).toBe('unknown')
  })

  it("reads Codex's models_cache.json shape", () => {
    expect(
      fastModelsFrom({
        models: [
          { slug: 'gpt-6-sol', service_tiers: [{ id: 'priority', name: 'Fast' }] },
          { slug: 'gpt-6-luna', additional_speed_tiers: ['fast'] },
          { slug: 'gpt-5.3-codex-spark', service_tiers: [] },
          { slug: '-x', service_tiers: [{ id: 'priority' }] },
          null
        ]
      })
    ).toEqual(['gpt-6-luna', 'gpt-6-sol'])
    expect(fastModelsFrom({})).toBeUndefined()
    expect(fastModelsFrom(null)).toBeUndefined()
  })
})

describe('fast-mode notes', () => {
  const base = { fast: true, pauseAbovePct: 80 }
  it('Claude: usage credits (subscription) or API prices; none when off', () => {
    expect(fastNotes({ ...base, agent: 'claude' })).toEqual([
      { tone: 'info', text: CLAUDE_FAST_CREDITS }
    ])
    expect(fastNotes({ ...base, agent: 'claude', api: true })[0].text).toBe(CLAUDE_FAST_API)
    expect(fastNotes({ ...base, fast: false, agent: 'claude' })).toEqual([])
  })

  it('Codex: warns above the pause line (2.5×), not at or below it', () => {
    const at = (pct: number, expired = false) =>
      fastNotes({
        ...base,
        agent: 'codex',
        codexLimits: { fiveHour: { pct, expired } as never }
      })
    expect(at(85)[0]).toMatchObject({ tone: 'warn' })
    expect(at(85)[0].text).toContain('85%')
    expect(at(85)[0].text).toContain('2.5×')
    expect(at(80)[0].tone).toBe('info')
    expect(at(95, true)[0].tone).toBe('info')
    expect(fastNotes({ ...base, agent: 'codex', codexLimits: null })[0].tone).toBe('info')
  })

  it("opened in the agent's own app: not passed", () => {
    expect(fastNotes({ ...base, agent: 'claude', inApp: 'claude-app' })[0].text).toContain(
      "isn't passed"
    )
    expect(fastNotes({ ...base, agent: 'codex', inApp: 'codex-app' })[0].text).toContain(
      "isn't passed"
    )
  })
})

// --------------------------------------------- every launch path (fixtures)

let root: string
let busy: { idle(): Promise<void> }[] = []

async function setup(opts: { codex?: boolean } = {}) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, opts)
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const providers = new ProviderRegistry([claudeProvider, createCodexProvider()])
  const sessions = new SessionService(platform, paths, metadata, settings, providers)
  busy.push(sessions)
  const launcher = new Launcher(
    platform,
    sessions,
    () => settings.value.terminal,
    {
      keyFor: () => 'sk-ant-api03-test-key-not-real',
      label: () => 'API · Test',
      subscriptionLabel: () => 'Subscription',
      launched: () => undefined
    },
    () => settings.value,
    paths.dataDir
  )
  launcher.codexFastModels = new CodexFastModels(() =>
    sessions.sources
      .filter((s) => s.provider === 'codex' && s.status === 'ok')
      .map((s) => ({ sourceId: s.id, home: codexHomeOf(s) }))
  )
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, settings, paths, metadata }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-fast-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe("the app's fast-mode settings file", () => {
  it('holds only {"fastMode": true}, and is put back when anything else is in it', async () => {
    const dataDir = join(root, 'data')
    const path = await ensureFastModeFile(dataDir)
    expect(path).toBe(fastModeFilePath(dataDir))
    expect(await readFile(path, 'utf8')).toBe(FAST_MODE_SETTINGS)
    expect(JSON.parse(FAST_MODE_SETTINGS)).toEqual({ fastMode: true })
    // Someone added a setting: the next launch's file has only fast mode again.
    await writeFile(path, '{"fastMode": true, "permissions": {"allow": ["Bash"]}}')
    await ensureFastModeFile(dataDir)
    expect(await readFile(path, 'utf8')).toBe(FAST_MODE_SETTINGS)
  })
})

describe('Launcher: every launch path passes fast mode', () => {
  it('desktop preview, the copied command and the launch (Windows)', async () => {
    const { sessions, launcher, paths } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    sessions.updateMeta(s.key, { fast: 'on' })
    const file = fastModeFilePath(paths.dataDir)
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.modelChoice).toMatchObject({ model: 'opus', fast: true, fastFrom: 'session' })
    expect(p.launchError).toBeUndefined()
    expect(p.claudeCommand).toContain(`--settings `)
    expect(p.claudeCommand).toContain('fast-mode.json')
    expect(p.commandLine).toContain(file.replace(/\\/g, '\\'))
    expect(await readFile(file, 'utf8')).toBe(FAST_MODE_SETTINGS)
    const r = await launcher.launch({ key: s.key, fork: true, skipPermissions: false })
    expect(r.ok).toBe(true)
    expect(r.commandLine).toContain('--fork-session')
    expect(r.commandLine).toContain('fast-mode.json')
  })

  it('project and Settings defaults; Off on the session wins', async () => {
    const { sessions, launcher, settings } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    settings.update((st) => {
      st.defaultFast = 'on'
    })
    let p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.modelChoice).toMatchObject({ fast: true, fastFrom: 'settings' })
    settings.update((st) => {
      st.defaultFast = 'off'
      st.projectModels = { [projectModelKey(s)!]: { fast: 'on' } }
    })
    p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.modelChoice).toMatchObject({ fast: true, fastFrom: 'project' })
    sessions.updateMeta(s.key, { fast: 'off' })
    p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.modelChoice?.fast).toBeUndefined()
    expect(p.claudeCommand).not.toContain('--settings')
  })

  it('a model without fast mode gets no flag', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    sessions.updateMeta(s.key, { fast: 'on', model: 'sonnet' })
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.modelChoice?.fast).toBeUndefined()
    expect(p.claudeCommand).toBe(`claude --model sonnet --effort high --resume ${ID}`)
  })

  it('WSL: the file where the distro mounts the data folder', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.env === 'wsl' && x.availability === 'live')!
    sessions.updateMeta(s.key, { fast: 'on', model: 'opus' })
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.launchError).toBeUndefined()
    expect(p.claudeCommand).toMatch(
      new RegExp(`^claude --model opus --settings '?/mnt/[a-z]/\\S*fast-mode\\.json'? --resume `)
    )
    // The sample's folder isn't in the sample distro, so only the command is built here.
    expect(p.commandLine).toContain('wsl.exe')
    expect(p.commandLine).toContain('/launch/fast-mode.json')
  })

  it('phone launches (Remote Control, asking mode) and API billing', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    // Set from the phone like any other edit.
    sessions.updateMeta(s.key, phoneMetaPatch({ fast: 'on' }))
    const opts = remoteLaunchOptions({ key: s.key, kind: 'resume' }, 'wt')
    const r = await launcher.launch(opts, { via: 'phone', device: 'Test phone' })
    expect(r.ok).toBe(true)
    expect(r.commandLine).toContain('--remote-control')
    expect(r.commandLine).toMatch(
      /--permission-mode default --model opus --effort high --settings .*fast-mode\.json/
    )
    const api = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      billingAccountId: 'acct-test'
    })
    expect(api.ok).toBe(true)
    expect(api.commandLine).toContain('fast-mode.json')
    expect(api.commandLine).not.toContain('sk-ant')
  })

  it('New session and Continue fresh pass it too; a branch inherits it', async () => {
    const { sessions, launcher, metadata } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    sessions.updateMeta(s.key, { fast: 'on' })
    const n = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      newSession: true
    })
    expect(n.claudeCommand).toMatch(
      /^claude --model opus --effort high --settings \S*fast-mode\.json/
    )
    sessions.recordBranch(
      'b0b0b0b0-0000-4000-8000-000000000001',
      { parentSessionId: ID, parentKey: s.key, via: 'continue', createdAt: '2026-11-10T00:00:00Z' },
      'Continued',
      { model: 'opus', fast: 'on' }
    )
    expect(metadata.value.sessions['b0b0b0b0-0000-4000-8000-000000000001']?.fast).toBe('on')
  })

  it("Continue fresh and New session go by the new session's model, not the last one used", async () => {
    const { sessions, launcher, metadata } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    // The sample's replies are all Sonnet 4.5 (no fast mode); no model of its own.
    expect(s.lastModel).toBe('claude-sonnet-4-5-20250929')
    sessions.updateMeta(s.key, { fast: 'on', model: '' })
    metadata.update((d) => {
      const k = sessions.metaKeyOf(s)
      d.sessions[k] = {
        ...d.sessions[k],
        aiSummary: {
          done: ['Fixed the login loop'],
          files: [],
          decisions: [],
          todos: [],
          pickUp: 'Test it.',
          generatedAt: '2026-11-10T10:00:00.000Z',
          messageCount: 2
        }
      }
    })
    // Resume continues on Sonnet 4.5: no flag.
    const r = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(r.modelChoice?.fast).toBeUndefined()
    expect(r.claudeCommand).not.toContain('--settings')
    // A new session runs on Claude Code's own default: the model isn't known, so it's passed.
    const c = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(c.continueError).toBeUndefined()
    expect(c.modelChoice?.fast).toBe(true)
    expect(c.claudeCommand).toContain('fast-mode.json')
    const n = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      newSession: true
    })
    expect(n.modelChoice?.fast).toBe(true)
    expect(n.claudeCommand).toContain('fast-mode.json')
    // And from the phone.
    const phoneOpts = remoteLaunchOptions({ key: s.key, kind: 'continue' }, 'wt')
    const pc = await launcher.preview(phoneOpts)
    expect(pc.claudeCommand).toContain('fast-mode.json')
    // A chosen model without fast mode still drops it, new session or not.
    sessions.updateMeta(s.key, { model: 'sonnet' })
    const cs = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(cs.claudeCommand).not.toContain('--settings')
  })

  it("Codex: -c service_tier=fast on a model in Codex's list, nothing on one that isn't", async () => {
    const { sessions, launcher, settings } = await setup({ codex: true })
    settings.update((st) => {
      st.providers = { claude: true, codex: true }
    })
    const s = sessions.list().find((x) => x.provider === 'codex' && x.env === 'windows')
    expect(s, 'a Windows Codex sample session').toBeDefined()
    const home = codexHomeOf(sessions.source(s!.sourceId)!)
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-6-sol', service_tiers: [{ id: 'priority', name: 'Fast' }] },
          { slug: 'gpt-5.3-codex-spark', service_tiers: [] }
        ]
      })
    )
    sessions.updateMeta(s!.key, { fast: 'on', model: 'gpt-6-sol' })
    let p = await launcher.preview({ key: s!.key, fork: false, skipPermissions: false })
    expect(p.modelChoice).toMatchObject({ fast: true })
    expect(p.commandLine).toContain('-m gpt-6-sol -c service_tier=fast')
    sessions.updateMeta(s!.key, { model: 'gpt-5.3-codex-spark' })
    p = await launcher.preview({ key: s!.key, fork: false, skipPermissions: false })
    expect(p.modelChoice?.fast).toBeUndefined()
    expect(p.commandLine).not.toContain('service_tier')
    // Codex's defaults are its own: Claude Code's Settings default doesn't apply.
    sessions.updateMeta(s!.key, { fast: '' as never, model: 'gpt-6-sol' })
    settings.update((st) => {
      st.defaultFast = 'on'
    })
    p = await launcher.preview({ key: s!.key, fork: false, skipPermissions: false })
    expect(p.commandLine).not.toContain('service_tier')
    settings.update((st) => {
      st.codexDefaultFast = 'on'
    })
    p = await launcher.preview({ key: s!.key, fork: false, skipPermissions: false })
    expect(p.commandLine).toContain('service_tier=fast')

    // A home whose list can't be read (the WSL sample has none) is never judged by the
    // Windows home's list: unknown there, so the flag stays even for a model that list lacks.
    const w = sessions.list().find((x) => x.provider === 'codex' && x.env === 'wsl')
    expect(w, 'a WSL Codex sample session').toBeDefined()
    expect(launcher.codexFastModels!.latest()).toMatchObject({
      [s!.sourceId]: ['gpt-6-sol'],
      [w!.sourceId]: null
    })
    sessions.updateMeta(w!.key, { fast: 'on', model: 'gpt-5.3-codex-spark' })
    const pw = await launcher.preview({ key: w!.key, fork: false, skipPermissions: false })
    expect(pw.modelChoice?.fast).toBe(true)
    expect(pw.claudeCommand).toContain('-m gpt-5.3-codex-spark -c service_tier=fast')
  })

  it("the phone's branch preview names the kept model, and nothing else of the branch", async () => {
    const s = { key: 'windows:s1', sessionId: 's1', title: 'T', availability: 'live', meta: {} }
    const rl = new RemoteLauncher({
      session: (k) => (k === s.key ? (s as never) : undefined),
      preview: async () => ({
        commandLine: 'x',
        claudeCommand: 'claude',
        terminal: 'wt',
        fellBack: false,
        cwd: 'C:\\code',
        cwdExists: true,
        willRestore: false,
        restoreImpossible: false,
        originalPath: 'C:\\x.jsonl',
        billingLabel: 'Subscription',
        modelChoice: { modelFrom: 'none', effortFrom: 'none', fast: true, fastFrom: 'session' },
        branch: {
          newSessionId: 'b1',
          targetPath: 'C:\\Users\\alex\\.claude\\projects\\x\\b1.jsonl',
          atMessageId: 'm1',
          atRole: 'assistant',
          atPreview: 'Done.',
          snapped: 'none',
          snapTools: [],
          keptMessages: 2,
          totalMessages: 4,
          name: 'T (branch)',
          lastModel: 'claude-opus-5-5'
        }
      }),
      launch: async () => ({ ok: true, restored: false, commandLine: 'x' }),
      settings: () => ({
        terminal: 'wt',
        readOnly: false,
        confirmOnPc: false,
        branchConfirmed: true
      }),
      confirm: async () => true,
      deviceActive: () => true,
      log: () => undefined,
      now: () => Date.now()
    })
    const p = await rl.preview({
      key: s.key,
      kind: 'branch',
      branch: { at: 'm1', mode: 'include' }
    })
    expect(p.branch).toEqual({ lastModel: 'claude-opus-5-5' })
    expect(JSON.stringify(p)).not.toContain('.claude')
  })

  it('Branch from here: the branch keeps the Fast choice, and goes by the model it keeps', async () => {
    const { sessions, launcher, metadata } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    // A session that ran on Opus 5.5, then moved to Sonnet 4.5 (no fast mode).
    const id = 'f0f0f0f0-0000-4000-8000-0000000000aa'
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: id, cwd: s.cwd, version: '2.1.322', ...o })
    const say = (uuid: string, parent: string | null, t: string, text: string) =>
      line({
        type: 'user',
        uuid,
        parentUuid: parent,
        timestamp: t,
        message: { role: 'user', content: text }
      })
    const reply = (uuid: string, parent: string, t: string, model: string) =>
      line({
        type: 'assistant',
        uuid,
        parentUuid: parent,
        timestamp: t,
        message: {
          id: `msg_${uuid}`,
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'Done.' }]
        }
      })
    const text = [
      say('u1', null, '2026-11-10T10:00:00Z', 'Fix the login loop'),
      reply('a1', 'u1', '2026-11-10T10:00:05Z', 'claude-opus-5-5'),
      say('u2', 'a1', '2026-11-10T10:01:00Z', 'Now the tests'),
      reply('a2', 'u2', '2026-11-10T10:01:05Z', 'claude-sonnet-4-5-20250929')
    ].join('\n')
    const path = join(dirname(s.originalPath), `${id}.jsonl`)
    await writeFile(path, text + '\n')
    const two = (await sessions.loadNew(s.sourceId, path))!
    expect(two.lastModel).toBe('claude-sonnet-4-5-20250929')
    sessions.updateMeta(two.key, { fast: 'on' })

    // Resuming it continues on Sonnet: no flag.
    const r = await launcher.preview({ key: two.key, fork: false, skipPermissions: false })
    expect(r.claudeCommand).not.toContain('--settings')
    // A branch at the Opus reply keeps only that part: it resumes on Opus 5.5, so fast applies.
    const detail = await sessions.detail(two.key)
    const opusReply = detail!.messages.find((m) => m.role === 'assistant')!.id
    const at = { at: opusReply, mode: 'include' as const }
    const b = await launcher.preview({
      key: two.key,
      fork: false,
      skipPermissions: false,
      branch: at
    })
    expect(b.branchError).toBeUndefined()
    expect(b.branch?.lastModel).toBe('claude-opus-5-5')
    expect(b.modelChoice?.fast).toBe(true)
    expect(b.claudeCommand).toContain('fast-mode.json')

    // Creating it: the new session keeps the parent's own Fast choice (On, then Off).
    for (const fast of ['on', 'off'] as const) {
      sessions.updateMeta(two.key, { fast })
      const created = await launcher.branches.create(sessions.get(two.key)!, at)
      expect(metadata.value.sessions[sessions.metaKeyOf(created)]?.fast, fast).toBe(fast)
      expect(created.lastModel).toBe('claude-opus-5-5')
    }
  })
})
