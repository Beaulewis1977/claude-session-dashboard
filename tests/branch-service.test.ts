import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJsonl } from '@shared/jsonl'
import { writeNewSessionFile } from '../src/main/core/branch-write'
import { assertBranchWrite, UnsafeWriteError } from '../src/main/core/safe-paths'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { Launcher } from '../src/main/services/launcher'
import { LineageService } from '../src/main/services/lineage'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { FIXTURES } from './helpers'

const SAFARI = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const FIXED_ID = '3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a'

let root: string

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
  const lineage = new LineageService(sessions, 1)
  const launcher = new Launcher(platform, sessions, () => settings.value.terminal)
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, lineage, metadata }
}

const sha = async (p: string) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-branch-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Branch from here (fixtures)', () => {
  it('adds a new session file next to the original and never touches the original', async () => {
    const { sessions, launcher, lineage } = await setup()
    const parent = sessions.list().find((s) => s.sessionId === SAFARI)!
    const before = await sha(parent.filePath)
    const filesBefore = await readdir(dirname(parent.filePath))
    const detail = (await sessions.detail(parent.key))!
    // An assistant message that calls a tool: the cut must take its result along.
    const target = detail.messages.find(
      (m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool_use')
    )!

    const preview = await launcher.preview({
      key: parent.key,
      fork: false,
      skipPermissions: true,
      branch: { at: target.id, mode: 'include', newSessionId: FIXED_ID }
    })
    expect(preview.branchError).toBeUndefined()
    expect(preview.branch).toMatchObject({
      newSessionId: FIXED_ID,
      atMessageId: target.id,
      snapped: 'forward',
      name: 'Safari login loop — branch'
    })
    expect(preview.branch!.targetPath).toBe(join(dirname(parent.filePath), `${FIXED_ID}.jsonl`))
    expect(preview.claudeCommand).toBe(`claude --resume ${FIXED_ID} --dangerously-skip-permissions`)

    const res = await launcher.launch({
      key: parent.key,
      fork: false,
      skipPermissions: true,
      branch: { at: target.id, mode: 'include', newSessionId: FIXED_ID }
    })
    expect(res.ok).toBe(true)
    expect(res.simulated).toBe(true)
    expect(res.commandLine).toContain(`--resume ${FIXED_ID}`)
    expect(res.commandLine).not.toContain('--fork-session')
    const branch = res.branch!
    expect(branch.key).toBe(`windows:${FIXED_ID}`)
    expect(branch.title).toBe('Safari login loop — branch')
    expect(branch.meta.branch).toMatchObject({
      parentSessionId: SAFARI,
      parentKey: parent.key,
      via: 'app',
      atMessageId: target.id,
      snapped: 'forward'
    })

    // Only one file was added; the original is byte-for-byte the same.
    expect(await sha(parent.filePath)).toBe(before)
    const filesAfter = await readdir(dirname(parent.filePath))
    expect(filesAfter.sort()).toEqual([...filesBefore, `${FIXED_ID}.jsonl`].sort())

    const { events } = parseJsonl(await readFile(branch.filePath, 'utf8'))
    expect(events.every((e) => e.sessionId === undefined || e.sessionId === FIXED_ID)).toBe(true)
    expect(branch.messageCount).toBeLessThan(parent.messageCount)

    await lineage.refresh()
    expect(sessions.get(branch.key)?.lineage).toMatchObject({
      parentKey: parent.key,
      atMessageId: target.id,
      via: 'app'
    })
    expect(sessions.get(parent.key)?.lineage).toBeUndefined()
  })

  it('never overwrites: an existing file with the requested id is left alone', async () => {
    const { sessions, launcher } = await setup()
    const parent = sessions.list().find((s) => s.sessionId === SAFARI)!
    const taken = join(dirname(parent.filePath), `${FIXED_ID}.jsonl`)
    await writeFile(taken, 'precious\n')
    const msg = (await sessions.detail(parent.key))!.messages.find((m) => m.role === 'user')!
    const res = await launcher.launch({
      key: parent.key,
      fork: false,
      skipPermissions: false,
      branch: { at: msg.id, mode: 'include', newSessionId: FIXED_ID, createOnly: true }
    })
    expect(res.ok).toBe(true)
    expect(res.branch!.sessionId).not.toBe(FIXED_ID)
    expect(await readFile(taken, 'utf8')).toBe('precious\n')
    await expect(writeNewSessionFile(dirname(taken), FIXED_ID, 'x')).rejects.toMatchObject({
      code: 'EEXIST'
    })
  })

  it('branches an archived-only session into its original folder without restoring it', async () => {
    const { sessions, launcher } = await setup()
    const archived = sessions.list().find((s) => s.availability === 'archived-only')!
    const msg = (await sessions.detail(archived.key))!.messages.filter(
      (m) => m.role === 'assistant'
    )[0]
    const res = await launcher.launch({
      key: archived.key,
      fork: false,
      skipPermissions: false,
      branch: { at: msg.id, mode: 'include', createOnly: true }
    })
    expect(res.ok).toBe(true)
    expect(dirname(res.branch!.filePath)).toBe(dirname(archived.originalPath))
    await expect(readFile(archived.originalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects a fork made outside the app from its shared message uuids', async () => {
    const { sessions, lineage } = await setup()
    const parent = sessions.list().find((s) => s.sessionId === SAFARI)!
    // What `claude --resume <id> --fork-session` leaves behind: the same lines with
    // a new session id, then the new conversation.
    const forkId = '4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b'
    const text = await readFile(parent.filePath, 'utf8')
    const copied = text
      .trimEnd()
      .split('\n')
      .map((l) => l.split(SAFARI).join(forkId))
    copied.push(
      JSON.stringify({
        type: 'user',
        uuid: '9c9c9c9c-0000-4000-8000-000000000001',
        sessionId: forkId,
        timestamp: '2026-10-21T09:00:00.000Z',
        message: { role: 'user', content: 'Try a different approach' }
      })
    )
    const path = join(dirname(parent.filePath), `${forkId}.jsonl`)
    await writeFile(path, copied.join('\n') + '\n')
    await sessions.fileChanged('windows', path)
    await lineage.refresh()
    const fork = sessions.get(`windows:${forkId}`)!
    expect(fork.lineage).toMatchObject({ parentKey: parent.key, via: 'shared-history' })
    expect(fork.lineage!.shared).toBeGreaterThan(2)
    expect(sessions.get(parent.key)?.lineage).toBeUndefined()
  })

  it('names and links a fork launched from the app when it appears', async () => {
    const { sessions, lineage } = await setup()
    const parent = sessions.list().find((s) => s.sessionId === SAFARI)!
    lineage.expectFork(parent)
    const forkId = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c'
    const text = await readFile(parent.filePath, 'utf8')
    const path = join(dirname(parent.filePath), `${forkId}.jsonl`)
    await writeFile(path, text.split(SAFARI).join(forkId))
    await sessions.fileChanged('windows', path)
    await lineage.refresh()
    const fork = sessions.get(`windows:${forkId}`)!
    expect(fork.title).toBe('Safari login loop — branch')
    expect(fork.meta.branch).toMatchObject({ parentKey: parent.key, via: 'fork' })
    expect(fork.lineage).toMatchObject({ parentKey: parent.key, via: 'fork' })
  })
})

describe('branch write guard', () => {
  it('only allows <uuid>.jsonl directly in the given project folder', () => {
    const dir = join('/home/u/.claude/projects', '-home-u-app')
    expect(() => assertBranchWrite(join(dir, `${FIXED_ID}.jsonl`), dir)).not.toThrow()
    expect(() => assertBranchWrite(join(dir, 'settings.json'), dir)).toThrow(UnsafeWriteError)
    expect(() => assertBranchWrite(join(dir, 'sub', `${FIXED_ID}.jsonl`), dir)).toThrow(
      UnsafeWriteError
    )
    expect(() => assertBranchWrite(join(dir, '..', `${FIXED_ID}.jsonl`), dir)).toThrow(
      UnsafeWriteError
    )
    expect(() => assertBranchWrite(join(dir, 'abc.jsonl'), dir)).toThrow(UnsafeWriteError)
  })
})
