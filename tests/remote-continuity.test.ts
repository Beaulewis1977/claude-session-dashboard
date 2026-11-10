// No duplicate terminals between PC and phone, Remote Control link pickup,
// "Open in: Claude desktop app", and Claude desktop sessions as a source
// (Code tab labels, the optional view-only Cowork source).

import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeLive,
  remoteActiveOf,
  type LiveSession,
  type ProcInput,
  type RunningFile
} from '@shared/live'
import { findRunningCopy, runningAdvice, runningKindOf, type RecordedOrigin } from '@shared/running'
import {
  CLAUDE_APP_FORK,
  CLAUDE_DESKTOP_MIN_VERSION,
  claudeAppArgs,
  claudeAppPreview,
  type ClaudeAppFacts
} from '@shared/claude-app'
import { addHints, detectSource, emptyHints, ASK_MARKER } from '@shared/source-label'
import { isViewOnly } from '@shared/view-only'
import type { LaunchOptions, LaunchPreview, SessionSummary } from '@shared/types'
import {
  parseLaunchRequest,
  RemoteLauncher,
  remoteLaunchOptions,
  type RemoteLaunchDeps
} from '../src/main/mobile/remote-launch'
import {
  COWORK_SOURCE_ID,
  coworkRoot,
  isCoworkSessionFile,
  listCoworkFiles,
  readDesktopIndex
} from '../src/main/providers/claude/desktop'
import { collectFiles } from '../src/main/core/backup-files'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { Launcher } from '../src/main/services/launcher'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { freshRemoteUrl, liveRemoteUrl } from '../src/renderer/src/lib/remote'
import { FIXTURES } from './helpers'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const BRIDGE = 'session_01AbCdEfGhIjKlMnOpQrStUv'
const RC_URL = `https://claude.ai/code/${BRIDGE}`

function live(p: Partial<LiveSession> & { key: string }): LiveSession {
  const sessionId = p.key.slice(p.key.indexOf(':') + 1)
  return {
    sessionId,
    sourceId: p.key.slice(0, p.key.indexOf(':')),
    env: 'windows',
    state: 'working',
    since: NOW - 60_000,
    lastSeenAt: NOW - 1000,
    basis: 'status',
    pid: 4242,
    ...p
  }
}

const noOrigin = (): RecordedOrigin | undefined => undefined

// ------------------------------------------------------------ duplicates

