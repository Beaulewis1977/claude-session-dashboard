import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inferBilling, parseBridgePayload, parseResetsAt } from '@shared/usage/bridge'
import type { SourceInfo } from '@shared/types'
import { diffLines, removeMember, scanTopLevel, setMember } from '../src/main/core/settings-edit'
import {
  assertBridgeWrite,
  assertClaudeSettingsWrite,
  UnsafeWriteError
} from '../src/main/core/safe-paths'
import { BridgeInstaller, createBridgeStore, envPaths } from '../src/main/services/bridge'

const SCRIPTS = join(__dirname, '..', 'resources', 'bridge')

describe('bridge payload', () => {
  const meta = { ts: 1000, source: 'windows' }

  it('reads the documented fields', () => {
    const r = parseBridgePayload(
      JSON.stringify({
        session_id: 'abc-123',
        model: { id: 'claude-opus-5-5', display_name: 'Opus' },
        workspace: { current_dir: '/home/me/x' },
        version: '2.1.300',
        cost: { total_cost_usd: 0.42 },
        context_window: { used_percentage: 31, context_window_size: 200000 },
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
          seven_day: { used_percentage: 41.2, resets_at: 1738857600 }
        }
      }),
      meta
    )
    expect(r).toEqual({
      ts: 1000,
      source: 'windows',
      sessionId: 'abc-123',
      model: 'claude-opus-5-5',
      modelName: 'Opus',
      version: '2.1.300',
      cwd: '/home/me/x',
      fiveHour: { pct: 23.5, resetsAt: 1738425600000 },
      sevenDay: { pct: 41.2, resetsAt: 1738857600000 },
      costUsd: 0.42,
      contextPct: 31,
      contextSize: 200000
    })
  })

  it('handles missing rate_limits, missing windows and nulls', () => {
    const noLimits = parseBridgePayload('{"session_id":"s","cost":{"total_cost_usd":1.5}}', meta)
    expect(noLimits?.fiveHour).toBeUndefined()
    expect(inferBilling([noLimits!])).toBe('api')
    const partial = parseBridgePayload(
      {
        rate_limits: { five_hour: null, seven_day: { used_percentage: 12 } },
        context_window: { used_percentage: null }
      },
      meta
    )
    expect(partial?.fiveHour).toBeUndefined()
    expect(partial?.sevenDay).toEqual({ pct: 12, resetsAt: undefined })
    expect(partial?.contextPct).toBeUndefined()
    expect(inferBilling([partial!])).toBe('subscription')
    expect(inferBilling([parseBridgePayload('{}', meta)!])).toBe('unknown')
    expect(parseBridgePayload('not json', meta)).toBeUndefined()
    expect(parseBridgePayload('[1,2]', meta)).toBeUndefined()
    // Unsafe session ids are dropped.
    expect(parseBridgePayload('{"session_id":"../../x"}', meta)?.sessionId).toBeUndefined()
  })

  it('accepts epoch seconds, epoch milliseconds and ISO resets_at', () => {
    expect(parseResetsAt(1738425600)).toBe(1738425600000)
    expect(parseResetsAt(1738425600.5)).toBe(1738425600500)
    expect(parseResetsAt('1738425600')).toBe(1738425600000)
    expect(parseResetsAt(1738425600000)).toBe(1738425600000)
    expect(parseResetsAt('2026-10-22T17:54:13Z')).toBe(Date.parse('2026-10-22T17:54:13Z'))
    expect(parseResetsAt('soon')).toBeUndefined()
    expect(parseResetsAt(null)).toBeUndefined()
    expect(parseResetsAt(-5)).toBeUndefined()
  })
})

