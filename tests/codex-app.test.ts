// "Open in Codex app": link building, project matching (Windows / WSL paths,
// case, trailing slashes), the availability rules, the read-only state reader,
// and the launches (desktop and phone) with the link opener faked.

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalFolder,
  codexAppPreview,
  FORK_IN_APP_NOTE,
  isSafeAppLink,
  matchProject,
  MAX_APP_LINK,
  newThreadLink,
  resolveOpenIn,
  sanitizeProjectOpenIn,
  threadLink,
  type CodexAppFacts,
  type CodexAppState
} from '@shared/codex-app'
import type { AiSummary } from '@shared/summary'
import type { LaunchOptions, LaunchPreview, SessionSummary } from '@shared/types'
import {
  APP_STATE_FILE,
  CodexAppService,
  parseCodexAppState,
  wslModeOf
} from '../src/main/providers/codex/app'
import { normalizeProjectKey, projectDefaultKey, projectKeyLabel } from '@shared/project-key'
import type { Platform } from '../src/main/platform'
import { cleanMetaPatch } from '../src/main/services/store'
import { handoffPath } from '../src/main/core/handoff'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { SessionService } from '../src/main/services/sessions'
import { Launcher } from '../src/main/services/launcher'
import { ProviderRegistry } from '../src/main/providers/registry'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import {
  parseLaunchRequest,
  RemoteLauncher,
  remoteLaunchOptions
} from '../src/main/mobile/remote-launch'
import type { StoredDevice } from '../src/main/mobile/devices'
import { FIXTURES } from './helpers'

const CLI = '019a1111-0000-7000-8000-000000000001'
const WSL = '019a7777-0000-7000-8000-000000000007'
const PID = '5e1f0c3a-1b2c-4d3e-8f90-123456789abc'

const project = (id: string, root: string, name = id) => ({ id, name, root })

function state(
  projects: CodexAppState['projects'],
  assignments: CodexAppState['assignments'] = {}
): CodexAppState {
  return { projects, assignments }
}

// ------------------------------------------------------------- paths

describe('canonicalFolder', () => {
  it('ignores case, slash direction and a trailing slash for Windows folders', () => {
    const a = canonicalFolder('C:\\Users\\Alex\\Code\\App')
    expect(a).toBe('win:c:\\users\\alex\\code\\app')
    expect(canonicalFolder('c:/users/alex/code/app/')).toBe(a)
    expect(canonicalFolder('C:\\Users\\\\Alex\\Code\\App\\\\')).toBe(a)
    expect(canonicalFolder('C:\\')).toBe('win:c:\\')
    expect(canonicalFolder('C:')).toBe('win:c:\\')
  })

  it('treats \\\\wsl$ and \\\\wsl.localhost as the same folder, keeping the Linux path case', () => {
    const a = canonicalFolder('\\\\wsl$\\Ubuntu-24.04\\home\\alex\\App')
    expect(a).toBe('wsl:ubuntu-24.04:/home/alex/App')
    expect(canonicalFolder('\\\\wsl.localhost\\ubuntu-24.04\\home\\alex\\App\\')).toBe(a)
    expect(canonicalFolder('//wsl.localhost/Ubuntu-24.04/home/alex/App')).toBe(a)
    expect(canonicalFolder('\\\\wsl$\\Ubuntu-24.04\\home\\alex\\app')).not.toBe(a)
    expect(canonicalFolder('\\\\wsl$\\Ubuntu')).toBe('wsl:ubuntu:/')
  })

  it('never takes a bare Linux path: the distro has to say which folder it is', () => {
    expect(canonicalFolder('/home/alex/App')).toBeUndefined()
    expect(canonicalFolder('/mnt/c/Users/Alex/App')).toBeUndefined()
    expect(canonicalFolder('\\\\NAS\\Share\\X')).toBe('unc:\\\\nas\\share\\x')
    expect(canonicalFolder('relative\\folder')).toBeUndefined()
    expect(canonicalFolder('')).toBeUndefined()
  })
})