describe('Already running: which launch would duplicate what', () => {
  it('Resume: the session itself, only while it runs', () => {
    const l = [live({ key: 'windows:a' }), live({ key: 'windows:b', state: 'exited' })]
    expect(
      findRunningCopy({ kind: 'resume', key: 'windows:a', live: l, origin: noOrigin })
    ).toMatchObject({
      key: 'windows:a',
      relation: 'self',
      where: 'terminal',
      provider: 'claude'
    })
    // An exited session (still listed for a while) is no duplicate.
    expect(
      findRunningCopy({ kind: 'resume', key: 'windows:b', live: l, origin: noOrigin })
    ).toBeUndefined()
    expect(
      findRunningCopy({ kind: 'resume', key: 'windows:c', live: l, origin: noOrigin })
    ).toBeUndefined()
  })

  it('Fork / Continue fresh: a fork or continuation of it the app launched, still running', () => {
    const origins: Record<string, RecordedOrigin> = {
      'windows:fork1': { parentKey: 'windows:a', via: 'fork' },
      'windows:cont1': { parentKey: 'windows:a', via: 'continue' },
      'windows:branch1': { parentKey: 'windows:a', via: 'app' },
      'windows:other': { parentKey: 'windows:z', via: 'fork' }
    }
    const origin = (k: string) => origins[k]
    const l = [
      live({ key: 'windows:a' }),
      live({ key: 'windows:cont1', state: 'approval' }),
      live({ key: 'windows:branch1' }),
      live({ key: 'windows:other' })
    ]
    // Forking a running session itself stays allowed: only its running children count.
    expect(
      findRunningCopy({ kind: 'fork', key: 'windows:a', live: [l[0]!], origin })
    ).toBeUndefined()
    const r = findRunningCopy({ kind: 'continue', key: 'windows:a', live: l, origin })
    expect(r).toMatchObject({ key: 'windows:cont1', relation: 'continue' })
    expect(findRunningCopy({ kind: 'fork', key: 'windows:a', live: l, origin })?.key).toBe(
      'windows:cont1'
    )
    // A branch (Branch from here) or another session's fork isn't one.
    expect(
      findRunningCopy({ kind: 'fork', key: 'windows:a', live: [l[2]!, l[3]!], origin })
    ).toBeUndefined()
    // An exited fork isn't either.
    expect(
      findRunningCopy({
        kind: 'fork',
        key: 'windows:a',
        live: [live({ key: 'windows:fork1', state: 'exited' })],
        origin
      })
    ).toBeUndefined()
  })

  it('a Remote Control link counts only when it is on in this run', () => {
    const on = live({ key: 'windows:a', remoteUrl: RC_URL, remoteActive: true })
    const stale = live({ key: 'windows:a', remoteUrl: RC_URL })
    expect(
      findRunningCopy({ kind: 'resume', key: 'windows:a', live: [on], origin: noOrigin })?.remoteUrl
    ).toBe(RC_URL)
    expect(
      findRunningCopy({ kind: 'resume', key: 'windows:a', live: [stale], origin: noOrigin })
        ?.remoteUrl
    ).toBeUndefined()
  })

  it('which check a launch needs', () => {
    expect(runningKindOf({ fork: false })).toBe('resume')
    expect(runningKindOf({ fork: true })).toBe('fork')
    expect(runningKindOf({ continueFresh: {} })).toBe('continue')
    expect(runningKindOf({ branch: { at: 'x' } })).toBeUndefined()
    expect(runningKindOf({ newSession: true })).toBeUndefined()
    expect(runningKindOf({ openIn: 'codex-app' })).toBe('codex-app')
    expect(runningKindOf({ openIn: 'claude-app' })).toBe('claude-app')
  })
})

describe('Already running: what the phone and the PC say', () => {
  const base = {
    key: 'windows:a',
    relation: 'self' as const,
    state: 'working' as const,
    env: 'windows' as const
  }

  it('phone, with Remote Control: Open in Claude app first; another copy always last', () => {
    const a = runningAdvice(
      { ...base, provider: 'claude', where: 'terminal', remoteUrl: RC_URL },
      'phone'
    )
    expect(a.title).toBe('Already running on your PC')
    expect(a.actions[0]).toBe('open-remote')
    expect(a.actions.at(-1)).toBe('another')
  })

  it('phone, without Remote Control: type /rc, then refresh (nothing launches)', () => {
    const a = runningAdvice({ ...base, provider: 'claude', where: 'terminal' }, 'phone')
    expect(a.title).toBe('Already running on your PC without Remote Control')
    expect(a.body).toBe('Type /rc in that terminal, then refresh.')
    expect(a.actions).not.toContain('open-remote')
    expect(a.actions.at(-1)).toBe('another')
  })

  it('PC: Focus terminal first', () => {
    expect(runningAdvice({ ...base, provider: 'claude', where: 'terminal' }, 'pc').actions[0]).toBe(
      'focus'
    )
    expect(
      runningAdvice({ ...base, provider: 'claude', where: 'terminal', remoteUrl: RC_URL }, 'pc')
        .actions[0]
    ).toBe('focus')
  })

  it('Codex: Focus terminal on PC or Open in Codex app, never Remote Control', () => {
    const t = runningAdvice({ ...base, provider: 'codex', where: 'terminal' }, 'phone')
    expect(t.actions).toEqual(['focus', 'open-codex-app', 'another'])
    expect(t.body).toMatch(/Codex Remote \(ChatGPT app\) reaches Codex app threads only/)
    const app = runningAdvice({ ...base, provider: 'codex', where: 'codex-app' }, 'phone')
    expect(app.actions).toEqual(['open-codex-app', 'another'])
  })
})

