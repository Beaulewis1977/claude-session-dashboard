// PR 33, second review: a lock or rollout that can't be read keeps its thread
// (never a false exit), an exact approval stays until it's answered, a changed
// hook or an unknown save time never counts as trusted, no lock-file limit,
// and the banner covers every home with a listed session.

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeCodexLive,
  emptyRollout,
  reduceRollout,
  type CodexThreadInput
} from '@shared/codex-live'
import { alertsCover, type HookEnv, type HookEvent, type LiveSession } from '@shared/live'
import { DEFAULT_LIVE_ALERTS } from '@shared/live-alerts'
import type { SessionSummary, SourceInfo } from '@shared/types'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import {
  CodexLiveReader,
  realCodexLiveFs,
  type CodexLiveFs,
  type ThreadLock
} from '../src/main/providers/codex/live'
import { ProviderRegistry } from '../src/main/providers/registry'
import {
  CodexHooksInstaller,
  createCodexHooksStore,
  groupAsWritten
} from '../src/main/services/codex-hooks'
import { createHooksStore, HooksInstaller } from '../src/main/services/hooks'
import { LiveService } from '../src/main/services/live'
import type { SessionService } from '../src/main/services/sessions'

const TID = '019b0000-0000-7000-8000-00000000c0de'
const err = (code: string) => Object.assign(new Error(code), { code })

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-review2-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('a lock file that can’t be read stays (never "free")', () => {
  it('Windows: a held lock whose time can’t be read keeps the time last read', async () => {
    let fail: string | undefined
    const fs: CodexLiveFs = {
      ...realCodexLiveFs,
      readdir: async () => [`${TID}.lock`],
      probeLock: async () => true,
      stat: async () => {
        if (fail) throw err(fail)
        return { mtimeMs: 1234, size: 0, ino: 1n, isFile: true }
      }
    }
    const r = new CodexLiveReader(fs)
    const home = String.raw`C:\Users\beau\.codex`
    expect((await r.locks({ env: 'windows', home }))![0]).toMatchObject({
      held: true,
      mtimeMs: 1234
    })
    fail = 'EIO'
    expect((await r.locks({ env: 'windows', home }))![0]).toMatchObject({
      held: true,
      mtimeMs: 1234
    })
    // Gone for good: nothing holds it.
    fail = 'ENOENT'
    expect((await r.locks({ env: 'windows', home }))![0].held).toBe(false)
  })

  it('WSL: a lock file that can’t be stat’ed keeps its cached inode, or is "can’t tell"', async () => {
    const distro = String.raw`\\wsl.localhost\Ubuntu`
    const home = String.raw`\\wsl.localhost\Ubuntu\home\beau\.codex`
    let fail: string | undefined
    const fs: CodexLiveFs = {
      ...realCodexLiveFs,
      readdir: async () => [`${TID}.lock`],
      stat: async () => {
        if (fail) throw err(fail)
        return { mtimeMs: 1000, size: 0, ino: 77n, isFile: true }
      },
      readSmall: async (p) =>
        /locks$/.test(p) ? '9: FLOCK  ADVISORY  WRITE 4242 08:30:77 0 EOF\n' : 'codex\0'
    }
    // No cache yet: can't tell.
    fail = 'EIO'
    const cold = (await new CodexLiveReader(fs).locks({ env: 'wsl', home, distroRoot: distro }))!
    expect(cold[0]).toMatchObject({ threadId: TID, held: undefined })
    // Cached, then failing (re-read because it's held now): still held.
    fail = undefined
    const r = new CodexLiveReader(fs)
    expect((await r.locks({ env: 'wsl', home, distroRoot: distro }))![0].held).toBe(true)
    fail = 'EIO'
    expect((await r.locks({ env: 'wsl', home, distroRoot: distro }))![0]).toMatchObject({
      held: true,
      pid: 4242
    })
  })

  it('no limit on lock files at all (a held one far past 20,000 is found)', async () => {
    const names = Array.from(
      { length: 25_000 },
      (_, i) => `019b0000-0000-7000-8000-${String(i).padStart(12, '0')}.lock`
    )
    const held = names[24_999]
    const fs: CodexLiveFs = {
      ...realCodexLiveFs,
      readdir: async () => names,
      probeLock: async (p) => p.endsWith(held),
      stat: async () => ({ mtimeMs: 1, size: 0, ino: 1n, isFile: true })
    }
    const out = (await new CodexLiveReader(fs).locks({ env: 'windows', home: 'C:\\h\\.codex' }))!
    expect(out).toHaveLength(25_000)
    expect(out.filter((l: ThreadLock) => l.held)).toHaveLength(1)
  })
})

