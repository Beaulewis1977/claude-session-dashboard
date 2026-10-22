// Fixtures mode (`npm run dev -- --fixtures`): copy the sample sessions into
// `.fixtures-data/` and run the app against that copy, with simulated launches.
// Files are only copied when missing; nothing is ever deleted.

import { constants } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURES_NOW } from '@shared/clock'
import type { JsonStore } from './core/json-store'
import type { AccountsFile } from './services/accounts'
import type { BridgeInstaller } from './services/bridge'
import type { SessionService } from './services/sessions'
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
  opts: { usageHistory?: boolean } = {}
): Promise<void> {
  const { fixturesDir, sourcesDir } = fixturesLayout(appRoot)
  await copyMissing(join(fixturesDir, 'windows'), join(sourcesDir, 'windows'))
  await copyMissing(join(fixturesDir, 'wsl'), join(sourcesDir, 'wsl'))
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
        cwd: 'C:\\Users\\beau\\code\\old-prototype',
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
    windows: join(sourcesDir, 'windows', 'Users', 'beau'),
    'wsl-Ubuntu-beau': join(sourcesDir, 'wsl', 'Ubuntu', 'home', 'beau')
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

/** Enable the bridge for the Windows and WSL (beau) homes once; WSL root stays off. */
export async function seedFixtureBridge(
  dataDir: string,
  sessions: SessionService,
  installer: BridgeInstaller
): Promise<void> {
  const marker = join(dataDir, '.bridge-seeded')
  if (await exists(marker)) return
  for (const id of ['windows', 'wsl-Ubuntu-beau']) {
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
  })
  await Promise.all([accounts.flush(), metadata.flush(), settings.flush()])
}
