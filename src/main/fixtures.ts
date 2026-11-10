// Fixtures mode (`npm run dev -- --fixtures`): copy the sample sessions into
// `.fixtures-data/` and run the app against that copy, with simulated launches.
// Files are only copied when missing; nothing is ever deleted. Data made from an
// older sample layout is moved aside first (see retireOldFixtureData).

import { constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  utimes,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { clockOffset, FIXTURES_NOW, now } from '@shared/clock'
import type { JsonStore } from './core/json-store'
import type { AccountsFile } from './services/accounts'
import type { BridgeInstaller } from './services/bridge'
import { BRIDGE_DIR_NAME } from './services/bridge'
import type { HooksInstaller } from './services/hooks'
import type { ProcCheck } from './services/live'
import type { SessionService } from './services/sessions'
import { CodexLiveReader, realCodexLiveFs } from './providers/codex/live'
import type { MetadataFile, SettingsFile } from './services/store'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Recursively copy `from` into `to`, skipping files that already exist. */
async function copyMissing(
  from: string,
  to: string,
  filter = (_name: string) => true
): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = join(from, e.name)
    const dest = join(to, e.name)
    if (e.isDirectory()) await copyMissing(src, dest, filter)
    else if (e.isFile() && filter(e.name) && !(await exists(dest))) {
      await copyFile(src, dest, constants.COPYFILE_EXCL).catch(() => undefined)
    }
  }
}

/**
 * The layout of the sample data in `fixtures/`. Files are only ever copied
 * when missing, so a change that moves or renames sample files (2: the sample
 * user and host were renamed) would leave the old copies next to the new ones
 * in an existing `.fixtures-data/`. Bump this when that happens.
 */
export const FIXTURES_DATA_VERSION = 2
const FIXTURES_VERSION_FILE = 'fixtures-version'

/**
 * Before anything opens `.fixtures-data/` (Electron keeps its own files and
 * the single-instance lock in `appdata`): if it was made from an older layout,
 * move its `sources` and `appdata` aside into `.fixtures-data/previous/`
 * (still git-ignored; nothing is deleted), so the sample data is copied fresh.
 * Returns where the old data went, or undefined. If the move isn't possible
 * (another fixtures-mode run has the files open), the old data stays and the
 * check runs again next time.
 */
export function retireOldFixtureData(
  appRoot: string,
  version = FIXTURES_DATA_VERSION,
  stamp = new Date().toISOString().replace(/[:.]/g, '-')
): string | undefined {
  const base = join(appRoot, '.fixtures-data')
  const marker = join(base, FIXTURES_VERSION_FILE)
  let had: number | undefined
  try {
    had = Number(readFileSync(marker, 'utf8').trim()) || undefined
  } catch {
    had = undefined
  }
  if (had === version) return undefined
  const parts = ['sources', 'appdata'].filter((p) => existsSync(join(base, p)))
  let dest: string | undefined
  if (parts.length) {
    dest = join(base, 'previous', `v${had ?? 1}-${stamp}`)
    try {
      mkdirSync(dest, { recursive: true })
      for (const p of parts) renameSync(join(base, p), join(dest, p))
    } catch (e) {
      console.warn(
        `[fixtures] .fixtures-data is from an older sample layout but couldn't be moved aside ` +
          `(${(e as Error).message}). Close other fixtures-mode runs, or move it yourself.`
      )
      return undefined
    }
  }
  mkdirSync(base, { recursive: true })
  writeFileSync(marker, `${version}\n`)
  if (dest) console.log(`[fixtures] Older sample data moved to ${dest}`)
  return dest
}

export function fixturesLayout(appRoot: string): {
  fixturesDir: string
  sourcesDir: string
  dataDir: string
} {
  const base = join(appRoot, '.fixtures-data')
  return {
    fixturesDir: join(appRoot, 'fixtures'),
    sourcesDir: join(base, 'sources'),
    dataDir: join(base, 'appdata')
  }
}