describe('matchProject', () => {
  const st = state(
    [
      project('local-a', 'C:\\Users\\Alex\\code\\shop api'),
      project('local-b', '\\\\wsl$\\Ubuntu\\home\\alex\\dotfiles'),
      project('local-c', 'C:\\Users\\Alex\\code'),
      project('local-d', 'C:\\Users\\Alex\\code\\app')
    ],
    { [CLI]: 'local-c' }
  )

  it('prefers the project the app assigned the thread to', () => {
    const m = matchProject(st, { sessionId: CLI.toUpperCase(), folder: 'D:\\elsewhere' })
    expect(m).toMatchObject({ kind: 'assigned', project: { id: 'local-c' } })
    expect(matchProject(st, { sessionId: CLI, folderReason: 'unknown' }).kind).toBe('assigned')
  })

  it('matches the root exactly, whatever the case, slashes or trailing slash', () => {
    for (const folder of [
      'C:\\Users\\Alex\\code\\shop api',
      'c:/users/alex/CODE/Shop API/',
      'C:\\Users\\Alex\\code\\shop api\\'
    ])
      expect(matchProject(st, { sessionId: WSL, folder })).toMatchObject({
        kind: 'exact',
        project: { id: 'local-a' }
      })
  })

  it('matches a distro folder by \\\\wsl.localhost or \\\\wsl$, keeping the Linux path case', () => {
    const folder = '\\\\wsl.localhost\\Ubuntu\\home\\alex\\dotfiles\\'
    expect(matchProject(st, { sessionId: WSL, folder })).toMatchObject({
      kind: 'exact',
      project: { id: 'local-b' }
    })
    const upper = '\\\\wsl.localhost\\Ubuntu\\home\\Alex\\dotfiles'
    expect(matchProject(st, { sessionId: WSL, folder: upper }).kind).toBe('none')
    const debian = '\\\\wsl.localhost\\Debian\\home\\alex\\dotfiles'
    expect(matchProject(st, { sessionId: WSL, folder: debian }).kind).toBe('none')
  })

  it('a distro folder at /mnt/c (custom mounts) never matches the Windows C: project', () => {
    const folder = '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\Alex\\code\\shop api'
    expect(matchProject(st, { sessionId: WSL, folder }).kind).toBe('none')
  })

  it('without a confirmed folder only the assignment counts, with the reason', () => {
    expect(matchProject(st, { sessionId: WSL, folderReason: 'no distro' })).toEqual({
      kind: 'none',
      reason: 'no distro'
    })
  })

  it('offers the closest project whose root holds the folder, never a sibling prefix', () => {
    const at = (folder: string) => matchProject(st, { sessionId: WSL, folder })
    expect(at('C:\\Users\\Alex\\code\\app\\packages\\web')).toMatchObject({
      kind: 'inside',
      project: { id: 'local-d' }
    })
    expect(at('C:\\Users\\Alex\\code\\app2')).toMatchObject({
      kind: 'inside',
      project: { id: 'local-c' }
    })
    expect(at('C:\\Users\\Alex\\codex').kind).toBe('none')
    expect(at('D:\\other').kind).toBe('none')
    expect(at('\\\\wsl$\\Ubuntu\\home\\alex\\dotfiles\\src')).toMatchObject({
      kind: 'inside',
      project: { id: 'local-b' }
    })
    expect(matchProject(st, { sessionId: WSL }).kind).toBe('none')
  })
})

// ------------------------------------------------------------- links

describe('links', () => {
  it('opens an existing thread by its id only', () => {
    expect(threadLink(CLI)).toBe(`codex://threads/${CLI}`)
    expect(threadLink(CLI.toUpperCase())).toBe(`codex://threads/${CLI}`)
    expect(() => threadLink('../settings')).toThrow()
    expect(() => threadLink('019a1111')).toThrow()
  })

  it('builds a new-thread link with projectId and prompt, never a path', () => {
    const l = newThreadLink(PID, 'Read the handoff file C:\\x y\\h.md first & go #1')
    expect(l).toBe(
      `codex://threads/new?projectId=${PID}&prompt=Read%20the%20handoff%20file%20C%3A%5Cx%20y%5Ch.md%20first%20%26%20go%20%231`
    )
    expect(l).not.toContain('path=')
    expect(isSafeAppLink(l)).toBe(true)
    expect(new URL(l).searchParams.get('prompt')).toBe(
      'Read the handoff file C:\\x y\\h.md first & go #1'
    )
    expect(() => newThreadLink('a/b', 'x')).toThrow()
    expect(() => newThreadLink(PID, '')).toThrow()
    expect(() => newThreadLink(PID, 'line\u0007bell')).toThrow()
    expect(() => newThreadLink(PID, 'x'.repeat(MAX_APP_LINK))).toThrow(/too long/)
  })

  it('only the two link shapes count as safe', () => {
    expect(isSafeAppLink(threadLink(CLI))).toBe(true)
    expect(isSafeAppLink('codex://threads/new?path=C%3A%5Cx&prompt=hi')).toBe(false)
    expect(isSafeAppLink(`codex://threads/new?projectId=${PID}&prompt=hi&path=x`)).toBe(false)
    expect(isSafeAppLink('codex://settings')).toBe(false)
    expect(isSafeAppLink('https://example.com')).toBe(false)
    expect(isSafeAppLink(`codex://threads/${CLI}?hostId=x`)).toBe(false)
  })
})

// ------------------------------------------------------------- availability rules

