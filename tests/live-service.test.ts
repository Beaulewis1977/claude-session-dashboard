// LiveService end to end on temp folders: running files and hook events in,
// states and alerts out. It never writes inside .claude.

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIVE_ALERTS } from '@shared/live-alerts'
import type { SessionSummary, SourceInfo } from '@shared/types'
import { createHooksStore, HooksInstaller } from '../src/main/services/hooks'
import { LiveService } from '../src/main/services/live'
import type { SessionService } from '../src/main/services/sessions'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-live-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

const SID = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'

async function setup(alive: Set<number>) {
  const home = join(root, 'home')
  const claude = join(home, '.claude')
  await mkdir(join(claude, 'sessions'), { recursive: true })
  await mkdir(join(claude, 'projects'), { recursive: true })
  await writeFile(join(claude, 'settings.json'), '{}\n')
  const src: SourceInfo = {
    id: 'windows',
    label: 'Windows',
    env: 'windows',
    projectsDir: join(claude, 'projects'),
    kind: 'auto',
    status: 'ok',
    sessionCount: 0,
    claudeSettingsPath: join(claude, 'settings.json')
  }
  const summary = {
    key: `windows:${SID}`,
    title: 'Checkout flow',
    meta: {} as SessionSummary['meta']
  } as SessionSummary
  const sessions = {
    sources: [src],
    source: (id: string) => (id === 'windows' ? src : undefined),
    get: (key: string) => (key === summary.key ? summary : undefined)
  } as unknown as SessionService
  const dataDir = join(root, 'appdata')
  const store = createHooksStore(dataDir)
  await store.load()
  const hooks = new HooksInstaller(store, { dataDir, scriptsDir: '', readScript: async () => '' })
  const notified: string[] = []
  const pushed: { kind: string; ref: string }[] = []
  const live = new LiveService({
    sessions,
    hooks,
    procs: { check: async (items) => items.map((q) => alive.has(q.pid)) },
    settings: () => ({ ...DEFAULT_LIVE_ALERTS, minWorkSec: 0 }),
    notify: (a, title) => notified.push(`${a.kind}:${title}`),
    push: async (kind, ref) => {
      pushed.push({ kind, ref })
      return 1
    },
    distroRoot: () => undefined
  })
  const running = (pid: number, status: string, extra: object = {}) =>
    writeFile(
      join(claude, 'sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: SID,
        cwd: 'C:\\code\\app',
        startedAt: Date.now() - 600_000,
        status,
        updatedAt: Date.now(),
        statusUpdatedAt: Date.now(),
        ...extra
      })
    )
  return { home, claude, live, running, notified, pushed, summary }
}

describe('LiveService', () => {
  it('shows running sessions, skips stale files, and alerts once on approval', async () => {
    const t = await setup(new Set([4242]))
    await t.running(4242, 'busy')
    // A file left behind days ago by a crashed session.
    await t.running(9999, 'idle', { sessionId: 'b7a1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d' })
    const old = new Date(Date.now() - 3 * 864e5)
    await utimes(join(t.claude, 'sessions', '9999.json'), old, old)
    await writeFile(
      join(t.claude, 'sessions', '9999.json'),
      JSON.stringify({
        pid: 9999,
        sessionId: 'b7a1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
        updatedAt: old.getTime()
      })
    )
    await utimes(join(t.claude, 'sessions', '9999.json'), old, old)

    await t.live.poll(true)
    let snap = t.live.snapshot()
    expect(snap.sessions.map((s) => [s.sessionId, s.state])).toEqual([[SID, 'working']])
    expect(t.notified).toEqual([])

    // Claude asks for approval: the hook event says what for.
    await t.running(4242, 'waiting', { waitingFor: 'dialog open' })
    const events = join(t.home, '.claude-session-dashboard', 'events')
    await mkdir(events, { recursive: true })
    await writeFile(
      join(events, `${SID}.Notification.json`),
      JSON.stringify({
        session_id: SID,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash'
      })
    )
    await t.live.poll(true)
    snap = t.live.snapshot()
    expect(snap.sessions[0]).toMatchObject({
      state: 'approval',
      detail: 'Claude needs your permission to use Bash'
    })
    expect(t.notified).toEqual(['approval:Checkout flow'])
    expect(t.pushed).toHaveLength(1)
    expect(t.pushed[0].kind).toBe('approval')
    // The push reference means nothing outside the PC; the PC resolves it.
    expect(t.pushed[0].ref).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(t.pushed[0].ref).not.toContain(SID.slice(0, 8))
    expect(t.live.resolveRef(t.pushed[0].ref)).toBe(`windows:${SID}`)
    expect(t.live.resolveRef('nope')).toBeNull()

    // Still waiting: no second alert.
    await t.live.poll(true)
    expect(t.notified).toHaveLength(1)

    // Muted: no alert for the next change.
    t.summary.meta.muteAlerts = true
    await t.running(4242, 'busy')
    await t.live.poll(true)
    await t.running(4242, 'idle')
    await t.live.poll(true)
    expect(t.notified).toHaveLength(1)
  })

  it('a process that ends shows as Exited, and nothing in .claude is touched', async () => {
    const alive = new Set([4242])
    const t = await setup(alive)
    await t.running(4242, 'idle')
    await t.live.poll(true)
    expect(t.live.snapshot().sessions[0].state).toBe('idle')
    alive.delete(4242)
    await t.live.poll(true)
    expect(t.live.snapshot().sessions[0].state).toBe('exited')
    expect(await readdir(join(t.claude, 'sessions'))).toEqual(['4242.json'])
  })

  it('prunes only its own old event files', async () => {
    const t = await setup(new Set())
    const events = join(t.home, '.claude-session-dashboard', 'events')
    await mkdir(events, { recursive: true })
    const old = new Date(Date.now() - 10 * 864e5)
    for (const n of [`${SID}.Stop.json`, 'notes.txt', `.tmp.123.${SID}.Stop.json`]) {
      await writeFile(join(events, n), '{}')
      await utimes(join(events, n), old, old)
    }
    await writeFile(join(events, `${SID}.SessionStart.json`), '{}')
    await t.live.poll(true)
    // The prune runs in the background.
    for (let i = 0; i < 50 && (await readdir(events)).length > 2; i++)
      await new Promise((r) => setTimeout(r, 20))
    expect((await readdir(events)).sort()).toEqual([`${SID}.SessionStart.json`, 'notes.txt'])
  })
})
