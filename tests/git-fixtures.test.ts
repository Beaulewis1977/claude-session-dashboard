// Git links end to end on the sample data (fixtures mode): the sessions'
// own files → signals → the sample repos (fixtures/git) → links, badges,
// PRs and search. No git or gh runs.

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sanitizeGitSettings } from '@shared/git/types'
import { createFixturesBackend } from '../src/main/git/fixtures'
import { GitLinksService } from '../src/main/git/service'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { ProviderRegistry } from '../src/main/providers/registry'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import { SessionService } from '../src/main/services/sessions'
import { LineageService } from '../src/main/services/lineage'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { FIXTURES } from './helpers'

let root: string
const busy: SessionService[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-git-fx-'))
})
afterEach(async () => {
  for (const s of busy.splice(0)) await s.idle()
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

async function setup(gh: 'ask' | 'on' = 'ask') {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: true })
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(
    platform,
    paths,
    metadata,
    settings,
    new ProviderRegistry([claudeProvider, createCodexProvider()])
  )
  busy.push(sessions)
  await sessions.start()
  await sessions.idle()
  // Forks and branches, as the app works them out after the scan.
  await new LineageService(sessions, 0).refresh()
  const git = new GitLinksService({
    sessions,
    backend: await createFixturesBackend(layout.fixturesDir),
    platform,
    dataDir: paths.dataDir,
    settings: () => ({ git: sanitizeGitSettings({ gh }), scanStoppedDistros: false })
  })
  sessions.gitBadgeResolver = (k) => git.badge(k)
  sessions.gitFilter = (q) => git.filter(q)
  await git.start()
  await git.schedule({ force: false })
  const key = (id: string) => sessions.list().find((s) => s.sessionId.startsWith(id))!.key
  return { sessions, git, key }
}

describe('git links on the sample data', () => {
  it('links the login fix (branch + files) and its merged PR', async () => {
    const { sessions, git, key } = await setup()
    const k = key('7f3c9a12')
    const v = git.view(k, { refresh: false })!
    expect(v.repo).toMatchObject({ github: 'beau/acme-web', env: 'Windows' })
    expect(v.commits.map((c) => [c.subject, c.level])).toEqual([
      ['Add cookie tests', 'high'],
      ['Fix login redirect: SameSite=Lax session cookie', 'high']
    ])
    expect(v.commits[0].branches).toEqual(['fix/login-redirect'])
    expect(v.prs).toMatchObject([
      { number: 14, via: 'merge', url: 'https://github.com/beau/acme-web/pull/14' }
    ])
    expect(sessions.get(k)!.git).toEqual({ commits: 2, prs: [14] })
    // Asked once before gh is used.
    expect(v.gh).toBe('ask')
  })

  it('reads a WSL repo through its distro, and finds the PR with gh once turned on', async () => {
    const { git, key } = await setup('on')
    const v = git.view(key('e9a1b2c3'), { refresh: false })!
    expect(v.repo).toMatchObject({ env: 'WSL: Ubuntu', github: 'beau/orders-api' })
    expect(v.commits.map((c) => [c.subject, c.level])).toEqual([
      ['Cursor pagination for GET /orders', 'high']
    ])
    expect(v.prs).toMatchObject([
      { number: 22, state: 'open', via: 'gh', title: 'Cursor pagination for /orders' }
    ])
    // api/openapi.yaml was changed by a subagent (Task), not an edit in this file.
    expect(v.uncommitted).toEqual([])
  })

  it("links a Codex thread's commit; its subagent gives way", async () => {
    const { git, key } = await setup()
    const v = git.view(key('019a1111'), { refresh: false })!
    expect(v.repo?.github).toBeUndefined()
    expect(v.commits.map((c) => [c.subject, c.level])).toEqual([
      ['Round the discount before the total', 'high']
    ])
    expect(v.prs).toEqual([])
    expect(git.view(key('019a3333'), { refresh: false })!.commits).toEqual([])
  })

  it('finds sessions by a file they touched or a commit', async () => {
    const { sessions, key } = await setup()
    expect(sessions.searchKeys('touched:cookies.ts').map((h) => h.key)).toContain(key('7f3c9a12'))
    expect(sessions.searchKeys('touched:internal/http/cursor.go').map((h) => h.key)).toEqual([
      key('e9a1b2c3')
    ])
    const sha = sessions.searchKeys('touched:checkout/total.ts').map((h) => h.key)
    expect(sha).toContain(key('019a1111'))
  })

  it('shows a diff from the sample patches', async () => {
    const { git, key } = await setup()
    const k = key('e9a1b2c3')
    const c = git.view(k, { refresh: false })!.commits[0]
    const d = await git.diff(k, c.sha, 'internal/http/cursor.go')
    expect(d.files).toMatchObject([{ path: 'internal/http/cursor.go', status: 'added', add: 13 }])
  })
})
