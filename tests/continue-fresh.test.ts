import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeLineage } from '@shared/lineage'
import type { LaunchOptions, SessionSummary } from '@shared/types'
import type { AiSummary as Summary } from '@shared/summary'
import {
  buildLaunchCommand,
  claudeArgs,
  isSafeContinueArg,
  type LaunchCommand
} from '../src/main/core/launch'
import { handoffPath, writeHandoff } from '../src/main/core/handoff'
import { isInsideClaudeDir } from '../src/main/core/safe-paths'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import {
  parseLaunchRequest,
  RemoteLauncher,
  remoteLaunchOptions,
  type RemoteLaunchDeps
} from '../src/main/mobile/remote-launch'
import { createFixturesPlatform } from '../src/main/platform'
import { Launcher, NO_SUMMARY } from '../src/main/services/launcher'
import { LineageService } from '../src/main/services/lineage'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { FIXTURES, TOOLS } from './helpers'

const SAFARI = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const ORDERS = 'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8'
const NEW_ID = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c'

const SUMMARY: Summary = {
  title: 'Fix the Safari login cookie',
  done: ['Found the SameSite bug'],
  files: ['src/auth/cookie.ts'],
  decisions: [],
  todos: ['Test on iOS'],
  pickUp: 'Run the iOS check.',
  model: 'claude-sonnet-5-5',
  generatedAt: '2026-10-22T19:47:00.000Z',
  messageCount: 2
}

describe('Continue fresh: the claude command', () => {
  const cont = {
    newSessionId: NEW_ID,
    prompt:
      '@C:\\Users\\beau\\AppData\\Roaming\\CSD\\handoffs\\a.md Continue from this handoff of an earlier session.'
  }

  it('puts the first message first, then the usual flags and a new session id', () => {
    const args = claudeArgs(
      'ignored',
      true,
      false,
      false,
      { name: 'Safari' },
      false,
      { model: 'sonnet', effort: 'high' },
      cont
    )
    expect(args).toEqual([
      cont.prompt,
      '--remote-control',
      'Safari',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--session-id',
      NEW_ID,
      '--dangerously-skip-permissions'
    ])
    // Never a resume of the old session.
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--fork-session')
  })

  it('adds the handoff folder with --add-dir before the session id (it takes several values)', () => {
    const args = claudeArgs('x', false, false, false, undefined, true, undefined, {
      ...cont,
      prompt: 'Read the handoff file C:\\Users\\Beau Lewis\\h.md first, then continue from it.',
      addDir: 'C:\\Users\\Beau Lewis\\AppData\\Roaming\\CSD\\handoffs'
    })
    expect(args.slice(-4)).toEqual([
      '--add-dir',
      'C:\\Users\\Beau Lewis\\AppData\\Roaming\\CSD\\handoffs',
      '--session-id',
      NEW_ID
    ])
    expect(args).toContain('--permission-mode')
  })

  it('refuses an id or a message that could be read as something else', () => {
    expect(() =>
      claudeArgs('x', false, false, false, undefined, false, undefined, {
        ...cont,
        newSessionId: '--x'
      })
    ).toThrow(/Invalid session id/)
    for (const bad of [
      'a "quoted" path',
      '100% done',
      'a; calc',
      'a & calc',
      'a | calc',
      'line\nbreak',
      '--dangerously-skip-permissions',
      ' leading space',
      '$(whoami)',
      '`id`'
    ]) {
      expect(isSafeContinueArg(bad)).toBe(false)
      expect(() =>
        claudeArgs('x', false, false, false, undefined, false, undefined, {
          ...cont,
          prompt: bad
        })
      ).toThrow()
    }
  })

  it('builds argument arrays for every terminal, the message staying one argument', () => {
    const msg =
      'Read the handoff file C:\\Users\\Beau Lewis\\AppData\\Roaming\\CSD\\handoffs\\a.md first, then continue from it.'
    const base = {
      sessionId: SAFARI,
      fork: false,
      skipPermissions: false,
      tools: TOOLS,
      continueFresh: { newSessionId: NEW_ID, prompt: msg }
    }
    const win: LaunchCommand[] = (['wt', 'powershell', 'cmd'] as const).map((terminal) =>
      buildLaunchCommand({
        ...base,
        env: 'windows',
        cwd: 'C:\\Users\\Beau Lewis\\code\\my app',
        terminal
      })
    )
    for (const c of win) {
      expect(c.claudeArgs[0]).toBe(msg)
      expect(c.claudeArgs).toContain('--session-id')
      expect(c.args.every((a) => !a.includes('\n'))).toBe(true)
      expect(c.commandLine).toContain(NEW_ID)
    }
    const wsl = buildLaunchCommand({
      ...base,
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/beau/my app',
      terminal: 'wt',
      continueFresh: {
        newSessionId: NEW_ID,
        prompt:
          '@/mnt/c/Users/beau/AppData/Roaming/CSD/handoffs/a.md Continue from this handoff of an earlier session.'
      }
    })
    const bash = wsl.args[wsl.args.length - 1]
    expect(bash).toContain(
      "claude '@/mnt/c/Users/beau/AppData/Roaming/CSD/handoffs/a.md Continue from this handoff of an earlier session.'"
    )
    expect(bash).toContain(`--session-id ${NEW_ID}`)
  })
})

