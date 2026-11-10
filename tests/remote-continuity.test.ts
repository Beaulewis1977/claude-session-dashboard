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
import {
  findRunningCopy,
  needsConfirm,
  primaryAction,
  runningAdvice,
  runningKindOf,
  type RecordedOrigin
} from '@shared/running'
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
import { HANDOFF_SCRIPT } from '../src/main/services/claude-app'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { Launcher } from '../src/main/services/launcher'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { freshRemoteUrl, liveRemoteUrl, runningNow } from '../src/renderer/src/lib/remote'
import { ProviderRegistry } from '../src/main/providers/registry'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
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

  it('starts Claude Code in its own hidden console (--desktop refuses redirected output), inputs only from env', () => {
    // No interpolated values in the script: path, folder and arguments come from CSD_* variables.
    expect(HANDOFF_SCRIPT).not.toMatch(/[A-Za-z]:\\|--resume|\$\{/)
    expect(HANDOFF_SCRIPT).toMatch(/Start-Process -FilePath \$env:CSD_CLAUDE/)
    expect(HANDOFF_SCRIPT).toMatch(/-WindowStyle Hidden/)
    expect(HANDOFF_SCRIPT).not.toMatch(/-Redirect/)
    // A hand-over that hangs is ended, never left running.
    // …with every process it started (an npm claude.cmd runs node under cmd.exe).
    expect(HANDOFF_SCRIPT).toMatch(
      /WaitForExit\(\[int\]\$env:CSD_WAIT_MS\)\) \{ & .*taskkill\.exe"\) \/PID \$p\.Id \/T \/F/
    )
    expect(HANDOFF_SCRIPT).not.toMatch(/Stop-Process/)
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

  it('a local session is not "Cloud" for an empty link attachment or its own Remote Control link', () => {
    const att = (url: unknown) => ({
      type: 'attachment',
      entrypoint: 'cli',
      attachment: { type: 'remote_session_change', url, commit: '', pr: '' }
    })
    const empty = emptyHints()
    addHints(empty, att(null))
    expect(detectSource(empty, win).label).toBe('terminal-windows')
    // Remote Control writes its link there too, next to its bridge_status entries.
    const rc = emptyHints()
    addHints(rc, { type: 'system', subtype: 'bridge_status', url: RC_URL, entrypoint: 'cli' })
    addHints(rc, att(RC_URL))
    expect(detectSource(rc, win).label).toBe('terminal-windows')
    // A claude.ai/code link without Remote Control (teleported here) is still a cloud session.
    const teleported = emptyHints()
    addHints(teleported, att(RC_URL))
    expect(detectSource(teleported, win).label).toBe('cloud')
    // And a remote entrypoint always is.
    const remote = emptyHints()
    addHints(remote, { entrypoint: 'remote_mobile' })
    expect(detectSource(remote, win).label).toBe('cloud')
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

async function setup(
  cowork: boolean,
  opts: { codex?: boolean; spawned?: string[]; gate?: Promise<void> } = {}
) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: opts.codex })
  const layout = fixturesLayout(root)
  // A sign-in file and task files next to the Cowork transcript (decoys: never read or copied).
  const home = join(
    layout.sourcesDir,
    'windows',
    'Users',
    'alex',
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
  const base = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  // A platform that "starts" commands (nothing runs; each command is recorded).
  const spawned = opts.spawned
  const platform = spawned
    ? {
        ...base,
        canLaunch: true,
        spawnDetached: async (c: { commandLine: string }) => {
          // Takes a moment, like starting a terminal does (or waits for the test).
          await (opts.gate ?? new Promise((r) => setTimeout(r, 20)))
          spawned.push(c.commandLine)
        }
      }
    : base
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  if (cowork) settings.update((s) => void (s.coworkSource = true))
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(
    platform,
    paths,
    metadata,
    settings,
    opts.codex ? new ProviderRegistry([claudeProvider, createCodexProvider()]) : undefined
  )
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

// ------------------------------------------------------- review fixes

describe('Review fixes', () => {
  it('two launches at once: only one starts; the second is told one is on its way', async () => {
    const spawned: string[] = []
    const { sessions, launcher } = await setup(false, { spawned })
    launcher.running = () => undefined // Running now hasn't seen it yet
    const key = `windows:${DESKTOP_ID}`
    const o = { key, fork: false, skipPermissions: false }
    const [a, b] = await Promise.all([launcher.launch(o), launcher.launch(o)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    const refused = a.ok ? b : a
    expect(refused.running).toMatchObject({ key, relation: 'self', pending: true })
    expect(spawned).toHaveLength(1)
    // Still reserved after it started, until Running now catches up.
    expect((await launcher.launch(o)).running?.pending).toBe(true)
    expect((await launcher.preview(o)).running?.pending).toBe(true)
    expect(runningAdvice((await launcher.preview(o)).running!, 'phone')).toMatchObject({
      title: 'Just started on your PC',
      actions: ['another']
    })
    // Forking it is a different launch: not blocked by the Resume on its way.
    expect((await launcher.preview({ ...o, fork: true })).running).toBeUndefined()
    // Confirmed: another copy starts.
    expect((await launcher.launch({ ...o, allowDuplicate: true })).ok).toBe(true)
    expect(spawned).toHaveLength(2)
    void sessions
  })

  it('a launch that failed frees its reservation at once', async () => {
    const { sessions, launcher } = await setup(false)
    launcher.running = () => undefined
    const s = sessions.get(`windows:${DESKTOP_ID}`)!
    const bad = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      remoteControl: true,
      billingAccountId: 'acct-1'
    })
    expect(bad.ok).toBe(false)
    expect(
      (await launcher.preview({ key: s.key, fork: false, skipPermissions: false })).running
    ).toBeUndefined()
  })

  it('a Codex fork (forked_from_id in its file) counts as a fork of its parent', async () => {
    const { sessions } = await setup(false, { codex: true })
    const parent = 'codex-windows:019a1111-0000-7000-8000-000000000001'
    const fork = 'codex-windows:019a4444-0000-7000-8000-000000000004'
    expect(sessions.get(fork)?.forkedFromId).toBe('019a1111-0000-7000-8000-000000000001')
    expect(sessions.originOf(fork)).toEqual({ parentKey: parent, via: 'fork' })
    const r = findRunningCopy({
      kind: 'fork',
      key: parent,
      live: [live({ key: fork, provider: 'codex', lockHeld: true })],
      origin: (k) => sessions.originOf(k)
    })
    expect(r).toMatchObject({ key: fork, relation: 'fork', where: 'terminal' })
  })

  it('desktop Open in Codex app for a terminal-held thread needs a confirm; Focus comes first', () => {
    const t = {
      key: 'c:1',
      relation: 'self' as const,
      state: 'working' as const,
      provider: 'codex' as const,
      env: 'windows' as const,
      where: 'terminal' as const
    }
    expect(needsConfirm(t, 'open-codex-app')).toBe(true)
    expect(primaryAction(t)).toBe('focus')
    const app = { ...t, where: 'codex-app' as const }
    expect(needsConfirm(app, 'open-codex-app')).toBe(false)
    expect(primaryAction(app)).toBe('open-codex-app')
  })

  it("a fork's live Remote Control link is never another session's fork", () => {
    const since = NOW - 20_000
    const other = live({
      key: 'windows:theirs',
      cwd: 'C:\\code',
      startedAt: NOW - 5000,
      remoteUrl: RC_URL,
      remoteActive: true
    })
    const sessions = [
      {
        key: 'windows:theirs',
        sourceId: 'windows',
        env: 'windows' as const,
        cwd: 'C:\\code',
        lineage: { parentKey: 'windows:z', parentSessionId: 'z', via: 'fork' as const }
      }
    ]
    const res = { fork: { parentKey: 'windows:a', sourceId: 'windows', cwd: 'C:\\code' } }
    expect(freshRemoteUrl(sessions, res, since, new Set(), [other])).toBeUndefined()
    // Linked to this parent: that one wins, even with another new process in the folder.
    const mine = live({
      key: 'windows:mine',
      cwd: 'C:\\code',
      startedAt: NOW - 4000,
      remoteUrl: `${RC_URL}x`,
      remoteActive: true
    })
    const stranger = live({
      key: 'windows:new',
      cwd: 'C:\\code',
      startedAt: NOW - 4000,
      remoteUrl: `${RC_URL}y`,
      remoteActive: true
    })
    const linked = [
      ...sessions,
      {
        key: 'windows:mine',
        sourceId: 'windows',
        env: 'windows' as const,
        cwd: 'C:\\code',
        lineage: { parentKey: 'windows:a', parentSessionId: 'a', via: 'fork' as const }
      }
    ]
    expect(freshRemoteUrl(linked, res, since, new Set(), [other, mine, stranger])).toBe(
      `${RC_URL}x`
    )
  })

  it('an open phone sheet follows Running now: no stale link after a restart without RC', () => {
    const seen = {
      key: 'windows:a',
      relation: 'self' as const,
      state: 'working' as const,
      provider: 'claude' as const,
      env: 'windows' as const,
      where: 'terminal' as const,
      remoteUrl: RC_URL
    }
    // Restarted without Remote Control: the old link goes (and Refresh shows again).
    expect(runningNow(seen, [live({ key: 'windows:a' })])?.remoteUrl).toBeUndefined()
    // Turned on later: the link comes from Running now.
    expect(
      runningNow({ ...seen, remoteUrl: undefined }, [
        live({ key: 'windows:a', remoteUrl: RC_URL, remoteActive: true })
      ])?.remoteUrl
    ).toBe(RC_URL)
    // Ended since: nothing to warn about.
    expect(runningNow(seen, [live({ key: 'windows:a', state: 'exited' })])).toBeUndefined()
    expect(runningNow(seen, [])).toBeUndefined()
    // On its way (not in Running now yet), or Running now not loaded: kept.
    expect(runningNow({ ...seen, pending: true }, [])).toMatchObject({ pending: true })
    expect(runningNow(seen, undefined)).toBe(seen)
  })

  it('a desktop-app session run through the SDK gets no terminal advice', () => {
    const l = [live({ key: 'windows:d', entrypoint: 'sdk-cli' })]
    const r = findRunningCopy({
      kind: 'resume',
      key: 'windows:d',
      live: l,
      origin: noOrigin,
      desktopApp: (k) => k === 'windows:d'
    })
    expect(r?.where).toBe('claude-app')
    const a = runningAdvice(r!, 'phone')
    expect(a.title).toBe('Already open in the Claude desktop app')
    expect(a.actions).toEqual(['another'])
    expect(a.body).not.toMatch(/\/rc/)
    // A terminal session the desktop app lists (handed over earlier, now back in a terminal) stays a terminal.
    const cli = findRunningCopy({
      kind: 'resume',
      key: 'windows:d',
      live: [live({ key: 'windows:d', entrypoint: 'cli' })],
      origin: noOrigin,
      desktopApp: () => true
    })
    expect(cli?.where).toBe('terminal')
  })

  it('Focus terminal on PC checks the phone is still paired right before focusing', async () => {
    const s = claudeSession()
    const focused: string[] = []
    let active = true
    const rl = new RemoteLauncher({
      session: () => s,
      preview: async () => PREVIEW,
      launch: async () => ({ ok: true, restored: false, commandLine: 'x' }),
      settings: () => ({
        terminal: 'wt',
        readOnly: false,
        confirmOnPc: false,
        branchConfirmed: true
      }),
      confirm: async () => true,
      deviceActive: () => active,
      log: () => undefined,
      focus: async (k) => {
        focused.push(k)
        return { ok: true }
      }
    })
    active = false
    const r = await rl.launch(DEVICE, { key: s.key, kind: 'focus' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/revoked/)
    expect(focused).toHaveLength(0)
  })

  it('Cowork sessions stay out of searches while the source is off', async () => {
    const { sessions, settings } = await setup(true)
    const key = `${COWORK_SOURCE_ID}:${COWORK_ID}`
    expect(sessions.searchKeys('action items').some((h) => h.key === key)).toBe(true)
    settings.update((st) => void (st.coworkSource = false))
    expect(sessions.searchKeys('action items').some((h) => h.key === key)).toBe(false)
  })
})

// ------------------------------------------------- final review fixes

describe('Reservations follow Running now', () => {
  type Internals = {
    reserve(s: SessionSummary, kind: string, cwd?: string): unknown
    release(r: unknown): void
    reservedCopy(s: SessionSummary, kind: string): unknown
  }

  it('retire as soon as the run shows up: once it exits, Resume is free (not "pending")', async () => {
    const spawned: string[] = []
    const { sessions, launcher } = await setup(false, { spawned })
    let now: LiveSession[] = []
    launcher.running = () => undefined
    launcher.liveSessions = () => now
    const key = `windows:${DESKTOP_ID}`
    const o = { key, fork: false, skipPermissions: false }
    expect((await launcher.launch(o)).ok).toBe(true)
    expect((await launcher.preview(o)).running?.pending).toBe(true)
    // Running now shows the new process: the reservation goes (Running now's own check takes over).
    now = [live({ key, startedAt: Date.now() })]
    launcher.observeLive()
    now = []
    // It exited: nothing is running and nothing is on its way.
    expect((await launcher.preview(o)).running).toBeUndefined()
    expect((await launcher.launch(o)).ok).toBe(true)
    expect(spawned).toHaveLength(2)
    void sessions
  })

  it('an older process of the session does not retire a new launch', async () => {
    const { launcher, sessions } = await setup(false, { spawned: [] })
    const key = `windows:${DESKTOP_ID}`
    launcher.running = () => undefined
    launcher.liveSessions = () => [live({ key, startedAt: Date.now() - 3600_000 })]
    await launcher.launch({ key, fork: false, skipPermissions: false, allowDuplicate: true })
    expect(
      (await launcher.preview({ key, fork: false, skipPermissions: false })).running?.pending
    ).toBe(true)
    void sessions
  })

  it('a fork on its way retires when the one new process in its folder appears', async () => {
    const { launcher, sessions } = await setup(false, { spawned: [] })
    const s = sessions.get(`windows:${DESKTOP_ID}`)!
    let now: LiveSession[] = []
    launcher.running = () => undefined
    launcher.liveSessions = () => now
    await launcher.launch({ key: s.key, fork: true, skipPermissions: false })
    expect(
      (await launcher.preview({ key: s.key, fork: true, skipPermissions: false })).running?.pending
    ).toBe(true)
    now = [live({ key: 'windows:new-fork', cwd: s.cwd!.toUpperCase(), startedAt: Date.now() })]
    expect(
      (await launcher.preview({ key: s.key, fork: true, skipPermissions: false })).running
    ).toBeUndefined()
  })

  it('opening a thread in the Codex app again is never blocked by its own open on the way', async () => {
    const { launcher, sessions } = await setup(false)
    const l = launcher as unknown as Internals
    const s = sessions.get(`windows:${DESKTOP_ID}`)!
    l.reserve(s, 'codex-app', s.cwd)
    expect(l.reservedCopy(s, 'codex-app')).toBeUndefined()
    // A terminal Resume of it on the way is a second copy, though.
    expect(l.reservedCopy(s, 'resume')).toMatchObject({ pending: true, where: 'codex-app' })
    l.reserve(s, 'resume', s.cwd)
    expect(l.reservedCopy(s, 'codex-app')).toMatchObject({ pending: true, where: 'terminal' })
  })

  it("a failed forced launch never frees another launch's reservation", async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const spawned: string[] = []
    const { launcher } = await setup(false, { spawned, gate })
    launcher.running = () => undefined
    const key = `windows:${DESKTOP_ID}`
    const o = { key, fork: false, skipPermissions: false }
    // 1. A launch that is still starting (its terminal hasn't opened yet).
    const first = launcher.launch(o)
    await new Promise((r) => setTimeout(r, 30))
    // 2. A forced second copy that fails (Remote Control can't run on an API key).
    const forced = await launcher.launch({
      ...o,
      allowDuplicate: true,
      remoteControl: true,
      billingAccountId: 'acct-1'
    })
    expect(forced.ok).toBe(false)
    // 3. An unforced launch is still refused: the first one is on its way.
    const third = await launcher.launch(o)
    expect(third).toMatchObject({ ok: false, running: { pending: true } })
    open()
    expect((await first).ok).toBe(true)
    expect(spawned).toHaveLength(1)
  })
})

describe('Pending phone notices upgrade from Running now', () => {
  const pending = {
    key: 'windows:a',
    relation: 'self' as const,
    state: 'working' as const,
    provider: 'claude' as const,
    env: 'windows' as const,
    where: 'terminal' as const,
    pending: true as const,
    pendingSince: NOW - 10_000,
    cwd: 'C:\\code',
    title: 'My session'
  }

  it('Resume: becomes the run, with its Remote Control link once it is on', () => {
    expect(runningNow(pending, [])).toBe(pending)
    // An older process of the session isn't the one just started.
    expect(
      runningNow(pending, [live({ key: 'windows:a', startedAt: NOW - 3600_000 })])?.pending
    ).toBe(true)
    const r = runningNow(pending, [
      live({ key: 'windows:a', startedAt: NOW - 5000, remoteUrl: RC_URL, remoteActive: true })
    ])
    expect(r).toMatchObject({
      key: 'windows:a',
      relation: 'self',
      remoteUrl: RC_URL,
      title: 'My session'
    })
    expect(r?.pending).toBeUndefined()
    expect(runningAdvice(r!, 'phone').actions[0]).toBe('open-remote')
  })

  it('Fork / Continue fresh: the one new process in its folder; two could be it: still pending', () => {
    const fork = { ...pending, relation: 'fork' as const }
    const child = live({
      key: 'windows:child',
      cwd: 'c:\\CODE',
      startedAt: NOW - 5000,
      remoteUrl: RC_URL,
      remoteActive: true
    })
    expect(runningNow(fork, [child])).toMatchObject({
      key: 'windows:child',
      relation: 'fork',
      remoteUrl: RC_URL
    })
    const other = live({ key: 'windows:other', cwd: 'C:\\code', startedAt: NOW - 4000 })
    expect(runningNow(fork, [child, other])?.pending).toBe(true)
    // The parent itself isn't its fork.
    expect(
      runningNow(fork, [live({ key: 'windows:a', cwd: 'C:\\code', startedAt: NOW - 5000 })])
        ?.pending
    ).toBe(true)
  })

  it('Codex: a pending notice upgrades too (and offers Refresh while it waits)', () => {
    const codex = { ...pending, key: 'codex-windows:t1', provider: 'codex' as const }
    const r = runningNow(codex, [
      live({ key: 'codex-windows:t1', provider: 'codex', lockHeld: true, startedAt: NOW - 5000 })
    ])
    expect(r).toMatchObject({ key: 'codex-windows:t1', where: 'terminal' })
    expect(r?.remoteUrl).toBeUndefined()
    expect(runningAdvice(codex, 'phone').title).toBe('Just started on your PC')
  })
})