describe('settings.json editing', () => {
  const original = `{
    "theme": "dark",
    "permissions": { "allow": ["Bash(npm test)"], "deny": [] },
    // not valid JSON is rejected elsewhere; this text has none
    "cleanupPeriodDays": 90
}
`.replace('    // not valid JSON is rejected elsewhere; this text has none\n', '')

  it('changes only one key and keeps formatting', () => {
    const out = setMember(original, 'statusLine', { type: 'command', command: 'sh x.sh' })
    expect(out.startsWith(original.slice(0, original.lastIndexOf('90') + 2))).toBe(true)
    expect(out).toContain(
      '    "cleanupPeriodDays": 90,\n    "statusLine": {\n        "type": "command",'
    )
    expect(JSON.parse(out)).toEqual({
      ...JSON.parse(original),
      statusLine: { type: 'command', command: 'sh x.sh' }
    })
    expect(removeMember(out, 'statusLine')).toBe(original)
  })

  it('replaces an existing value in place and can put the exact old text back', () => {
    const withLine = setMember(
      original,
      'statusLine',
      undefined,
      '{"type":"command",  "command": "~/s.sh"}'
    )
    const replaced = setMember(withLine, 'statusLine', { type: 'command', command: 'new' })
    const back = setMember(
      replaced,
      'statusLine',
      undefined,
      '{"type":"command",  "command": "~/s.sh"}'
    )
    expect(back).toBe(withLine)
  })

  it('handles empty, minified and first-member cases', () => {
    expect(JSON.parse(setMember('{}', 'a', 1))).toEqual({ a: 1 })
    expect(setMember('{"x":1}', 'a', { b: 2 })).toBe('{"x":1, "a": {"b":2}}')
    expect(removeMember('{"a": 1, "b": 2}', 'a')).toBe('{"b": 2}')
    expect(removeMember('{"a": 1}', 'a')).toBe('{}')
    expect(() => scanTopLevel('[1]')).toThrow()
    expect(() => scanTopLevel('{"a": }')).toThrow()
    // Strings containing braces and escaped quotes.
    expect(scanTopLevel('{"a": "}\\"{", "b": [1, {"c": "]"}]}').members.map((m) => m.key)).toEqual([
      'a',
      'b'
    ])
  })

  it('produces a line diff', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd')
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'same', text: 'c' },
      { type: 'add', text: 'd' }
    ])
  })
})

describe('write guards', () => {
  it('only allows settings.json inside .claude, and only the bridge folder outside it', () => {
    expect(() => assertClaudeSettingsWrite('/h/.claude/settings.json')).not.toThrow()
    expect(() =>
      assertClaudeSettingsWrite('/h/.claude/settings.json.csd-0a1b2c3d.tmp')
    ).not.toThrow()
    expect(() => assertClaudeSettingsWrite('/h/.claude/projects/x.jsonl')).toThrow(UnsafeWriteError)
    expect(() => assertClaudeSettingsWrite('/h/.claude/settings.local.json')).toThrow(
      UnsafeWriteError
    )
    expect(() => assertClaudeSettingsWrite('/h/settings.json')).toThrow(UnsafeWriteError)
    expect(() => assertBridgeWrite('/h/.claude-session-dashboard/bin/statusline.sh')).not.toThrow()
    expect(() => assertBridgeWrite('/h/.claude/.claude-session-dashboard/x')).toThrow(
      UnsafeWriteError
    )
    expect(() => assertBridgeWrite('/h/other/x')).toThrow(UnsafeWriteError)
  })
})

// ---------------------------------------------------------------- installer

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-bridge-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
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

async function installer(gitBash?: string) {
  const dataDir = join(root, 'appdata')
  const store = createBridgeStore(dataDir)
  await store.load()
  return {
    dataDir,
    inst: new BridgeInstaller(store, { dataDir, scriptsDir: SCRIPTS, gitBash: async () => gitBash })
  }
}

