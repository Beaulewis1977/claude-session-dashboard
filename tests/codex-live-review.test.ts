// PR 33 review: an unreadable lock is never "ended", a crashed CLI turn isn't
// work, an old hook event can't override a later trust change, a guessed
// approval is pushed as "may", and the setup banner waits for a working hook.

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeCodexLive,
  emptyRollout,
  reduceRollout,
  type CodexLiveInputs,
  type CodexThreadInput
} from '@shared/codex-live'
import { alertsWork, UNVERIFIED_MAX_MS, type LiveSession } from '@shared/live'
import { pushKindOf } from '@shared/live-alerts'
import type { SourceInfo } from '@shared/types'
import { pushPayload } from '../src/main/mobile/webpush'
import { CodexHooksInstaller, createCodexHooksStore } from '../src/main/services/codex-hooks'

const T0 = Date.parse('2026-11-08T20:00:00.000Z')
const TID = '019b0000-0000-7000-8000-00000000c0de'
const KEY = `codex-wsl-Ubuntu-beau:${TID}`
const line = (ms: number, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: new Date(ms).toISOString(), type: 'event_msg', payload })
const working = () =>
  reduceRollout(emptyRollout(), [
    line(T0 - 60_000, { type: 'task_started', turn_id: 't', started_at: (T0 - 60_000) / 1000 })
  ])
const thread = (over: Partial<CodexThreadInput> = {}): CodexThreadInput => ({
  sourceId: 'codex-wsl-Ubuntu-beau',
  env: 'wsl',
  threadId: TID,
  held: true,
  heldSince: T0 - 60 * 60_000,
  rollout: working(),
  rolloutMtime: T0 - 60_000,
  info: { label: 'codex-cli' },
  ...over
})
const run = (over: Partial<CodexLiveInputs>): LiveSession[] =>
  computeCodexLive({
    now: T0,
    threads: [thread()],
    events: [],
    exactApprovals: new Set(),
    seenWorking: new Set(),
    ...over
  })
const map = (rows: LiveSession[]) => new Map(rows.map((r) => [r.key, r]))

describe('a lock that can’t be checked is never "ended"', () => {
  it('keeps an open thread (unconfirmed) while its lock was seen held lately, without an exit', () => {
    const first = run({})
    expect(first[0]).toMatchObject({ state: 'working', lockHeld: true })
    const seen = new Map([[KEY, T0]])
    const unknown = run({
      now: T0 + 5000,
      threads: [thread({ held: undefined })],
      prev: map(first),
      lockSeenAt: seen
    })
    expect(unknown[0]).toMatchObject({ state: 'working', lockHeld: true, unverified: true })
    // Readable again and still held: confirmed, no exit in between.
    const back = run({ now: T0 + 10_000, prev: map(unknown), lockSeenAt: seen })
    expect(back[0].state).toBe('working')
    expect(back[0].unverified).toBeUndefined()
  })

  it('after a while without being able to check, it counts only fresh work', () => {
    const first = run({})
    const later = T0 + UNVERIFIED_MAX_MS + 60_000
    const rows = run({
      now: later,
      threads: [
        thread({
          held: undefined,
          rollout: reduceRollout(working(), [
            line(T0 - 50_000, { type: 'task_complete', turn_id: 't' })
          ]),
          rolloutMtime: T0 - 50_000
        })
      ],
      prev: map(first),
      lockSeenAt: new Map([[KEY, T0]])
    })
    expect(rows).toEqual([])
  })
})

describe('a crashed CLI turn isn’t work', () => {
  it('a free lock and an open turn: no row for the CLI, a row for the desktop app', () => {
    // The CLI died mid-turn before the dashboard saw its lock; the rollout still has the turn open.
    expect(run({ threads: [thread({ held: false, heldSince: undefined })] })).toEqual([])
    const desktop = run({
      threads: [thread({ held: false, heldSince: undefined, info: { label: 'codex-desktop' } })]
    })
    expect(desktop[0]).toMatchObject({ state: 'working', unverified: true })
  })
})

describe('a guessed approval is pushed as "may need"', () => {
  it('picks the push kind from the guess, and the phone payload carries only that', () => {
    const s = { guess: true } as LiveSession
    expect(pushKindOf({ kind: 'approval', session: s })).toBe('approval_maybe')
    expect(pushKindOf({ kind: 'approval', session: {} as LiveSession })).toBe('approval')
    expect(pushKindOf({ kind: 'finished', session: s })).toBe('finished')
    expect(JSON.parse(pushPayload({ kind: 'approval_maybe', ref: 'abcdefgh12' }))).toEqual({
      v: 1,
      kind: 'approval_maybe',
      ref: 'abcdefgh12'
    })
  })

  it('the service worker words it as a maybe', async () => {
    const sw = await readFile(join(__dirname, '..', 'src', 'renderer', 'public', 'sw.js'), 'utf8')
    expect(sw).toContain("approval_maybe: 'A session may need your approval'")
  })
})

describe('the setup banner waits for alerts that really run', () => {
  it('a Codex hook counts only when trusted and hooks are on', () => {
    expect(alertsWork({ installed: true })).toBe(true)
    expect(alertsWork({ installed: false })).toBe(false)
    expect(alertsWork({ installed: true, provider: 'codex', trust: 'untrusted' })).toBe(false)
    expect(alertsWork({ installed: true, provider: 'codex', trust: 'disabled' })).toBe(false)
    expect(
      alertsWork({ installed: true, provider: 'codex', trust: 'trusted', hooksFeatureOff: true })
    ).toBe(false)
    expect(alertsWork({ installed: true, provider: 'codex', trust: 'trusted' })).toBe(true)
  })
})

describe('an old hook event can’t override a later trust change', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'csd-codex-review-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  async function installed() {
    const home = join(root, 'Users', 'beau', '.codex')
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
    return { home, src, inst }
  }

  it('an event after the latest saves proves the hook runs', async () => {
    const { src, inst } = await installed()
    expect((await inst.describe(src, Date.now() + 60_000))?.trust).toBe('trusted')
  })

  it('an event older than the latest config.toml save (trust revoked since) doesn’t count', async () => {
    const { home, src, inst } = await installed()
    const event = Date.now() + 1000
    const later = new Date(event + 60_000)
    await writeFile(join(home, 'config.toml'), 'model = "gpt"\n# trust revoked in /hooks\n')
    await utimes(join(home, 'config.toml'), later, later)
    expect((await inst.describe(src, event))?.trust).toBe('untrusted')
  })

  it('an event older than the latest hooks.json save (the hook changed since) doesn’t count', async () => {
    const { home, src, inst } = await installed()
    const event = Date.now() + 1000
    const later = new Date(event + 60_000)
    await utimes(join(home, 'hooks.json'), later, later)
    expect((await inst.describe(src, event))?.trust).toBe('untrusted')
  })

  it('never overrides a hook turned off in /hooks', async () => {
    const { home, src, inst } = await installed()
    const key = `${join(home, 'hooks.json')}:permission_request:0:0`
    const later = new Date(Date.now() + 60_000)
    await writeFile(
      join(home, 'config.toml'),
      `[hooks.state.'${key}']\ntrusted_hash = "sha256:x"\nenabled = false\n`
    )
    await utimes(join(home, 'config.toml'), later, later)
    expect((await inst.describe(src, Date.now() + 120_000))?.trust).toBe('disabled')
  })
})