// --------------------------------------------------------------- fixtures

let root: string
let busy: SessionService[] = []

async function setup(
  wsl: {
    path?: (distro: string, p: string) => string | undefined
    canRead?: (distro: string, p: string) => boolean
  } = {}
) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
  const layout = fixturesLayout(root)
  const base = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const spawned: LaunchCommand[] = []
  // Launching "works" here: the command is captured instead of run.
  const platform = {
    ...base,
    canLaunch: true,
    spawnDetached: async (cmd: LaunchCommand) => {
      spawned.push(cmd)
    },
    wslPath: async (d: string, p: string) => (wsl.path ? wsl.path(d, p) : base.wslPath(d, p)),
    wslCanRead: async (d: string, p: string) => (wsl.canRead ? wsl.canRead(d, p) : true)
  }
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(platform, paths, metadata, settings)
  busy.push(sessions)
  const lineage = new LineageService(sessions, 1)
  // What the app tags after a launch (billing, Remote Control): the session it's told about.
  const tagged: { sessionId: string; key: string }[] = []
  const launcher = new Launcher(
    platform,
    sessions,
    () => 'wt',
    {
      keyFor: () => undefined,
      label: () => undefined,
      subscriptionLabel: () => 'Subscription',
      launched: (t) => tagged.push({ sessionId: t.sessionId, key: t.key })
    },
    () => ({}),
    paths.dataDir
  )
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher, lineage, metadata, paths, layout, spawned, tagged }
}

const sha = async (p: string) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-continue-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('Continue fresh (fixtures)', { timeout: 30_000 }, () => {
  it('needs a summary first', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.sessionId === SAFARI)!
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(p.continueError).toBe(NO_SUMMARY)
    const r = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(r).toMatchObject({ ok: false, error: NO_SUMMARY })
  })

  it('writes the handoff to the app folder, starts a new session from it and links it', async () => {
    const { sessions, launcher, metadata, paths, spawned, tagged } = await setup()
    const s = sessions.list().find((x) => x.sessionId === SAFARI)!
    sessions.setAiSummary(s.key, SUMMARY)
    const before = await sha(s.filePath)
    const filesBefore = await readdir(dirname(s.filePath))

    const opts: LaunchOptions = {
      key: s.key,
      fork: false,
      skipPermissions: true,
      remoteControl: true,
      continueFresh: { newSessionId: NEW_ID }
    }
    const p = await launcher.preview(opts)
    expect(p.continueError).toBeUndefined()
    expect(p.continueFresh).toMatchObject({
      newSessionId: NEW_ID,
      handoffPath: handoffPath(paths.dataDir, NEW_ID),
      name: `${s.title} — continued`,
      newSince: s.messageCount - SUMMARY.messageCount
    })
    expect(p.continueFresh!.handoff).toContain('Run the iOS check.')
    expect(p.claudeCommand).toContain(`--session-id ${NEW_ID}`)
    expect(p.claudeCommand).not.toContain('--resume')
    expect(p.remoteControlName).toBe(`${s.title} continued`.replace(/ — /, ' '))

    const r = await launcher.launch(opts)
    expect(r).toMatchObject({ ok: true, continuedKey: `${s.sourceId}:${NEW_ID}` })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].claudeArgs).toContain(NEW_ID)
    // The summary itself never travels on the command line.
    expect(spawned[0].args.join(' ')).not.toContain('Run the iOS check.')

    // The handoff file: in the app's data folder, never in .claude.
    const file = handoffPath(paths.dataDir, NEW_ID)
    expect(file.startsWith(paths.dataDir)).toBe(true)
    expect(isInsideClaudeDir(file)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(p.continueFresh!.handoff)

    // Nothing in the project folder changed: the new session file is Claude Code's to write.
    expect(await sha(s.filePath)).toBe(before)
    expect(await readdir(dirname(s.filePath))).toEqual(filesBefore)

    // Linked as "continued from", in the app's metadata only.
    expect(metadata.value.sessions[NEW_ID]).toMatchObject({
      name: `${s.title} — continued`,
      branch: { parentSessionId: SAFARI, parentKey: s.key, via: 'continue' }
    })
    // Billing and Remote Control are tagged on the new session, never the original.
    expect(tagged).toEqual([{ sessionId: NEW_ID, key: `${s.sourceId}:${NEW_ID}` }])
  })

  it('never overwrites a handoff: a taken id gets a new one', async () => {
    const { sessions, launcher, paths } = await setup()
    const s = sessions.list().find((x) => x.sessionId === SAFARI)!
    sessions.setAiSummary(s.key, SUMMARY)
    await writeHandoff(paths.dataDir, NEW_ID, 'mine')
    await expect(writeHandoff(paths.dataDir, NEW_ID, 'other')).rejects.toMatchObject({
      code: 'EEXIST'
    })
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: { newSessionId: NEW_ID }
    })
    expect(p.continueFresh!.newSessionId).not.toBe(NEW_ID)
    expect(await readFile(handoffPath(paths.dataDir, NEW_ID), 'utf8')).toBe('mine')
  })

  it('a WSL session reads the handoff through /mnt', async () => {
    const { sessions, launcher } = await setup()
    const s = sessions.list().find((x) => x.sessionId === ORDERS)!
    sessions.setAiSummary(s.key, SUMMARY)
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: {}
    })
    expect(p.continueError).toBeUndefined()
    const path = p.continueFresh!.sessionPath
    expect(path.startsWith('/')).toBe(true)
    expect(path).not.toContain('\\')
    expect(p.claudeCommand).toContain(path)
  })
})

