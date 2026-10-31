// Session alerts: adding our hooks to settings.json keeps every existing hook
// (and every other byte), and Disable takes out exactly ours.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOOK_EVENTS } from '@shared/live'
import type { SourceInfo } from '@shared/types'
import { appendHookGroups, withoutHandlers } from '../src/main/core/settings-edit'
import {
  createHooksStore,
  hookCommand,
  hookGroup,
  HooksInstaller,
  installedEvents,
  isHookCommand
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
  return { home, settingsPath, dataDir, store, inst, src: source('wsl', home, 'beau') }
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

const cmd = 'sh /home/beau/.claude-session-dashboard/bin/csd-hook.sh'

describe('hook commands', () => {
  it('builds the right command per environment and recognises it', () => {
    const win = hookCommand(source('windows', 'C:\\Users\\Beau Lewis'))!
    expect(win).toMatch(
      /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*\/\.claude-session-dashboard\/bin\/csd-hook\.ps1"$/
    )
    expect(win).not.toContain('\\')
    expect(hookCommand(source('wsl', '/x/home/beau', 'beau'))).toBe(cmd)
    expect(hookCommand(source('wsl', '/x/root', 'root'))).toBe(
      'sh /root/.claude-session-dashboard/bin/csd-hook.sh'
    )
    expect(hookCommand({ ...source('wsl', '/x', 'beau'), kind: 'custom' })).toBeUndefined()
    expect(isHookCommand(win)).toBe(true)
    expect(isHookCommand('C:\\x\\.claude-session-dashboard\\bin\\csd-hook.ps1')).toBe(true)
    expect(isHookCommand('~/guard.sh')).toBe(false)
    expect(hookGroup(cmd)).toEqual({
      hooks: [{ type: 'command', command: cmd, timeout: 10, async: true }]
    })
  })
})

describe('appendHookGroups', () => {
  const g = hookGroup(cmd)

  it('appends to existing lists without changing a byte of what is there', () => {
    const out = appendHookGroups(MINE, [
      ['Stop', g],
      ['Notification', g]
    ])
    const json = JSON.parse(out)
    expect(json.hooks.Stop).toHaveLength(2)
    expect(json.hooks.Stop[0].hooks[0].command).toBe('afplay ~/done.wav')
    expect(json.hooks.Stop[1]).toEqual(g)
    expect(json.hooks.PreToolUse).toEqual(JSON.parse(MINE).hooks.PreToolUse)
    expect(json.hooks.Notification).toEqual([g])
    expect(json.env).toEqual({ FOO: '1' })
    // Everything that was there is still there, in order, as text.
    let at = 0
    for (const line of MINE.split('\n').filter((l) => l.trim() && !/^\s*[\]}],?$/.test(l))) {
      const i = out.indexOf(line.trimEnd().replace(/,$/, ''), at)
      expect(i, line).toBeGreaterThanOrEqual(at)
      at = i
    }
  })

  it('creates hooks when missing, keeps one-line and tab-indented files in their style', () => {
    const oneLine = appendHookGroups('{"model":"opus"}', [['Stop', g]])
    expect(oneLine.split('\n')).toHaveLength(1)
    expect(JSON.parse(oneLine).hooks.Stop).toEqual([g])
    const tabs = appendHookGroups('{\n\t"model": "opus"\n}\n', [['Stop', g]])
    expect(tabs).toContain('\n\t"hooks": {\n\t\t"Stop": [')
    expect(JSON.parse(tabs).hooks.Stop).toEqual([g])
    const empty = appendHookGroups('{}', [['Stop', g]])
    expect(JSON.parse(empty)).toEqual({ hooks: { Stop: [g] } })
    const emptyList = appendHookGroups('{\n  "hooks": { "Stop": [] }\n}', [['Stop', g]])
    expect(JSON.parse(emptyList).hooks.Stop).toEqual([g])
  })

  it('refuses hooks it does not understand', () => {
    expect(() => appendHookGroups('{"hooks": []}', [['Stop', g]])).toThrow(/not an object/)
    expect(() => appendHookGroups('{"hooks": {"Stop": {}}}', [['Stop', g]])).toThrow(/not a list/)
  })

  it('takes out only our handlers', () => {
    const hooks = {
      Stop: [
        { hooks: [{ type: 'command', command: 'afplay ~/done.wav' }] },
        g,
        // Someone put their own handler in our group: it stays.
        { hooks: [{ type: 'command', command: 'echo mine' }, (g.hooks as unknown[])[0]] }
      ],
      Notification: [g]
    }
    const out = withoutHandlers(
      hooks,
      (h) => isHookCommand((h as { command?: string }).command),
      () => true
    )
    expect(out).toEqual({
      Stop: [
        { hooks: [{ type: 'command', command: 'afplay ~/done.wav' }] },
        { hooks: [{ type: 'command', command: 'echo mine' }] }
      ]
    })
    expect(
      withoutHandlers(
        { Stop: [] },
        () => true,
        () => true
      )
    ).toBeUndefined()
  })
})

