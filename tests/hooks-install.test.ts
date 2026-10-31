// Session alerts: adding our hooks to settings.json keeps every existing hook
// (and every other byte, comments included), Disable takes out exactly ours,
// and a save by another program at the same moment is never lost.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOOK_EVENTS } from '@shared/live'
import type { SourceInfo } from '@shared/types'
import {
  appendHookGroups,
  duplicateKeys,
  hooksProblem,
  parseJsonc,
  removeHookHandlers,
  rawMember,
  setMember
} from '../src/main/core/settings-edit'
import { cleanupSettingsLeftovers, writeSettings } from '../src/main/services/bridge'
import {
  createHooksStore,
  hookCommand,
  hookGroup,
  HooksInstaller,
  installedEvents,
  isOurHandler,
  windowsHookCommand
} from '../src/main/services/hooks'
import { localShell, shellPath } from './helpers'

const SCRIPTS = join(__dirname, '..', 'resources', 'bridge')

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-hooks-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

function source(env: 'windows' | 'wsl', home: string, user?: string): SourceInfo {
  return {
    id: env === 'windows' ? 'windows' : `wsl-Ubuntu-${user}`,
    label: env === 'windows' ? 'Windows' : 'WSL: Ubuntu',
    env,
    distro: env === 'wsl' ? 'Ubuntu' : undefined,
    user,
    projectsDir: join(home, '.claude', 'projects'),
    kind: 'auto',
    status: 'ok',
    sessionCount: 0,
    claudeSettingsPath: join(home, '.claude', 'settings.json')
  }
}

async function setup(text?: string) {
  const home = join(root, 'home')
  await mkdir(join(home, '.claude'), { recursive: true })
  const settingsPath = join(home, '.claude', 'settings.json')
  if (text !== undefined) await writeFile(settingsPath, text)
  const dataDir = join(root, 'appdata')
  const store = createHooksStore(dataDir)
  await store.load()
  const inst = new HooksInstaller(store, {
    dataDir,
    scriptsDir: SCRIPTS,
    readScript: (p) => readFile(p, 'utf8')
  })
  const src = source('wsl', home, 'beau')
  const install = async () => inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
  const uninstall = async () =>
    inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
  const read = () => readFile(settingsPath, 'utf8')
  return { home, settingsPath, dataDir, store, inst, src, install, uninstall, read }
}

const MINE = `{
  "model": "opus",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "afplay ~/done.wav" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "~/guard.sh" }]
      }
    ]
  },
  "env": { "FOO": "1" }
}
`

const COMMENTED = `{
  // My settings.
  "model": "opus", // the best one
  /* Hooks below. */
  "hooks": {
    "Stop": [
      // ding when done
      { "hooks": [{ "type": "command", "command": "afplay ~/done.wav" }] }
    ]
  } // end of hooks
}
`

const CMD = 'sh /home/beau/.claude-session-dashboard/bin/csd-hook.sh'
const OURS = new Set([CMD])
const mine = (h: unknown) => isOurHandler(h, OURS)

/** Every line of `before` appears in `after`, in the same order. */
function keepsLines(before: string, after: string): void {
  let at = 0
  for (const line of before.split(/\r?\n/).filter((l) => l.trim())) {
    const i = after.indexOf(line, at)
    expect(i, `missing or moved: ${line}`).toBeGreaterThanOrEqual(at)
    at = i + line.length
  }
}

