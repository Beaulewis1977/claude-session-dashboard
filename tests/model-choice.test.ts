// Per-session model and effort for launches: the flags, where the choice
// comes from (session → project → Settings), and every launch path.

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLaunchCommand, claudeArgs, type LaunchInput } from '../src/main/core/launch'
import { prepareFixtures, seedFixtureData, fixturesLayout } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { Launcher } from '../src/main/services/launcher'
import { SessionService } from '../src/main/services/sessions'
import {
  appPaths,
  cleanMetaPatch,
  createMetadataStore,
  createSettingsStore
} from '../src/main/services/store'
import { remoteLaunchOptions } from '../src/main/mobile/remote-launch'
import { phoneMetaPatch, phoneSettingsPatch } from '../src/main/mobile/rpc'
import {
  choiceLabel,
  cleanEffortChoice,
  cleanModelChoice,
  isValidModel,
  modelArgs,
  modelLabel,
  modelsSeen,
  resolveModelChoice,
  sanitizeProjectModels
} from '@shared/model-choice'
import { MOBILE_SAFE_SETTINGS } from '@shared/mobile'
import { DEFAULT_SETTINGS } from '@shared/types'
import { FIXTURES, TOOLS } from './helpers'

const ID = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const CMD = TOOLS.cmd
const PS = TOOLS.powershell
const WT = TOOLS.wt!
const WSL = TOOLS.wsl
const CLAUDE = TOOLS.claude!
const SPACES = 'C:\\Users\\beau\\My Projects\\desktop app'

const launch = (o: Partial<LaunchInput> & Pick<LaunchInput, 'env' | 'cwd' | 'terminal'>) =>
  buildLaunchCommand({ sessionId: ID, fork: false, skipPermissions: false, tools: TOOLS, ...o })

describe('model and effort flags', () => {
  it('"Default" adds no flags', () => {
    expect(modelArgs()).toEqual([])
    expect(modelArgs('default', 'default')).toEqual([])
    expect(claudeArgs(ID, false, false, false, undefined, false, {})).toEqual(['--resume', ID])
    expect(claudeArgs(ID, true, true, false, undefined, false, {})).toEqual(
      claudeArgs(ID, true, true)
    )
    const cmd = launch({ env: 'windows', cwd: SPACES, terminal: 'wt', modelChoice: {} })
    expect(cmd.claudeArgs).not.toContain('--model')
    expect(cmd.claudeArgs).not.toContain('--effort')
  })

  it('puts --model and --effort before --resume, and before the other flags', () => {
    expect(
      claudeArgs(ID, true, true, false, undefined, false, { model: 'opus', effort: 'high' })
    ).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
      '--resume',
      ID,
      '--dangerously-skip-permissions',
      '--fork-session'
    ])
    expect(claudeArgs(ID, false, false, false, undefined, false, { effort: 'max' })).toEqual([
      '--effort',
      'max',
      '--resume',
      ID
    ])
    // New session: no --resume, but the same flags.
    expect(claudeArgs(ID, false, false, true, undefined, false, { model: 'sonnet' })).toEqual([
      '--model',
      'sonnet'
    ])
  })

  it('goes after Remote Control and the permission mode (phone launches)', () => {
    expect(
      claudeArgs(ID, false, false, false, { name: 'My session' }, true, {
        model: 'opus',
        effort: 'xhigh'
      })
    ).toEqual([
      '--remote-control',
      'My session',
      '--permission-mode',
      'default',
      '--model',
      'opus',
      '--effort',
      'xhigh',
      '--resume',
      ID
    ])
  })

  it('refuses models and levels that could be read as shell syntax or a flag', () => {
    for (const bad of [
      'opus; rm -rf ~',
      '$(whoami)',
      '`id`',
      'opus"',
      "opus'",
      'opus & calc',
      'opus|x',
      '%PATH%',
      '!x!',
      '-p',
      '--dangerously-skip-permissions',
      'a b',
      'opus\nrm',
      ''
    ]) {
      expect(isValidModel(bad), bad).toBe(false)
      expect(() => modelArgs(bad), bad).toThrow()
    }
    expect(() => modelArgs(undefined, 'ultra')).toThrow()
    expect(() => modelArgs(undefined, 'high; rm')).toThrow()
  })

  it('accepts aliases, full IDs, [1m], Vertex and Bedrock forms', () => {
    for (const ok of [
      'opus',
      'sonnet[1m]',
      'opusplan',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5@20250929',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123'
    ])
      expect(isValidModel(ok), ok).toBe(true)
  })
})