describe('hooks installer', () => {
  it('shows a diff of additions only, backs up, writes the script, and restores exactly', async () => {
    const { settingsPath, dataDir, inst, src, home } = await setup(MINE)
    const plan = await inst.plan(src, 'install')
    expect(plan.error).toBeUndefined()
    // The review shows additions only: not one existing line changes.
    expect(plan.diff.filter((d) => d.type === 'remove')).toEqual([])
    expect(plan.diff.filter((d) => d.type === 'same').map((d) => d.text)).toEqual(MINE.split('\n'))
    expect(plan.diff.some((d) => d.type === 'add' && d.text.includes('csd-hook.sh'))).toBe(true)

    const res = await inst.apply(src, 'install', plan.token)
    expect(res.ok).toBe(true)
    const after = await readFile(settingsPath, 'utf8')
    expect(installedEvents(after).sort()).toEqual([...HOOK_EVENTS].sort())
    const json = JSON.parse(after)
    expect(json.hooks.Stop[0].hooks[0].command).toBe('afplay ~/done.wav')
    expect(json.hooks.PreToolUse).toEqual(JSON.parse(MINE).hooks.PreToolUse)
    expect(json.model).toBe('opus')
    // Backup of the exact original, and the script with Linux line endings.
    const backups = await readdir(join(dataDir, 'backups', 'settings'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dataDir, 'backups', 'settings', backups[0]), 'utf8')).toBe(MINE)
    const script = await readFile(
      join(home, '.claude-session-dashboard', 'bin', 'csd-hook.sh'),
      'utf8'
    )
    expect(script).not.toContain('\r\n')

    // Enabling again changes nothing.
    expect((await inst.plan(src, 'install')).noop).toBe(true)
    const d = await inst.describe(src)
    expect(d?.installed).toBe(true)
    expect(d?.changedSinceInstall).toBe(false)

    const un = await inst.plan(src, 'uninstall')
    expect((await inst.apply(src, 'uninstall', un.token)).ok).toBe(true)
    expect(await readFile(settingsPath, 'utf8')).toBe(MINE)
    expect((await inst.describe(src))?.installed).toBe(false)
  })

  it('restores the hooks byte for byte when only other settings changed', async () => {
    const { settingsPath, inst, src } = await setup(MINE)
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    const changed = (await readFile(settingsPath, 'utf8')).replace(
      '"model": "opus"',
      '"model": "sonnet"'
    )
    await writeFile(settingsPath, changed)
    await inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
    expect(await readFile(settingsPath, 'utf8')).toBe(
      MINE.replace('"model": "opus"', '"model": "sonnet"')
    )
  })

  it('keeps hooks added after it, and removes only its own', async () => {
    const { settingsPath, inst, src } = await setup(MINE)
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    const json = JSON.parse(await readFile(settingsPath, 'utf8'))
    json.hooks.Notification.push({ hooks: [{ type: 'command', command: 'notify-send hi' }] })
    json.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'echo start' }] })
    await writeFile(settingsPath, JSON.stringify(json, null, 2))
    await inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
    const out = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(installedEvents(JSON.stringify(out))).toEqual([])
    expect(out.hooks.Stop).toEqual(JSON.parse(MINE).hooks.Stop)
    expect(out.hooks.PreToolUse).toEqual(JSON.parse(MINE).hooks.PreToolUse)
    expect(out.hooks.Notification).toEqual([
      { hooks: [{ type: 'command', command: 'notify-send hi' }] }
    ])
    expect(out.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo start' }] }
    ])
    // Events the app created and nobody else uses are gone again.
    expect(out.hooks.UserPromptSubmit).toBeUndefined()
    expect(out.env).toEqual({ FOO: '1' })
  })

  it('repairs a removed hook, then still takes out exactly its own', async () => {
    const { settingsPath, inst, src } = await setup(MINE)
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    const json = JSON.parse(await readFile(settingsPath, 'utf8'))
    delete json.hooks.SessionEnd
    await writeFile(settingsPath, JSON.stringify(json, null, 2))
    expect((await inst.describe(src))?.changedSinceInstall).toBe(true)
    const repair = await inst.plan(src, 'install')
    expect(repair.noop).toBeUndefined()
    await inst.apply(src, 'install', repair.token)
    expect(installedEvents(await readFile(settingsPath, 'utf8'))).toContain('SessionEnd')
    await inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
    const out = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(out.hooks).toEqual(JSON.parse(MINE).hooks)
  })

  it('creates settings.json when missing, and leaves an empty object on disable', async () => {
    const { settingsPath, inst, src } = await setup()
    const plan = await inst.plan(src, 'install')
    expect(plan.createsFile).toBe(true)
    await inst.apply(src, 'install', plan.token)
    expect(installedEvents(await readFile(settingsPath, 'utf8'))).toHaveLength(HOOK_EVENTS.length)
    await inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({})
  })

  it('refuses invalid JSON and odd hooks, and a file changed since the review', async () => {
    const bad = await setup('{ "model": ')
    expect((await bad.inst.plan(bad.src, 'install')).error).toMatch(/won't change it/)
    await writeFile(bad.settingsPath, '{"hooks": ["x"]}')
    expect((await bad.inst.plan(bad.src, 'install')).error).toMatch(/not an object/)
    await writeFile(bad.settingsPath, MINE)
    const plan = await bad.inst.plan(bad.src, 'install')
    await writeFile(bad.settingsPath, MINE.replace('opus', 'haiku'))
    const res = await bad.inst.apply(bad.src, 'install', plan.token)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/changed/)
    expect(await bad.inst.describe(bad.src)).toMatchObject({ installed: false })
  })

  it('updates its own script, brings back a deleted one, and leaves a changed one alone', async () => {
    const { home, store, inst, src } = await setup(MINE)
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    const script = join(home, '.claude-session-dashboard', 'bin', 'csd-hook.sh')
    const bundled = await readFile(script, 'utf8')
    // An older version the app wrote (recorded hash) is replaced.
    await writeFile(script, '#!/bin/sh\n# old\n')
    store.update((d) => {
      d.installs[src.id].scriptSha256 = createHash('sha256')
        .update('#!/bin/sh\n# old\n')
        .digest('hex')
    })
    expect(await inst.refreshScripts([src])).toEqual([src.id])
    expect(await readFile(script, 'utf8')).toBe(bundled)
    // Changed by someone: kept.
    await writeFile(script, '#!/bin/sh\n# mine\n')
    expect(await inst.refreshScripts([src])).toEqual([])
    expect(await readFile(script, 'utf8')).toBe('#!/bin/sh\n# mine\n')
    // Deleted: comes back.
    await rm(script)
    expect(await inst.refreshScripts([src])).toEqual([src.id])
    expect(await readFile(script, 'utf8')).toBe(bundled)
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

  it('ignores unsafe or incomplete input and never fails', async () => {
    const dir = join(root, 'b')
    expect(run(dir, '')).toBe('')
    expect(run(dir, '{"session_id":"../../evil","hook_event_name":"Stop"}')).toBe('')
    expect(run(dir, '{"session_id":"ok","hook_event_name":"../x"}')).toBe('')
    expect(run(dir, 'not json')).toBe('')
    const names = await readdir(join(dir, 'events')).catch(() => [])
    expect(names).toEqual([])
  })
})
