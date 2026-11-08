// Codex approval alerts: the one PermissionRequest hook in ~/.codex/hooks.json.
// Adding it keeps every existing hook (and every other byte), Disable takes
// out exactly ours, trust is only ever read from config.toml (never written),
// and the hook scripts save only the session, the event and the tool name.

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SourceInfo } from '@shared/types'
import { assertCodexHooksWrite, UnsafeWriteError } from '../src/main/core/safe-paths'
import { cleanupSettingsLeftovers, writeSettings } from '../src/main/services/bridge'
import {
  CODEX_HOOKS,
  codexHookPaths,
  CodexHooksInstaller,
  createCodexHooksStore,
  handlerPosition
} from '../src/main/services/codex-hooks'
import { windowsHookCommand } from '../src/main/services/hooks'
import { localShell, shellPath } from './helpers'

const SCRIPTS = join(__dirname, '..', 'resources', 'bridge')

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-hooks-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

/** This PC's own hooks.json shape (an installer's SessionStart hook), with a sample path. */
const GSD = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\\"C:/Users/beau/.codex/hooks/check-update.cmd\\"",
            "commandWindows": "\\"C:/Users/beau/.codex/hooks/check-update.cmd\\""
          }
        ]
      }
    ]
  }
}
`

function source(home: string, over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    id: 'codex-windows',
    provider: 'codex',
    label: 'Windows',
    env: 'windows',
    projectsDir: join(home, '.codex', 'sessions'),
    kind: 'auto',
    status: 'ok',
    sessionCount: 0,
    ...over
  }
}

async function setup(hooksJson?: string, configToml = 'model = "gpt"\n') {
  const home = join(root, 'Users', 'beau')
  const codex = join(home, '.codex')
  await mkdir(join(codex, 'sessions'), { recursive: true })
  if (hooksJson !== undefined) await writeFile(join(codex, 'hooks.json'), hooksJson)
  await writeFile(join(codex, 'config.toml'), configToml)
  await writeFile(join(codex, 'auth.json'), '{"token":"sample-not-real"}')
  const dataDir = join(root, 'appdata')
  const store = createCodexHooksStore(dataDir)
  await store.load()
  const reads: string[] = []
  const inst = new CodexHooksInstaller(store, {
    dataDir,
    scriptsDir: SCRIPTS,
    readScript: (p) => readFile(p, 'utf8'),
    readHome: async (p) => {
      reads.push(p)
      try {
        return await readFile(p, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    }
  })
  return { home, codex, src: source(home), inst, dataDir, reads }
}

const read = (p: string): Promise<string> => readFile(p, 'utf8')

describe('where the Codex hook goes', () => {
  it('a Windows home: hooks.json next to config.toml, the script in the bridge folder', () => {
    const p = codexHookPaths(source('C:\\Users\\beau'))!
    expect(p.hooksPath).toBe(join('C:\\Users\\beau', '.codex', 'hooks.json'))
    expect(p.codexHooksPath).toBe(p.hooksPath)
    expect(p.bridgeDir).toBe(join('C:\\Users\\beau', '.claude-session-dashboard'))
    expect(p.command).toBe(
      windowsHookCommand(
        join('C:\\Users\\beau', '.claude-session-dashboard', 'bin', 'csd-codex-hook.ps1')
      )
    )
  })

  it('a WSL home: the Linux path Codex sees, and a plain sh command', () => {
    const home = '\\\\wsl.localhost\\Ubuntu\\home\\beau'
    const p = codexHookPaths(
      source(home, { id: 'codex-wsl-Ubuntu-beau', env: 'wsl', distro: 'Ubuntu', user: 'beau' })
    )!
    expect(p.codexHooksPath).toBe('/home/beau/.codex/hooks.json')
    expect(p.command).toBe('sh /home/beau/.claude-session-dashboard/bin/csd-codex-hook.sh')
  })

  it('never for a custom CODEX_HOME, another name, or a Claude home', () => {
    expect(codexHookPaths(source('C:\\x', { kind: 'custom' }))).toBeUndefined()
    expect(
      codexHookPaths({ ...source('C:\\x'), projectsDir: 'C:\\x\\.codex2\\sessions' })
    ).toBeUndefined()
    expect(codexHookPaths({ ...source('C:\\x'), provider: 'claude' })).toBeUndefined()
  })
})

describe('the write guard', () => {
  it('allows only hooks.json (and the app’s temp files next to it) in a .codex folder', () => {
    expect(() => assertCodexHooksWrite('C:\\Users\\beau\\.codex\\hooks.json')).not.toThrow()
    expect(() =>
      assertCodexHooksWrite('C:\\Users\\beau\\.codex\\hooks.json.csd-1a2b.tmp')
    ).not.toThrow()
    for (const bad of [
      'C:\\Users\\beau\\.codex\\config.toml',
      'C:\\Users\\beau\\.codex\\auth.json',
      'C:\\Users\\beau\\.codex\\sessions\\hooks.json',
      'C:\\Users\\beau\\.claude\\hooks.json',
      'C:\\Users\\beau\\.claude\\.codex\\hooks.json',
      'C:\\Users\\beau\\hooks.json'
    ])
      expect(() => assertCodexHooksWrite(bad), bad).toThrow(UnsafeWriteError)
  })

  it('the atomic save refuses any other file', async () => {
    const p = join(root, '.codex', 'config.toml')
    await mkdir(join(root, '.codex'), { recursive: true })
    await expect(writeSettings(p, 'x', undefined, {}, CODEX_HOOKS)).rejects.toThrow(
      UnsafeWriteError
    )
  })
})

describe('installing and removing the hook', () => {
  it('creates hooks.json when there is none, and Disable leaves an empty one', async () => {
    const { codex, src, inst } = await setup()
    const plan = await inst.plan(src, 'install')
    expect(plan.error).toBeUndefined()
    expect(plan.createsFile).toBe(true)
    expect(plan.notes?.[0]).toMatch(/\/hooks/)
    expect((await inst.apply(src, 'install', plan.token)).ok).toBe(true)
    const json = JSON.parse(await read(join(codex, 'hooks.json')))
    expect(json.hooks.PermissionRequest).toEqual([
      {
        hooks: [
          { type: 'command', command: codexHookPaths(src)!.command, timeout: 10, async: true }
        ]
      }
    ])
    expect(Object.keys(json.hooks)).toEqual(['PermissionRequest'])
    const script = join(
      root,
      'Users',
      'beau',
      '.claude-session-dashboard',
      'bin',
      'csd-codex-hook.ps1'
    )
    expect((await stat(script)).isFile()).toBe(true)
    const off = await inst.plan(src, 'uninstall')
    expect((await inst.apply(src, 'uninstall', off.token)).ok).toBe(true)
    // The app never deletes a file in .codex: it stays, empty.
    expect(JSON.parse(await read(join(codex, 'hooks.json')))).toEqual({})
  })

  it('appends to an existing file without changing a byte, backs it up, and restores it exactly', async () => {
    const { codex, src, inst, dataDir } = await setup(GSD)
    const plan = await inst.plan(src, 'install')
    // Additions only (the one closing bracket gets its comma).
    expect(plan.diff.filter((d) => d.type === 'remove').every((d) => d.text === '    ]')).toBe(true)
    expect(plan.diff.filter((d) => d.type === 'add').map((d) => d.text)).toContain(
      '    "PermissionRequest": ['
    )
    const res = await inst.apply(src, 'install', plan.token)
    expect(res.ok).toBe(true)
    expect(await read(res.backupPath!)).toBe(GSD)
    expect(res.backupPath!.startsWith(join(dataDir, 'backups', 'codex-hooks'))).toBe(true)
    const after = await read(join(codex, 'hooks.json'))
    // Everything before our addition is exactly as it was.
    const at = after.indexOf(',\n    "PermissionRequest"')
    expect(after.slice(0, at)).toBe(GSD.slice(0, GSD.lastIndexOf('    ]') + 5))
    expect(installedOk(await inst.describe(src))).toBe(true)
    const off = await inst.plan(src, 'uninstall')
    await inst.apply(src, 'uninstall', off.token)
    expect(await read(join(codex, 'hooks.json'))).toBe(GSD)
  })

  it('keeps comments, and the user’s later edits, taking out only its own handler', async () => {
    const withComment = GSD.replace('{\n  "hooks"', '{\n  // my hooks\n  "hooks"')
    const { codex, src, inst } = await setup(withComment)
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    // The user adds a hook of their own after ours, and a wrapper that mentions our script.
    const mine = await read(join(codex, 'hooks.json'))
    const edited = mine.replace(
      /("PermissionRequest": \[\n[\s\S]*?\n {6}\})\n {4}\]/,
      `$1,\n      { "hooks": [ { "type": "command", "command": "my-approval-logger csd-codex-hook.ps1" } ] }\n    ]`
    )
    expect(edited).not.toBe(mine)
    await writeFile(join(codex, 'hooks.json'), edited)
    const off = await inst.plan(src, 'uninstall')
    // Codex keys trust by position: the user's own hook after ours must be trusted again.
    expect(off.notes?.join(' ')).toMatch(/1 of your own PermissionRequest hook comes after/)
    await inst.apply(src, 'uninstall', off.token)
    const out = await read(join(codex, 'hooks.json'))
    expect(out).toContain('// my hooks')
    expect(out).toContain('my-approval-logger csd-codex-hook.ps1')
    expect(out).not.toContain(codexHookPaths(src)!.command)
    expect(out).toContain('check-update.cmd')
  })

  it('refuses a hooks.json it can’t edit safely', async () => {
    const { src, inst } = await setup('{ "hooks": {}, "hooks": {} }')
    const plan = await inst.plan(src, 'install')
    expect(plan.error).toMatch(/hooks\.json/)
    expect(plan.error).not.toMatch(/settings\.json/)
    const bad = await setup('{ "hooks": { "PermissionRequest": {} } }')
    expect((await bad.inst.plan(bad.src, 'install')).error).toMatch(/not a list/)
  })

  it('changes nothing when hooks.json changed after the review', async () => {
    const { codex, src, inst } = await setup(GSD)
    const plan = await inst.plan(src, 'install')
    await writeFile(join(codex, 'hooks.json'), GSD.replace('SessionStart', 'SessionEnd'))
    const res = await inst.apply(src, 'install', plan.token)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/changed since you reviewed/)
    expect(await read(join(codex, 'hooks.json'))).toBe(GSD.replace('SessionStart', 'SessionEnd'))
  })

  it('never writes config.toml, and never reads auth.json', async () => {
    const toml = 'model = "gpt"\n[features]\nhooks = true\n'
    const { codex, src, inst, reads } = await setup(GSD, toml)
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    await inst.describe(src)
    await inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
    expect(await read(join(codex, 'config.toml'))).toBe(toml)
    expect(reads.every((p) => /hooks\.json$|config\.toml$/.test(p))).toBe(true)
    expect(reads.some((p) => /auth\.json/.test(p))).toBe(false)
    expect((await readdir(codex)).sort()).toEqual([
      'auth.json',
      'config.toml',
      'hooks.json',
      'sessions'
    ])
  })

  it('tidies only its own leftover temp files next to hooks.json', async () => {
    const { codex, inst, dataDir } = await setup(GSD)
    await writeFile(join(codex, 'hooks.json.csd-0a1b2c3d.tmp'), 'half')
    await writeFile(join(codex, 'hooks.json.bak'), 'theirs')
    const r = await cleanupSettingsLeftovers(
      join(codex, 'hooks.json'),
      inst.backupDir,
      dataDir,
      CODEX_HOOKS
    )
    expect(r.removed).toBe(1)
    expect((await readdir(codex)).sort()).toEqual([
      'auth.json',
      'config.toml',
      'hooks.json',
      'hooks.json.bak',
      'sessions'
    ])
  })
})

const installedOk = (e: { installed: boolean; changedSinceInstall?: boolean } | undefined) =>
  !!e?.installed && !e.changedSinceInstall

describe('trust, read from config.toml', () => {
  it('untrusted until config.toml has a trust entry for its position, then trusted', async () => {
    const { codex, src, inst } = await setup(GSD)
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    expect(await inst.describe(src)).toMatchObject({
      installed: true,
      provider: 'codex',
      trust: 'untrusted'
    })
    const pos = handlerPosition(
      await read(join(codex, 'hooks.json')),
      'PermissionRequest',
      inst.commands(src)
    )
    expect(pos).toEqual({ group: 0, handler: 0, groups: 1 })
    const key = `${join(codex, 'hooks.json')}:permission_request:0:0`
    await writeFile(
      join(codex, 'config.toml'),
      `model = "gpt"\n\n[hooks.state.'${key}']\ntrusted_hash = "sha256:abc"\n`
    )
    const d = await inst.describe(src)
    expect(d?.trust).toBe('trusted')
    expect(inst.exactSources([d!])).toEqual(new Set(['codex-windows']))
    await writeFile(
      join(codex, 'config.toml'),
      `[features]\nhooks = false\n[hooks.state.'${key}']\ntrusted_hash = "sha256:abc"\nenabled = false\n`
    )
    expect(await inst.describe(src)).toMatchObject({ trust: 'disabled', hooksFeatureOff: true })
  })

  it('a home that isn’t installed reports no trust', async () => {
    const { src, inst } = await setup(GSD)
    const d = await inst.describe(src)
    expect(d).toMatchObject({ installed: false, provider: 'codex' })
    expect(d?.trust).toBeUndefined()
  })
})

// The scripts themselves: run for real (Windows PowerShell; Git for Windows' sh).
const PS =
  process.platform === 'win32' &&
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true })
    .status === 0
const SH = localShell('sh')
const PAYLOAD = JSON.stringify({
  session_id: '01a1bcd4-9e22-7511-b475-70f7803c33fd',
  transcript_path: 'C:/x.jsonl',
  cwd: 'C:\\code\\app',
  hook_event_name: 'PermissionRequest',
  model: 'gpt',
  turn_id: 't1',
  tool_name: 'Bash',
  tool_input: { command: 'curl https://secret.example/?token=abc', description: 'Upload it' }
})
const SAVED = {
  session_id: '01a1bcd4-9e22-7511-b475-70f7803c33fd',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash'
}

describe.runIf(PS)('csd-codex-hook.ps1', () => {
  it('saves only the session, the event and the tool, prints nothing', async () => {
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const script = join(bin, 'csd-codex-hook.ps1')
    await copyFile(join(SCRIPTS, 'csd-codex-hook.ps1'), script)
    const out = join(root, 'bridge')
    const stdout = execFileSync('powershell.exe', windowsHookCommand(script).split(' ').slice(1), {
      input: PAYLOAD,
      env: { ...process.env, CSD_BRIDGE_DIR: out },
      windowsHide: true,
      timeout: 60_000,
      encoding: 'utf8'
    })
    expect(stdout).toBe('')
    const dir = join(out, 'codex-events')
    expect(await readdir(dir)).toEqual([`${SAVED.session_id}.PermissionRequest.json`])
    const text = await read(join(dir, `${SAVED.session_id}.PermissionRequest.json`))
    expect(JSON.parse(text)).toEqual(SAVED)
    expect(text).not.toMatch(/secret|token|curl|Upload/)
  }, 60_000)
})

describe.runIf(!!SH)('csd-codex-hook.sh', () => {
  const run = (dir: string, input: string) =>
    execFileSync(SH!, [join(SCRIPTS, 'csd-codex-hook.sh')], {
      input,
      env: { ...process.env, PATH: shellPath(SH!), CSD_BRIDGE_DIR: dir },
      encoding: 'utf8'
    })

  it('saves only the session, the event and the tool, prints nothing', async () => {
    const dir = join(root, 'b')
    expect(run(dir, PAYLOAD)).toBe('')
    const text = await read(join(dir, 'codex-events', `${SAVED.session_id}.PermissionRequest.json`))
    expect(JSON.parse(text)).toEqual(SAVED)
    expect(text).not.toMatch(/secret|token|curl|Upload/)
  })

  it('reads top-level fields only, and drops a tool name that isn’t a plain name', async () => {
    const dir = join(root, 'c')
    run(
      dir,
      JSON.stringify({
        tool_input: { session_id: 'evil', hook_event_name: 'Stop', tool_name: 'x' },
        session_id: 'real-1',
        hook_event_name: 'PermissionRequest',
        tool_name: 'rm -rf "/"'
      })
    )
    expect(await readdir(join(dir, 'codex-events'))).toEqual(['real-1.PermissionRequest.json'])
    expect(
      JSON.parse(await read(join(dir, 'codex-events', 'real-1.PermissionRequest.json')))
    ).toEqual({
      session_id: 'real-1',
      hook_event_name: 'PermissionRequest'
    })
  })

  it('ignores a payload without a valid session or event', async () => {
    const dir = join(root, 'd')
    run(dir, '{"session_id":"../../etc","hook_event_name":"PermissionRequest"}')
    run(dir, 'not json')
    await expect(readdir(join(dir, 'codex-events'))).rejects.toThrow()
  })
})
