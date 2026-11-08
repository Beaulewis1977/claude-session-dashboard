// Codex's login file (~/.codex/auth.json) is never opened: a whole scan,
// archive and read of the sample Codex homes (which have an auth.json) is
// watched through every file function the app uses, and no call names it.

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const touched: string[] = []
const record = (p: unknown): void => {
  if (typeof p === 'string') touched.push(p)
  else if (p instanceof URL) touched.push(p.pathname)
  else if (Buffer.isBuffer(p)) touched.push(p.toString())
}

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  const wrap =
    <F extends (...a: never[]) => unknown>(f: F) =>
    (...a: Parameters<F>): ReturnType<F> => {
      record(a[0])
      return f(...a) as ReturnType<F>
    }
  return {
    ...real,
    default: real,
    open: wrap(real.open),
    readFile: wrap(real.readFile),
    stat: wrap(real.stat),
    lstat: wrap(real.lstat),
    copyFile: wrap(real.copyFile),
    readdir: wrap(real.readdir),
    access: wrap(real.access)
  }
})
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  const wrap =
    <F extends (...a: never[]) => unknown>(f: F) =>
    (...a: Parameters<F>): ReturnType<F> => {
      record(a[0])
      return f(...a) as ReturnType<F>
    }
  return {
    ...real,
    default: real,
    createReadStream: wrap(real.createReadStream),
    readFileSync: wrap(real.readFileSync),
    openSync: wrap(real.openSync),
    copyFileSync: wrap(real.copyFileSync)
  }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-auth-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

it('never opens, stats, copies or reads auth.json while scanning, archiving, reading and counting Codex usage', async () => {
  const { prepareFixtures, fixturesLayout } = await import('../src/main/fixtures')
  const { createFixturesPlatform } = await import('../src/main/platform')
  const { appPaths, createMetadataStore, createSettingsStore } =
    await import('../src/main/services/store')
  const { SessionService } = await import('../src/main/services/sessions')
  const { ProviderRegistry } = await import('../src/main/providers/registry')
  const { createCodexProvider } = await import('../src/main/providers/codex')
  const { claudeProvider } = await import('../src/main/providers/claude')

  await cp(join(__dirname, '..', 'fixtures'), join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: true })
  const layout = fixturesLayout(root)
  const authFile = join(layout.sourcesDir, 'windows', 'Users', 'beau', '.codex', 'auth.json')
  // The sample home really has one.
  expect((await import('node:fs')).existsSync(authFile)).toBe(true)

  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  settings.update((s) => {
    s.codexArchive = 'all'
  })
  touched.length = 0
  const sessions = new SessionService(
    createFixturesPlatform(layout.fixturesDir, layout.sourcesDir),
    paths,
    metadata,
    settings,
    new ProviderRegistry([claudeProvider, createCodexProvider()])
  )
  await sessions.start()
  await sessions.idle()
  const codex = sessions.list().filter((s) => s.provider === 'codex')
  expect(codex.length).toBeGreaterThan(0)
  for (const s of codex) await sessions.detail(s.key)
  sessions.searchKeys('checkout')
  await sessions.rescan()
  await sessions.idle()
  // Usage and limits: every rollout read again in full (token_count events).
  const { UsageService, usagePaths } = await import('../src/main/services/usage')
  const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
    weekStart: 'monday',
    prices: []
  }))
  await usage.start()
  await usage.idle()
  expect(usage.codexRecords().length).toBeGreaterThan(0)
  expect(usage.codexLimitReadings().length).toBeGreaterThan(0)

  // The scan really went through the Codex home…
  expect(touched.some((p) => /[\\/]\.codex[\\/]sessions/.test(p))).toBe(true)
  expect(touched.some((p) => /session_index\.jsonl$/.test(p))).toBe(true)
  // …and never named its login file.
  expect(touched.filter((p) => /auth\.json$/i.test(p))).toEqual([])
  // Nothing in the archive is a copy of it either.
  expect(
    Object.values(metadata.value.archive).some((r) => /auth\.json$/i.test(r.originalPath))
  ).toBe(false)
})