describe('Continue fresh in WSL: the path as the distro sees it', { timeout: 30_000 }, () => {
  it("uses the distro's own mount root", async () => {
    const { sessions, launcher, paths } = await setup({
      path: (_d, p) => (p === paths.dataDir ? '/c/appdata' : undefined)
    })
    const s = sessions.list().find((x) => x.sessionId === ORDERS)!
    sessions.setAiSummary(s.key, SUMMARY)
    const p = await launcher.preview({
      key: s.key,
      fork: false,
      skipPermissions: false,
      continueFresh: { newSessionId: NEW_ID }
    })
    expect(p.continueError).toBeUndefined()
    expect(p.continueFresh!.sessionPath).toBe(`/c/appdata/handoffs/${NEW_ID}.md`)
    expect(p.claudeCommand).toContain(`@/c/appdata/handoffs/${NEW_ID}.md`)
  })

  it('refuses when the distro cannot reach the data folder', async () => {
    const { sessions, launcher, spawned } = await setup({ path: () => undefined })
    const s = sessions.list().find((x) => x.sessionId === ORDERS)!
    sessions.setAiSummary(s.key, SUMMARY)
    const opts = { key: s.key, fork: false, skipPermissions: false, continueFresh: {} }
    expect((await launcher.preview(opts)).continueError).toMatch(/can't read the app's data folder/)
    expect((await launcher.launch(opts)).ok).toBe(false)
    expect(spawned).toHaveLength(0)
  })

  it('starts nothing if the distro cannot read the written handoff', async () => {
    const { sessions, launcher, spawned } = await setup({
      canRead: (_d, p) => !p.endsWith('.md')
    })
    const s = sessions.list().find((x) => x.sessionId === ORDERS)!
    sessions.setAiSummary(s.key, SUMMARY)
    const r = await launcher.launch({
      key: s.key,
      fork: false,
      skipPermissions: false,
      // A folder that exists in the sample distro.
      cwdOverride: '/home/beau',
      continueFresh: {}
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/can't read the handoff file/)
    expect(spawned).toHaveLength(0)
  })
})

describe('A launch is allowed right up to the start', { timeout: 30_000 }, () => {
  for (const why of ['the phone was revoked', 'read-only mode was turned on'])
    it(`starts nothing when ${why} during the WSL check`, async () => {
      let stop: string | undefined
      const { sessions, launcher, spawned } = await setup({
        canRead: () => {
          // Changes while the distro is being asked.
          stop = why
          return true
        }
      })
      const s = sessions.list().find((x) => x.sessionId === ORDERS)!
      sessions.setAiSummary(s.key, SUMMARY)
      const r = await launcher.launch(
        {
          key: s.key,
          fork: false,
          skipPermissions: false,
          askPermissions: true,
          remoteControl: true,
          cwdOverride: '/home/beau',
          continueFresh: {}
        },
        { via: 'phone', device: 'Phone', stillAllowed: () => stop }
      )
      expect(r).toMatchObject({ ok: false, error: `Not launched: ${why}.` })
      expect(spawned).toHaveLength(0)
    })
})

describe('Continue fresh: lineage', () => {
  it('shows the new session as continued from the old one', () => {
    const out = computeLineage([
      { key: 'w:old', sessionId: 'old', sourceId: 'w', firstUuid: 'u1' },
      {
        key: 'w:new',
        sessionId: 'new',
        sourceId: 'w',
        firstUuid: 'u9',
        recorded: { parentSessionId: 'old', parentKey: 'w:old', via: 'continue' }
      }
    ])
    expect(out.get('w:new')).toEqual({
      parentKey: 'w:old',
      parentSessionId: 'old',
      via: 'continue',
      shared: undefined,
      atMessageId: undefined,
      atTime: undefined
    })
    expect(out.get('w:old')).toBeUndefined()
  })
})

describe('Continue fresh from a phone', () => {
  const SESSION = {
    key: `windows:${SAFARI}`,
    sessionId: SAFARI,
    title: 'Fix login',
    availability: 'live',
    meta: { aiSummary: SUMMARY }
  } as unknown as SessionSummary

  function launcher(session = SESSION) {
    const launched: LaunchOptions[] = []
    const deps: RemoteLaunchDeps = {
      session: (k) => (k === session.key ? session : undefined),
      preview: async () => ({
        commandLine: 'x',
        claudeCommand: 'claude',
        terminal: 'wt',
        fellBack: false,
        cwd: 'C:\\code',
        cwdExists: true,
        willRestore: false,
        restoreImpossible: false,
        originalPath: 'x',
        billingLabel: 'Subscription',
        continueFresh: {
          newSessionId: NEW_ID,
          handoffPath: 'h',
          sessionPath: 'h',
          mode: 'mention',
          handoff: '',
          newSince: 3,
          name: 'n'
        }
      }),
      launch: async (opts) => {
        launched.push(opts)
        return { ok: true, restored: false, commandLine: 'x', continuedKey: `windows:${NEW_ID}` }
      },
      settings: () => ({
        terminal: 'wt',
        readOnly: false,
        confirmOnPc: false,
        branchConfirmed: true
      }),
      confirm: async () => true,
      deviceActive: () => true,
      log: () => undefined
    }
    return { rl: new RemoteLauncher(deps), launched }
  }
  const DEVICE = { id: 'd1', name: 'Phone', tokenHash: '', createdAt: '', lastSeenAt: '' }

  it('is a fixed command with the same safe options as Resume', async () => {
    const req = parseLaunchRequest({
      key: SESSION.key,
      kind: 'continue',
      skipPermissions: true,
      continueFresh: { newSessionId: NEW_ID }
    })
    expect(req).toEqual({ key: SESSION.key, kind: 'continue' })
    expect(remoteLaunchOptions(req as never, 'wt')).toEqual({
      key: SESSION.key,
      fork: false,
      skipPermissions: false,
      askPermissions: true,
      remoteControl: true,
      terminal: 'wt',
      continueFresh: {}
    })
    const { rl, launched } = launcher()
    expect((await rl.preview({ key: SESSION.key, kind: 'continue' })).newSinceSummary).toBe(3)
    const r = await rl.launch(DEVICE, { key: SESSION.key, kind: 'continue' })
    expect(r).toMatchObject({ ok: true, key: `windows:${NEW_ID}` })
    expect(launched[0]).toMatchObject({ skipPermissions: false, remoteControl: true })
    expect(launched[0].billingAccountId).toBeUndefined()
  })

  it('needs a summary written on the PC', async () => {
    const { rl, launched } = launcher({ ...SESSION, meta: {} })
    const r = await rl.launch(DEVICE, { key: SESSION.key, kind: 'continue' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Summarize this session on your PC/)
    expect(launched).toHaveLength(0)
  })
})
