// LiveService with Codex: a rollout on disk and a thread lock (faked: the real
// probe is tested against a real lock in codex-lock-probe.test.ts) in, rows and
// alerts out. Follows Settings → Providers, and backs off while nothing runs.

import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIVE_ALERTS } from '@shared/live-alerts'
import type { SessionSummary, SourceInfo } from '@shared/types'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import { CodexLiveReader, realCodexLiveFs } from '../src/main/providers/codex/live'
import { ProviderRegistry } from '../src/main/providers/registry'
import { CodexHooksInstaller, createCodexHooksStore } from '../src/main/services/codex-hooks'
import { createHooksStore, HooksInstaller } from '../src/main/services/hooks'
import { LiveService } from '../src/main/services/live'
import type { SessionService } from '../src/main/services/sessions'

const TID = '01a1bcd4-9e22-7511-b475-70f7803c33fd'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-live-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

const ln = (ms: number, payload: Record<string, unknown>): string =>
  `${JSON.stringify({ timestamp: new Date(ms).toISOString(), type: 'event_msg', payload })}\n`

async function setup() {
  const home = join(root, 'Users', 'beau', '.codex')
  const day = join(home, 'sessions', '2026', '11', '08')
  await mkdir(day, { recursive: true })
  await mkdir(join(home, 'thread-writer-locks'), { recursive: true })
  const lockPath = join(home, 'thread-writer-locks', `${TID}.lock`)
  await writeFile(lockPath, '')
  const rollout = join(day, `rollout-2026-11-08T14-23-33-${TID}.jsonl`)
  const t0 = Date.now()
  // Codex took the lock (resumed the thread) before the turn started.
  const took = new Date(t0 - 5 * 60_000)
  await utimes(lockPath, took, took)
  await writeFile(rollout, ln(t0 - 60_000, { type: 'task_started', turn_id: 'a' }))
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
  const summary = {
    key: `codex-windows:${TID}`,
    sessionId: TID,
    sourceId: 'codex-windows',
    provider: 'codex',
    title: 'Coupon fix',
    availability: 'live',
    originalPath: rollout,
    filePath: rollout,
    cwd: 'C:\\code\\shop',
    source: 'codex-cli',
    lastActivityAt: new Date(t0 - 60_000).toISOString(),
    meta: {} as SessionSummary['meta']
  } as unknown as SessionSummary
  const providers = new ProviderRegistry([claudeProvider, createCodexProvider()])
  const sessions = {
    providers,
    sources: [src],
    source: (id: string) => (id === src.id ? src : undefined),
    get: (key: string) => (key === summary.key ? summary : undefined),
    list: () => [summary]
  } as unknown as SessionService
  // The lock: held while `held` says so. Counts how often the lock folder is read.
  const state = { held: true, lists: 0 }
  const reader = new CodexLiveReader({
    ...realCodexLiveFs,
    readdir: async (dir) => {
      if (/thread-writer-locks$/.test(dir)) state.lists++
      return realCodexLiveFs.readdir(dir)
    },
    probeLock: async (p) => (p === lockPath ? state.held : false)
  })
  const dataDir = join(root, 'appdata')
  const hs = createHooksStore(dataDir)
  const cs = createCodexHooksStore(dataDir)
  await hs.load()
  await cs.load()
  const notified: string[] = []
  const pushed: string[] = []
  let mono = 0
  const live = new LiveService({
    sessions,
    hooks: new HooksInstaller(hs, { dataDir, scriptsDir: '', readScript: async () => '' }),
    codexHooks: new CodexHooksInstaller(cs, {
      dataDir,
      scriptsDir: '',
      readScript: async () => ''
    }),
    codexReader: reader,
    procs: { check: async (items) => items.map(() => undefined) },
    settings: () => ({ ...DEFAULT_LIVE_ALERTS, minWorkSec: 0, exited: true }),
    notify: (a, title) => notified.push(`${a.kind}:${title}`),
    push: async (kind) => {
      pushed.push(kind)
      return 1
    },
    distroRoot: () => undefined,
    mono: () => mono
  })
  return {
    live,
    state,
    rollout,
    providers,
    summary,
    notified,
    pushed,
    t0,
    tick: (ms: number) => (mono += ms)
  }
}

describe('LiveService · Codex', () => {
  it('a held thread works, finishes (alert), then exits (alert) when its lock is released', async () => {
    const t = await setup()
    await t.live.poll(true)
    expect(t.live.snapshot().sessions).toMatchObject([
      { key: `codex-windows:${TID}`, provider: 'codex', state: 'working', lockHeld: true }
    ])
    expect(t.live.codexLockPath(`codex-windows:${TID}`)).toMatch(/thread-writer-locks/)
    await appendFile(t.rollout, ln(Date.now(), { type: 'task_complete', turn_id: 'a' }))
    t.tick(3000)
    await t.live.poll()
    expect(t.live.snapshot().sessions[0].state).toBe('idle')
    expect(t.notified).toEqual(['finished:Coupon fix'])
    expect(t.pushed).toEqual(['finished'])
    t.state.held = false
    t.tick(3000)
    await t.live.poll()
    expect(t.live.snapshot().sessions[0].state).toBe('exited')
    expect(t.notified).toEqual(['finished:Coupon fix', 'exited:Coupon fix'])
  })

  it('an escalated command left waiting alerts as a (guessed) approval', async () => {
    const t = await setup()
    await t.live.poll(true)
    await appendFile(
      t.rollout,
      `${JSON.stringify({
        timestamp: new Date(Date.now() - 10_000).toISOString(),
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'c1',
          arguments: '{"cmd":"npm publish","sandbox_permissions":"require_escalated"}'
        }
      })}\n`
    )
    t.tick(3000)
    await t.live.poll()
    expect(t.live.snapshot().sessions[0]).toMatchObject({ state: 'approval', guess: true })
    expect(t.notified).toEqual(['approval:Coupon fix'])
    expect(t.pushed).toEqual(['approval'])
  })

  it('follows Settings → Providers: no Codex rows while Codex is off', async () => {
    const t = await setup()
    await t.live.poll(true)
    expect(t.live.snapshot().sessions).toHaveLength(1)
    t.providers.setEnabled({ codex: false })
    t.tick(3000)
    await t.live.poll(true)
    expect(t.live.snapshot().sessions).toEqual([])
  })

  it('polls a home every 2 s while a thread is open, and backs off to 10 s when nothing runs', async () => {
    const t = await setup()
    await t.live.poll(true)
    const after = t.state.lists
    t.tick(2100)
    await t.live.poll()
    expect(t.state.lists).toBe(after + 1)
    // Nothing runs any more: the thread ended long ago and its row went away.
    t.state.held = false
    ;(t.summary as { lastActivityAt: string }).lastActivityAt = new Date(
      Date.now() - 2 * 60 * 60_000
    ).toISOString()
    await appendFile(
      t.rollout,
      ln(Date.now() - 50 * 60_000, { type: 'task_complete', turn_id: 'a' })
    )
    t.tick(2100)
    await t.live.poll()
    t.tick(30 * 60_000)
    await t.live.poll()
    const idle = t.state.lists
    t.tick(2100)
    await t.live.poll()
    t.tick(2100)
    await t.live.poll()
    expect(t.state.lists).toBe(idle)
    t.tick(6000)
    await t.live.poll()
    expect(t.state.lists).toBe(idle + 1)
  })
})