describe('codexAppPreview (availability)', () => {
  const st = state([
    project('p-exact', 'C:\\work\\app', 'app'),
    project('p-parent', 'C:\\work', 'work')
  ])
  const facts = (f: Partial<CodexAppFacts> = {}): CodexAppFacts => ({
    installed: true,
    wslMode: false,
    state: st,
    appHome: true,
    sourceLabel: 'Windows',
    fileExists: true,
    folder: 'C:\\work\\app',
    ...f
  })
  const s = { sessionId: CLI }

  it('is hidden off Windows or without the app', () => {
    expect(codexAppPreview('resume', s, facts({ unsupportedPlatform: true }))).toMatchObject({
      available: false,
      hidden: true
    })
    expect(codexAppPreview('resume', s, facts({ installed: false }))).toMatchObject({
      available: false,
      hidden: true
    })
  })

  it('explains WSL mode and an unreadable project list', () => {
    expect(codexAppPreview('resume', s, facts({ wslMode: true })).reason).toMatch(/WSL/)
    // config.toml unreadable or invalid: unknown, so nothing is offered (never taken as off).
    const unknown = codexAppPreview(
      'resume',
      s,
      facts({ wslMode: undefined, configError: 'access denied' })
    )
    expect(unknown).toMatchObject({ available: false })
    expect(unknown.reason).toMatch(/config\.toml \(access denied\)/)
    const r = codexAppPreview('continue', s, facts({ state: undefined, stateError: 'bad' }))
    expect(r).toMatchObject({ available: false })
    expect(r.reason).toMatch(/bad/)
  })

  it('Resume and Fork: only Windows .codex threads whose file is still there', () => {
    expect(codexAppPreview('resume', s, facts())).toEqual({ available: true })
    expect(codexAppPreview('fork', s, facts())).toEqual({ available: true, note: FORK_IN_APP_NOTE })
    expect(
      codexAppPreview('resume', s, facts({ appHome: false, sourceLabel: 'WSL: Ubuntu' })).reason
    ).toMatch(/Windows \.codex folder only.*WSL: Ubuntu/)
    expect(codexAppPreview('resume', s, facts({ fileExists: false })).available).toBe(false)
    expect(codexAppPreview('resume', { ...s, sessionId: 'not-a-uuid' }, facts()).available).toBe(
      false
    )
  })

  it('Continue fresh: the matching project, an inside project only when opted in, else none', () => {
    expect(codexAppPreview('continue', s, facts())).toMatchObject({
      available: true,
      project: { id: 'p-exact', name: 'app' }
    })
    const sub = facts({ folder: 'C:\\work\\lib' })
    expect(codexAppPreview('continue', s, sub)).toMatchObject({
      available: false,
      inside: { id: 'p-parent', name: 'work' },
      reason: 'This folder is inside the Codex project work.'
    })
    expect(codexAppPreview('continue', s, sub, { id: 'p-parent', root: 'C:\\work' })).toMatchObject(
      { available: true, project: { id: 'p-parent' } }
    )
    expect(codexAppPreview('continue', s, facts({ folder: 'D:\\x' })).reason).toMatch(
      /isn't a project in the Codex app/
    )
    // No confirmed folder: the reason is shown.
    const why = codexAppPreview(
      'continue',
      s,
      facts({ folder: undefined, folderReason: "doesn't record which distro" })
    )
    expect(why.reason).toMatch(/isn't a project in the Codex app\. doesn't record which distro/)
    // Not tied to the Windows home: a WSL session can continue in a WSL project.
    expect(
      codexAppPreview('continue', s, facts({ appHome: false, fileExists: false })).available
    ).toBe(true)
  })

  it('a consent counts only for the project it was given for (id and root)', () => {
    const sub = facts({ folder: 'C:\\work\\lib' })
    // The same id with another root (the project was moved) or another id: asked again.
    expect(codexAppPreview('continue', s, sub, { id: 'p-parent', root: 'C:\\old' })).toMatchObject({
      available: false,
      inside: { id: 'p-parent' }
    })
    expect(codexAppPreview('continue', s, sub, { id: 'p-exact', root: 'C:\\work' }).available).toBe(
      false
    )
    // A consent never turns a non-inside match into anything else.
    expect(
      codexAppPreview('continue', s, facts({ folder: 'D:\\x' }), {
        id: 'p-parent',
        root: 'C:\\work'
      }).available
    ).toBe(false)
  })

  it('a consent is checked against the final match, however it was matched', () => {
    const parent = { id: 'p-parent', root: 'C:\\work' }
    const sub = facts({ folder: 'C:\\work\\lib' })
    // The app assigned the thread to another project after the user chose p-parent.
    const assigned = facts({
      folder: 'C:\\work\\lib',
      state: { ...st, assignments: { [CLI]: 'p-exact' } }
    })
    const r = codexAppPreview('continue', s, assigned, parent)
    expect(r).toMatchObject({
      available: false,
      consentChanged: true,
      project: { id: 'p-exact' }
    })
    expect(r.reason).toMatch(/changed since you chose it/)
    // Without the old consent, the new project is shown as is (no consent needed).
    expect(codexAppPreview('continue', s, assigned)).toMatchObject({
      available: true,
      project: { id: 'p-exact' }
    })
    // An exact match to another project, or no match at all: the same.
    expect(
      codexAppPreview('continue', s, facts({ folder: 'C:\\work\\app' }), parent).consentChanged
    ).toBe(true)
    expect(codexAppPreview('continue', s, facts({ folder: 'D:\\x' }), parent).consentChanged).toBe(
      true
    )
    // Still the same project: opens.
    expect(codexAppPreview('continue', s, sub, parent).available).toBe(true)
  })
})

