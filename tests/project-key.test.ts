// Per-project defaults (billing, model and effort) share one key: WSL by
// distro and exact path, Windows ignoring case. Billing defaults saved by
// 1.4.0 and older (bare paths for WSL) are migrated without losing any.

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isLegacyWslKey,
  migrateLegacyKeys,
  normalizeProjectKey,
  projectDefault,
  projectDefaultKey,
  projectKeyLabel,
  withProjectDefault,
  type ProjectRef
} from '@shared/project-key'
import { projectModelKey } from '@shared/model-choice'
import { prepareFixtures, seedFixtureData, fixturesLayout } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { FIXTURES } from './helpers'

const ubuntuApp: ProjectRef = { env: 'wsl', distro: 'Ubuntu', cwd: '/home/me/App' }
const ubuntuLower: ProjectRef = { env: 'wsl', distro: 'Ubuntu', cwd: '/home/me/app' }
const debianApp: ProjectRef = { env: 'wsl', distro: 'Debian', cwd: '/home/me/App' }
const winApp: ProjectRef = { env: 'windows', cwd: 'C:\\Code\\App' }

describe('project keys', () => {
  it('WSL: distro and exact path; Windows: the folder, ignoring case', () => {
    expect(projectDefaultKey(ubuntuApp)).toBe('wsl:Ubuntu:/home/me/App')
    expect(projectDefaultKey(ubuntuLower)).toBe('wsl:Ubuntu:/home/me/app')
    expect(projectDefaultKey(debianApp)).toBe('wsl:Debian:/home/me/App')
    expect(projectDefaultKey(winApp)).toBe('c:\\code\\app')
    expect(projectDefaultKey({ env: 'windows', cwd: 'c:\\CODE\\app' })).toBe('c:\\code\\app')
    expect(projectDefaultKey({ env: 'wsl', cwd: '/home/me/App' })).toBeUndefined()
    expect(projectDefaultKey({ env: 'windows' })).toBeUndefined()
    // Billing and model defaults use the same key.
    expect(projectModelKey(ubuntuApp)).toBe(projectDefaultKey(ubuntuApp))
  })

  it('normalizes stored keys, keeping legacy WSL keys only when asked', () => {
    expect(normalizeProjectKey('C:\\Code\\App')).toBe('c:\\code\\app')
    expect(normalizeProjectKey('wsl:Ubuntu:/home/me/App')).toBe('wsl:Ubuntu:/home/me/App')
    expect(normalizeProjectKey('wsl:Ubuntu:relative')).toBeUndefined()
    expect(normalizeProjectKey('/home/me/app')).toBeUndefined()
    expect(normalizeProjectKey('/home/me/app', true)).toBe('/home/me/app')
    expect(normalizeProjectKey('')).toBeUndefined()
    expect(isLegacyWslKey('/home/me/app')).toBe(true)
    expect(isLegacyWslKey('c:\\code')).toBe(false)
    expect(projectKeyLabel('wsl:Ubuntu:/home/me/App')).toBe('WSL: Ubuntu · /home/me/App')
    expect(projectKeyLabel('c:\\code\\app')).toBe('c:\\code\\app')
  })
})