describe('Codex: duplicate check', () => {
  const codex = (p: Partial<LiveSession>) =>
    live({ key: 'codex-windows:t1', provider: 'codex', basis: 'lock', ...p })

  it('a thread a terminal holds is running there; the Codex app on top of it is a second copy', () => {
    const l = [codex({ lockHeld: true })]
    expect(
      findRunningCopy({ kind: 'resume', key: 'codex-windows:t1', live: l, origin: noOrigin })
    ).toMatchObject({
      where: 'terminal',
      provider: 'codex'
    })
    expect(
      findRunningCopy({ kind: 'codex-app', key: 'codex-windows:t1', live: l, origin: noOrigin })
        ?.where
    ).toBe('terminal')
  })

  it('a thread the Codex app runs: opening it in the app again is fine, a terminal is a duplicate', () => {
    const l = [codex({ lockHeld: false, basis: 'rollout' })]
    expect(
      findRunningCopy({ kind: 'codex-app', key: 'codex-windows:t1', live: l, origin: noOrigin })
    ).toBeUndefined()
    expect(
      findRunningCopy({ kind: 'resume', key: 'codex-windows:t1', live: l, origin: noOrigin })?.where
    ).toBe('codex-app')
  })

  it('never offers a Remote Control link for Codex', () => {
    const l = [codex({ lockHeld: true, remoteUrl: RC_URL, remoteActive: true })]
    expect(
      findRunningCopy({ kind: 'resume', key: 'codex-windows:t1', live: l, origin: noOrigin })
        ?.remoteUrl
    ).toBeUndefined()
  })
})

// ------------------------------------------------------- RC link pickup

describe('Remote Control link pickup (also after /rc typed later)', () => {
  const started = NOW - 30 * 60_000
  const file = (extra: Partial<RunningFile> = {}): RunningFile => ({
    pid: 4242,
    sessionId: 'a',
    startedAt: started,
    status: 'idle',
    statusUpdatedAt: NOW - 5000,
    ...extra
  })
  const proc = (f: RunningFile): ProcInput => ({
    sourceId: 'windows',
    env: 'windows',
    file: f,
    mtime: NOW - 1000,
    alive: true
  })
  const run = (f: RunningFile, transcript?: { remoteUrl?: string; remoteUrlAt?: number }) =>
    computeLive({
      now: NOW,
      procs: [proc(f)],
      events: [],
      hooksOn: new Set(),
      transcript: () => transcript,
      sourceEnv: () => ({ env: 'windows' })
    })[0]!

  it('is off until Remote Control is on, then the running file gives the link at once', () => {
    expect(run(file()).remoteActive).toBeUndefined()
    // /rc typed later: Claude Code writes bridgeSessionId into its running file.
    const after = run(file({ bridgeSessionId: BRIDGE }))
    expect(after.remoteActive).toBe(true)
    expect(after.remoteUrl).toBe(RC_URL)
    expect(liveRemoteUrl([after], 'windows:a')).toBe(RC_URL)
  })

  it('a transcript link from an earlier run is not "on now"; one recorded in this run is', () => {
    const old = run(file(), { remoteUrl: RC_URL, remoteUrlAt: started - 3600_000 })
    expect(old.remoteUrl).toBe(RC_URL)
    expect(old.remoteActive).toBeUndefined()
    expect(liveRemoteUrl([old], 'windows:a')).toBeUndefined()
    const now = run(file(), { remoteUrl: RC_URL, remoteUrlAt: NOW - 10_000 })
    expect(now.remoteActive).toBe(true)
    expect(remoteActiveOf(undefined, { remoteUrl: RC_URL, remoteUrlAt: NOW }, undefined)).toBe(
      false
    )
  })

  it("the phone's launch sheet takes the live link of what it just started", () => {
    const since = NOW - 20_000
    const fresh = live({
      key: 'windows:a',
      startedAt: NOW - 5000,
      remoteUrl: RC_URL,
      remoteActive: true
    })
    expect(freshRemoteUrl([], { key: 'windows:a' }, since, new Set(), [fresh])).toBe(RC_URL)
    // Started before the launch: not what the phone just started.
    const older = { ...fresh, startedAt: NOW - 3600_000 }
    expect(freshRemoteUrl([], { key: 'windows:a' }, since, new Set(), [older])).toBeUndefined()
    // A fork: the one new process in its folder.
    const fork = live({
      key: 'windows:new',
      cwd: 'C:\\code',
      startedAt: NOW - 5000,
      remoteUrl: RC_URL,
      remoteActive: true
    })
    expect(
      freshRemoteUrl(
        [],
        { fork: { parentKey: 'windows:a', sourceId: 'windows', cwd: 'c:\\CODE' } },
        since,
        new Set(['windows:a']),
        [fork]
      )
    ).toBe(RC_URL)
  })
})