it('never names auth.json while Running now polls Codex and the approval hook is added and removed', async () => {
  const { prepareFixtures, fixturesLayout } = await import('../src/main/fixtures')
  const { createFixturesPlatform } = await import('../src/main/platform')
  const { appPaths, createMetadataStore, createSettingsStore } =
    await import('../src/main/services/store')
  const { SessionService } = await import('../src/main/services/sessions')
  const { ProviderRegistry } = await import('../src/main/providers/registry')
  const { createCodexProvider } = await import('../src/main/providers/codex')
  const { claudeProvider } = await import('../src/main/providers/claude')
  const { CodexLiveReader, realCodexLiveFs } = await import('../src/main/providers/codex/live')
  const { LiveService } = await import('../src/main/services/live')
  const { createHooksStore, HooksInstaller } = await import('../src/main/services/hooks')
  const { CodexHooksInstaller, createCodexHooksStore } =
    await import('../src/main/services/codex-hooks')
  const { DEFAULT_LIVE_ALERTS } = await import('@shared/live-alerts')
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')

  await cp(join(__dirname, '..', 'fixtures'), join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: true })
  const layout = fixturesLayout(root)
  const codexHome = join(layout.sourcesDir, 'windows', 'Users', 'beau', '.codex')
  // An open thread: its lock file exists (and the probe below says it's held).
  const locks = join(codexHome, 'thread-writer-locks')
  await mkdir(locks, { recursive: true })
  const held = join(locks, '019a1111-0000-7000-8000-000000000001.lock')
  await writeFile(held, '')

  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  const sessions = new SessionService(
    createFixturesPlatform(layout.fixturesDir, layout.sourcesDir),
    paths,
    metadata,
    settings,
    new ProviderRegistry([claudeProvider, createCodexProvider()])
  )
  await sessions.start()
  await sessions.idle()
  const src = sessions.sources.find((s) => s.id === 'codex-windows')!
  const hs = createHooksStore(layout.dataDir)
  const cs = createCodexHooksStore(layout.dataDir)
  await hs.load()
  await cs.load()
  const scripts = join(__dirname, '..', 'resources', 'bridge')
  const codexHooks = new CodexHooksInstaller(cs, {
    dataDir: layout.dataDir,
    scriptsDir: scripts,
    readScript: (p) => readFile(p, 'utf8')
  })
  touched.length = 0
  const live = new LiveService({
    sessions,
    hooks: new HooksInstaller(hs, {
      dataDir: layout.dataDir,
      scriptsDir: scripts,
      readScript: (p) => readFile(p, 'utf8')
    }),
    codexHooks,
    codexReader: new CodexLiveReader({ ...realCodexLiveFs, probeLock: async (p) => p === held }),
    procs: { check: async (items) => items.map(() => undefined) },
    settings: () => DEFAULT_LIVE_ALERTS,
    notify: () => undefined,
    push: async () => 0,
    distroRoot: (id) => sessions.source(id)?.distroRoot
  })
  await live.poll(true)
  expect(live.snapshot().sessions.some((s) => s.provider === 'codex')).toBe(true)
  const plan = await codexHooks.plan(src, 'install')
  expect((await codexHooks.apply(src, 'install', plan.token)).ok).toBe(true)
  await live.refreshHooks()
  await live.poll(true)
  await codexHooks.apply(src, 'uninstall', (await codexHooks.plan(src, 'uninstall')).token)

  // It really read the locks and the open thread's rollout…
  expect(touched.some((p) => /thread-writer-locks/.test(p))).toBe(true)
  expect(touched.some((p) => /019a1111-0000-7000-8000-000000000001\.jsonl$/.test(p))).toBe(true)
  expect(touched.some((p) => /hooks\.json$/.test(p))).toBe(true)
  // …and never named its login file.
  expect(touched.filter((p) => /auth\.json$/i.test(p))).toEqual([])
})
