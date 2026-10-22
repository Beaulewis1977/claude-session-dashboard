// Building resume/fork launch commands as argument arrays.
//
// Commands are spawned with `child_process.spawn(command, args, { detached: true })`.
// Arguments are never joined into a shell string, so paths with spaces work.
// `commandLine` is only for display and the "Copy resume command" action.

import type { EnvKind, TerminalPref } from '@shared/types'
import { isValidDistroName } from './wsl'

export interface LaunchInput {
  env: EnvKind
  sessionId: string
  cwd: string
  distro?: string
  fork: boolean
  skipPermissions: boolean
  terminal: TerminalPref
}

export interface LaunchCommand {
  command: string
  args: string[]
  /** Pass `windowsVerbatimArguments` (only for cmd.exe, which does its own parsing). */
  verbatim: boolean
  /** Working directory for spawn (Windows sessions only). */
  spawnCwd?: string
  commandLine: string
  claudeCommand: string
  claudeArgs: string[]
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id) && id.length <= 128
}

export function claudeArgs(sessionId: string, skipPermissions: boolean, fork: boolean): string[] {
  if (!isValidSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  const args = ['--resume', sessionId]
  if (skipPermissions) args.push('--dangerously-skip-permissions')
  if (fork) args.push('--fork-session')
  return args
}

/** Quote one argument the way the MSVC runtime / CommandLineToArgvW expects. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
    } else {
      out += '\\'.repeat(backslashes) + ch
      backslashes = 0
    }
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

export function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsArg).join(' ')
}

/** PowerShell single-quoted string literal. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function buildLaunchCommand(input: LaunchInput): LaunchCommand {
  const cArgs = claudeArgs(input.sessionId, input.skipPermissions, input.fork)
  const claudeCommand = ['claude', ...cArgs].join(' ')
  const base = { claudeCommand, claudeArgs: cArgs }

  if (input.env === 'wsl') {
    const distro = input.distro ?? ''
    if (!isValidDistroName(distro)) throw new Error(`Invalid WSL distro name: ${distro}`)
    const wslArgs = ['-d', distro, '--cd', input.cwd, '--', 'bash', '-lic', claudeCommand]
    switch (input.terminal) {
      case 'wt': {
        const args = ['wsl.exe', ...wslArgs]
        return {
          ...base,
          command: 'wt.exe',
          args,
          verbatim: false,
          commandLine: formatCommandLine('wt.exe', args)
        }
      }
      case 'powershell': {
        const script = `wsl.exe -d ${psQuote(distro)} --cd ${psQuote(input.cwd)} -- bash -lic ${psQuote(claudeCommand)}`
        const args = ['-NoExit', '-Command', script]
        return {
          ...base,
          command: 'powershell.exe',
          args,
          verbatim: false,
          commandLine: formatCommandLine('powershell.exe', args)
        }
      }
      case 'cmd': {
        const line = `wsl.exe -d ${distro} --cd "${input.cwd}" -- bash -lic "${claudeCommand}"`
        return {
          ...base,
          command: 'cmd.exe',
          args: ['/k', line],
          verbatim: true,
          commandLine: `cmd.exe /k ${line}`
        }
      }
    }
  }

  // Windows session
  switch (input.terminal) {
    case 'wt': {
      const args = ['-d', input.cwd, 'cmd', '/k', 'claude', ...cArgs]
      return {
        ...base,
        command: 'wt.exe',
        args,
        verbatim: false,
        spawnCwd: input.cwd,
        commandLine: formatCommandLine('wt.exe', args)
      }
    }
    case 'powershell': {
      const script = `Set-Location -LiteralPath ${psQuote(input.cwd)}; ${claudeCommand}`
      const args = ['-NoExit', '-Command', script]
      return {
        ...base,
        command: 'powershell.exe',
        args,
        verbatim: false,
        spawnCwd: input.cwd,
        commandLine: formatCommandLine('powershell.exe', args)
      }
    }
    case 'cmd': {
      const line = `cd /d "${input.cwd}" && ${claudeCommand}`
      return {
        ...base,
        command: 'cmd.exe',
        args: ['/k', line],
        verbatim: true,
        spawnCwd: input.cwd,
        commandLine: `cmd.exe /k ${line}`
      }
    }
  }
}