describe('hook commands', () => {
  it('builds the right command per environment', () => {
    expect(hookCommand(source('wsl', '/x/home/beau', 'beau'))).toBe(CMD)
    expect(hookCommand(source('wsl', '/x/root', 'root'))).toBe(
      'sh /root/.claude-session-dashboard/bin/csd-hook.sh'
    )
    expect(hookCommand({ ...source('wsl', '/x', 'beau'), kind: 'custom' })).toBeUndefined()
    expect(hookGroup(CMD)).toEqual({
      hooks: [{ type: 'command', command: CMD, timeout: 10, async: true }]
    })
  })

  it('passes the Windows path as data no shell can read as code', () => {
    const home = "C:\\Users\\O'Brien $(rm -rf ~) `x` %PATH%"
    const cmd = hookCommand(source('windows', home))!
    // Base64 only: the same in Git Bash and PowerShell, nothing to expand.
    expect(cmd).toMatch(
      /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    const script = join(home, '.claude-session-dashboard', 'bin', 'csd-hook.ps1')
    const decoded = Buffer.from(cmd.split(' ').pop()!, 'base64').toString('utf16le')
    // The path never appears in the PowerShell source: only as base64 data.
    expect(decoded).not.toContain('Brien')
    const data = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(decoded)![1]
    expect(Buffer.from(data, 'base64').toString('utf8')).toBe(script)
    expect(decoded).toBe(
      `$ProgressPreference = 'SilentlyContinue'; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')); & $p`
    )
    // The same fixed source for any path; only the data differs.
    const other = Buffer.from(
      windowsHookCommand('C:\\a\\b.ps1').split(' ').pop()!,
      'base64'
    ).toString('utf16le')
    expect(other.replace(/'[A-Za-z0-9+/=]+'\)/, '')).toBe(
      decoded.replace(/'[A-Za-z0-9+/=]+'\)/, '')
    )
  })

  it('owns only handlers that run exactly its command', () => {
    expect(mine({ type: 'command', command: CMD })).toBe(true)
    expect(mine({ type: 'command', command: CMD, timeout: 99 })).toBe(true)
    // A wrapper or another script that mentions the path is the user's.
    expect(mine({ type: 'command', command: `${CMD} --verbose` })).toBe(false)
    expect(mine({ type: 'command', command: `tee /tmp/log | ${CMD}` })).toBe(false)
    expect(mine({ type: 'command', command: CMD.replace('csd-hook', 'csd-hook-mine') })).toBe(false)
    expect(mine({ type: 'prompt', command: CMD })).toBe(false)
    expect(mine('x')).toBe(false)
  })
})

describe('settings.json editing', () => {
  const g = hookGroup(CMD)

  it('appends without changing a byte of what is there', () => {
    const out = appendHookGroups(MINE, [
      ['Stop', g],
      ['Notification', g]
    ])
    const json = JSON.parse(out)
    expect(json.hooks.Stop).toEqual([...JSON.parse(MINE).hooks.Stop, g])
    expect(json.hooks.Notification).toEqual([g])
    keepsLines(MINE, out)
  })

  it('keeps one-line, tab-indented, CRLF and empty files in their style', () => {
    const oneLine = appendHookGroups('{"model":"opus"}', [['Stop', g]])
    expect(oneLine.split('\n')).toHaveLength(1)
    const tabs = appendHookGroups('{\n\t"model": "opus"\n}\n', [['Stop', g]])
    expect(tabs).toContain('\n\t"hooks": {\n\t\t"Stop": [')
    expect(JSON.parse(appendHookGroups('{}', [['Stop', g]]))).toEqual({ hooks: { Stop: [g] } })
    const crlf = appendHookGroups(MINE.replace(/\n/g, '\r\n'), [['Notification', g]])
    expect(crlf).not.toMatch(/[^\r]\n/)
  })

  it('reads and keeps comments, a trailing note staying on its line', () => {
    expect(parseJsonc(COMMENTED)).toMatchObject({ model: 'opus' })
    const out = appendHookGroups(COMMENTED, [
      ['Stop', g],
      ['Notification', g]
    ])
    expect(parseJsonc(out)).toMatchObject({ hooks: { Stop: [{}, g], Notification: [g] } })
    keepsLines(COMMENTED.replace('  } // end of hooks', '  }'), out)
    expect(out).toContain('} // end of hooks')
    expect(out).toContain('// ding when done')
    // A new top-level key after a value with a note: the note stays put.
    expect(setMember('{\n  "a": 1 // note\n}', 'b', 2)).toBe('{\n  "a": 1, // note\n  "b": 2\n}')
  })

  it('refuses duplicate keys and hooks it does not understand', () => {
    const dup = '{"hooks": {"Stop": []}, "model": "x", "hooks": {"Notification": []}}'
    expect(duplicateKeys(dup)).toEqual(['hooks'])
    // JSON (and so Claude Code) uses the last one; so does the app.
    expect(rawMember(dup, 'hooks')).toBe('{"Notification": []}')
    expect(hooksProblem(dup)).toMatch(/appears twice/)
    expect(() => appendHookGroups(dup, [['Stop', g]])).toThrow(/appears twice/)
    expect(hooksProblem('{"hooks": {"Stop": [], "Stop": []}}')).toMatch(/hooks.Stop" appears twice/)
    expect(hooksProblem('{"hooks": []}')).toMatch(/not an object/)
    expect(hooksProblem('{"hooks": {"Stop": {}}}')).toMatch(/not a list/)
  })

  it('takes out only its handlers, as text, keeping everything else', () => {
    const text = `{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "afplay ~/done.wav" }] },
      {
        "hooks": [
          { "type": "command", "command": "${CMD}", "timeout": 10, "async": true }
        ]
      },
      // Someone put their own handler next to ours: it stays.
      { "hooks": [{ "type": "command", "command": "echo mine" }, { "type": "command", "command": "${CMD}" }] },
      { "matcher": "x", "hooks": [{ "type": "command", "command": "${CMD}" }] }
    ],
    "Notification": [{ "hooks": [{ "type": "command", "command": "${CMD}" }] }]
  }
}`
    const out = removeHookHandlers(text, mine, { dropEvent: () => true, dropHooks: true })!
    expect(parseJsonc(out)).toEqual({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'afplay ~/done.wav' }] },
          { hooks: [{ type: 'command', command: 'echo mine' }] },
          // A group with more than our handler (a matcher) stays, emptied.
          { matcher: 'x', hooks: [] }
        ]
      }
    })
    expect(out).toContain('// Someone put their own handler next to ours: it stays.')
    expect(out).toContain('{ "hooks": [{ "type": "command", "command": "afplay ~/done.wav" }] },')
    expect(
      removeHookHandlers('{"hooks": {"Stop": []}}', mine, {
        dropEvent: () => true,
        dropHooks: true
      })
    ).toBeUndefined()
  })
})