describe('launch commands with a model and effort', () => {
  const choice = { model: 'claude-opus-4-5-20251101', effort: 'high' as const }

  it('Windows Terminal + cmd (path with spaces)', () => {
    const cmd = launch({
      env: 'windows',
      cwd: SPACES,
      terminal: 'wt',
      skipPermissions: true,
      modelChoice: choice
    })
    expect(cmd.command).toBe(WT)
    expect(cmd.args).toEqual([
      '-d',
      SPACES,
      CMD,
      '/s',
      '/k',
      `"${CLAUDE}" --model claude-opus-4-5-20251101 --effort high --resume ${ID} --dangerously-skip-permissions`
    ])
    expect(cmd.claudeCommand).toBe(
      `claude --model claude-opus-4-5-20251101 --effort high --resume ${ID} --dangerously-skip-permissions`
    )
    // The copied command has the same flags.
    expect(cmd.commandLine).toContain('--model claude-opus-4-5-20251101 --effort high --resume')
  })

  it('PowerShell (path with spaces)', () => {
    const cmd = launch({ env: 'windows', cwd: SPACES, terminal: 'powershell', modelChoice: choice })
    expect(cmd.command).toBe(PS)
    expect(cmd.args[2]).toBe(
      `Set-Location -LiteralPath '${SPACES}'; & '${CLAUDE}' --model claude-opus-4-5-20251101 --effort high --resume ${ID}`
    )
    expect(cmd.spawnCwd).toBe(SPACES)
  })

  it('cmd (path with spaces)', () => {
    const cmd = launch({ env: 'windows', cwd: SPACES, terminal: 'cmd', modelChoice: choice })
    expect(cmd.command).toBe(CMD)
    expect(cmd.args).toEqual([
      '/s',
      '/k',
      `""${CLAUDE}" --model claude-opus-4-5-20251101 --effort high --resume ${ID}"`
    ])
  })

  it('quotes a model with brackets for every shell', () => {
    const m = { model: 'sonnet[1m]' }
    expect(launch({ env: 'windows', cwd: SPACES, terminal: 'cmd', modelChoice: m }).args[2]).toBe(
      `""${CLAUDE}" --model "sonnet[1m]" --resume ${ID}"`
    )
    expect(
      launch({ env: 'windows', cwd: SPACES, terminal: 'powershell', modelChoice: m }).args[2]
    ).toContain(`--model 'sonnet[1m]' --resume`)
    // bash would expand [1m] as a glob without quotes.
    expect(
      launch({ env: 'wsl', distro: 'Ubuntu', cwd: '/home/beau/x', terminal: 'wt', modelChoice: m })
        .claudeCommand
    ).toBe(`claude --model 'sonnet[1m]' --resume ${ID}`)
  })

  it('WSL in every terminal (path with spaces)', () => {
    const cwd = '/home/beau/My Projects/orders api'
    const line = `claude --model opus --effort medium --resume ${ID} --fork-session`
    const m = { model: 'opus', effort: 'medium' as const }
    const wt = launch({
      env: 'wsl',
      distro: 'Ubuntu',
      cwd,
      terminal: 'wt',
      fork: true,
      modelChoice: m
    })
    expect(wt.args).toEqual([WSL, '-d', 'Ubuntu', '--cd', cwd, '--', 'bash', '-lic', line])
    const ps = launch({
      env: 'wsl',
      distro: 'Ubuntu',
      cwd,
      terminal: 'powershell',
      fork: true,
      modelChoice: m
    })
    expect(ps.args[2]).toBe(`& '${WSL}' -d 'Ubuntu' --cd '${cwd}' -- bash -lic '${line}'`)
    const cmd = launch({
      env: 'wsl',
      distro: 'Ubuntu',
      cwd,
      terminal: 'cmd',
      fork: true,
      modelChoice: m
    })
    expect(cmd.args[2]).toBe(`""${WSL}" -d Ubuntu --cd "${cwd}" -- bash -lic "${line}""`)
  })

  it('never builds a command with an unsafe model', () => {
    expect(() =>
      launch({ env: 'windows', cwd: SPACES, terminal: 'wt', modelChoice: { model: 'x;calc' } })
    ).toThrow()
  })
})