// ------------------------------------------------------ phone launches

const DEVICE = { id: 'd1', name: 'Phone', tokenHash: '', createdAt: '', lastSeenAt: '' }

function claudeSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: 'windows:11111111-1111-4111-8111-111111111111',
    sessionId: '11111111-1111-4111-8111-111111111111',
    sourceId: 'windows',
    sourceLabel: 'Windows',
    env: 'windows',
    filePath: 'x',
    originalPath: 'x',
    availability: 'live',
    projectDir: 'p',
    projectName: 'p',
    cwd: 'C:\\code',
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCallCount: 0,
    malformedLines: 0,
    sizeBytes: 10,
    models: [],
    meta: { aiSummary: { text: 's', at: '', model: 'haiku' } as never },
    title: 'My session',
    titleSource: 'name',
    source: 'terminal-windows',
    sourceReason: '',
    provider: 'claude',
    ...over
  }
}

const PREVIEW: LaunchPreview = {
  commandLine: 'x',
  claudeCommand: 'claude',
  terminal: 'wt',
  fellBack: false,
  cwd: 'C:\\code',
  cwdExists: true,
  willRestore: false,
  restoreImpossible: false,
  originalPath: 'x',
  billingLabel: 'Subscription'
}

function phone(
  opts: {
    session?: SessionSummary
    running?: boolean
    readOnly?: boolean
    confirmOnPc?: boolean
  } = {}
) {
  const s = opts.session ?? claudeSession()
  const launched: LaunchOptions[] = []
  const logs: string[] = []
  const focused: string[] = []
  let confirms = 0
  const copy = {
    key: s.key,
    relation: 'self' as const,
    state: 'working' as const,
    provider: 'claude' as const,
    env: 'windows' as const,
    where: 'terminal' as const
  }
  const deps: RemoteLaunchDeps = {
    session: (k) => (k === s.key ? s : undefined),
    preview: async (o) => ({
      ...PREVIEW,
      ...(opts.running && !o.allowDuplicate ? { running: copy } : {})
    }),
    launch: async (o) => {
      launched.push(o)
      return { ok: true, restored: false, commandLine: 'x' }
    },
    settings: () => ({
      terminal: 'wt',
      readOnly: opts.readOnly === true,
      confirmOnPc: opts.confirmOnPc === true,
      branchConfirmed: true
    }),
    confirm: async () => {
      confirms++
      return true
    },
    deviceActive: () => true,
    log: (e) => logs.push(`${e.action}: ${e.detail ?? ''}`),
    running: (o) => (opts.running && !o.allowDuplicate ? copy : undefined),
    focus: async (k) => {
      focused.push(k)
      return { ok: true, how: 'tab' }
    }
  }
  return { rl: new RemoteLauncher(deps), launched, logs, focused, s, confirms: () => confirms }
}