describe('Open in: remembered choice', () => {
  it('session, then project, then Settings, then the terminal', () => {
    expect(resolveOpenIn('codex-app', 'terminal', 'terminal')).toEqual({
      value: 'codex-app',
      from: 'session'
    })
    expect(resolveOpenIn(undefined, 'codex-app', 'terminal')).toEqual({
      value: 'codex-app',
      from: 'project'
    })
    expect(resolveOpenIn(undefined, undefined, 'codex-app')).toEqual({
      value: 'codex-app',
      from: 'global'
    })
    expect(resolveOpenIn(undefined, undefined, undefined)).toEqual({
      value: 'terminal',
      from: 'default'
    })
  })

  it('keeps only known values and valid project keys', () => {
    expect(
      sanitizeProjectOpenIn({
        'C:\\Work\\App': 'codex-app',
        'wsl:Ubuntu:/home/alex/x': 'terminal',
        'wsl:bad': 'codex-app',
        'D:\\y': 'browser',
        '': 'terminal'
      })
    ).toEqual({ 'c:\\work\\app': 'codex-app', 'wsl:Ubuntu:/home/alex/x': 'terminal' })
    expect(sanitizeProjectOpenIn(['x'])).toEqual({})
    expect(cleanMetaPatch({ openIn: 'codex-app' })).toEqual({ openIn: 'codex-app' })
    expect(cleanMetaPatch({ openIn: 'x' as never })).toEqual({ openIn: undefined })
  })

  it('a Linux folder in a Windows home keeps its own project key, case and all', () => {
    const key = projectDefaultKey({ env: 'windows', cwd: '/home/Alex/App' })
    expect(key).toBe('linux:/home/Alex/App')
    expect(projectDefaultKey({ env: 'windows', cwd: '/home/alex/app' })).not.toBe(key)
    expect(normalizeProjectKey(key!)).toBe(key)
    expect(sanitizeProjectOpenIn({ [key!]: 'codex-app' })).toEqual({ [key!]: 'codex-app' })
    expect(projectKeyLabel(key!)).toBe('WSL · /home/Alex/App')
    expect(normalizeProjectKey('linux:relative')).toBeUndefined()
    // Windows and WSL keys are unchanged.
    expect(projectDefaultKey({ env: 'windows', cwd: 'C:\\Code\\App' })).toBe('c:\\code\\app')
    expect(projectDefaultKey({ env: 'wsl', distro: 'Ubuntu', cwd: '/home/Me/App' })).toBe(
      'wsl:Ubuntu:/home/Me/App'
    )
  })
})

// ------------------------------------------------------------- the app's state file

const STATE_JSON = JSON.stringify({
  'electron-saved-workspace-roots': ['ignored'],
  'project-order': ['p-2', 'local-1'],
  'local-projects': {
    'local-1': { id: 'local-1', name: 'one', rootPaths: ['C:\\one'] },
    'p-2': { id: 'p-2', name: 'two', rootPaths: ['\\\\wsl$\\Ubuntu\\home\\b\\two', 'C:\\extra'] },
    'p-3': { id: 'p-3', name: 'three', rootPaths: ['C:\\three'] },
    'bad key!': { id: 'bad key!', name: 'x', rootPaths: ['C:\\x'] },
    mismatch: { id: 'other', name: 'y', rootPaths: ['C:\\y'] },
    empty: { id: 'empty', name: 'z', rootPaths: [] }
  },
  'thread-project-assignments': {
    [CLI.toUpperCase()]: { projectKind: 'local', projectId: 'p-3' },
    [WSL]: { projectKind: 'remote', projectId: 'r-1' }
  }
})

describe('parseCodexAppState', () => {
  it('reads projects in sidebar order, their first root, and local assignments', () => {
    const st = parseCodexAppState(STATE_JSON)!
    expect(st.projects.map((p) => p.id)).toEqual(['p-2', 'local-1', 'p-3'])
    expect(st.projects[0]).toEqual({
      id: 'p-2',
      name: 'two',
      root: '\\\\wsl$\\Ubuntu\\home\\b\\two'
    })
    expect(st.assignments).toEqual({ [CLI]: 'p-3' })
  })

  it('refuses a file that does not look like the app state', () => {
    expect(parseCodexAppState('not json')).toBeUndefined()
    expect(parseCodexAppState('[]')).toBeUndefined()
    expect(parseCodexAppState('{"other": 1}')).toBeUndefined()
  })
})