describe('status line installer', () => {
  const settingsText = `{
  "model": "opus",
  "statusLine": {
    "type": "command",
    "command": "~/.claude/my status.sh",
    "padding": 1
  },
  "env": { "FOO": "1" }
}
`

  it('builds the right command per environment', () => {
    const win = envPaths(source('windows', 'C:\\Users\\Beau Lewis'))!
    expect(win.command).toBe(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join('C:\\Users\\Beau Lewis', '.claude-session-dashboard').replace(/\\/g, '/')}/bin/statusline.ps1"`
    )
    expect(envPaths(source('wsl', '/x/home/beau', 'beau'))!.command).toBe(
      'sh /home/beau/.claude-session-dashboard/bin/statusline.sh'
    )
    expect(envPaths(source('wsl', '/x/root', 'root'))!.command).toBe(
      'sh /root/.claude-session-dashboard/bin/statusline.sh'
    )
    expect(envPaths({ ...source('wsl', '/x', 'beau'), kind: 'custom' })).toBeUndefined()
  })

  it('preserves other keys, chains the old command, backs up first, and restores exactly', async () => {
    const home = join(root, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    const settingsPath = join(home, '.claude', 'settings.json')
    await writeFile(settingsPath, settingsText)
    const src = source('wsl', home, 'beau')
    const { inst, dataDir } = await installer()

    const plan = await inst.plan(src, 'install')
    expect(plan.error).toBeUndefined()
    expect(plan.chained).toBe('~/.claude/my status.sh')
    expect(
      plan.diff.filter((d) => d.type !== 'same').map((d) => `${d.type} ${d.text.trim()}`)
    ).toEqual([
      'remove "command": "~/.claude/my status.sh",',
      'add "command": "sh /home/beau/.claude-session-dashboard/bin/statusline.sh",'
    ])
    // Nothing is written by planning.
    expect(await readFile(settingsPath, 'utf8')).toBe(settingsText)

    const res = await inst.apply(src, 'install', plan.token)
    expect(res.ok).toBe(true)
    expect(await readFile(res.backupPath!, 'utf8')).toBe(settingsText)
    expect(res.backupPath!.startsWith(join(dataDir, 'backups', 'settings'))).toBe(true)
    const after = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(after).toEqual({
      model: 'opus',
      statusLine: {
        type: 'command',
        command: 'sh /home/beau/.claude-session-dashboard/bin/statusline.sh',
        padding: 1
      },
      env: { FOO: '1' }
    })
    expect(await readFile(join(home, '.claude-session-dashboard', 'chain.sh'), 'utf8')).toBe(
      '~/.claude/my status.sh\n'
    )
    expect(
      await readFile(join(home, '.claude-session-dashboard', 'bin', 'statusline.sh'), 'utf8')
    ).toContain('status line bridge')
    // Nothing else appeared in .claude.
    expect(await readdir(join(home, '.claude'))).toEqual(['settings.json'])

    const env = await inst.describe(src)
    expect(env).toMatchObject({ installed: true, chained: '~/.claude/my status.sh' })

    const undo = await inst.plan(src, 'uninstall')
    expect(undo.chained).toBe('~/.claude/my status.sh')
    expect((await inst.apply(src, 'uninstall', undo.token)).ok).toBe(true)
    expect(await readFile(settingsPath, 'utf8')).toBe(settingsText)
    expect((await inst.describe(src))?.installed).toBe(false)
  })

  it('restores only statusLine when other keys changed after installing', async () => {
    const home = join(root, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    const settingsPath = join(home, '.claude', 'settings.json')
    await writeFile(settingsPath, settingsText)
    const src = source('wsl', home, 'beau')
    const { inst } = await installer()
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    // Claude Code (or the user) edits another key meanwhile.
    const edited = (await readFile(settingsPath, 'utf8')).replace('"opus"', '"sonnet"')
    await writeFile(settingsPath, edited)
    await inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
    expect(await readFile(settingsPath, 'utf8')).toBe(settingsText.replace('"opus"', '"sonnet"'))
  })

  it('creates settings.json when missing and leaves an empty object on disable', async () => {
    const home = join(root, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    const src = source('windows', home)
    const { inst } = await installer()
    const plan = await inst.plan(src, 'install')
    expect(plan.createsFile).toBe(true)
    expect(plan.chained).toBeUndefined()
    await inst.apply(src, 'install', plan.token)
    const p = join(home, '.claude', 'settings.json')
    expect(JSON.parse(await readFile(p, 'utf8')).statusLine.command).toContain('statusline.ps1')
    expect(
      JSON.parse(await readFile(join(home, '.claude-session-dashboard', 'chain.json'), 'utf8'))
    ).toEqual({
      command: '',
      shell: null
    })
    expect(
      await readFile(join(home, '.claude-session-dashboard', 'bin', 'statusline.ps1'), 'utf8')
    ).toMatch(/\r\n/)
    await inst.apply(src, 'uninstall', (await inst.plan(src, 'uninstall')).token)
    expect(JSON.parse(await readFile(p, 'utf8'))).toEqual({})
  })

  it('refuses invalid JSON and changes made after the review', async () => {
    const home = join(root, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    const p = join(home, '.claude', 'settings.json')
    const src = source('wsl', home, 'beau')
    const { inst } = await installer()
    await writeFile(p, '{ "a": 1, }')
    expect((await inst.plan(src, 'install')).error).toMatch(/isn't valid JSON/)
    await writeFile(p, '{ "a": 1 }')
    const plan = await inst.plan(src, 'install')
    await writeFile(p, '{ "a": 2 }')
    const res = await inst.apply(src, 'install', plan.token)
    expect(res.ok).toBe(false)
    expect(await readFile(p, 'utf8')).toBe('{ "a": 2 }')
  })

  it('records the Git Bash path for chaining a Windows status line', async () => {
    const home = join(root, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'settings.json'), settingsText)
    const src = source('windows', home)
    const { inst } = await installer('C:\\Program Files\\Git\\bin\\bash.exe')
    await inst.apply(src, 'install', (await inst.plan(src, 'install')).token)
    expect(
      JSON.parse(await readFile(join(home, '.claude-session-dashboard', 'chain.json'), 'utf8'))
    ).toEqual({
      command: '~/.claude/my status.sh',
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe'
    })
  })
})

// ------------------------------------------------------------ the sh script

describe('statusline.sh', () => {
  const payload = JSON.stringify({
    session_id: 'sess-1',
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    context_window: {
      total_input_tokens: 5,
      used_percentage: 8.4,
      current_usage: { input_tokens: 1 }
    },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 }
    }
  })
  const run = (dir: string, input: string) =>
    execFileSync('sh', [join(SCRIPTS, 'statusline.sh')], {
      input,
      env: { ...process.env, CSD_BRIDGE_DIR: dir },
      encoding: 'utf8'
    })

  it('saves the payload atomically and prints a short status line', async () => {
    const dir = join(root, 'b')
    const out = run(dir, payload)
    expect(out).toBe('Opus · 5h 23% · week 41% · ctx 8%\n')
    expect((await readFile(join(dir, 'live', 'latest.json'), 'utf8')).trim()).toBe(payload)
    expect((await readFile(join(dir, 'live', 'sess-1.json'), 'utf8')).trim()).toBe(payload)
    // No temp files left behind.
    expect((await readdir(join(dir, 'live'))).sort()).toEqual(['latest.json', 'sess-1.json'])
  })

  it('works without rate_limits and with odd input, and never fails', async () => {
    const dir = join(root, 'b')
    expect(run(dir, '{"model":{"display_name":"Sonnet"}}')).toBe('Sonnet\n')
    expect(run(dir, '')).toBe('')
    expect(run(dir, '{"session_id":"../../evil"}')).toBe('Claude\n')
    expect(await readdir(join(dir, 'live'))).not.toContain('evil.json')
  })

  it('pipes the payload to the previous command when chained', async () => {
    const dir = join(root, 'b')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'chain.sh'), 'printf "mine:" ; wc -c | tr -d " "\n')
    expect(run(dir, payload)).toBe(`mine:${payload.length + 1}\n`)
    // An empty chain file means "no previous command".
    await writeFile(join(dir, 'chain.sh'), '')
    expect(run(dir, payload)).toMatch(/^Opus/)
  })

  it('finishes quickly', () => {
    const dir = join(root, 'b')
    const t = Date.now()
    for (let i = 0; i < 5; i++) run(dir, payload)
    // Generous bound for CI machines; typically ~20 ms per run. This is the WSL
    // script: on Windows the test's `sh` is Git Bash, where each program the
    // script starts (cat, mv, …) costs a slow process start of its own, so the
    // bound there measures Git Bash rather than the script.
    expect((Date.now() - t) / 5).toBeLessThan(process.platform === 'win32' ? 1500 : 250)
  })
})