describe('hooks installer', () => {
  it('shows a diff of additions only, backs up, writes the script, and restores exactly', async () => {
    const { dataDir, inst, src, home, install, uninstall, read } = await setup(MINE)
    const plan = await inst.plan(src, 'install')
    expect(plan.error).toBeUndefined()
    expect(plan.diff.filter((d) => d.type === 'remove')).toEqual([])
    expect(plan.diff.filter((d) => d.type === 'same').map((d) => d.text)).toEqual(MINE.split('\n'))

    expect((await install()).ok).toBe(true)
    const after = await read()
    expect(installedEvents(after, OURS).sort()).toEqual([...HOOK_EVENTS].sort())
    keepsLines(MINE, after)
    const backups = await readdir(join(dataDir, 'backups', 'settings'))
    expect(await readFile(join(dataDir, 'backups', 'settings', backups[0]), 'utf8')).toBe(MINE)
    const script = await readFile(
      join(home, '.claude-session-dashboard', 'bin', 'csd-hook.sh'),
      'utf8'
    )
    expect(script).not.toContain('\r\n')
    // No leftovers from the careful write next to settings.json.
    expect(await readdir(join(home, '.claude'))).toEqual(['settings.json'])

    expect((await inst.plan(src, 'install')).noop).toBe(true)
    expect(await inst.describe(src)).toMatchObject({ installed: true, changedSinceInstall: false })
    expect((await uninstall()).ok).toBe(true)
    expect(await read()).toBe(MINE)
    expect((await inst.describe(src))?.installed).toBe(false)
  })

  it('restores the hooks byte for byte when only other settings changed', async () => {
    const { settingsPath, install, uninstall, read } = await setup(MINE)
    await install()
    await writeFile(settingsPath, (await read()).replace('"model": "opus"', '"model": "sonnet"'))
    await uninstall()
    expect(await read()).toBe(MINE.replace('"model": "opus"', '"model": "sonnet"'))
  })

  it('after a hand edit of hooks, removes only its own text: the rest stays byte for byte', async () => {
    const { settingsPath, install, uninstall, read } = await setup(MINE)
    await install()
    // A hook added by hand, in the user's own style, with a comment.
    const edit = (s: string) =>
      s.replace(
        '{ "type": "command", "command": "afplay ~/done.wav" }',
        '{ "type": "command", "command": "afplay ~/done.wav" },\n          // and say it\n          {"type":"command","command":"say done"}'
      )
    await writeFile(settingsPath, edit(await read()))
    await uninstall()
    expect(await read()).toBe(edit(MINE))
  })

  it('keeps hooks added after it in its own lists, and a wrapper of the user’s', async () => {
    const { settingsPath, install, uninstall, read } = await setup(MINE)
    await install()
    const json = JSON.parse(await read())
    json.hooks.Notification.push({ hooks: [{ type: 'command', command: 'notify-send hi' }] })
    json.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: `${CMD} --log` }] })
    await writeFile(settingsPath, JSON.stringify(json, null, 2))
    await uninstall()
    const out = JSON.parse(await read())
    expect(installedEvents(JSON.stringify(out), OURS)).toEqual([])
    expect(out.hooks.Stop).toEqual(JSON.parse(MINE).hooks.Stop)
    expect(out.hooks.Notification).toEqual([
      { hooks: [{ type: 'command', command: 'notify-send hi' }] }
    ])
    expect(out.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: `${CMD} --log` }] }
    ])
    expect(out.hooks.UserPromptSubmit).toBeUndefined()
    expect(out.env).toEqual({ FOO: '1' })
  })

  it('a wrapper that mentions the script is not taken for the app’s hook', async () => {
    const wrapped = `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "bash -c 'tee /tmp/x | ${CMD}'"}]}]}}`
    const { inst, src, install, uninstall, read } = await setup(wrapped)
    expect((await inst.describe(src))?.installed).toBe(false)
    expect((await inst.plan(src, 'uninstall')).noop).toBe(true)
    await install()
    await uninstall()
    expect(await read()).toBe(wrapped)
  })

  it('installs into and restores a commented file exactly, also after other edits', async () => {
    const { settingsPath, install, uninstall, read } = await setup(COMMENTED)
    expect((await install()).ok).toBe(true)
    expect(installedEvents(await read(), OURS)).toHaveLength(HOOK_EVENTS.length)
    await uninstall()
    expect(await read()).toBe(COMMENTED)
    // Hooks edited by hand in the meantime: only the app's text goes.
    await install()
    const edit = (s: string) => s.replace('// ding when done', '// ding when done (edited)')
    await writeFile(settingsPath, edit(await read()))
    await uninstall()
    expect(await read()).toBe(edit(COMMENTED))
  })

  it('keeps a CRLF file CRLF, and restores it exactly', async () => {
    const crlf = MINE.replace(/\n/g, '\r\n')
    const { install, uninstall, read } = await setup(crlf)
    await install()
    expect(await read()).not.toMatch(/[^\r]\n/)
    await uninstall()
    expect(await read()).toBe(crlf)
  })

  it('repairs a removed hook, then still takes out exactly its own', async () => {
    const { settingsPath, inst, src, install, uninstall, read } = await setup(MINE)
    await install()
    const json = JSON.parse(await read())
    delete json.hooks.SessionEnd
    await writeFile(settingsPath, JSON.stringify(json, null, 2))
    expect((await inst.describe(src))?.changedSinceInstall).toBe(true)
    await install()
    expect(installedEvents(await read(), OURS)).toContain('SessionEnd')
    await uninstall()
    expect(JSON.parse(await read()).hooks).toEqual(JSON.parse(MINE).hooks)
  })

  it('creates settings.json when missing, and leaves an empty object on disable', async () => {
    const { inst, src, install, uninstall, read } = await setup()
    expect((await inst.plan(src, 'install')).createsFile).toBe(true)
    await install()
    expect(installedEvents(await read(), OURS)).toHaveLength(HOOK_EVENTS.length)
    await uninstall()
    expect(JSON.parse(await read())).toEqual({})
  })

  it('refuses invalid JSON, duplicate or odd hooks, and a file changed since the review', async () => {
    const bad = await setup('{ "model": ')
    expect((await bad.inst.plan(bad.src, 'install')).error).toMatch(/won't change it/)
    await writeFile(bad.settingsPath, '{"hooks": ["x"]}')
    expect((await bad.inst.plan(bad.src, 'install')).error).toMatch(/not an object/)
    await writeFile(bad.settingsPath, '{"hooks": {}, "hooks": {"Stop": []}}')
    expect((await bad.inst.plan(bad.src, 'install')).error).toMatch(/appears twice/)
    await writeFile(bad.settingsPath, MINE)
    const plan = await bad.inst.plan(bad.src, 'install')
    await writeFile(bad.settingsPath, MINE.replace('opus', 'haiku'))
    const res = await bad.inst.apply(bad.src, 'install', plan.token)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/changed/)
    expect(await bad.read()).toBe(MINE.replace('opus', 'haiku'))
  })

  it('refusing a file with duplicate keys writes nothing: no backup, no script, no change', async () => {
    const dup = '{"hooks": {"Stop": []}, "model": "x", "hooks": {"Notification": []}}'
    const { inst, src, home, dataDir, read } = await setup(dup)
    const plan = await inst.plan(src, 'install')
    expect(plan.error).toMatch(/appears twice/)
    const res = await inst.apply(src, 'install', plan.token)
    expect(res.ok).toBe(false)
    expect(await read()).toBe(dup)
    await expect(readdir(join(dataDir, 'backups'))).rejects.toThrow()
    await expect(readdir(join(home, '.claude-session-dashboard'))).rejects.toThrow()
    expect(await readdir(join(home, '.claude'))).toEqual(['settings.json'])
  })

  it('updates its own script, brings back a deleted one, and leaves a changed one alone', async () => {
    const { home, store, inst, src, install } = await setup(MINE)
    await install()
    const script = join(home, '.claude-session-dashboard', 'bin', 'csd-hook.sh')
    const bundled = await readFile(script, 'utf8')
    await writeFile(script, '#!/bin/sh\n# old\n')
    store.update((d) => {
      d.installs[src.id].scriptSha256 = createHash('sha256')
        .update('#!/bin/sh\n# old\n')
        .digest('hex')
    })
    expect(await inst.refreshScripts([src])).toEqual([src.id])
    expect(await readFile(script, 'utf8')).toBe(bundled)
    await writeFile(script, '#!/bin/sh\n# mine\n')
    expect(await inst.refreshScripts([src])).toEqual([])
    expect(await readFile(script, 'utf8')).toBe('#!/bin/sh\n# mine\n')
    await rm(script)
    expect(await inst.refreshScripts([src])).toEqual([src.id])
    expect(await readFile(script, 'utf8')).toBe(bundled)
  })
})

