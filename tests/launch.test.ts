import { describe, expect, it } from 'vitest'
import {
  buildLaunchCommand,
  claudeArgs,
  CMD_FOLDER_REASON,
  CMD_UNC_REASON,
  cwdProblem,
  formatCommandLine,
  psQuote,
  quoteWindowsArg,
  WT_FOLDER_REASON,
  type LaunchInput
} from '../src/main/core/launch'
import { TOOLS } from './helpers'

const ID = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const CMD = TOOLS.cmd
const PS = TOOLS.powershell
const WT = TOOLS.wt!
const WSL = TOOLS.wsl
const CLAUDE = TOOLS.claude!

const launch = (o: Partial<LaunchInput> & Pick<LaunchInput, 'env' | 'cwd' | 'terminal'>) =>
  buildLaunchCommand({ sessionId: ID, fork: false, skipPermissions: false, tools: TOOLS, ...o })

describe('claudeArgs', () => {
  it('adds flags in order', () => {
    expect(claudeArgs(ID, false, false)).toEqual(['--resume', ID])
    expect(claudeArgs(ID, true, true)).toEqual([
      '--resume',
      ID,
      '--dangerously-skip-permissions',
      '--fork-session'
    ])
  })
  it('rejects ids that could inject shell syntax', () => {
    expect(() => claudeArgs('abc; rm -rf ~', false, false)).toThrow()
    expect(() => claudeArgs('$(whoami)', false, false)).toThrow()
    expect(() => claudeArgs('', false, false)).toThrow()
  })
})

describe('Windows sessions', () => {
  it('builds the Windows Terminal command as an argument array (path with spaces)', () => {
    const cmd = launch({
      env: 'windows',
      cwd: 'C:\\Users\\beau\\My Projects\\desktop app',
      skipPermissions: true,
      terminal: 'wt'
    })
    expect(cmd.command).toBe(WT)
    expect(cmd.args).toEqual([
      '-d',
      'C:\\Users\\beau\\My Projects\\desktop app',
      CMD,
      '/s',
      '/k',
      `"${CLAUDE}" --resume ${ID} --dangerously-skip-permissions`
    ])
    expect(cmd.verbatim).toBe(false)
    // Windows Terminal is given -d, so it isn't started in the project folder.
    expect(cmd.spawnCwd).toBeUndefined()
    expect(cmd.claudeCommand).toBe(`claude --resume ${ID} --dangerously-skip-permissions`)
    expect(cmd.commandLine).toBe(
      `"${WT}" -d "C:\\Users\\beau\\My Projects\\desktop app" ${CMD} /s /k "\\"${CLAUDE}\\" --resume ${ID} --dangerously-skip-permissions"`
    )
  })

  it('adds --fork-session when forking and omits skip-permissions when off', () => {
    const cmd = launch({ env: 'windows', cwd: 'C:\\code\\app', fork: true, terminal: 'wt' })
    expect(cmd.args.at(-1)).toBe(`"${CLAUDE}" --resume ${ID} --fork-session`)
    expect(cmd.claudeCommand).toBe(`claude --resume ${ID} --fork-session`)
  })

  it('falls back to PowerShell and cmd', () => {
    const ps = launch({ env: 'windows', cwd: "C:\\it's here", terminal: 'powershell' })
    expect(ps.command).toBe(PS)
    expect(ps.args).toEqual([
      '-NoExit',
      '-Command',
      `Set-Location -LiteralPath 'C:\\it''s here'; & '${CLAUDE}' --resume ${ID}`
    ])
    expect(ps.spawnCwd).toBe("C:\\it's here")

    const cmd = launch({
      env: 'windows',
      cwd: 'C:\\My Code',
      skipPermissions: true,
      terminal: 'cmd'
    })
    expect(cmd.command).toBe(CMD)
    expect(cmd.verbatim).toBe(true)
    // cmd starts in the folder: the folder's name never reaches its parser.
    expect(cmd.spawnCwd).toBe('C:\\My Code')
    expect(cmd.args).toEqual([
      '/s',
      '/k',
      `""${CLAUDE}" --resume ${ID} --dangerously-skip-permissions"`
    ])
    expect(cmd.args.join(' ')).not.toContain('My Code')
  })

  it("keeps cmd from finding npm's `node` in the project folder", () => {
    const shim = 'C:\\Users\\beau\\AppData\\Roaming\\npm\\claude.cmd'
    const tools = { ...TOOLS, claude: shim }
    const wt = launch({ env: 'windows', cwd: 'C:\\code\\app', terminal: 'wt', tools })
    expect(wt.args.at(-1)).toBe(
      `set NoDefaultCurrentDirectoryInExePath=1& "${shim}" --resume ${ID}`
    )
    const cmd = launch({ env: 'windows', cwd: 'C:\\code\\app', terminal: 'cmd', tools })
    expect(cmd.args.at(-1)).toBe(
      `"set NoDefaultCurrentDirectoryInExePath=1& "${shim}" --resume ${ID}"`
    )
    // PowerShell runs a .cmd through cmd too.
    const ps = launch({ env: 'windows', cwd: 'C:\\code\\app', terminal: 'powershell', tools })
    expect(ps.args.at(-1)).toBe(
      `Set-Location -LiteralPath 'C:\\code\\app'; $env:NoDefaultCurrentDirectoryInExePath = '1'; & '${shim}' --resume ${ID}`
    )
    // claude.exe doesn't need it.
    for (const terminal of ['cmd', 'powershell'] as const)
      expect(launch({ env: 'windows', cwd: 'C:\\x', terminal }).args.at(-1)).not.toContain(
        'NoDefault'
      )
  })
})