describe('where the choice comes from', () => {
  const cwd = 'C:\\Users\\beau\\code\\acme-web'
  const settings = {
    defaultModel: 'sonnet',
    defaultEffort: 'medium' as const,
    projectModels: { [cwd.toLowerCase()]: { model: 'opus' } }
  }

  it('session → project → Settings', () => {
    expect(resolveModelChoice({ model: 'haiku', effort: 'max' }, cwd, settings)).toEqual({
      model: 'haiku',
      effort: 'max',
      modelFrom: 'session',
      effortFrom: 'session'
    })
    // No session choice: the project's model, Settings' effort.
    expect(resolveModelChoice({}, cwd, settings)).toEqual({
      model: 'opus',
      effort: 'medium',
      modelFrom: 'project',
      effortFrom: 'settings'
    })
    // Another project: Settings only.
    expect(resolveModelChoice(undefined, 'D:\\other', settings)).toMatchObject({
      model: 'sonnet',
      modelFrom: 'settings'
    })
  })

  it('matches the project folder case-insensitively', () => {
    expect(resolveModelChoice({}, cwd.toUpperCase(), settings).model).toBe('opus')
  })

  it('"default" stops the search: no flag, whatever comes after', () => {
    expect(resolveModelChoice({ model: 'default' }, cwd, settings)).toMatchObject({
      model: undefined,
      modelFrom: 'session'
    })
    expect(
      resolveModelChoice({}, cwd, {
        ...settings,
        projectModels: { [cwd.toLowerCase()]: { effort: 'default' } }
      })
    ).toMatchObject({ effort: undefined, effortFrom: 'project' })
  })

  it("Claude Code's default when nothing is set (the app's own defaults)", () => {
    expect(resolveModelChoice({}, cwd, DEFAULT_SETTINGS)).toEqual({
      model: undefined,
      effort: undefined,
      modelFrom: 'none',
      effortFrom: 'none'
    })
    expect(resolveModelChoice(undefined, undefined, {})).toMatchObject({ modelFrom: 'none' })
  })

  it('skips stored values that are not safe or known', () => {
    expect(
      resolveModelChoice({ model: 'x; calc', effort: 'ultra' as never }, cwd, settings)
    ).toMatchObject({ model: 'opus', modelFrom: 'project', effort: 'medium' })
  })
})

describe('saving the choice', () => {
  it('metadata patches keep valid choices and clear the rest', () => {
    expect(cleanMetaPatch({ model: ' opus ', effort: 'high' })).toEqual({
      model: 'opus',
      effort: 'high'
    })
    expect(cleanMetaPatch({ model: 'Default', effort: 'default' })).toEqual({
      model: 'default',
      effort: 'default'
    })
    expect(cleanMetaPatch({ model: '', effort: '' as never })).toEqual({
      model: undefined,
      effort: undefined
    })
    expect(cleanMetaPatch({ model: '$(id)', effort: 'turbo' as never })).toEqual({
      model: undefined,
      effort: undefined
    })
    expect(cleanModelChoice(42)).toBeUndefined()
    expect(cleanEffortChoice(null)).toBeUndefined()
  })

  it('project defaults are validated and keyed by lower-cased folder', () => {
    expect(
      sanitizeProjectModels({
        'C:\\Code\\App': { model: 'opus', effort: 'low' },
        '/home/beau/x': { model: 'rm -rf /', effort: 'nope' },
        '/home/beau/y': { effort: 'default' },
        bad: 'opus'
      })
    ).toEqual({
      'c:\\code\\app': { model: 'opus', effort: 'low' },
      '/home/beau/y': { effort: 'default' }
    })
    expect(sanitizeProjectModels(null)).toEqual({})
    expect(sanitizeProjectModels(['x'])).toEqual({})
  })

  it('a phone may set the model and effort of a session, and the defaults', () => {
    expect(phoneMetaPatch({ model: 'opus', effort: 'high', billing: { mode: 'api' } })).toEqual({
      model: 'opus',
      effort: 'high'
    })
    expect(MOBILE_SAFE_SETTINGS).toContain('defaultModel')
    expect(MOBILE_SAFE_SETTINGS).toContain('defaultEffort')
    // Not the per-project defaults (keyed by folder on the PC).
    expect(phoneSettingsPatch({ projectModels: { x: { model: 'opus' } } })).toEqual({})
  })
})