describe('wslModeOf (config.toml, parsed as TOML)', () => {
  it('reads windows.runCodexInWindowsSubsystemForLinux in any TOML form', () => {
    const on = { on: true }
    const off = { on: false }
    expect(wslModeOf('[windows]\nrunCodexInWindowsSubsystemForLinux = true\n')).toEqual(on)
    expect(wslModeOf('[windows]\r\nrunCodexInWindowsSubsystemForLinux = false # off\r\n')).toEqual(
      off
    )
    expect(wslModeOf('windows.runCodexInWindowsSubsystemForLinux = true')).toEqual(on)
    expect(wslModeOf('windows = { runCodexInWindowsSubsystemForLinux = true }')).toEqual(on)
    expect(wslModeOf('[windows]\n"runCodexInWindowsSubsystemForLinux" = true')).toEqual(on)
    expect(wslModeOf('[other]\nrunCodexInWindowsSubsystemForLinux = true')).toEqual(off)
    expect(wslModeOf('# [windows]\n# runCodexInWindowsSubsystemForLinux = true')).toEqual(off)
    expect(wslModeOf('[windows]\nrunCodexInWindowsSubsystemForLinux = "true"')).toEqual(off)
    expect(wslModeOf('')).toEqual(off)
  })

  it('an invalid file is an error, never "off"', () => {
    const r = wslModeOf('[windows\nrunCodexInWindowsSubsystemForLinux = true')
    expect('error' in r && r.error).toMatch(/isn't valid TOML/)
  })
})

describe('CodexAppService', () => {
  function service(over: Partial<ConstructorParameters<typeof CodexAppService>[0]> = {}) {
    const reads: string[] = []
    let mtime = 1
    const svc = new CodexAppService({
      supported: true,
      home: () => 'C:\\Users\\b\\.codex',
      protocolRegistered: async () => true,
      readText: async (p) => {
        reads.push(p)
        return p.endsWith(APP_STATE_FILE) ? STATE_JSON : '[windows]\n'
      },
      statFile: async () => ({ size: STATE_JSON.length, mtimeMs: mtime }),
      ...over
    })
    return { svc, reads, touch: () => mtime++ }
  }

  it('reads the state file once until it changes, and only config.toml besides', async () => {
    const { svc, reads, touch } = service()
    const a = await svc.snapshot()
    expect(a).toMatchObject({ installed: true, wslMode: false })
    expect(a.state?.projects).toHaveLength(3)
    await svc.snapshot()
    expect(reads.filter((p) => p.endsWith(APP_STATE_FILE))).toHaveLength(1)
    touch()
    await svc.snapshot()
    expect(reads.filter((p) => p.endsWith(APP_STATE_FILE))).toHaveLength(2)
    expect(reads.every((p) => /config\.toml$|\.codex-global-state\.json$/.test(p))).toBe(true)
    expect(reads.some((p) => /auth\.json/i.test(p))).toBe(false)
  })

  it('reports not installed, unsupported, a missing or oversized state file', async () => {
    expect(await service({ protocolRegistered: async () => false }).svc.snapshot()).toMatchObject({
      installed: false
    })
    expect(await service({ supported: false }).svc.snapshot()).toMatchObject({ installed: false })
    const missing = await service({
      statFile: async () => {
        throw new Error('ENOENT')
      }
    }).svc.snapshot()
    expect(missing).toMatchObject({ installed: true })
    expect(missing.stateError).toMatch(/no project list/)
    const big = await service({
      statFile: async () => ({ size: 200 * 1024 * 1024, mtimeMs: 1 })
    }).svc.snapshot()
    expect(big.stateError).toMatch(/large/)
  })

  it('config.toml: missing is off; unreadable or invalid is unknown, with the reason', async () => {
    const fail = (code: string) => async (p: string) => {
      if (p.endsWith(APP_STATE_FILE)) return STATE_JSON
      throw Object.assign(new Error(`${code}: no`), { code })
    }
    expect(await service({ readText: fail('ENOENT') }).svc.snapshot()).toMatchObject({
      wslMode: false
    })
    const denied = await service({ readText: fail('EACCES') }).svc.snapshot()
    expect(denied.wslMode).toBeUndefined()
    expect(denied.configError).toMatch(/couldn't read config\.toml: EACCES/)
    const invalid = await service({
      readText: async (p) => (p.endsWith(APP_STATE_FILE) ? STATE_JSON : '[windows')
    }).svc.snapshot()
    expect(invalid.wslMode).toBeUndefined()
    expect(invalid.configError).toMatch(/isn't valid TOML/)
    const inline = await service({
      readText: async (p) =>
        p.endsWith(APP_STATE_FILE)
          ? STATE_JSON
          : 'windows = { runCodexInWindowsSubsystemForLinux = true }'
    }).svc.snapshot()
    expect(inline.wslMode).toBe(true)
  })
})

// ------------------------------------------------------------- launches (fixtures)

let root = ''
const busy: SessionService[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-app-'))
})

afterEach(async () => {
  await Promise.all(busy.splice(0).map((b) => b.idle().catch(() => undefined)))
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

const SUMMARY: AiSummary = {
  title: 'Ship the shop API',
  done: ['Added the routes'],
  files: ['src/routes.ts'],
  decisions: [],
  todos: ['Write the tests'],
  pickUp: 'Write the tests.',
  model: 'claude-sonnet-5-5',
  generatedAt: '2026-10-22T19:47:00.000Z',
  messageCount: 2
}

async function setup(
  projects: CodexAppState['projects'],
  open?: (l: string) => Promise<void>,
  over: Partial<Platform> = {}
) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: true })
  const layout = fixturesLayout(root)
  const base = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const platform: Platform = {
    ...base,
    canLaunch: true,
    spawnDetached: async () => {
      throw new Error('a terminal must not be started')
    },
    ...over
  }
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const providers = new ProviderRegistry([claudeProvider, createCodexProvider()])
  const sessions = new SessionService(platform, paths, metadata, settings, providers)
  busy.push(sessions)
  const launcher = new Launcher(
    platform,
    sessions,
    () => 'wt',
    undefined,
    () => settings.value,
    paths.dataDir
  )
  const opened: string[] = []
  const toText = (ps: CodexAppState['projects'], asg: Record<string, string> = {}) =>
    JSON.stringify({
      'local-projects': Object.fromEntries(
        ps.map((p) => [p.id, { id: p.id, name: p.name, rootPaths: [p.root] }])
      ),
      'thread-project-assignments': Object.fromEntries(
        Object.entries(asg).map(([t, id]) => [t, { projectKind: 'local', projectId: id }])
      )
    })
  let stateText = toText(projects)
  let mtime = 1
  /** The Codex app's project list (and thread assignments) change, as if edited in the app. */
  const setProjects = (ps: CodexAppState['projects'], asg: Record<string, string> = {}): void => {
    stateText = toText(ps, asg)
    mtime++
  }
  launcher.codexApp = {
    service: new CodexAppService({
      supported: true,
      home: () => 'C:\\Users\\alex\\.codex',
      protocolRegistered: async () => true,
      readText: async (p) => (p.endsWith(APP_STATE_FILE) ? stateText : ''),
      statFile: async () => ({ size: stateText.length, mtimeMs: mtime })
    }),
    open: async (l) => {
      opened.push(l)
      await open?.(l)
    }
  }
  await sessions.start()
  await sessions.idle()
  const find = (id: string) =>
    sessions.list().find((x) => x.provider === 'codex' && x.sessionId === id)!
  /** Look a session up with other fields (another folder or home), as the launcher sees it. */
  const pretend = (id: string, patch: Partial<SessionSummary>): SessionSummary => {
    const s = { ...find(id), ...patch }
    const get = sessions.get.bind(sessions)
    sessions.get = (k: string) => (k === s.key ? s : get(k))
    return s
  }
  return { sessions, launcher, metadata, paths, opened, find, pretend, setProjects }
}

const opts = (key: string, more: Partial<LaunchOptions> = {}): LaunchOptions => ({
  key,
  fork: false,
  skipPermissions: true,
  openIn: 'codex-app',
  ...more
})

describe('Open in Codex app (fixtures)', { timeout: 30_000 }, () => {
  it('Resume opens the thread link; Fork opens it with the menu note; no terminal', async () => {
    const { launcher, opened, find } = await setup([])
    const s = find(CLI)
    const p = await launcher.preview(opts(s.key))
    expect(p.codexApp).toEqual({ available: true })
    const r = await launcher.launch(opts(s.key))
    expect(r).toMatchObject({
      ok: true,
      openedIn: 'codex-app',
      commandLine: `codex://threads/${CLI}`
    })
    const f = await launcher.launch(opts(s.key, { fork: true }))
    expect(f).toMatchObject({ ok: true, note: FORK_IN_APP_NOTE })
    expect(opened).toEqual([`codex://threads/${CLI}`, `codex://threads/${CLI}`])
  })

  it('a WSL-home session is not opened (the app shows only the Windows .codex)', async () => {
    const { launcher, opened, find } = await setup([])
    const s = find(WSL)
    const r = await launcher.launch(opts(s.key))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Windows \.codex folder only/)
    expect(opened).toEqual([])
  })

  it('Continue fresh: handoff written, prefilled link in the matching project, linked later', async () => {
    const { sessions, launcher, metadata, paths, opened, find } = await setup([
      project(PID, 'c:/users/ALEX/code/shop api/', 'shop api')
    ])
    const s = find(CLI)
    sessions.setAiSummary(s.key, SUMMARY)
    const id = '6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d'
    const o = opts(s.key, { continueFresh: { newSessionId: id } })
    const p = await launcher.preview(o)
    expect(p.codexApp).toMatchObject({ available: true, project: { id: PID, name: 'shop api' } })
    const r = await launcher.launch(o)
    expect(r).toMatchObject({ ok: true, openedIn: 'codex-app' })
    expect(opened).toHaveLength(1)
    const url = new URL(opened[0])
    expect(url.searchParams.get('projectId')).toBe(PID)
    expect(url.searchParams.has('path')).toBe(false)
    const file = handoffPath(paths.dataDir, id, 'codex')
    expect(url.searchParams.get('prompt')).toContain(file)
    expect(await readFile(file, 'utf8')).toContain('Ship the shop API')
    expect(metadata.value.pendingContinues?.[id]).toMatchObject({
      parentSessionId: CLI,
      sourceId: 'codex-windows'
    })
  })

  it('Continue fresh from a WSL home: a WSL project, the handoff by its Windows path', async () => {
    const { sessions, launcher, metadata, opened, find } = await setup([
      project('local-dots', '\\\\wsl.localhost\\ubuntu\\home\\alex\\projects\\dotfiles', 'dotfiles')
    ])
    const s = find(WSL)
    sessions.setAiSummary(s.key, SUMMARY)
    const r = await launcher.launch(opts(s.key, { continueFresh: {} }))
    expect(r.ok).toBe(true)
    const prompt = new URL(opened[0]).searchParams.get('prompt')!
    expect(prompt).not.toMatch(/\/mnt\//)
    expect(prompt).toMatch(/handoffs[\\/]codex[\\/][0-9a-f-]{36}\.md/)
    const pending = Object.values(metadata.value.pendingContinues ?? {})
    expect(pending[0]).toMatchObject({ parentSessionId: WSL, sourceId: 'codex-windows' })
  })

  it('Continue fresh: not a project → refused; inside a project → only with the opt-in', async () => {
    const none = await setup([project('p-other', 'D:\\elsewhere')])
    const s1 = none.find(CLI)
    none.sessions.setAiSummary(s1.key, SUMMARY)
    const r1 = await none.launcher.launch(opts(s1.key, { continueFresh: {} }))
    expect(r1.ok).toBe(false)
    expect(r1.error).toMatch(/isn't a project in the Codex app/)
    expect(none.opened).toEqual([])
    expect(none.metadata.value.pendingContinues ?? {}).toEqual({})
  })

  it('inside a project: refused without the opt-in, opened in that project with it', async () => {
    const { sessions, launcher, opened, find } = await setup([
      project('p-code', 'C:\\Users\\alex\\code', 'code')
    ])
    const s = find(CLI)
    sessions.setAiSummary(s.key, SUMMARY)
    const p: LaunchPreview = await launcher.preview(opts(s.key, { continueFresh: {} }))
    expect(p.codexApp).toMatchObject({ available: false, inside: { name: 'code' } })
    expect((await launcher.launch(opts(s.key, { continueFresh: {} }))).ok).toBe(false)
    const accepted = { id: p.codexApp!.inside!.id, root: p.codexApp!.inside!.root }
    const r = await launcher.launch(opts(s.key, { continueFresh: {}, codexAppProject: accepted }))
    expect(r.ok).toBe(true)
    expect(new URL(opened[0]).searchParams.get('projectId')).toBe('p-code')
  })

  it('a consent never opens a project the app assigned the thread to afterwards', async () => {
    const code = project('p-code', 'C:\\Users\\alex\\code', 'code')
    const other = project('p-other', 'D:\\other', 'other')
    const { sessions, launcher, opened, find, setProjects } = await setup([code, other])
    const s = find(CLI)
    sessions.setAiSummary(s.key, SUMMARY)
    const p = await launcher.preview(opts(s.key, { continueFresh: {} }))
    const accepted = { id: p.codexApp!.inside!.id, root: p.codexApp!.inside!.root }
    setProjects([code, other], { [CLI]: 'p-other' })
    const r = await launcher.launch(opts(s.key, { continueFresh: {}, codexAppProject: accepted }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/changed since you chose it/)
    expect(opened).toEqual([])
    // The dialog then previews without the old consent and shows the new project.
    const again = await launcher.preview(opts(s.key, { continueFresh: {} }))
    expect(again.codexApp).toMatchObject({ available: true, project: { id: 'p-other' } })
  })

  it('an assignment to a removed project falls back to matching the folder', async () => {
    const shop = project(PID, 'C:\\Users\\alex\\code\\shop api', 'shop api')
    const { sessions, launcher, opened, find, setProjects } = await setup([shop])
    setProjects([shop], { [CLI]: 'p-removed' })
    const s = find(CLI)
    sessions.setAiSummary(s.key, SUMMARY)
    const p = await launcher.preview(opts(s.key, { continueFresh: {} }))
    expect(p.codexApp).toMatchObject({ available: true, project: { id: PID } })
    expect((await launcher.launch(opts(s.key, { continueFresh: {} }))).ok).toBe(true)
    expect(new URL(opened[0]).searchParams.get('projectId')).toBe(PID)
  })

  it('a consent given for one project never opens another (the list changed meanwhile)', async () => {
    const { sessions, launcher, opened, find, setProjects } = await setup([
      project('p-code', 'C:\\Users\\alex\\code', 'code')
    ])
    const s = find(CLI)
    sessions.setAiSummary(s.key, SUMMARY)
    const p = await launcher.preview(opts(s.key, { continueFresh: {} }))
    const accepted = { id: p.codexApp!.inside!.id, root: p.codexApp!.inside!.root }
    // Same id, moved to another root that still holds the folder.
    setProjects([project('p-code', 'C:\\Users\\alex', 'code')])
    const moved = await launcher.launch(
      opts(s.key, { continueFresh: {}, codexAppProject: accepted })
    )
    expect(moved.ok).toBe(false)
    expect(moved.error).toMatch(/changed since you chose it/)
    // Another project now holds the folder.
    setProjects([project('p-other', 'C:\\Users\\alex\\code', 'other')])
    const other = await launcher.launch(
      opts(s.key, { continueFresh: {}, codexAppProject: accepted })
    )
    expect(other.ok).toBe(false)
    expect(opened).toEqual([])
  })

  it('a WSL /mnt/c folder matches a C: project only when the distro maps it there', async () => {
    const shop = project(PID, 'C:\\Users\\alex\\code\\shop api', 'shop api')
    // Default mounts (the fixture distro maps /mnt/c to C:).
    const std = await setup([shop])
    std.sessions.setAiSummary(std.find(WSL).key, SUMMARY)
    const a = std.pretend(WSL, { cwd: '/mnt/c/Users/alex/code/shop api' })
    expect((await std.launcher.preview(opts(a.key, { continueFresh: {} }))).codexApp).toMatchObject(
      {
        available: true,
        project: { id: PID }
      }
    )
  })

  it('a custom mount at /mnt/c is a Linux folder: no match, nothing opened', async () => {
    const shop = project(PID, 'C:\\Users\\alex\\code\\shop api', 'shop api')
    const custom = await setup([shop], undefined, {
      wslWindowsPath: async (d, p) => `\\\\wsl.localhost\\${d}${p.replace(/\//g, '\\')}`
    })
    custom.sessions.setAiSummary(custom.find(WSL).key, SUMMARY)
    const b = custom.pretend(WSL, { cwd: '/mnt/c/Users/alex/code/shop api' })
    const r = await custom.launcher.launch(opts(b.key, { continueFresh: {} }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/isn't a project in the Codex app/)
    expect(custom.opened).toEqual([])
  })

  it("a /mnt folder the distro can't confirm is never guessed", async () => {
    const shop = project(PID, 'C:\\Users\\alex\\code\\shop api', 'shop api')
    const { sessions, launcher, opened, find, pretend } = await setup([shop], undefined, {
      wslWindowsPath: async () => undefined
    })
    sessions.setAiSummary(find(WSL).key, SUMMARY)
    const s = pretend(WSL, { cwd: '/mnt/c/Users/alex/code/shop api' })
    const r = await launcher.launch(opts(s.key, { continueFresh: {} }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/couldn't confirm which Windows folder/)
    expect(opened).toEqual([])
  })

  it('a Windows-home session with a Linux folder: the distro is never inferred from the projects', async () => {
    const dots = project(
      'local-dots',
      '\\\\wsl$\\Ubuntu\\home\\alex\\projects\\dotfiles',
      'dotfiles'
    )
    const { sessions, launcher, opened, find, pretend } = await setup([dots], undefined, {
      listDistros: async () => ['Ubuntu', 'Debian'],
      defaultDistro: async () => 'Ubuntu'
    })
    sessions.setAiSummary(find(CLI).key, SUMMARY)
    // It may have run in Debian: only Ubuntu's folder is a project, which proves nothing.
    const s = pretend(CLI, { cwd: '/home/alex/projects/dotfiles' })
    const r = await launcher.launch(opts(s.key, { continueFresh: {} }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/doesn't record which distro/)
    expect(opened).toEqual([])
  })

  it('a Windows-home session in /mnt/c: matched when every distro maps it to the same folder', async () => {
    const shop = project(PID, 'C:\\Users\\alex\\code\\shop api', 'shop api')
    const { sessions, launcher, find, pretend } = await setup([shop], undefined, {
      listDistros: async () => ['Ubuntu', 'Debian'],
      defaultDistro: async () => 'Ubuntu'
    })
    sessions.setAiSummary(find(CLI).key, SUMMARY)
    const s = pretend(CLI, { cwd: '/mnt/c/Users/alex/code/shop api' })
    expect((await launcher.preview(opts(s.key, { continueFresh: {} }))).codexApp).toMatchObject({
      available: true,
      project: { id: PID }
    })
  })

  it("drops the pending link when the app can't be opened", async () => {
    const { sessions, launcher, metadata, find } = await setup(
      [project(PID, 'C:\\Users\\alex\\code\\shop api')],
      async () => {
        throw new Error('no handler')
      }
    )
    const s = find(CLI)
    sessions.setAiSummary(s.key, SUMMARY)
    const r = await launcher.launch(opts(s.key, { continueFresh: {} }))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Couldn't open the Codex app: no handler/)
    expect(metadata.value.pendingContinues ?? {}).toEqual({})
  })

  it('Claude Code sessions get no Codex app preview', async () => {
    const { sessions, launcher } = await setup([])
    const claude = sessions.list().find((x) => x.provider !== 'codex')!
    const p = await launcher.preview({ key: claude.key, fork: false, skipPermissions: false })
    expect(p.codexApp).toBeUndefined()
    const r = await launcher.launch({ ...opts(claude.key) })
    expect(r.ok).toBe(false)
  })
})

describe('Open in Codex app on PC (phone)', () => {
  it('is a fixed command: only the thread, no flags or folder', () => {
    expect(parseLaunchRequest({ key: 'codex-windows:x', kind: 'codex-app' })).toEqual({
      key: 'codex-windows:x',
      kind: 'codex-app'
    })
    expect(remoteLaunchOptions({ key: 'k', kind: 'codex-app' }, 'wt', 'codex')).toEqual({
      key: 'k',
      fork: false,
      skipPermissions: false,
      askPermissions: true,
      terminal: 'wt',
      openIn: 'codex-app'
    })
  })

  it('is refused for Claude sessions and explains why the app cannot open one', async () => {
    const device = { id: 'd1', name: 'Phone' } as StoredDevice
    const sessions: Record<string, { provider: 'claude' | 'codex' }> = {
      claude: { provider: 'claude' },
      codex: { provider: 'codex' }
    }
    const launched: LaunchOptions[] = []
    const remote = new RemoteLauncher({
      session: (key) =>
        sessions[key]
          ? ({ key, title: key, meta: {}, provider: sessions[key].provider } as never)
          : undefined,
      preview: async () =>
        ({
          commandLine: '',
          claudeCommand: '',
          terminal: 'wt',
          fellBack: false,
          cwdExists: false,
          willRestore: false,
          restoreImpossible: false,
          originalPath: '',
          billingLabel: '',
          codexApp: { available: false, reason: 'Not in the Windows .codex.' }
        }) as LaunchPreview,
      launch: async (o) => {
        launched.push(o)
        return { ok: true, restored: false, commandLine: '', openedIn: 'codex-app' }
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
    })
    expect(await remote.preview({ key: 'claude', kind: 'codex-app' })).toMatchObject({
      ok: false,
      error: 'Only Codex sessions open in the Codex app.'
    })
    expect(await remote.preview({ key: 'codex', kind: 'codex-app' })).toMatchObject({
      ok: false,
      error: 'Not in the Windows .codex.',
      codexApp: true
    })
    const r = await remote.launch(device, { key: 'codex', kind: 'codex-app' })
    expect(r).toMatchObject({ ok: true, key: 'codex' })
    expect(launched[0]).toMatchObject({ openIn: 'codex-app', skipPermissions: false })
  })
})
