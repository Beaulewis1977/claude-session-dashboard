// PR 33, third review: an exact approval belongs to the call that asked; a home
// that leaves the source list keeps its threads a while; a reordered or foreign
// trust entry isn't the app's; approval → idle alerts "finished"; a Codex home
// without alert setup isn't covered; an edited hook says so.

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyRollout, hookStillWaiting, reduceRollout } from '@shared/codex-live'
import { alertsCover, type LiveSession } from '@shared/live'
import { detectAlerts } from '@shared/live-alerts'
import type { SessionSummary, SourceInfo } from '@shared/types'
import { DEFAULT_LIVE_ALERTS } from '@shared/live-alerts'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import { CodexLiveReader, realCodexLiveFs } from '../src/main/providers/codex/live'
import { ProviderRegistry } from '../src/main/providers/registry'
import { CodexHooksInstaller, createCodexHooksStore } from '../src/main/services/codex-hooks'
import { createHooksStore, HooksInstaller } from '../src/main/services/hooks'
import { LiveService } from '../src/main/services/live'
import type { SessionService } from '../src/main/services/sessions'

const TID = '019b0000-0000-7000-8000-00000000c0de'
const T0 = Date.parse('2026-11-08T20:00:00.000Z')
const ln = (ms: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload })
const call = (ms: number, id: string, escalated: boolean) =>
  ln(ms, 'response_item', {
    type: 'function_call',
    name: 'exec_command',
    call_id: id,
    arguments: JSON.stringify({
      cmd: 'x',
      ...(escalated ? { sandbox_permissions: 'require_escalated' } : {})
    })
  })
const output = (ms: number, id: string) =>
  ln(ms, 'response_item', { type: 'function_call_output', call_id: id, output: '' })

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-review3-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('an exact approval belongs to the call that asked', () => {
  const hookAt = T0
  const base = () =>
    reduceRollout(emptyRollout(), [
      ln(T0 - 9000, 'event_msg', { type: 'task_started', turn_id: 't' }),
      call(T0 - 3000, 'A', true),
      call(T0 - 3000, 'B', false)
    ])

  it('another tool finishing (or starting) while A waits doesn’t answer it', () => {
    const r = base()
    reduceRollout(r, [output(T0 + 2000, 'B'), call(T0 + 2500, 'C', false)])
    expect(hookStillWaiting(r, hookAt)).toBe(true)
  })

  it('A’s own output answers it (an approved command returns within its yield time)', () => {
    const r = base()
    reduceRollout(r, [output(T0 + 4000, 'A')])
    expect(hookStillWaiting(r, hookAt)).toBe(false)
  })

  it('without an escalated call, any call running at the request counts', () => {
    const r = reduceRollout(emptyRollout(), [
      ln(T0 - 9000, 'event_msg', { type: 'task_started', turn_id: 't' }),
      call(T0 - 3000, 'P', false)
    ])
    expect(hookStillWaiting(r, hookAt)).toBe(true)
    reduceRollout(r, [output(T0 + 1000, 'P')])
    expect(hookStillWaiting(r, hookAt)).toBe(false)
  })

  it('a call answered before the request isn’t the one asking', () => {
    const r = reduceRollout(emptyRollout(), [
      ln(T0 - 9000, 'event_msg', { type: 'task_started', turn_id: 't' }),
      call(T0 - 5000, 'old', true),
      output(T0 - 4000, 'old'),
      call(T0 - 2000, 'A', true)
    ])
    expect(hookStillWaiting(r, hookAt)).toBe(true)
  })
})

describe('approval straight to idle is "finished"', () => {
  it('alerts when the turn ended before Working was seen again', () => {
    const s = (state: LiveSession['state']): LiveSession =>
      ({
        key: 'k',
        sessionId: 's',
        sourceId: 'x',
        env: 'windows',
        state,
        since: T0,
        lastSeenAt: T0,
        basis: 'hook'
      }) as LiveSession
    expect(detectAlerts(new Map([['k', s('approval')]]), [s('idle')]).map((a) => a.kind)).toEqual([
      'finished'
    ])
    expect(
      detectAlerts(new Map([['k', s('approval')]]), [{ ...s('idle'), failed: true }]).map(
        (a) => a.kind
      )
    ).toEqual(['failed'])
  })
})

describe('a Codex home without alert setup isn’t covered', () => {
  it('a custom Codex home’s session keeps the banner; a Claude one without hooks doesn’t', () => {
    const row = (
      provider: 'codex' | 'claude'
    ): Pick<LiveSession, 'sourceId' | 'state' | 'provider'> => ({
      sourceId: 'custom',
      state: 'working',
      provider
    })
    expect(alertsCover([row('codex')], [], ['codex'])).toBe(false)
    expect(alertsCover([row('claude')], [], ['claude'])).toBe(true)
  })
})