describe('migrating billing defaults from 1.4.0 and older', () => {
  it('keeps Windows defaults exactly as they were', () => {
    const before = { 'c:\\code\\app': 'acct-1', 'd:\\work': 'subscription' }
    const after = migrateLegacyKeys(before, [winApp, ubuntuApp])
    expect(after).toBe(before)
    expect(projectDefault(after, winApp)).toBe('acct-1')
    expect(projectDefault(after, { env: 'windows', cwd: 'C:\\CODE\\APP' })).toBe('acct-1')
  })

  it('moves a legacy WSL key to every project it matched before (any distro, any case)', () => {
    const before = { '/home/me/app': 'acct-1', 'c:\\code\\app': 'subscription' }
    const after = migrateLegacyKeys(before, [ubuntuApp, ubuntuLower, debianApp, winApp])
    expect(after).toEqual({
      'wsl:Ubuntu:/home/me/App': 'acct-1',
      'wsl:Ubuntu:/home/me/app': 'acct-1',
      'wsl:Debian:/home/me/App': 'acct-1',
      'c:\\code\\app': 'subscription'
    })
    // Every one of them resolves the same as before the migration.
    for (const p of [ubuntuApp, ubuntuLower, debianApp])
      expect(projectDefault(before, p), JSON.stringify(p)).toBe(projectDefault(after, p))
  })

  it('keeps a legacy key that matches no known session yet, for a later scan', () => {
    const before = { '/home/me/other': 'acct-1' }
    expect(migrateLegacyKeys(before, [ubuntuApp, winApp])).toBe(before)
    // …and migrates it once a session in that folder shows up.
    expect(
      migrateLegacyKeys(before, [{ env: 'wsl', distro: 'Ubuntu', cwd: '/home/me/other' }])
    ).toEqual({ 'wsl:Ubuntu:/home/me/other': 'acct-1' })
  })

  it('never replaces a default already saved in the new form', () => {
    const before = { '/home/me/app': 'acct-old', 'wsl:Ubuntu:/home/me/App': 'acct-new' }
    expect(migrateLegacyKeys(before, [ubuntuApp, debianApp])).toEqual({
      'wsl:Ubuntu:/home/me/App': 'acct-new',
      'wsl:Debian:/home/me/App': 'acct-old'
    })
  })

  it('reads a not-yet-migrated legacy key the way it was read before', () => {
    const legacy = { '/home/me/app': 'acct-1' }
    expect(projectDefault(legacy, ubuntuApp)).toBe('acct-1')
    expect(projectDefault(legacy, debianApp)).toBe('acct-1')
  })
})

describe('the same path in two distros, or differing only by case', () => {
  it('keeps separate billing defaults', () => {
    let d: Record<string, string> = {}
    d = withProjectDefault(d, ubuntuApp, 'acct-1', [])
    d = withProjectDefault(d, debianApp, 'subscription', [])
    d = withProjectDefault(d, ubuntuLower, 'acct-2', [])
    expect(projectDefault(d, ubuntuApp)).toBe('acct-1')
    expect(projectDefault(d, debianApp)).toBe('subscription')
    expect(projectDefault(d, ubuntuLower)).toBe('acct-2')
  })

  it("clearing one project's default leaves the others (legacy keys are migrated first)", () => {
    const legacy = { '/home/me/app': 'acct-1' }
    const d = withProjectDefault(legacy, ubuntuApp, undefined, [ubuntuApp, debianApp])
    expect(projectDefault(d, ubuntuApp)).toBeUndefined()
    expect(projectDefault(d, debianApp)).toBe('acct-1')
    expect(d).toEqual({ 'wsl:Debian:/home/me/App': 'acct-1' })
  })
})

// The fixtures' sample billing default is a 1.4.0-style WSL key.
let root: string
let busy: { idle(): Promise<void> }[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-pkey-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('fixtures', () => {
  it('migrates the sample WSL billing default to its distro', async () => {
    await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
    // The ml-pipeline sessions are part of the usage samples.
    await prepareFixtures(root, { usageHistory: true })
    const layout = fixturesLayout(root)
    const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
    const paths = appPaths(layout.dataDir)
    const metadata = createMetadataStore(paths)
    const settings = createSettingsStore(paths)
    await metadata.load()
    await settings.load()
    await seedFixtureData(root, paths.archiveDir, metadata)
    const sessions = new SessionService(platform, paths, metadata, settings)
    busy.push(sessions)
    await sessions.start()
    await sessions.idle()
    const seed = JSON.parse(await readFile(join(FIXTURES, 'usage', 'seed.json'), 'utf8')) as {
      projectBilling: Record<string, string>
    }
    const after = migrateLegacyKeys(seed.projectBilling, sessions.list())
    expect(after).toEqual({
      'wsl:Ubuntu:/home/beau/projects/ml-pipeline':
        seed.projectBilling['/home/beau/projects/ml-pipeline']
    })
    const s = sessions.list().find((x) => x.cwd === '/home/beau/projects/ml-pipeline')!
    expect(projectDefault(after, s)).toBe(projectDefault(seed.projectBilling, s))
  })
})