describe('a rollout that can’t be read keeps its last state', () => {
  it('returns what was read before; forgets it only when the file is gone', async () => {
    const path = join(root, `rollout-x-${TID}.jsonl`)
    await writeFile(
      path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } })}\n`
    )
    let fail: string | undefined
    const r = new CodexLiveReader({
      ...realCodexLiveFs,
      stat: async (p) => {
        if (fail) throw err(fail)
        return realCodexLiveFs.stat(p)
      }
    })
    expect(Object.keys((await r.rollout(path))!.state.open)).toEqual(['t'])
    fail = 'EIO'
    expect(Object.keys((await r.rollout(path))!.state.open)).toEqual(['t'])
    fail = 'ENOENT'
    expect(await r.rollout(path)).toBeUndefined()
  })
})

describe('a whole Codex home that can’t be read keeps its threads (unconfirmed)', () => {
  it('a WSL share outage: the thread stays working, marked "can’t check", with no exit alert', async () => {
    const home = join(root, 'home', '.codex')
    const day = join(home, 'sessions', '2026', '11', '08')
    await mkdir(day, { recursive: true })
    await mkdir(join(home, 'thread-writer-locks'), { recursive: true })
    const lock = join(home, 'thread-writer-locks', `${TID}.lock`)
    await writeFile(lock, '')
    const took = new Date(Date.now() - 5 * 60_000)
    await utimes(lock, took, took)
    const rollout = join(day, `rollout-2026-11-08T14-23-33-${TID}.jsonl`)
    await writeFile(
      rollout,
      `${JSON.stringify({ timestamp: new Date(Date.now() - 60_000).toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'a' } })}\n`
    )
    const src: SourceInfo = {
      id: 'codex-wsl-Ubuntu-beau',
      provider: 'codex',
      label: 'WSL: Ubuntu',
      env: 'windows',
      projectsDir: join(home, 'sessions'),
      kind: 'auto',
      status: 'ok',
      sessionCount: 0
    }
    const summary = {
      key: `${src.id}:${TID}`,
      sessionId: TID,
      sourceId: src.id,
      provider: 'codex',
      title: 'Coupon fix',
      availability: 'live',
      originalPath: rollout,
      source: 'codex-cli',
      lastActivityAt: new Date().toISOString(),
      meta: {} as SessionSummary['meta']
    } as unknown as SessionSummary
    const sessions = {
      providers: new ProviderRegistry([claudeProvider, createCodexProvider()]),
      sources: [src],
      source: () => src,
      get: (k: string) => (k === summary.key ? summary : undefined),
      list: () => [summary]
    } as unknown as SessionService
    const dataDir = join(root, 'appdata')
    const hs = createHooksStore(dataDir)
    const cs = createCodexHooksStore(dataDir)
    await hs.load()
    await cs.load()
    const notified: string[] = []
    let mono = 0
    const live = new LiveService({
      sessions,
      hooks: new HooksInstaller(hs, { dataDir, scriptsDir: '', readScript: async () => '' }),
      codexHooks: new CodexHooksInstaller(cs, {
        dataDir,
        scriptsDir: '',
        readScript: async () => ''
      }),
      codexReader: new CodexLiveReader({ ...realCodexLiveFs, probeLock: async (p) => p === lock }),
      procs: { check: async (items) => items.map(() => undefined) },
      settings: () => ({ ...DEFAULT_LIVE_ALERTS, exited: true }),
      notify: (a) => notified.push(a.kind),
      push: async () => 0,
      distroRoot: () => undefined,
      mono: () => mono
    })
    await live.poll(true)
    expect(live.snapshot().sessions[0]).toMatchObject({ state: 'working', lockHeld: true })
    // The share goes away: the app marks the source unreadable.
    src.status = 'unreadable'
    mono += 3000
    await live.poll(true)
    expect(live.snapshot().sessions[0]).toMatchObject({
      state: 'working',
      unverified: true,
      lockUnknown: true
    })
    expect(notified).toEqual([])
  })
})

describe('an exact approval stays until it’s answered', () => {
  const T0 = Date.parse('2026-11-08T20:00:00.000Z')
  const ln = (ms: number, type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload })
  const base = () =>
    reduceRollout(emptyRollout(), [
      ln(T0 - 60_000, 'event_msg', { type: 'task_started', turn_id: 't' }),
      ln(T0 - 3000, 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'c1',
        input: 'await tools.exec_command({cmd:"a"}); await tools.exec_command({cmd:"b"})'
      })
    ])
  const hook: HookEvent = {
    ts: T0 - 2000,
    source: 'codex-windows',
    event: 'PermissionRequest',
    sessionId: TID,
    toolName: 'Bash'
  }
  const state = (r: ReturnType<typeof base>) =>
    computeCodexLive({
      now: T0,
      threads: [
        {
          sourceId: 'codex-windows',
          env: 'windows',
          threadId: TID,
          held: true,
          heldSince: T0 - 600_000,
          rollout: r,
          info: { label: 'codex-cli' }
        } satisfies CodexThreadInput
      ],
      events: [hook],
      exactApprovals: new Set(['codex-windows']),
      seenWorking: new Set()
    })[0]

  it('progress lines another tool writes meanwhile don’t clear it', () => {
    const r = base()
    reduceRollout(r, [
      ln(T0 - 500, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution' } }),
      ln(T0 - 400, 'event_msg', { type: 'token_count' })
    ])
    expect(state(r)).toMatchObject({ state: 'approval', basis: 'hook' })
  })

  it('the asking call’s output answers it; another tool starting doesn’t', () => {
    const out = base()
    reduceRollout(out, [
      ln(T0 - 300, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1' })
    ])
    expect(state(out).state).toBe('working')
    const call = base()
    reduceRollout(call, [
      ln(T0 - 300, 'response_item', {
        type: 'function_call',
        name: 'x',
        call_id: 'c2',
        arguments: '{}'
      })
    ])
    // Another call starting meanwhile (the asking call c1 still has no output).
    expect(state(call).state).toBe('approval')
  })
})

describe('a changed hook, or an unknown save time, is never "trusted"', () => {
  async function installed(savedAt?: (p: string) => Promise<number | undefined>) {
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
      readScript: (p) => readFile(p, 'utf8'),
      ...(savedAt ? { savedAt } : {})
    })
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    return { home, src, inst }
  }

  it('the app’s group edited (a matcher added) after it was trusted: untrusted', async () => {
    const { home, src, inst } = await installed()
    const key = `${join(home, 'hooks.json')}:permission_request:0:0`
    await writeFile(
      join(home, 'config.toml'),
      `[hooks.state.'${key}']\ntrusted_hash = "sha256:x"\n`
    )
    expect((await inst.describe(src))?.trust).toBe('trusted')
    const text = await readFile(join(home, 'hooks.json'), 'utf8')
    expect(groupAsWritten(text, 0)).toBe(true)
    const edited = text.replace(
      '"hooks": [\n          {',
      '"matcher": "Bash",\n        "hooks": [\n          {'
    )
    expect(edited).not.toBe(text)
    await writeFile(join(home, 'hooks.json'), edited)
    expect(groupAsWritten(edited, 0)).toBe(false)
    expect((await inst.describe(src))?.trust).toBe('untrusted')
  })

  it('a save time that can’t be read never lets an old event through', async () => {
    const { src, inst } = await installed(async (p) =>
      /config\.toml$/.test(p) ? undefined : Date.now() - 864e5
    )
    expect((await inst.describe(src, Date.now() + 60_000))?.trust).toBe('untrusted')
  })
})

describe('the setup banner covers every home with a listed session', () => {
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
  const row = (sourceId: string): Pick<LiveSession, 'sourceId' | 'state'> => ({
    sourceId,
    state: 'working'
  })

  it('a trusted Windows hook doesn’t hide the banner for a WSL session without one', () => {
    const hooks = [env('codex-windows'), env('codex-wsl', { installed: false })]
    expect(alertsCover([row('codex-windows')], hooks, ['codex'])).toBe(true)
    expect(alertsCover([row('codex-windows'), row('codex-wsl')], hooks, ['codex'])).toBe(false)
    expect(
      alertsCover([row('codex-wsl')], [env('codex-wsl', { trust: 'untrusted' })], ['codex'])
    ).toBe(false)
  })

  it('a home nothing runs in doesn’t matter; with nothing listed, each agent needs one somewhere', () => {
    const hooks = [env('codex-windows'), env('codex-wsl', { installed: false })]
    expect(alertsCover([], hooks, ['codex'])).toBe(true)
    expect(alertsCover([], [env('codex-wsl', { installed: false })], ['codex'])).toBe(false)
  })
})