describe('trust: the app’s own hash, wherever its group sits', () => {
  async function setup(configToml: string, hooksJson?: string) {
    const home = join(root, 'Users', 'alex', '.codex')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, 'config.toml'), configToml)
    if (hooksJson) await writeFile(join(home, 'hooks.json'), hooksJson)
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
    const key = (g: number) => `${join(home, 'hooks.json')}:permission_request:${g}:0`
    const trustAt = async (entries: [number, string][]) => {
      await writeFile(
        join(home, 'config.toml'),
        entries.map(([g, h]) => `[hooks.state.'${key(g)}']\ntrusted_hash = "${h}"\n`).join('\n')
      )
      const later = new Date(Date.now() + 60_000)
      await utimes(join(home, 'config.toml'), later, later)
    }
    return { home, src, inst, trustAt }
  }

  it('a hash that was in config.toml before the install is never the app’s', async () => {
    const mine =
      '{ "hooks": { "PermissionRequest": [ { "hooks": [ { "type": "command", "command": "mine" } ] } ] } }\n'
    // The user's own group is at 0 (trusted as sha256:theirs); the app's goes to 1.
    const { inst, src, trustAt } = await setup(
      '[hooks.state.\'placeholder\']\ntrusted_hash = "sha256:theirs"\n',
      mine
    )
    expect(inst.record(src.id)?.foreignHashes).toContain('sha256:theirs')
    expect(inst.record(src.id)?.installGroup).toBe(1)
    // The app's group moved to 0, where the user's group's trust still sits.
    await trustAt([[0, 'sha256:theirs']])
    const text = await readFile(join(root, 'Users', 'alex', '.codex', 'hooks.json'), 'utf8')
    const swapped = JSON.parse(text)
    swapped.hooks.PermissionRequest.reverse()
    await writeFile(
      join(root, 'Users', 'alex', '.codex', 'hooks.json'),
      JSON.stringify(swapped, null, 2)
    )
    expect((await inst.describe(src))?.trust).toBe('untrusted')
  })

  it('once known, only the app’s own hash counts, at whatever position', async () => {
    const { home, inst, src, trustAt } = await setup('model = "gpt"\n')
    await trustAt([[0, 'sha256:ours']])
    expect((await inst.describe(src))?.trust).toBe('trusted')
    await new Promise((r) => setTimeout(r, 50))
    expect(inst.record(src.id)?.ourHash).toBe('sha256:ours')
    // Another hash at its position (a different group's, after a reorder): not trusted.
    await trustAt([[0, 'sha256:other']])
    expect((await inst.describe(src))?.trust).toBe('untrusted')
    // Its own hash at a new position (moved, and Codex keyed it there): trusted.
    const json = JSON.parse(await readFile(join(home, 'hooks.json'), 'utf8'))
    json.hooks.PermissionRequest.unshift({ hooks: [{ type: 'command', command: 'theirs' }] })
    await writeFile(join(home, 'hooks.json'), JSON.stringify(json, null, 2))
    await trustAt([
      [0, 'sha256:other'],
      [1, 'sha256:ours']
    ])
    expect((await inst.describe(src))?.trust).toBe('trusted')
  })

  it('an edited group says so (and isn’t trusted)', async () => {
    const { home, inst, src, trustAt } = await setup('model = "gpt"\n')
    await trustAt([[0, 'sha256:ours']])
    const json = JSON.parse(await readFile(join(home, 'hooks.json'), 'utf8'))
    json.hooks.PermissionRequest[0].matcher = 'Bash'
    await writeFile(join(home, 'hooks.json'), JSON.stringify(json, null, 2))
    expect(await inst.describe(src)).toMatchObject({ trust: 'untrusted', hookModified: true })
  })
})

describe('a home that leaves the source list keeps its threads a while', () => {
  it('a stopped distro’s home replaced by a placeholder: still listed, unconfirmed, no exit', async () => {
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
      `${ln(Date.now() - 60_000, 'event_msg', { type: 'task_started', turn_id: 'a' })}\n`
    )
    const user: SourceInfo = {
      id: 'codex-wsl-Ubuntu-alex',
      provider: 'codex',
      label: 'WSL: Ubuntu',
      env: 'windows',
      projectsDir: join(home, 'sessions'),
      kind: 'auto',
      status: 'ok',
      sessionCount: 0
    }
    const placeholder: SourceInfo = {
      ...user,
      id: 'codex-wsl-Ubuntu',
      status: 'not-running',
      projectsDir: join(root, 'x')
    }
    const summary = {
      key: `${user.id}:${TID}`,
      sessionId: TID,
      sourceId: user.id,
      provider: 'codex',
      title: 'Coupon fix',
      availability: 'live',
      originalPath: rollout,
      source: 'codex-cli',
      lastActivityAt: new Date().toISOString(),
      meta: {} as SessionSummary['meta']
    } as unknown as SessionSummary
    const list = { sources: [user] }
    const sessions = {
      providers: new ProviderRegistry([claudeProvider, createCodexProvider()]),
      get sources() {
        return list.sources
      },
      source: (id: string) => list.sources.find((s) => s.id === id),
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
    // A rescan finds the distro stopped: the user's home is replaced by a placeholder.
    list.sources = [placeholder]
    mono += 3000
    await live.poll(true)
    expect(live.snapshot().sessions[0]).toMatchObject({
      key: summary.key,
      state: 'working',
      unverified: true
    })
    expect(notified).toEqual([])
  })
})