describe('Phone: no duplicate terminals', () => {
  it('preview says it is already running, with its title', async () => {
    const { rl, s } = phone({ running: true })
    const p = await rl.preview({ key: s.key, kind: 'resume' })
    expect(p.running).toMatchObject({ key: s.key, relation: 'self', title: 'My session' })
  })

  it('refuses before asking the PC or counting a launch, and logs it', async () => {
    const { rl, s, launched, logs, confirms } = phone({ running: true, confirmOnPc: true })
    const r = await rl.launch(DEVICE, { key: s.key, kind: 'resume' })
    expect(r.ok).toBe(false)
    expect(r.running?.key).toBe(s.key)
    expect(launched).toHaveLength(0)
    expect(confirms()).toBe(0)
    expect(logs.at(-1)).toMatch(/already running on the PC/)
  })

  it('force ("Start another copy anyway") starts it, still with the fixed safe options', async () => {
    const { rl, s, launched, logs } = phone({ running: true })
    // Refused first, then forced right away: the refusal didn't use up the rate limit.
    await rl.launch(DEVICE, { key: s.key, kind: 'resume' })
    const r = await rl.launch(DEVICE, { key: s.key, kind: 'resume', force: true })
    expect(r.ok).toBe(true)
    expect(launched[0]).toMatchObject({
      allowDuplicate: true,
      skipPermissions: false,
      askPermissions: true,
      remoteControl: true
    })
    expect(logs.at(-1)).toMatch(/another copy, confirmed on the phone/)
  })

  it('force is only `true`; anything else is refused, and Branch never carries it', () => {
    expect(parseLaunchRequest({ key: 'k', kind: 'resume', force: 'yes' })).toEqual({
      error: 'Bad request'
    })
    expect(parseLaunchRequest({ key: 'k', kind: 'resume', force: true })).toEqual({
      key: 'k',
      kind: 'resume',
      force: true
    })
    expect(
      parseLaunchRequest({
        key: 'k',
        kind: 'branch',
        force: true,
        branch: { at: 'm', mode: 'include' }
      })
    ).not.toHaveProperty('force')
  })

  it('phone launches never use skip-permissions, forced or not, for any kind', () => {
    for (const kind of ['resume', 'fork', 'continue', 'codex-app'] as const)
      for (const force of [undefined, true] as const)
        for (const provider of ['claude', 'codex'] as const) {
          const o = remoteLaunchOptions(
            { key: 'k', kind, ...(force ? { force } : {}) },
            'wt',
            provider
          )
          expect(o.skipPermissions).toBe(false)
          expect(o.askPermissions).toBe(true)
          expect(o.allowDuplicate === true).toBe(force === true)
        }
  })

  it('Focus terminal on PC: starts nothing, logged, refused in read-only mode, rate-limited', async () => {
    const { rl, s, focused, launched, logs } = phone()
    const r = await rl.launch(DEVICE, { key: s.key, kind: 'focus' })
    expect(r).toMatchObject({ ok: true, focused: 'tab' })
    expect(focused).toEqual([s.key])
    expect(launched).toHaveLength(0)
    expect(logs.at(-1)).toMatch(/^focus: Focus terminal/)
    expect((await rl.launch(DEVICE, { key: s.key, kind: 'focus' })).error).toMatch(
      /Too many requests/
    )
    const ro = phone({ readOnly: true })
    expect((await ro.rl.launch(DEVICE, { key: ro.s.key, kind: 'focus' })).ok).toBe(false)
    expect(ro.focused).toHaveLength(0)
  })

  it('a Cowork session is view-only from the phone too', async () => {
    const { rl, s, launched } = phone({
      session: claudeSession({ sourceId: COWORK_SOURCE_ID, viewOnly: 'cowork' })
    })
    const r = await rl.launch(DEVICE, { key: s.key, kind: 'resume' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/view-only/)
    expect(launched).toHaveLength(0)
  })
})

// ------------------------------------------------ Claude desktop app

describe('Open in: Claude desktop app', () => {
  const facts: ClaudeAppFacts = {
    env: 'windows',
    provider: 'claude',
    viewOnly: false,
    fork: false,
    other: false,
    installed: true,
    cliFound: true,
    version: '2.1.321'
  }
  const ID = '11111111-1111-4111-8111-111111111111'

  it('offers it for a Windows Claude Code session with Claude Code 2.1.285+', () => {
    expect(claudeAppPreview(facts, ID)).toEqual({
      available: true,
      commandLine: `claude --desktop --resume ${ID}`
    })
  })

  it('says why not where it can never work, and hides it where it is not offered', () => {
    expect(claudeAppPreview({ ...facts, env: 'wsl' }, ID)?.reason).toMatch(/Windows sessions only/)
    expect(claudeAppPreview({ ...facts, installed: false }, ID)?.reason).toMatch(/isn't installed/)
    expect(claudeAppPreview({ ...facts, version: '2.1.284' }, ID)?.reason).toMatch(
      new RegExp(CLAUDE_DESKTOP_MIN_VERSION.replace(/\./g, '\\.'))
    )
    expect(claudeAppPreview({ ...facts, provider: 'codex' }, ID)).toBeUndefined()
    expect(claudeAppPreview({ ...facts, viewOnly: true }, ID)).toBeUndefined()
    expect(claudeAppPreview({ ...facts, other: true }, ID)).toBeUndefined()
    // Fork only once it's been checked on a real session.
    expect(claudeAppPreview({ ...facts, fork: true }, ID) === undefined).toBe(!CLAUDE_APP_FORK)
  })

  it('only ever passes fixed flags and a checked session id', () => {
    expect(claudeAppArgs(ID, false)).toEqual(['--desktop', '--resume', ID])
    expect(() => claudeAppArgs('x" & calc', false)).toThrow()
    expect(() => claudeAppArgs('--dangerously-skip-permissions', false)).toThrow()
  })
})

// --------------------------------------------- Claude desktop labels

describe('Claude desktop labels and the Ask Claude hiding rule', () => {
  const hints = (...eps: string[]) => {
    const h = emptyHints()
    for (const e of eps) addHints(h, { entrypoint: e })
    return h
  }
  const win = { env: 'windows' as const }

  it('entrypoint claude-desktop, or listed in the Code tab (even as sdk-cli), is "Claude desktop"', () => {
    expect(detectSource(hints('claude-desktop'), win).label).toBe('desktop')
    expect(detectSource(hints('sdk-cli'), win).label).toBe('sdk')
    expect(detectSource(hints('sdk-cli'), { ...win, desktopIndexed: true }).label).toBe('desktop')
    expect(detectSource(hints('local-agent'), win).label).toBe('cowork')
    expect(detectSource(hints('cli'), { ...win, cowork: true }).label).toBe('cowork')
  })

  it('hides only real Ask Claude runs, never a desktop or terminal session', () => {
    const ask = { ...win, firstPrompt: `${ASK_MARKER} what changed?` }
    expect(detectSource(hints('sdk-cli'), ask).label).toBe('ask-claude')
    expect(detectSource(hints(), ask).label).toBe('ask-claude')
    // The same first prompt in a real session (pasted, say) doesn't hide it.
    expect(detectSource(hints('sdk-cli'), { ...ask, desktopIndexed: true }).label).toBe('desktop')
    expect(detectSource(hints('claude-desktop'), ask).label).toBe('desktop')
    expect(detectSource(hints('cli'), ask).label).toBe('terminal-windows')
    expect(detectSource(hints('sdk-cli'), { ...ask, cowork: true }).label).toBe('cowork')
  })

  it('view-only: imported conversations and Cowork sessions', () => {
    expect(isViewOnly({ availability: 'imported' })).toBe(true)
    expect(isViewOnly({ availability: 'live', viewOnly: 'cowork' })).toBe(true)
    expect(isViewOnly({ availability: 'live' })).toBe(false)
  })
})

// ------------------------------------- desktop folders (temp copies)

let root: string
let busy: SessionService[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-continuity-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

const ACCT = 'acct-sample'
const ORG = 'org-sample'
const COWORK_ID = '3a7e1c9d-6b2f-4d8a-9e0c-5f4b3a2e1d0c'
const DESKTOP_ID = 'c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c'

describe('Claude desktop folders are read narrowly', () => {
  it('the Code-tab index: only cliSessionId, only from local_<id>.json files', async () => {
    const dir = join(root, 'Claude', 'claude-code-sessions', ACCT, ORG)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'local_5d1f0c7e-2a4b-4c6d-8e9f-0a1b2c3d4e5f.json'),
      JSON.stringify({ cliSessionId: DESKTOP_ID.toUpperCase(), title: 't' })
    )
    await writeFile(join(dir, 'local_6d1f0c7e-2a4b-4c6d-8e9f-0a1b2c3d4e5f.json'), '{broken')
    await writeFile(join(dir, 'other.json'), JSON.stringify({ cliSessionId: COWORK_ID }))
    await writeFile(
      join(dir, 'local_7d1f0c7e-2a4b-4c6d-8e9f-0a1b2c3d4e5f.json'),
      JSON.stringify({ cliSessionId: 'not-a-uuid' })
    )
    expect([...(await readDesktopIndex(join(root, 'Claude')))]).toEqual([DESKTOP_ID])
    expect((await readDesktopIndex(join(root, 'nope'))).size).toBe(0)
  })

  it('Cowork: only .claude\\projects\\<project>\\<id>.jsonl, never credentials or task files', async () => {
    const home = join(root, 'Claude', 'local-agent-mode-sessions', ACCT, ORG, 'local_task1')
    const projects = join(home, '.claude', 'projects', 'C--outputs')
    await mkdir(projects, { recursive: true })
    await writeFile(join(projects, `${COWORK_ID}.jsonl`), '{}\n')
    await writeFile(join(home, '.claude', '.credentials.json'), '{"sample":"not a real secret"}')
    await mkdir(join(home, 'uploads'), { recursive: true })
    await writeFile(join(home, 'uploads', `${DESKTOP_ID}.jsonl`), '{}\n')
    await writeFile(join(home, 'audit.jsonl'), '{}\n')
    const files = await listCoworkFiles(coworkRoot(join(root, 'Claude')))
    expect(files?.map((f) => f.sessionId)).toEqual([COWORK_ID])
    expect(isCoworkSessionFile(join(projects, `${COWORK_ID}.jsonl`))).toBe(true)
    expect(isCoworkSessionFile(join(home, '.claude', '.credentials.json'))).toBe(false)
    expect(isCoworkSessionFile(join(home, 'uploads', `${DESKTOP_ID}.jsonl`))).toBe(false)
  })
})

async function setup(cowork: boolean) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
  const layout = fixturesLayout(root)
  // A sign-in file and task files next to the Cowork transcript (decoys: never read or copied).
  const home = join(
    layout.sourcesDir,
    'windows',
    'Users',
    'beau',
    'AppData',
    'Roaming',
    'Claude',
    'local-agent-mode-sessions',
    ACCT,
    ORG,
    'local_task1'
  )
  await writeFile(join(home, '.claude', '.credentials.json'), '{"sample":"not a real secret"}')
  await mkdir(join(home, 'uploads'), { recursive: true })
  await writeFile(join(home, 'uploads', 'q3-retro.md'), '# notes\n')
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  if (cowork) settings.update((s) => void (s.coworkSource = true))
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(platform, paths, metadata, settings)
  sessions.desktopDir = join(platform.windowsHome, 'AppData', 'Roaming', 'Claude')
  busy.push(sessions)
  const launcher = new Launcher(platform, sessions, () => settings.value.terminal)
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, paths, settings }
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []))
    if (e.isFile()) out.push(join(e.parentPath, e.name))
  return out
}