describe('WSL sessions', () => {
  it('builds the wt + wsl.exe command with a login shell (path with spaces)', () => {
    const cmd = launch({
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/root/infra scripts',
      fork: true,
      skipPermissions: true,
      terminal: 'wt'
    })
    expect(cmd.command).toBe(WT)
    expect(cmd.args).toEqual([
      WSL,
      '-d',
      'Ubuntu',
      '--cd',
      '/root/infra scripts',
      '--',
      'bash',
      '-lic',
      `claude --resume ${ID} --dangerously-skip-permissions --fork-session`
    ])
    expect(cmd.spawnCwd).toBeUndefined()
    expect(cmd.commandLine).toBe(
      `"${WT}" ${WSL} -d Ubuntu --cd "/root/infra scripts" -- bash -lic "claude --resume ${ID} --dangerously-skip-permissions --fork-session"`
    )
  })

  it('supports PowerShell and cmd windows', () => {
    const ps = launch({
      env: 'wsl',
      distro: 'Ubuntu-22.04',
      cwd: '/home/me/a b',
      terminal: 'powershell'
    })
    expect(ps.command).toBe(PS)
    expect(ps.args[2]).toBe(
      `& '${WSL}' -d 'Ubuntu-22.04' --cd '/home/me/a b' -- bash -lic 'claude --resume ${ID}'`
    )
    const cmd = launch({ env: 'wsl', distro: 'Ubuntu', cwd: '/home/me/a b', terminal: 'cmd' })
    expect(cmd.command).toBe(CMD)
    expect(cmd.args).toEqual([
      '/s',
      '/k',
      `""${WSL}" -d Ubuntu --cd "/home/me/a b" -- bash -lic "claude --resume ${ID}""`
    ])
  })

  it('rejects bad distro names', () => {
    expect(() =>
      launch({ env: 'wsl', distro: 'Ubuntu & calc', cwd: '/', terminal: 'wt' })
    ).toThrow()
  })
})

