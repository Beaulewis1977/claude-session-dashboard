import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLaunchCommand,
  claudeArgs,
  claudeCommandLine,
  REMOTE_CONTROL_API_ERROR,
  REMOTE_CONTROL_FLAG,
  remoteControlName,
  type LaunchInput
} from '../src/main/core/launch'
import { childEnv } from '../src/main/platform'
import { analyzeEvents, parseJsonl, remoteSessionUrl } from '../src/shared/jsonl'
import { TOOLS } from './helpers'

const ID = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const CLAUDE = TOOLS.claude!

const launch = (o: Partial<LaunchInput> & Pick<LaunchInput, 'env' | 'cwd' | 'terminal'>) =>
  buildLaunchCommand({ sessionId: ID, fork: false, skipPermissions: false, tools: TOOLS, ...o })

const HOSTILE_NAMES = [
  '$(rm -rf ~); "x" %PATH% !x! & calc | `whoami`',
  "it's ‘quoted’ $env:USERPROFILE; Write-Output pwned",
  '--dangerously-skip-permissions',
  '-- --fork-session',
  'a\nb\r\tc\u0000d',
  '^&|<>()[]{}=,;'
]

describe('remoteControlName', () => {
  it('keeps letters, digits, spaces and _ . - only, and never starts with "-"', () => {
    for (const raw of HOSTILE_NAMES) {
      const n = remoteControlName(raw)
      if (n === undefined) continue
      expect(n).toMatch(/^[\p{L}\p{N}_][\p{L}\p{N} _.-]*$/u)
      expect(n.startsWith('-')).toBe(false)
    }
    expect(remoteControlName('--dangerously-skip-permissions')).toBe('dangerously-skip-permissions')
    expect(remoteControlName('Fix login bug (v2): “auth” flow')).toBe('Fix login bug v2 auth flow')
    expect(remoteControlName('Café 東京 sprint')).toBe('Café 東京 sprint')
    expect(remoteControlName('   ')).toBeUndefined()
    expect(remoteControlName(undefined)).toBeUndefined()
    expect(remoteControlName('x'.repeat(200))!.length).toBe(80)
  })
})

