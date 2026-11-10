// PR 33, fourth review: an approval the hook can't pin on one call is shown as
// uncertain; an outage freezes the last known state (approvals and the desktop
// app's unlocked threads too); approval → finished honours the minimum work
// time; trust by position needs an untouched hooks.json; custom Codex folders
// get a note instead of a dead-end setup banner.

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeCodexLive,
  emptyRollout,
  hookWait,
  reduceRollout,
  type CodexLiveInputs,
  type CodexThreadInput
} from '@shared/codex-live'
import {
  alertsGap,
  EXITED_KEEP_MS,
  UNVERIFIED_MAX_MS,
  type HookEnv,
  type HookEvent,
  type LiveSession
} from '@shared/live'
import { alertVerdict, DEFAULT_LIVE_ALERTS, detectAlerts } from '@shared/live-alerts'
import type { SourceInfo } from '@shared/types'
import { CodexHooksInstaller, createCodexHooksStore } from '../src/main/services/codex-hooks'

const TID = '019b0000-0000-7000-8000-00000000c0de'
const T0 = Date.parse('2026-11-08T20:00:00.000Z')
const ln = (ms: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload })
const call = (ms: number, id: string) =>
  ln(ms, 'response_item', {
    type: 'function_call',
    name: 'exec_command',
    call_id: id,
    arguments: JSON.stringify({ cmd: 'x', sandbox_permissions: 'require_escalated' })
  })
const output = (ms: number, id: string) =>
  ln(ms, 'response_item', { type: 'function_call_output', call_id: id })
const started = (ms: number) => ln(ms, 'event_msg', { type: 'task_started', turn_id: 't' })

const thread = (over: Partial<CodexThreadInput> = {}): CodexThreadInput => ({
  sourceId: 'codex-windows',
  env: 'windows',
  threadId: TID,
  held: true,
  heldSince: T0 - 3_600_000,
  rollout: reduceRollout(emptyRollout(), [started(T0 - 60_000)]),
  rolloutMtime: T0 - 60_000,
  info: { label: 'codex-cli' },
  ...over
})
const run = (over: Partial<CodexLiveInputs>): LiveSession[] =>
  computeCodexLive({
    now: T0,
    threads: [thread()],
    events: [],
    exactApprovals: new Set(['codex-windows']),
    seenWorking: new Set(),
    ...over
  })
const map = (rows: LiveSession[]) => new Map(rows.map((r) => [r.key, r]))

describe('an approval the hook can’t pin on one call is uncertain', () => {
  const r = () =>
    reduceRollout(emptyRollout(), [started(T0 - 9000), call(T0 - 3000, 'A'), call(T0 - 3000, 'B')])

  it('both still running: waiting; one answered, one running: maybe; both answered: no', () => {
    expect(hookWait(r(), T0)).toBe('yes')
    expect(hookWait(reduceRollout(r(), [output(T0 + 2000, 'A')]), T0)).toBe('maybe')
    expect(hookWait(reduceRollout(r(), [output(T0 + 2000, 'A'), output(T0 + 2500, 'B')]), T0)).toBe(
      'no'
    )
  })

  it('a "maybe" shows as Needs approval? (and pushes as "may"), never dropped early', () => {
    const hook: HookEvent = {
      ts: T0,
      source: 'codex-windows',
      event: 'PermissionRequest',
      sessionId: TID,
      toolName: 'Bash'
    }
    const rows = run({
      now: T0 + 3000,
      threads: [thread({ rollout: reduceRollout(r(), [output(T0 + 2000, 'A')]) })],
      events: [hook]
    })
    expect(rows[0]).toMatchObject({ state: 'approval', guess: true, basis: 'hook' })
    expect(rows[0].detail).toMatch(/May still need your approval/)
  })
})

describe('an outage freezes the last known state', () => {
  it('an approval stays an approval (unconfirmed), not Working or a guess', () => {
    const hook: HookEvent = {
      ts: T0 - 1000,
      source: 'codex-windows',
      event: 'PermissionRequest',
      sessionId: TID
    }
    const asking = reduceRollout(emptyRollout(), [started(T0 - 60_000), call(T0 - 2000, 'A')])
    const first = run({ threads: [thread({ rollout: asking })], events: [hook] })
    expect(first[0]).toMatchObject({ state: 'approval', basis: 'hook' })
    // The home becomes unreadable (or its source is replaced): events and lock are gone.
    const frozen = run({
      now: T0 + 60_000,
      threads: [thread({ held: undefined, rollout: asking, outageSince: T0 + 5000 })],
      events: [],
      prev: map(first)
    })
    expect(frozen[0]).toMatchObject({
      state: 'approval',
      basis: 'hook',
      unverified: true,
      lockUnknown: true
    })
  })

  it('a desktop thread nobody locks stays its full 30 minutes, then goes', () => {
    const desktop = { label: 'codex-desktop' }
    const first = run({ threads: [thread({ held: false, heldSince: undefined, info: desktop })] })
    expect(first[0].state).toBe('working')
    const out = (now: number) =>
      run({
        now,
        threads: [thread({ held: undefined, info: desktop, outageSince: T0 })],
        prev: map(first)
      })
    // Past the 10-minute activity window, still there.
    expect(out(T0 + 20 * 60_000)[0]).toMatchObject({ state: 'working', lockUnknown: true })
    expect(out(T0 + UNVERIFIED_MAX_MS + 1000)).toEqual([])
  })

  it('an ended thread stays ended', () => {
    const exited = { ...run({})[0], state: 'exited' as const, since: T0 }
    const rows = run({
      now: T0 + 60_000,
      threads: [thread({ held: undefined, outageSince: T0 })],
      prev: map([exited])
    })
    expect(rows[0].state).toBe('exited')
    expect(
      run({
        now: T0 + EXITED_KEEP_MS + 1000,
        threads: [thread({ held: undefined, outageSince: T0 })],
        prev: map([exited])
      })
    ).toEqual([])
  })
})