describe('programs come from trusted absolute paths (SEC-01)', () => {
  it('never starts a program by bare name, in any terminal or environment', () => {
    for (const env of ['windows', 'wsl'] as const)
      for (const terminal of ['wt', 'powershell', 'cmd'] as const)
        for (const newSession of [false, true]) {
          const cmd = launch({
            env,
            distro: 'Ubuntu',
            cwd: env === 'wsl' ? '/home/me/app' : 'C:\\code\\app',
            terminal,
            newSession
          })
          expect(cmd.command).toMatch(/^[A-Z]:\\/)
          expect([TOOLS.wt, TOOLS.powershell, TOOLS.cmd]).toContain(cmd.command)
          // The shell started inside the terminal, and Claude or wsl.exe, by absolute path too.
          const inner = env === 'wsl' ? WSL : CLAUDE
          expect(cmd.args.join(' ')).toContain(inner)
          expect(cmd.commandLine).not.toMatch(/(^|[\s"'])(wt|cmd|powershell|wsl)(\.exe)?\s/)
          // (In WSL, `claude` is found by the Linux login shell.)
          if (env === 'windows')
            expect(cmd.commandLine).not.toMatch(/(^|[\s"'&])claude(\.exe|\.cmd)?\s/)
        }
  })

  it('refuses to build a Windows launch without a found Claude Code', () => {
    expect(() =>
      launch({
        env: 'windows',
        cwd: 'C:\\x',
        terminal: 'wt',
        tools: { ...TOOLS, claude: undefined }
      })
    ).toThrow(/Claude Code wasn't found/)
    expect(() =>
      launch({
        env: 'windows',
        cwd: 'C:\\x',
        terminal: 'cmd',
        tools: { ...TOOLS, claude: 'claude' }
      })
    ).toThrow(/Claude Code wasn't found/)
  })
})

describe('working folders are never read as commands (SEC-02)', () => {
  it("keeps a folder with ';' or '%' away from Windows Terminal", () => {
    for (const [env, cwd] of [
      ['windows', 'C:\\synthetic\\project;audit-placeholder.exe'],
      ['windows', 'C:\\synthetic\\100%PATH%'],
      ['wsl', '/home/synthetic/project;C:/audit-placeholder.exe'],
      ['wsl', '/home/synthetic/%USERPROFILE%']
    ] as const) {
      const cmd = launch({ env, distro: 'Ubuntu', cwd, terminal: 'wt' })
      expect(cmd.terminal).toBe('powershell')
      expect(cmd.terminalReason).toBe(WT_FOLDER_REASON)
      expect(cmd.command).toBe(PS)
      // The folder only appears inside a PowerShell literal string.
      expect(cmd.args[2]).toContain(psQuote(cwd))
    }
  })

  it('never puts a Windows folder into a cmd command line', () => {
    const cwd = 'C:\\R&D\\a%CMDCMDLINE%b ^ | (x)'
    const cmd = launch({ env: 'windows', cwd, terminal: 'cmd' })
    expect(cmd.spawnCwd).toBe(cwd)
    expect(cmd.args.join(' ')).not.toContain('R&D')
    expect(cmd.commandLine).not.toContain('R&D')
  })

  it("doesn't start cmd in a network folder (it would fall back to C:\\Windows)", () => {
    const cmd = launch({ env: 'windows', cwd: '\\\\server\\share\\proj', terminal: 'cmd' })
    expect(cmd.terminal).toBe('powershell')
    expect(cmd.terminalReason).toBe(CMD_UNC_REASON)
  })

  it('keeps a WSL folder that cmd would expand away from cmd', () => {
    for (const cwd of ['/home/me/%PATH%', '/home/me/!x!']) {
      const cmd = launch({ env: 'wsl', distro: 'Ubuntu', cwd, terminal: 'cmd' })
      expect(cmd.terminal).toBe('powershell')
      expect(cmd.terminalReason).toBe(CMD_FOLDER_REASON)
    }
  })

  it('refuses WSL folders with quotes, backslashes or control characters', () => {
    for (const cwd of [
      '/home/synthetic/" & echo AUDIT_MARKER & rem "',
      '/home/synthetic/ends-with\\',
      '/home/synthetic/new\nline',
      'relative/path'
    ]) {
      expect(cwdProblem('wsl', cwd)).toBeTruthy()
      for (const terminal of ['wt', 'powershell', 'cmd'] as const)
        expect(() => launch({ env: 'wsl', distro: 'Ubuntu', cwd, terminal })).toThrow()
    }
    expect(cwdProblem('wsl', '/home/me/odd $name (1) & co; it’s')).toBeUndefined()
  })

  it('only accepts full Windows folder paths', () => {
    for (const cwd of ['.', 'code\\app', 'C:relative', '\\rooted', '-d', 'C:\\a"b'])
      expect(cwdProblem('windows', cwd)).toBeTruthy()
    for (const cwd of ['C:\\code', 'd:/code', '\\\\server\\share'])
      expect(cwdProblem('windows', cwd)).toBeUndefined()
  })
})

describe('psQuote', () => {
  it('doubles every quote PowerShell ends a literal string at', () => {
    expect(psQuote("it's")).toBe("'it''s'")
    // ‘ ’ ‚ ‛ also close a single-quoted string in PowerShell.
    expect(psQuote('a’; calc; ’b')).toBe("'a’’; calc; ’’b'")
    expect(psQuote('\u2018\u201a\u201b')).toBe("'\u2018\u2018\u201a\u201a\u201b\u201b'")
  })
})

describe('quoteWindowsArg', () => {
  it('quotes only when needed and escapes quotes and trailing backslashes', () => {
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('a b')).toBe('"a b"')
    expect(quoteWindowsArg('C:\\My Dir\\')).toBe('"C:\\My Dir\\\\"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(formatCommandLine('x.exe', ['a', 'b c'])).toBe('x.exe a "b c"')
  })
})
