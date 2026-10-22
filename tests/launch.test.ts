import { describe, expect, it } from 'vitest'
import {
  buildLaunchCommand,
  claudeArgs,
  formatCommandLine,
  quoteWindowsArg
} from '../src/main/core/launch'

const ID = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'

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
    const cmd = buildLaunchCommand({
      env: 'windows',
      sessionId: ID,
      cwd: 'C:\\Users\\beau\\My Projects\\desktop app',
      fork: false,
      skipPermissions: true,
      terminal: 'wt'
    })
    expect(cmd.command).toBe('wt.exe')
    expect(cmd.args).toEqual([
      '-d',
      'C:\\Users\\beau\\My Projects\\desktop app',
      'cmd',
      '/k',
      'claude',
      '--resume',
      ID,
      '--dangerously-skip-permissions'
    ])
    expect(cmd.verbatim).toBe(false)
    expect(cmd.commandLine).toBe(
      `wt.exe -d "C:\\Users\\beau\\My Projects\\desktop app" cmd /k claude --resume ${ID} --dangerously-skip-permissions`
    )
  })

  it('adds --fork-session when forking and omits skip-permissions when off', () => {
    const cmd = buildLaunchCommand({
      env: 'windows',
      sessionId: ID,
      cwd: 'C:\\code\\app',
      fork: true,
      skipPermissions: false,
      terminal: 'wt'
    })
    expect(cmd.args.slice(4)).toEqual(['claude', '--resume', ID, '--fork-session'])
    expect(cmd.claudeCommand).toBe(`claude --resume ${ID} --fork-session`)
  })

  it('falls back to PowerShell and cmd', () => {
    const ps = buildLaunchCommand({
      env: 'windows',
      sessionId: ID,
      cwd: "C:\\it's here",
      fork: false,
      skipPermissions: false,
      terminal: 'powershell'
    })
    expect(ps.command).toBe('powershell.exe')
    expect(ps.args).toEqual([
      '-NoExit',
      '-Command',
      `Set-Location -LiteralPath 'C:\\it''s here'; claude --resume ${ID}`
    ])
    expect(ps.spawnCwd).toBe("C:\\it's here")

    const cmd = buildLaunchCommand({
      env: 'windows',
      sessionId: ID,
      cwd: 'C:\\My Code',
      fork: false,
      skipPermissions: true,
      terminal: 'cmd'
    })
    expect(cmd.command).toBe('cmd.exe')
    expect(cmd.verbatim).toBe(true)
    expect(cmd.args).toEqual([
      '/k',
      `cd /d "C:\\My Code" && claude --resume ${ID} --dangerously-skip-permissions`
    ])
  })
})

describe('WSL sessions', () => {
  it('builds the wt + wsl.exe command with a login shell (path with spaces)', () => {
    const cmd = buildLaunchCommand({
      env: 'wsl',
      distro: 'Ubuntu',
      sessionId: ID,
      cwd: '/root/infra scripts',
      fork: true,
      skipPermissions: true,
      terminal: 'wt'
    })
    expect(cmd.command).toBe('wt.exe')
    expect(cmd.args).toEqual([
      'wsl.exe',
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
      `wt.exe wsl.exe -d Ubuntu --cd "/root/infra scripts" -- bash -lic "claude --resume ${ID} --dangerously-skip-permissions --fork-session"`
    )
  })

  it('supports PowerShell and cmd windows', () => {
    const ps = buildLaunchCommand({
      env: 'wsl',
      distro: 'Ubuntu-22.04',
      sessionId: ID,
      cwd: '/home/me/a b',
      fork: false,
      skipPermissions: false,
      terminal: 'powershell'
    })
    expect(ps.args[2]).toBe(
      `wsl.exe -d 'Ubuntu-22.04' --cd '/home/me/a b' -- bash -lic 'claude --resume ${ID}'`
    )
    const cmd = buildLaunchCommand({
      env: 'wsl',
      distro: 'Ubuntu',
      sessionId: ID,
      cwd: '/home/me/a b',
      fork: false,
      skipPermissions: false,
      terminal: 'cmd'
    })
    expect(cmd.args).toEqual([
      '/k',
      `wsl.exe -d Ubuntu --cd "/home/me/a b" -- bash -lic "claude --resume ${ID}"`
    ])
  })

  it('rejects bad distro names', () => {
    expect(() =>
      buildLaunchCommand({
        env: 'wsl',
        distro: 'Ubuntu & calc',
        sessionId: ID,
        cwd: '/',
        fork: false,
        skipPermissions: false,
        terminal: 'wt'
      })
    ).toThrow()
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