describe('labels', () => {
  it('names models and choices for badges', () => {
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('sonnet[1m]')).toBe('Sonnet 1M')
    expect(modelLabel('opusplan')).toBe('Opus Plan')
    expect(modelLabel('claude-opus-4-5-20251101')).toBe('Opus 4.5')
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(choiceLabel({ model: 'opus', effort: 'high' })).toBe('Opus · High')
    expect(choiceLabel({ model: 'opus', effort: 'xhigh' })).toBe('Opus · XHigh')
    expect(choiceLabel({ effort: 'low' })).toBe('Low effort')
    expect(choiceLabel({})).toBe('')
  })

  it('lists models seen in the logs, most recently used first', () => {
    expect(
      modelsSeen([
        { models: ['claude-sonnet-4-5-20250929'], lastActivityAt: '2026-10-01T10:00:00Z' },
        {
          models: ['claude-opus-4-5-20251101', 'claude-haiku-4-5'],
          lastActivityAt: '2026-10-20T10:00:00Z'
        },
        { models: ['claude-sonnet-4-5-20250929'], startedAt: '2026-10-25T10:00:00Z' },
        { models: ['bad model'], lastActivityAt: '2026-10-30T10:00:00Z' }
      ])
    ).toEqual(['claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'claude-opus-4-5-20251101'])
  })
})

// ---------------------------------------------------------------------------
// Every launch path, with the fixtures (nothing is started off Windows).

let root: string
/** Services with background work (archive copies) to finish before cleanup. */
let busy: { idle(): Promise<void> }[] = []

async function setup() {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
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
    () => settings.value
  )
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, settings }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-model-'))
})
afterEach(async () => {
  // Archive copies run in the background: Windows can't remove a folder in use.
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('Launcher: every launch path uses the choice', () => {
  it('desktop preview, the copied commands and the launch', async () => {
    const { sessions, launcher } = await setup()
    // Fixtures: "Safari login loop" is saved with opus / high.
    const s = sessions.list().find((x) => x.sessionId === ID)!
    expect(s.meta).toMatchObject({ model: 'opus', effort: 'high' })
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.modelChoice).toMatchObject({ model: 'opus', effort: 'high', modelFrom: 'session' })
    expect(p.claudeCommand).toBe(`claude --model opus --effort high --resume ${ID}`)
    expect(p.commandLine).toContain('--model opus --effort high --resume')
    const r = await launcher.launch({ key: s.key, fork: true, skipPermissions: false })
    expect(r.ok).toBe(true)
    expect(r.commandLine).toContain(`--model opus --effort high --resume ${ID} --fork-session`)
  })

  it('"Default" on the session falls back to the project, then Settings', async () => {
    const { sessions, launcher, settings } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    sessions.updateMeta(s.key, { model: '', effort: '' as never })
    let p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.claudeCommand).toBe(`claude --resume ${ID}`)
    settings.update((st) => {
      st.defaultEffort = 'low'
      st.projectModels = { [s.cwd!.toLowerCase()]: { model: 'sonnet' } }
    })
    p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.claudeCommand).toBe(`claude --model sonnet --effort low --resume ${ID}`)
    expect(p.modelChoice).toMatchObject({ modelFrom: 'project', effortFrom: 'settings' })
  })

  it('WSL sessions', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.env === 'wsl' && x.availability === 'live')!
    sessions.updateMeta(s.key, { model: 'claude-sonnet-4-5-20250929', effort: 'max' })
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: true })
    expect(p.claudeCommand).toBe(
      `claude --model claude-sonnet-4-5-20250929 --effort max --resume ${s.sessionId} --dangerously-skip-permissions`
    )
    expect(p.commandLine).toContain('wsl.exe')
  })

  it('Remote Control and phone-triggered launches', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    const opts = remoteLaunchOptions({ key: s.key, kind: 'resume' }, 'wt')
    const r = await launcher.launch(opts, { via: 'phone', device: 'Test phone' })
    expect(r.ok).toBe(true)
    expect(r.commandLine).toContain('--remote-control')
    expect(r.commandLine).toContain('--permission-mode default --model opus --effort high --resume')
    expect(r.commandLine).not.toContain('--dangerously-skip-permissions')
  })

  it('API-billed launches (the key stays out of the command)', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    const r = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      billingAccountId: 'acct-test'
    })
    expect(r.ok).toBe(true)
    expect(r.commandLine).toContain(`--model opus --effort high --resume ${ID}`)
    expect(r.commandLine).not.toContain('sk-ant')
  })

  it('New session in the folder', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ID)!
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      newSession: true
    })
    expect(p.claudeCommand).toBe('claude --model opus --effort high')
  })
})