export async function prepareFixtures(
  appRoot: string,
  opts: { usageHistory?: boolean; codex?: boolean } = {}
): Promise<void> {
  const { fixturesDir, sourcesDir } = fixturesLayout(appRoot)
  await copyMissing(join(fixturesDir, 'windows'), join(sourcesDir, 'windows'))
  await copyMissing(join(fixturesDir, 'wsl'), join(sourcesDir, 'wsl'))
  if (opts.codex) {
    // Sample Codex homes (~/.codex): plain and zstd rollouts, thread names.
    const codex = join(fixturesDir, 'codex')
    await copyMissing(join(codex, 'windows'), join(sourcesDir, 'windows'))
    await copyMissing(join(codex, 'wsl'), join(sourcesDir, 'wsl'))
  }
  if (opts.usageHistory) {
    // 13 weeks of generated sessions with token usage (scripts/make-usage-fixtures.mjs).
    const usage = join(fixturesDir, 'usage')
    await copyMissing(join(usage, 'windows'), join(sourcesDir, 'windows'))
    await copyMissing(join(usage, 'wsl'), join(sourcesDir, 'wsl'))
  }
}

/** Seed user metadata and an "archived only" session on first run. */
export async function seedFixtureData(
  appRoot: string,
  archiveDir: string,
  metadata: JsonStore<MetadataFile>
): Promise<void> {
  const { fixturesDir, sourcesDir } = fixturesLayout(appRoot)
  const seed = JSON.parse(await readFile(join(fixturesDir, 'metadata-seed.json'), 'utf8')) as Pick<
    MetadataFile,
    'sessions'
  >
  const archivedDir = join(fixturesDir, 'archived', 'windows')
  const relOriginal = (await readFile(join(archivedDir, 'original-path.txt'), 'utf8')).trim()
  const files = (await readdir(archivedDir)).filter((f) => f.endsWith('.jsonl'))

  await copyMissing(archivedDir, join(archiveDir, 'windows'), (n) => n.endsWith('.jsonl'))
  metadata.update((d) => {
    if (Object.keys(d.sessions).length === 0) d.sessions = seed.sessions
    for (const f of files) {
      const sessionId = f.slice(0, -6)
      const key = `windows:${sessionId}`
      if (d.archive[key]) continue
      const now = new Date().toISOString()
      d.archive[key] = {
        sessionId,
        sourceId: 'windows',
        sourceLabel: 'Windows',
        env: 'windows',
        originalPath: join(sourcesDir, ...relOriginal.split('/')),
        archivePath: join(archiveDir, 'windows', f),
        cwd: 'C:\\Users\\alex\\code\\old-prototype',
        size: 0,
        sha256: '',
        sourceMtimeMs: 0,
        firstArchivedAt: now,
        archivedAt: now
      }
    }
  })
  await metadata.flush()
}

/** Seed the limits history and the bridge's live files from fixtures/usage. */
export async function seedFixtureUsage(appRoot: string, dataDir: string): Promise<void> {
  const { fixturesDir, sourcesDir } = fixturesLayout(appRoot)
  const usage = join(fixturesDir, 'usage')
  const history = join(dataDir, 'limits-history.ndjson')
  if (!(await exists(history))) {
    await mkdir(dataDir, { recursive: true })
    await copyFile(join(usage, 'limits-history.ndjson'), history, constants.COPYFILE_EXCL).catch(
      () => undefined
    )
  }
  const homes: Record<string, string> = {
    windows: join(sourcesDir, 'windows', 'Users', 'alex'),
    'wsl-Ubuntu-alex': join(sourcesDir, 'wsl', 'Ubuntu', 'home', 'alex')
  }
  for (const [source, home] of Object.entries(homes)) {
    const from = join(usage, 'live', source)
    if (!(await exists(from))) continue
    const to = join(home, '.claude-session-dashboard', 'live')
    await copyMissing(from, to, (n) => n.endsWith('.json'))
    // Give the files the capture time on the fixtures clock.
    const captured = Date.parse(
      (await readFile(join(from, 'captured-at.txt'), 'utf8').catch(() => '')).trim()
    )
    if (!Number.isFinite(captured)) continue
    const real = new Date(captured - (FIXTURES_NOW - Date.now()))
    for (const n of await readdir(from)) {
      if (n.endsWith('.json')) await utimes(join(to, n), real, real).catch(() => undefined)
    }
  }
}