describe('Claude desktop sessions in the dashboard (fixtures)', () => {
  it('a Code-tab session is labelled "Claude desktop"; Cowork stays off by default', async () => {
    const { sessions } = await setup(false)
    expect(sessions.get(`windows:${DESKTOP_ID}`)?.source).toBe('desktop')
    expect(sessions.list().some((s) => s.sourceId === COWORK_SOURCE_ID)).toBe(false)
    expect(sessions.sources.some((s) => s.cowork)).toBe(false)
  })

  it('the Cowork source: view-only, searchable, archived without any credential file, never launched', async () => {
    const { sessions, launcher, paths } = await setup(true)
    const s = sessions.get(`${COWORK_SOURCE_ID}:${COWORK_ID}`)
    expect(s).toMatchObject({ source: 'cowork', viewOnly: 'cowork' })
    expect(sessions.searchKeys('action items').some((h) => h.key === s!.key)).toBe(true)
    const src = sessions.source(COWORK_SOURCE_ID)!
    // No settings.json: never a status line, hooks or Running now for it.
    expect(src.claudeSettingsPath).toBeUndefined()
    const archived = await allFiles(join(paths.archiveDir, COWORK_SOURCE_ID))
    expect(archived.map((f) => f.split(/[\\/]/).pop())).toEqual([`${COWORK_ID}.jsonl`])
    expect((await allFiles(paths.dataDir)).some((f) => /credentials|q3-retro/i.test(f))).toBe(false)
    const r = await launcher.launch({ key: s!.key, fork: false, skipPermissions: false })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/view-only/)
    expect((await launcher.openShell(s!.key)).ok).toBe(false)
  })

  it('backups leave Cowork copies (and their records) out while the source is off', async () => {
    const { sessions, paths, settings } = await setup(true)
    await sessions.idle()
    const on = await collectFiles(paths.dataDir)
    expect(on.files.some((f) => f.rel.startsWith(`archive/${COWORK_SOURCE_ID}/`))).toBe(true)
    settings.update((s) => void (s.coworkSource = false))
    const off = await collectFiles(paths.dataDir, undefined, {
      skipArchiveSources: [COWORK_SOURCE_ID]
    })
    expect(off.files.some((f) => f.rel.startsWith(`archive/${COWORK_SOURCE_ID}/`))).toBe(false)
    const meta = off.files.find((f) => f.rel === 'metadata.json')!
    const { readFile } = await import('node:fs/promises')
    const backed = JSON.parse(meta.transform!(await readFile(meta.abs)).toString('utf8')) as {
      archive: Record<string, { sourceId: string }>
    }
    expect(Object.values(backed.archive).some((r) => r.sourceId === COWORK_SOURCE_ID)).toBe(false)
    expect(Object.values(backed.archive).some((r) => r.sourceId === 'windows')).toBe(true)
    // Hidden from the list while off (nothing is removed from the archive).
    expect(sessions.get(`${COWORK_SOURCE_ID}:${COWORK_ID}`)).toBeUndefined()
    expect((await allFiles(join(paths.archiveDir, COWORK_SOURCE_ID))).length).toBe(1)
  })

  it('a backup never holds a credential-named file, wherever it is', async () => {
    const { paths } = await setup(false)
    await mkdir(join(paths.archiveDir, 'windows'), { recursive: true })
    await writeFile(join(paths.archiveDir, 'windows', 'credentials.json'), '{}')
    const c = await collectFiles(paths.dataDir)
    expect(c.files.some((f) => /credentials/i.test(f.rel))).toBe(false)
  })

  it('the launcher refuses a running session unless another copy is confirmed', async () => {
    const { sessions, launcher } = await setup(false)
    const s = sessions.get(`windows:${DESKTOP_ID}`)!
    launcher.running = (x, kind) =>
      findRunningCopy({
        kind,
        key: x.key,
        live: [live({ key: s.key, remoteUrl: RC_URL, remoteActive: true })],
        origin: (k) => sessions.originOf(k)
      })
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.running).toMatchObject({ key: s.key, remoteUrl: RC_URL })
    const refused = await launcher.launch({ key: s.key, fork: false, skipPermissions: false })
    expect(refused).toMatchObject({ ok: false, running: { key: s.key } })
    // Forking a running session is allowed (its own fork isn't running).
    expect(
      (await launcher.preview({ key: s.key, fork: true, skipPermissions: false })).running
    ).toBeUndefined()
    const anyway = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      allowDuplicate: true
    })
    expect(anyway.running).toBeUndefined()
    expect(anyway.ok).toBe(true)
  })

  it('Continue fresh sees a continuation the app recorded, before its file exists', async () => {
    const { sessions } = await setup(false)
    const parent = sessions.get(`windows:${DESKTOP_ID}`)!
    const child = '99999999-9999-4999-8999-999999999999'
    sessions.recordBranch(child, {
      parentSessionId: parent.sessionId,
      parentKey: parent.key,
      via: 'continue',
      createdAt: new Date().toISOString()
    })
    expect(sessions.originOf(`windows:${child}`)).toEqual({
      parentKey: parent.key,
      via: 'continue'
    })
    const r = findRunningCopy({
      kind: 'continue',
      key: parent.key,
      live: [live({ key: `windows:${child}` })],
      origin: (k) => sessions.originOf(k)
    })
    expect(r).toMatchObject({ relation: 'continue', key: `windows:${child}` })
  })

  it('the Claude desktop app choice is offered from the PC only, never the phone', async () => {
    const { sessions, launcher } = await setup(false)
    launcher.claudeApp = {
      facts: async () => ({ installed: true, version: '2.1.321' }),
      open: async () => ({ ok: true, output: '' })
    }
    const s = sessions.get(`windows:${DESKTOP_ID}`)!
    const p = await launcher.preview({ key: s.key, fork: false, skipPermissions: false })
    expect(p.claudeApp?.available).toBe(true)
    const viaPhone = await launcher.launch(
      { key: s.key, fork: false, skipPermissions: false, openIn: 'claude-app' },
      { via: 'phone' }
    )
    expect(viaPhone.ok).toBe(false)
    expect(viaPhone.error).toMatch(/from the PC only/)
  })
})