describe('claudeArgs with Remote Control', () => {
  it('puts --remote-control and the name before --resume', () => {
    expect(claudeArgs(ID, false, false, false, { name: 'My session' })).toEqual([
      REMOTE_CONTROL_FLAG,
      'My session',
      '--resume',
      ID
    ])
    expect(claudeArgs(ID, false, true, false, {})).toEqual([
      '--remote-control',
      '--resume',
      ID,
      '--fork-session'
    ])
    // A hostile name never becomes a flag of its own.
    const args = claudeArgs(ID, false, false, false, { name: '--dangerously-skip-permissions' })
    expect(args.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(0)
  })

  it('leaves the command unchanged without Remote Control', () => {
    expect(claudeArgs(ID, false, false)).toEqual(['--resume', ID])
  })

  it('quotes the name for bash', () => {
    expect(claudeCommandLine(claudeArgs(ID, false, false, false, { name: 'My session' }))).toBe(
      `claude --remote-control 'My session' --resume ${ID}`
    )
  })
})

describe('Remote Control launch commands', () => {
  it('Windows Terminal + cmd: the name is one quoted argument', () => {
    const cmd = launch({
      env: 'windows',
      cwd: 'C:\\code\\my app',
      terminal: 'wt',
      remoteControl: { name: 'Fix login bug' }
    })
    expect(cmd.args.at(-1)).toBe(`"${CLAUDE}" --remote-control "Fix login bug" --resume ${ID}`)
    expect(cmd.unsetEnv).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
  })

  it('PowerShell: the name is a single-quoted literal', () => {
    const cmd = launch({
      env: 'windows',
      cwd: 'C:\\code\\app',
      terminal: 'powershell',
      remoteControl: { name: 'Fix login bug' }
    })
    expect(cmd.args[2]).toContain(`& '${CLAUDE}' --remote-control 'Fix login bug' --resume ${ID}`)
  })

  it('WSL in every terminal', () => {
    const rc = { name: 'Infra work' }
    const wt = launch({
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/me',
      terminal: 'wt',
      remoteControl: rc
    })
    expect(wt.args.at(-1)).toBe(`claude --remote-control 'Infra work' --resume ${ID}`)
    const ps = launch({
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/me',
      terminal: 'powershell',
      remoteControl: rc
    })
    expect(ps.args[2]).toBe(
      `& '${TOOLS.wsl}' -d 'Ubuntu' --cd '/home/me' -- bash -lic 'claude --remote-control ''Infra work'' --resume ${ID}'`
    )
    const cmd = launch({
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/me',
      terminal: 'cmd',
      remoteControl: rc
    })
    expect(cmd.args[2]).toBe(
      `""${TOOLS.wsl}" -d Ubuntu --cd "/home/me" -- bash -lic "claude --remote-control 'Infra work' --resume ${ID}""`
    )
  })

  it('refuses API-key billing (Remote Control needs the subscription)', () => {
    expect(() =>
      launch({
        env: 'windows',
        cwd: 'C:\\code\\app',
        terminal: 'powershell',
        apiKey: 'sk-ant-api03-test',
        remoteControl: {}
      })
    ).toThrow(REMOTE_CONTROL_API_ERROR)
  })

  it('never adds --dangerously-skip-permissions by itself', () => {
    for (const terminal of ['wt', 'powershell', 'cmd'] as const)
      for (const name of HOSTILE_NAMES) {
        const w = launch({
          env: 'windows',
          cwd: 'C:\\a',
          terminal,
          remoteControl: { name: remoteControlName(name) }
        })
        expect(JSON.stringify(w.args)).not.toContain('--dangerously-skip-permissions')
        expect(w.claudeArgs).not.toContain('--dangerously-skip-permissions')
        const l = launch({
          env: 'wsl',
          distro: 'Ubuntu',
          cwd: '/a',
          terminal,
          remoteControl: { name }
        })
        expect(l.claudeArgs).not.toContain('--dangerously-skip-permissions')
        expect(l.claudeArgs).not.toContain('--fork-session')
      }
  })

  it('drops API credentials from the child environment, case-insensitively', () => {
    const env = childEnv(
      { PATH: 'x', anthropic_api_key: 'k', ANTHROPIC_AUTH_TOKEN: 't', HOME: 'h' },
      { unsetEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] }
    )
    expect(env).toEqual({ PATH: 'x', HOME: 'h' })
    // Without Remote Control nothing is dropped, and the launch's own variables are added.
    expect(childEnv({ A: '1' }, { env: { B: '2' } })).toEqual({ A: '1', B: '2' })
  })

  it("never passes on a running Claude Code session's own variables", () => {
    // The app started from inside a Claude Code session inherits these.
    const env = childEnv(
      {
        PATH: 'x',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 's',
        CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
        CLAUDE_CODE_MESSAGING_TOKEN: 't',
        CLAUDE_CODE_MESSAGING_SOCKET: 'p',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_PID: '9',
        CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe',
        CLAUDE_CONFIG_DIR: 'C:/cfg'
      },
      {}
    )
    expect(env).toEqual({
      PATH: 'x',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe',
      CLAUDE_CONFIG_DIR: 'C:/cfg'
    })
  })

  it.runIf(process.platform === 'win32')(
    'cmd really passes the name as one argument (and nothing else runs)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'csd-rc-'))
      const fake = join(dir, 'claude args.cmd')
      writeFileSync(fake, '@echo off\r\necho [%~1][%~2][%~3][%~4][%~5]\r\n')
      for (const raw of HOSTILE_NAMES.concat('Fix login bug')) {
        const name = remoteControlName(raw)
        const cmd = buildLaunchCommand({
          env: 'windows',
          sessionId: ID,
          cwd: dir,
          fork: false,
          skipPermissions: false,
          terminal: 'cmd',
          tools: { ...TOOLS, claude: fake },
          remoteControl: { name }
        })
        const args = cmd.args.map((a) => (a === '/k' ? '/c' : a))
        const r = spawnSync(cmd.command, args, {
          cwd: cmd.spawnCwd,
          windowsVerbatimArguments: true,
          encoding: 'utf8'
        })
        const expected = name
          ? `[--remote-control][${name}][--resume][${ID}][]`
          : `[--remote-control][--resume][${ID}][][]`
        expect(r.stdout.trim()).toBe(expected)
      }
    },
    30_000
  )

  const hasBash = spawnSync('bash', ['-c', 'true']).status === 0
  it.runIf(hasBash)('bash really passes the name as one argument', () => {
    for (const raw of HOSTILE_NAMES.concat("Bob's work")) {
      const line = claudeCommandLine(claudeArgs(ID, false, false, false, { name: raw }))
      // The script goes in on stdin: WSL's bash.exe can mangle a -c argument.
      const r = spawnSync('bash', ['-s'], {
        input: `claude() { printf '[%s]' "$@"; }; ${line}
`,
        encoding: 'utf8'
      })
      const name = remoteControlName(raw)
      expect(r.stdout).toBe(
        name
          ? `[--remote-control][${name}][--resume][${ID}]`
          : `[--remote-control][--resume][${ID}]`
      )
    }
  })
})

describe('Remote Control links in session files', () => {
  const line = (o: object) => JSON.stringify(o)
  it('reads the latest bridge_status link', () => {
    const text = [
      line({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        timestamp: '2026-10-23T10:00:00Z'
      }),
      line({
        type: 'system',
        subtype: 'bridge_status',
        url: 'https://claude.ai/code/session_015zxfBknkp7ndVwquBtoZYq',
        timestamp: '2026-10-23T10:01:00Z'
      }),
      line({
        type: 'system',
        subtype: 'bridge_status',
        url: 'https://claude.ai/code/session_02AAAAAAAAAAAAAAAAAAAAAA',
        timestamp: '2026-10-23T11:00:00Z'
      })
    ].join('\n')
    const a = analyzeEvents(parseJsonl(text).events)
    expect(a.remoteUrl).toBe('https://claude.ai/code/session_02AAAAAAAAAAAAAAAAAAAAAA')
    expect(a.remoteUrlAt).toBe('2026-10-23T11:00:00.000Z')
    expect(a.userMessageCount).toBe(1)
  })

  it('accepts only claude.ai/code session links', () => {
    expect(remoteSessionUrl('https://claude.ai/code/session_015zxfBknkp7ndVwquBtoZYq')).toBeTruthy()
    for (const bad of [
      'http://claude.ai/code/session_015zxfBknkp7ndVwquBtoZYq',
      'https://claude.ai.evil.com/code/session_015zxfBknkp7ndVwquBtoZYq',
      'https://claude.ai/code/session_015zxf?x=javascript:alert(1)',
      'javascript:alert(1)',
      42
    ])
      expect(remoteSessionUrl(bad)).toBeUndefined()
  })
})