describe('saving settings.json', () => {
  async function file(text?: string) {
    const dir = join(root, 'h', '.claude')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'settings.json')
    if (text !== undefined) await writeFile(path, text)
    return { dir, path }
  }

  it('writes through a temp file and one rename, leaving nothing behind', async () => {
    const { dir, path } = await file('A')
    const seen: string[] = []
    await writeSettings(path, 'NEW', 'A', {
      // At the swap: settings.json is still there, and the full new file is ready.
      beforeSwap: async () => {
        seen.push(await readFile(path, 'utf8'))
        const tmp = (await readdir(dir)).find((n) => n.endsWith('.tmp'))!
        seen.push(await readFile(join(dir, tmp), 'utf8'))
      }
    })
    expect(seen).toEqual(['A', 'NEW'])
    expect(await readFile(path, 'utf8')).toBe('NEW')
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('a save after the review (up to the swap) is kept, and nothing is changed', async () => {
    const { dir, path } = await file('A')
    await expect(
      writeSettings(path, 'NEW', 'A', { beforeSwap: () => writeFile(path, 'SAVED BY CLAUDE') })
    ).rejects.toThrow(/changed/)
    expect(await readFile(path, 'utf8')).toBe('SAVED BY CLAUDE')
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('a file created meanwhile (there was none) is kept', async () => {
    const { path } = await file()
    await expect(
      writeSettings(path, 'NEW', undefined, {
        beforeSwap: () => writeFile(path, 'SAVED BY CLAUDE')
      })
    ).rejects.toThrow(/changed/)
    expect(await readFile(path, 'utf8')).toBe('SAVED BY CLAUDE')
  })

  it('refuses, changing nothing, when one atomic rename is not possible', async () => {
    const { dir, path } = await file('A')
    const noRename = async () => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    }
    await expect(writeSettings(path, 'NEW', 'A', { rename: noRename })).rejects.toThrow(
      /can't be replaced in one step.*Nothing was changed/
    )
    expect(await readFile(path, 'utf8')).toBe('A')
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('refuses any path but settings.json in .claude', async () => {
    const { dir } = await file('A')
    await expect(writeSettings(join(dir, 'other.json'), 'x', 'A')).rejects.toThrow(/Refusing/)
  })

  it('known limit: an editor that already has the file open can still overwrite it; the backup stays intact', async () => {
    const { settingsPath, dataDir, install, read } = await setup(MINE)
    // An editor opened settings.json before the change and keeps its own copy.
    const editorBuffer = await read()
    expect((await install()).ok).toBe(true)
    // ...and saves its stale copy afterwards, over the app's change.
    await writeFile(settingsPath, `${editorBuffer.trimEnd()}\n`)
    expect(installedEvents(await read(), OURS)).toEqual([])
    // Nothing of the user's is lost: the reviewed original is in the backup.
    const dir = join(dataDir, 'backups', 'settings')
    const backups = await readdir(dir)
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, backups[0]), 'utf8')).toBe(MINE)
  })
})

describe('tidying up after an interrupted save', () => {
  async function layout(files: Record<string, string>) {
    const dir = join(root, 'h', '.claude')
    await mkdir(dir, { recursive: true })
    for (const [n, t] of Object.entries(files)) await writeFile(join(dir, n), t)
    const dataDir = join(root, 'appdata')
    const backupDir = join(dataDir, 'backups', 'settings')
    return { dir, path: join(dir, 'settings.json'), dataDir, backupDir }
  }

  it('removes its own temp files and keeps a leftover .prev as a backup', async () => {
    const l = await layout({
      'settings.json': 'CURRENT',
      'settings.json.csd-0a1b2c3d.tmp': 'HALF',
      'settings.json.csd-11111111.prev': 'OLDER',
      'notes.txt': 'mine'
    })
    const r = await cleanupSettingsLeftovers(l.path, l.backupDir, l.dataDir)
    expect(r).toEqual({ removed: 2, restored: false })
    expect((await readdir(l.dir)).sort()).toEqual(['notes.txt', 'settings.json'])
    expect(await readFile(l.path, 'utf8')).toBe('CURRENT')
    const saved = await readdir(l.backupDir)
    expect(saved).toHaveLength(1)
    expect(await readFile(join(l.backupDir, saved[0]), 'utf8')).toBe('OLDER')
  })

  it('puts a .prev back only when settings.json is missing', async () => {
    const l = await layout({ 'settings.json.csd-22222222.prev': 'MOVED ASIDE' })
    expect(await cleanupSettingsLeftovers(l.path, l.backupDir, l.dataDir)).toEqual({
      removed: 1,
      restored: true
    })
    expect(await readFile(l.path, 'utf8')).toBe('MOVED ASIDE')
    expect(await readdir(l.dir)).toEqual(['settings.json'])
  })
})

// The sh script itself (Git for Windows' sh on Windows; skipped without one).
const SH = localShell('sh')

describe.runIf(!!SH)('csd-hook.sh', () => {
  const run = (dir: string, input: string) =>
    execFileSync(SH!, [join(SCRIPTS, 'csd-hook.sh')], {
      input,
      env: { ...process.env, PATH: shellPath(SH!), CSD_BRIDGE_DIR: dir },
      encoding: 'utf8'
    })

  it('saves each event atomically under its session and name, and prints nothing', async () => {
    const dir = join(root, 'b')
    const payload = JSON.stringify({
      session_id: 'abc-123',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash'
    })
    expect(run(dir, payload)).toBe('')
    expect(run(dir, '{"session_id":"abc-123","hook_event_name":"Stop"}')).toBe('')
    expect((await readdir(join(dir, 'events'))).sort()).toEqual([
      'abc-123.Notification.json',
      'abc-123.Stop.json'
    ])
    expect((await readFile(join(dir, 'events', 'abc-123.Notification.json'), 'utf8')).trim()).toBe(
      payload
    )
  })

  it('reads only top-level fields, never the same names nested in tool input', async () => {
    const dir = join(root, 'b')
    run(
      dir,
      JSON.stringify({
        tool_input: { session_id: 'evil', hook_event_name: 'Stop', note: 'a "quote" } ] { [' },
        session_id: 'real-1',
        list: [{ hook_event_name: 'Nope' }],
        hook_event_name: 'PermissionRequest',
        after: { session_id: 'later' }
      })
    )
    expect(await readdir(join(dir, 'events'))).toEqual(['real-1.PermissionRequest.json'])
  })

  it('ignores unsafe, incomplete, non-object and oversized input, and never fails', async () => {
    const dir = join(root, 'b')
    expect(run(dir, '')).toBe('')
    expect(run(dir, '{"session_id":"../../evil","hook_event_name":"Stop"}')).toBe('')
    expect(run(dir, '{"session_id":"ok","hook_event_name":"../x"}')).toBe('')
    expect(run(dir, '[{"session_id":"ok","hook_event_name":"Stop"}]')).toBe('')
    expect(run(dir, 'not json')).toBe('')
    const big = JSON.stringify({
      session_id: 'big',
      hook_event_name: 'Stop',
      m: 'x'.repeat(1_100_000)
    })
    expect(run(dir, big)).toBe('')
    const names = await readdir(join(dir, 'events')).catch(() => [])
    expect(names).toEqual([])
  })
})