/** Enable the bridge for the Windows and WSL (alex) homes once; WSL root stays off. */
export async function seedFixtureBridge(
  dataDir: string,
  sessions: SessionService,
  installer: BridgeInstaller
): Promise<void> {
  const marker = join(dataDir, '.bridge-seeded')
  if (await exists(marker)) return
  for (const id of ['windows', 'wsl-Ubuntu-alex']) {
    const src = sessions.source(id)
    if (!src) continue
    const plan = await installer.plan(src, 'install')
    if (!plan.error && !plan.noop) await installer.apply(src, 'install', plan.token)
  }
  await writeFile(marker, `${new Date().toISOString()}\n`).catch(() => undefined)
}

/** Sample API accounts (no real keys), credit grants and billing tags. */
export async function seedFixtureAccounts(
  appRoot: string,
  accounts: JsonStore<AccountsFile>,
  metadata: JsonStore<MetadataFile>,
  settings: JsonStore<SettingsFile>
): Promise<void> {
  if (accounts.value.accounts.length || accounts.value.grants.length) return
  const seed = JSON.parse(
    await readFile(join(fixturesLayout(appRoot).fixturesDir, 'usage', 'seed.json'), 'utf8')
  ) as {
    accounts: AccountsFile['accounts']
    grants: AccountsFile['grants']
    billing: Record<string, { mode: 'api'; accountId: string }>
    projectBilling: Record<string, string>
  }
  accounts.update((d) => {
    d.accounts = seed.accounts.map((a) => ({ ...a, sample: true }))
    d.grants = seed.grants
  })
  metadata.update((d) => {
    for (const [sid, b] of Object.entries(seed.billing)) {
      d.sessions[sid] = { ...(d.sessions[sid] ?? {}), billing: { ...b, source: 'launch' } }
    }
  })
  settings.update((s) => {
    s.projectBilling = { ...seed.projectBilling }
    // Limit health: normal dates before the sample data's Oct 1 cut, and one
    // time marked as "used Claude elsewhere".
    s.health = { ...s.health, baselineFrom: '2026-08-03', baselineTo: '2026-09-26' }
    s.elsewhere = [
      {
        id: 'sample-elsewhere',
        from: Date.parse('2026-10-18T17:30:00Z'),
        to: Date.parse('2026-10-18T19:00:00Z'),
        note: 'claude.ai on my phone'
      }
    ]
  })
  await Promise.all([accounts.flush(), metadata.flush(), settings.flush()])
}

/** Sample processes that count as running in fixtures mode (nothing real is checked). */
const FIXTURE_LIVE_PIDS = new Set([41200, 41288, 51700])

export function fixtureProcChecker(): ProcCheck {
  return { check: async (items) => items.map((q) => FIXTURE_LIVE_PIDS.has(q.pid)) }
}

interface FixtureRun {
  source: string
  pid: number
  sessionId: string
  cwd: string
  status?: string
  waitingFor?: string
  name?: string
  /** Minutes ago. */
  started: number
  changed: number
  bridgeSessionId?: string
}

const FIXTURE_RUNS: FixtureRun[] = [
  {
    source: 'windows',
    pid: 41200,
    sessionId: '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
    cwd: 'C:\\Users\\alex\\code\\acme-web',
    status: 'busy',
    started: 42,
    changed: 3
  },
  {
    source: 'windows',
    pid: 41288,
    sessionId: 'c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c',
    cwd: 'C:\\Users\\alex\\My Projects\\desktop app',
    status: 'waiting',
    waitingFor: 'dialog open',
    started: 95,
    changed: 6,
    bridgeSessionId: 'session_01FixtureRemoteCtl0001'
  },
  {
    source: 'wsl-Ubuntu-alex',
    pid: 51700,
    sessionId: 'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8',
    cwd: '/home/alex/projects/orders-api',
    status: 'idle',
    name: 'orders-api retries',
    started: 130,
    changed: 12
  },
  // Crashed a few minutes ago: shown as Exited for a while.
  {
    source: 'wsl-Ubuntu-alex',
    pid: 51733,
    sessionId: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
    cwd: '/home/alex/dotfiles',
    status: 'busy',
    started: 30,
    changed: 8
  },
  // Left behind days ago (a stale file): not shown.
  {
    source: 'windows',
    pid: 39001,
    sessionId: '2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b',
    cwd: 'C:\\Users\\alex\\code\\acme-web',
    status: 'idle',
    started: 4400,
    changed: 4300
  }
]