describe('approval → finished honours "Finished only after"', () => {
  it('a Codex approval row carries its turn’s start, and a short turn doesn’t alert', () => {
    const hook: HookEvent = {
      ts: T0 - 1000,
      source: 'codex-windows',
      event: 'PermissionRequest',
      sessionId: TID
    }
    const short = reduceRollout(emptyRollout(), [started(T0 - 5000), call(T0 - 2000, 'A')])
    const asking = run({ threads: [thread({ rollout: short })], events: [hook] })
    expect(asking[0]).toMatchObject({ state: 'approval', turnStartedAt: T0 - 5000 })
    const done = { ...asking[0], state: 'idle' as const, since: T0 + 2000 }
    const [a] = detectAlerts(map(asking), [done])
    expect(a.kind).toBe('finished')
    const settings = { ...DEFAULT_LIVE_ALERTS, minWorkSec: 20 }
    const ctx = {
      now: T0 + 2000,
      muted: () => false,
      workedSince: () => asking[0].turnStartedAt,
      localTime: () => new Date(2026, 10, 8, 12)
    }
    expect(alertVerdict(a, settings, ctx)).toEqual({ show: false, why: 'short' })
  })
})

describe('trust by position needs an untouched hooks.json', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'csd-codex-review4-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  it('changed since the install (before the hook’s own hash is known): only an approval proves trust', async () => {
    const home = join(root, 'Users', 'alex', '.codex')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, 'config.toml'), 'model = "gpt"\n')
    const src: SourceInfo = {
      id: 'codex-windows',
      provider: 'codex',
      label: 'Windows',
      env: 'windows',
      projectsDir: join(home, 'sessions'),
      kind: 'auto',
      status: 'ok',
      sessionCount: 0
    }
    const dataDir = join(root, 'appdata')
    const store = createCodexHooksStore(dataDir)
    await store.load()
    const inst = new CodexHooksInstaller(store, {
      dataDir,
      scriptsDir: join(__dirname, '..', 'resources', 'bridge'),
      readScript: (p) => readFile(p, 'utf8')
    })
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    // Another tool rewrites hooks.json (same hook, other formatting), then a trust
    // entry appears at the hook's position: it could be another hook's.
    const json = JSON.parse(await readFile(join(home, 'hooks.json'), 'utf8'))
    await writeFile(join(home, 'hooks.json'), JSON.stringify(json))
    const key = `${join(home, 'hooks.json')}:permission_request:0:0`
    await writeFile(
      join(home, 'config.toml'),
      `[hooks.state.'${key}']\ntrusted_hash = "sha256:x"\n`
    )
    const later = new Date(Date.now() + 60_000)
    await utimes(join(home, 'config.toml'), later, later)
    expect((await inst.describe(src))?.trust).toBe('untrusted')
    expect(inst.record(src.id)?.ourHash).toBeUndefined()
    // An approval the hook delivered after both saves proves it (and its hash is learned).
    expect((await inst.describe(src, Date.now() + 120_000))?.trust).toBe('trusted')
    await new Promise((r) => setTimeout(r, 50))
    expect(inst.record(src.id)?.ourHash).toBe('sha256:x')
  })
})

describe('custom Codex folders get a note, not a dead-end setup banner', () => {
  const row = (sourceId: string, provider: 'codex' | 'claude' = 'codex') =>
    ({ sourceId, state: 'working', provider }) as Pick<
      LiveSession,
      'sourceId' | 'state' | 'provider'
    >
  const env = (sourceId: string, over: Partial<HookEnv> = {}): HookEnv => ({
    sourceId,
    label: sourceId,
    env: 'windows',
    settingsPath: '',
    installed: true,
    provider: 'codex',
    trust: 'trusted',
    ...over
  })

  it('only custom-folder sessions uncovered: "custom"; a home that can be set up: "setup"', () => {
    expect(alertsGap([row('custom')], [], ['codex'])).toBe('custom')
    expect(
      alertsGap([row('custom'), row('codex-windows')], [env('codex-windows')], ['codex'])
    ).toBe('custom')
    expect(
      alertsGap(
        [row('custom'), row('codex-windows')],
        [env('codex-windows', { trust: 'untrusted' })],
        ['codex']
      )
    ).toBe('setup')
    expect(alertsGap([row('codex-windows')], [env('codex-windows')], ['codex'])).toBe('none')
  })
})
