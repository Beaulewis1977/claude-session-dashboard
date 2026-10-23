import { cp, mkdtemp, readFile, rm, stat, unlink, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareFixtures, seedFixtureData, fixturesLayout } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { Launcher } from '../src/main/services/launcher'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { sessionToMarkdown } from '@shared/markdown'
import { FIXTURES } from './helpers'

let root: string
/** Services with background work (archive copies) to finish before cleanup. */
let busy: { idle(): Promise<void> }[] = []

async function setup() {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
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
  const launcher = new Launcher(platform, sessions, () => settings.value.terminal)
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, layout, paths, metadata, settings }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-service-'))
})
afterEach(async () => {
  // fileChanged() queues an archive copy in the background: let it finish
  // before the folder goes, or Windows can refuse to remove it (ENOTEMPTY).
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true })
})

describe('SessionService (fixtures)', () => {
  it('finds Windows and WSL sessions, including /root, and reports stopped distros', async () => {
    const { sessions } = await setup()
    const list = sessions.list()
    expect(list).toHaveLength(9)
    const byEnv = (env: string) => list.filter((s) => s.env === env)
    expect(byEnv('windows')).toHaveLength(6)
    expect(byEnv('wsl')).toHaveLength(3)
    expect(list.find((s) => s.cwd === '/root/infra scripts')?.sourceId).toBe('wsl-Ubuntu-root')

    const sources = sessions.payload().sources
    expect(sources.find((s) => s.distro === 'Debian')?.status).toBe('not-running')
    expect(sources.some((s) => s.distro === 'docker-desktop')).toBe(false)
    expect(sources.find((s) => s.id === 'wsl-Ubuntu-beau')?.cleanupPeriodDays).toBe(90)
    expect(sources.find((s) => s.id === 'windows')?.cleanupPeriodDays).toBeNull()
  })

  it('labels each session with the product that ran it, stores it, and keeps a manual override', async () => {
    const { sessions, metadata } = await setup()
    const get = (id: string) => sessions.list().find((s) => s.sessionId === id)!
    expect(get('7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d').source).toBe('vscode')
    expect(get('2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b').source).toBe('terminal-windows')
    expect(get('5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a').source).toBe('terminal-wsl')
    expect(get('a0b1c2d3-e4f5-4a6b-9c8d-7e6f5a4b3c2d').source).toBe('sdk')
    // Legacy format: no entrypoint recorded.
    expect(get('c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c').source).toBe('unknown')
    expect(metadata.value.sessions['7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'].source).toMatchObject({
      label: 'vscode',
      by: 'auto'
    })
    const key = get('c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c').key
    sessions.updateMeta(key, { source: { label: 'jetbrains', by: 'manual' } })
    expect(get('c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c')).toMatchObject({
      source: 'jetbrains',
      sourceReason: 'Set by hand'
    })
    await sessions.rescan()
    expect(get('c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c').source).toBe('jetbrains')
    sessions.updateMeta(key, { source: null as unknown as undefined })
    expect(get('c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c').source).toBe('unknown')
    await sessions.idle()
  })

  it('applies titles from metadata, summaries and first prompts', async () => {
    const { sessions } = await setup()
    const get = (id: string) => sessions.list().find((s) => s.sessionId === id)!
    expect(get('7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d')).toMatchObject({
      title: 'Safari login loop',
      titleSource: 'name'
    })
    expect(get('e9a1b2c3-d4e5-4f60-8172-839405a6b7c8').titleSource).toBe('summary')
    expect(get('2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b').titleSource).toBe('first-prompt')
    expect(get('2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b').malformedLines).toBe(2)
  })

  it('archives every session and shows the archived-only one', async () => {
    const { sessions, paths } = await setup()
    const archived = sessions.list().find((s) => s.availability === 'archived-only')!
    expect(archived.title).toBe('Canvas particle demo for meetup')
    for (const s of sessions.list()) {
      const rec = sessions.archiveRecord(s.key)!
      expect(rec.archivePath.startsWith(paths.archiveDir)).toBe(true)
      expect((await stat(rec.archivePath)).size).toBeGreaterThan(0)
    }
  })

  it('stores names/descriptions/tags only in its own metadata and indexes them', async () => {
    const { sessions, paths, metadata, layout } = await setup()
    const s = sessions.list().find((x) => x.titleSource === 'first-prompt')!
    const before = await readFile(s.filePath, 'utf8')
    sessions.updateMeta(s.key, {
      name: 'Moment to date-fns',
      description: 'Plan',
      tags: ['Refactor', 'refactor', ' Dates ']
    })
    await metadata.flush()
    expect(sessions.get(s.key)!.meta.tags).toEqual(['refactor', 'dates'])
    expect(await readFile(s.filePath, 'utf8')).toBe(before)
    expect(await readFile(paths.metadataFile, 'utf8')).toContain('Moment to date-fns')
    expect(s.filePath.startsWith(layout.sourcesDir)).toBe(true)

    await new Promise((r) => setTimeout(r, 50))
    expect(sessions.searchKeys('date-fns').map((h) => h.key)).toContain(s.key)
    expect(sessions.searchKeys('safari cookie')[0].key).toContain('7f3c9a12')
    expect(sessions.searchKeys('pagination')[0].fields.length).toBeGreaterThan(0)
  })

  it('picks up new and growing files, and falls back to the archive when one disappears', async () => {
    const { sessions } = await setup()
    const s = sessions.list().find((x) => x.sessionId.startsWith('c41e2d7a'))!
    await appendFile(
      s.filePath,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'one more question' },
        timestamp: '2026-10-22T10:00:00Z'
      }) + '\n'
    )
    await sessions.fileChanged(s.sourceId, s.filePath)
    await sessions.idle()
    expect(sessions.get(s.key)!.userMessageCount).toBe(3)
    expect((await stat(sessions.archiveRecord(s.key)!.archivePath)).size).toBe(
      (await stat(s.filePath)).size
    )

    // Simulate Claude Code's cleanup removing the file (in the temp copy).
    await unlink(s.filePath)
    await sessions.pollSource(s.sourceId)
    const after = sessions.get(s.key)!
    expect(after.availability).toBe('archived-only')
    expect(after.userMessageCount).toBe(3)

    const newPath = join(s.filePath, '..', '11111111-2222-4333-8444-555555555555.jsonl')
    await writeFile(
      newPath,
      JSON.stringify({
        type: 'user',
        cwd: 'C:\\x',
        message: { content: 'brand new' },
        timestamp: '2026-10-22T11:00:00Z'
      }) + '\n'
    )
    await sessions.fileChanged(s.sourceId, newPath)
    expect(sessions.list().some((x) => x.firstPrompt === 'brand new')).toBe(true)
  })

  it('restores an archived-only session before resuming, without overwriting', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.availability === 'archived-only')!
    const preview = await launcher.preview({ key: s.key, fork: false, skipPermissions: true })
    expect(preview.willRestore).toBe(true)
    // Fixtures pretend the old-prototype folder is gone.
    expect(preview.cwdExists).toBe(false)
    const refused = await launcher.launch({ key: s.key, fork: false, skipPermissions: true })
    expect(refused.ok).toBe(false)

    const res = await launcher.launch({
      key: s.key,
      fork: true,
      skipPermissions: true,
      cwdOverride: 'C:\\Users\\beau\\code\\new-place'
    })
    expect(res).toMatchObject({ ok: true, restored: true, simulated: true })
    expect(res.commandLine).toBe(
      `Start-Process -FilePath 'C:\\Users\\beau\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' -ArgumentList '-d C:\\Users\\beau\\code\\new-place C:\\Windows\\System32\\cmd.exe /s /k "\\"C:\\Users\\beau\\.local\\bin\\claude.exe\\" --resume ${s.sessionId} --dangerously-skip-permissions --fork-session"'`
    )
    const restored = await readFile(s.originalPath, 'utf8')
    expect(restored).toBe(await readFile(s.archivePath!, 'utf8'))

    // A second launch must not overwrite the (now existing) original.
    await writeFile(s.originalPath, restored + '{"type":"user","message":{"content":"new"}}\n')
    const again = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      cwdOverride: 'C:\\tmp'
    })
    expect(again.restored).toBe(false)
    expect(await readFile(s.originalPath, 'utf8')).toContain('"new"')
  })

  it('reuses the startup cache and re-parses only changed files', async () => {
    const first = await setup()
    const before = first.sessions.list()
    const changed = before.find((x) => x.sessionId.startsWith('c41e2d7a'))!
    await appendFile(
      changed.filePath,
      JSON.stringify({
        type: 'user',
        message: { content: 'added between runs' },
        timestamp: '2026-10-22T12:00:00Z'
      }) + '\n'
    )
    // Second start with the same data folder.
    const layout = fixturesLayout(root)
    const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
    const paths = appPaths(layout.dataDir)
    const metadata = createMetadataStore(paths)
    const settings = createSettingsStore(paths)
    await metadata.load()
    await settings.load()
    const again = new SessionService(platform, paths, metadata, settings)
    busy.push(again)
    await again.start()
    await again.idle()
    expect(
      again
        .list()
        .map((x) => x.key)
        .sort()
    ).toEqual(before.map((x) => x.key).sort())
    expect(again.get(changed.key)!.userMessageCount).toBe(changed.userMessageCount + 1)
    expect(again.searchKeys('added between runs').map((h) => h.key)).toEqual([changed.key])
    expect(again.searchKeys('safari cookie')[0].key).toContain('7f3c9a12')
    await stat(join(paths.dataDir, 'cache', 'sessions-v3.json'))
  })

  it('builds WSL previews and exports Markdown', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.cwd === '/root/infra scripts')!
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      terminal: 'wt'
    })
    expect(p.commandLine).toBe(
      `Start-Process -FilePath 'C:\\Users\\beau\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' -ArgumentList 'C:\\Windows\\System32\\wsl.exe -d Ubuntu --cd "/root/infra scripts" -- bash -lic "claude --resume ${s.sessionId}"'`
    )
    const detail = (await sessions.detail(s.key))!
    const md = sessionToMarkdown(detail)
    expect(md).toContain('# Write a systemd timer')
    expect(md).toContain('WSL: Ubuntu')
    expect(md).toContain('<summary>🔧 Write pg-backup.service</summary>')
    expect(md).toContain('Nightly postgres backup timer')
  })
})