function runningFile(r: FixtureRun, t: number, status = r.status): string {
  const at = t - r.changed * 60_000
  return `${JSON.stringify(
    {
      pid: r.pid,
      sessionId: r.sessionId,
      cwd: r.cwd,
      startedAt: t - r.started * 60_000,
      version: '2.1.316',
      kind: 'interactive',
      entrypoint: 'cli',
      ...(r.name ? { name: r.name, nameSource: 'user' } : {}),
      status,
      ...(r.waitingFor && status === 'waiting' ? { waitingFor: r.waitingFor } : {}),
      updatedAt: at,
      statusUpdatedAt: at,
      ...(r.bridgeSessionId ? { bridgeSessionId: r.bridgeSessionId } : {})
    },
    null,
    2
  )}\n`
}

/**
 * "Running now" in fixtures mode: session alerts on for the sample homes,
 * running-session files and a hook event, written fresh on every start (they
 * live in `.fixtures-data`). One session keeps switching between working and
 * finished, so alerts can be seen.
 */
export async function seedFixtureLive(
  dataDir: string,
  sessions: SessionService,
  hooks: HooksInstaller
): Promise<void> {
  const marker = join(dataDir, '.hooks-seeded')
  if (!(await exists(marker))) {
    for (const id of ['windows', 'wsl-Ubuntu-alex']) {
      const src = sessions.source(id)
      if (!src) continue
      const plan = await hooks.plan(src, 'install')
      if (!plan.error && !plan.noop) await hooks.apply(src, 'install', plan.token)
    }
    await writeFile(marker, `${new Date().toISOString()}\n`).catch(() => undefined)
  }
  const t = now()
  const real = (appMs: number): Date => new Date(appMs - clockOffset())
  const dirOf = (source: string): string | undefined => {
    const settings = sessions.source(source)?.claudeSettingsPath
    return settings ? dirname(settings) : undefined
  }
  for (const r of FIXTURE_RUNS) {
    const claude = dirOf(r.source)
    if (!claude) continue
    const dir = join(claude, 'sessions')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${r.pid}.json`)
    await writeFile(file, runningFile(r, t))
    const when = real(t - r.changed * 60_000)
    await utimes(file, when, when).catch(() => undefined)
  }
  // The waiting session's hook event says what it waits for.
  const win = dirOf('windows')
  if (win) {
    const events = join(dirname(win), BRIDGE_DIR_NAME, 'events')
    await mkdir(events, { recursive: true })
    const r = FIXTURE_RUNS[1]
    const file = join(events, `${r.sessionId}.Notification.json`)
    await writeFile(
      file,
      `${JSON.stringify({
        session_id: r.sessionId,
        cwd: r.cwd,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash'
      })}\n`
    )
    const when = real(t - r.changed * 60_000)
    await utimes(file, when, when).catch(() => undefined)
  }
  // Working ⇄ finished, every 45 seconds.
  const busy = FIXTURE_RUNS[0]
  const claude = dirOf(busy.source)
  if (!claude) return
  let working = true
  setInterval(() => {
    working = !working
    const at = now()
    void writeFile(
      join(claude, 'sessions', `${busy.pid}.json`),
      runningFile({ ...busy, changed: 0 }, at, working ? 'busy' : 'idle')
    ).catch(() => undefined)
  }, 45_000).unref()
}

// ------------------------------------------------------------ Codex live

/** Codex threads whose locks are "held" in fixtures mode, per home (Windows, WSL). */
const FIXTURE_CODEX_HELD = {
  windows: ['019a4444-0000-7000-8000-000000000004', '019a1111-0000-7000-8000-000000000001'],
  wsl: ['019a7777-0000-7000-8000-000000000007']
}

const fakeIno = (id: string): bigint => BigInt(parseInt(id.slice(-6), 16) + 900_000)

/**
 * Codex's thread locks in fixtures mode: three threads are open (two on
 * Windows, one in WSL), without any real lock. Everything else is read from
 * the fixture copies as usual.
 */
export function fixtureCodexReader(): CodexLiveReader {
  const heldIn = (dir: string): string[] =>
    /[\\/]wsl[\\/]/.test(dir) ? FIXTURE_CODEX_HELD.wsl : FIXTURE_CODEX_HELD.windows
  const all = [...FIXTURE_CODEX_HELD.windows, ...FIXTURE_CODEX_HELD.wsl]
  const lockOf = (path: string): string | undefined =>
    all.find((id) => path.endsWith(`${id}.lock`) && /thread-writer-locks/.test(path))
  const since = Date.now() - 35 * 60_000
  return new CodexLiveReader({
    ...realCodexLiveFs,
    readdir: async (dir) =>
      /thread-writer-locks$/.test(dir)
        ? heldIn(dir).map((id) => `${id}.lock`)
        : realCodexLiveFs.readdir(dir),
    stat: async (path) => {
      const id = lockOf(path)
      return id
        ? { mtimeMs: since, size: 0, ino: fakeIno(id), isFile: true }
        : realCodexLiveFs.stat(path)
    },
    probeLock: async (path) => !!lockOf(path),
    readSmall: async (path) => {
      if (/[\\/]proc[\\/]locks$/.test(path))
        return FIXTURE_CODEX_HELD.wsl
          .map((id, i) => `${i + 1}: FLOCK  ADVISORY  WRITE 6100${i} 08:30:${fakeIno(id)} 0 EOF`)
          .join('\n')
      if (/[\\/]proc[\\/]\d+[\\/]cmdline$/.test(path)) return 'codex\0resume\0'
      return realCodexLiveFs.readSmall(path)
    }
  })
}

/**
 * Codex in Running now (fixtures mode): one thread keeps switching between
 * working and finished, one has an escalated command waiting (a "probably
 * needs approval"), by appending turn events to the fixture copies of their
 * rollouts in `.fixtures-data`.
 */
export async function seedFixtureCodexLive(sessions: SessionService): Promise<void> {
  const path = (id: string): string | undefined => sessions.get(`codex-windows:${id}`)?.originalPath
  const iso = (ms: number): string => new Date(ms).toISOString()
  const line = (ms: number, type: string, payload: Record<string, unknown>): string =>
    `${JSON.stringify({ timestamp: iso(ms), type, payload })}\n`
  const [busyId, waitId] = FIXTURE_CODEX_HELD.windows
  const wait = path(waitId)
  if (wait) {
    const t = now() - 3 * 60_000
    await appendFile(
      wait,
      line(t, 'event_msg', {
        type: 'task_started',
        turn_id: 'fx-turn-wait',
        started_at: Math.floor(t / 1000)
      }) +
        line(t + 20_000, 'response_item', {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'fx-call-wait',
          arguments: JSON.stringify({
            cmd: 'npm publish',
            sandbox_permissions: 'require_escalated'
          })
        })
    ).catch(() => undefined)
  }
  const busy = path(busyId)
  if (!busy) return
  let n = 0
  const flip = (): void => {
    const t = now()
    const id = `fx-turn-${n++}`
    const working = n % 2 === 1
    void appendFile(
      busy,
      working
        ? line(t, 'event_msg', {
            type: 'task_started',
            turn_id: id,
            started_at: Math.floor(t / 1000)
          })
        : line(t, 'event_msg', {
            type: 'task_complete',
            turn_id: `fx-turn-${n - 2}`,
            completed_at: Math.floor(t / 1000)
          })
    ).catch(() => undefined)
  }
  flip()
  setInterval(flip, 45_000).unref()
}
