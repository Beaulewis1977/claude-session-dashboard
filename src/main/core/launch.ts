// Building resume/fork launch commands as argument arrays.
//
// Commands are spawned with `child_process.spawn(command, args, { detached: true })`.
// Arguments are never joined into a shell string, so paths with spaces work.
// `commandLine` is only for display and the "Copy resume command" action: a
// PowerShell command that opens the same terminal (see shownCommand).
//
// Every program is started by absolute path (see which.ts), so nothing in a
// project folder can stand in for the terminal, the shell or Claude. The
// working folder comes from the session file, so it never reaches a parser
// that could read it as a command: cmd.exe never sees a Windows folder (it
// starts in it instead), PowerShell only sees it as a literal string, Windows
// Terminal never gets a ";" (its command separator) or a "%", and WSL folders
// with quotes, backslashes or control characters are refused.

import type { EnvKind, TerminalPref } from '@shared/types'
import { modelArgs, type ResolvedModel } from '@shared/model-choice'
import { isAbsoluteWindowsPath } from './which'
import { isValidDistroName } from './wsl'

/** Absolute paths of the programs a launch can start. */
export interface LaunchTools {
  /** Windows Terminal; undefined when it isn't installed. */
  wt?: string
  powershell: string
  cmd: string
  wsl: string
  /** Claude Code for Windows sessions (claude.exe or npm's claude.cmd); undefined if not found. */
  claude?: string
}

export interface LaunchInput {
  env: EnvKind
  sessionId: string
  cwd: string
  distro?: string
  fork: boolean
  skipPermissions: boolean
  terminal: TerminalPref
  tools: LaunchTools
  /** Start a new session instead of resuming `sessionId`. */
  newSession?: boolean
  /**
   * Run on API credits. The key goes only into the child process environment,
   * never into the arguments or the command line shown or copied.
   */
  apiKey?: string
  /** Current WSLENV of the app, to extend rather than replace. */
  wslenv?: string
  /** Turn on Remote Control (claude.ai/code and the Claude app), optionally with a session name. */
  remoteControl?: RemoteControl
  /**
   * Start in the prompting permission mode whatever the user's settings say
   * (`--permission-mode default`). Launches from a phone always set this:
   * without it, Claude Code's own default for terminal sessions may run
   * commands without asking.
   */
  askPermissions?: boolean
  /** `--model` / `--effort` (validated; nothing for Claude Code's default). */
  modelChoice?: ModelChoice
  /** Continue fresh: a new session with this id whose first message is `prompt`. */
  continueFresh?: ContinueFreshArgs
}

export interface ContinueFreshArgs {
  newSessionId: string
  /** The short first message pointing at the handoff file (see handoffPrompt). */
  prompt: string
  /** The handoff file's folder, when the message asks Claude to read it (`--add-dir`). */
  addDir?: string
}

export type ModelChoice = Pick<ResolvedModel, 'model' | 'effort'>

export interface RemoteControl {
  /** Already cleaned with remoteControlName(). */
  name?: string
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
  /** Extra environment for the child process only. */
  env?: Record<string, string>
  /** Variables removed from the child's environment (Remote Control refuses API-key auth). */
  unsetEnv?: string[]
  /** The terminal actually used. */
  terminal: TerminalPref
  /** Why the terminal differs from the requested one. */
  terminalReason?: string
}

export const WT_API_REASON =
  "API billing opens PowerShell instead of Windows Terminal: a new Windows Terminal window can join one that's already running and get its environment instead of the key."

export const WT_FOLDER_REASON =
  'This folder\'s name contains ";" or "%", which Windows Terminal reads as a new command or a variable, so PowerShell is used instead.'

export const CMD_FOLDER_REASON =
  'This folder\'s name contains "%" or "!", which cmd expands even inside quotes, so PowerShell is used instead.'

export const CMD_UNC_REASON =
  "cmd can't start in a network folder (\\\\server\\share), so PowerShell is used instead."

export const TOOL_PATH_REASON =
  'The path to Claude Code or wsl.exe contains a character Windows Terminal or cmd reads specially (";", "%" or "!"), so PowerShell is used instead.'

/** Why `terminal` can't be given this folder, or these programs, safely (PowerShell is used instead). */
function folderReason(
  terminal: TerminalPref,
  env: EnvKind,
  cwd: string,
  tools: LaunchTools
): string | undefined {
  // The program that goes inside the terminal's command line.
  const inner = (env === 'wsl' ? tools.wsl : tools.claude) ?? ''
  // Windows Terminal splits every argument at ";" and expands %variables% in the line it runs.
  if (terminal === 'wt' && /[;%]/.test(cwd)) return WT_FOLDER_REASON
  if (terminal === 'wt' && /[;%]/.test(inner + (tools.cmd ?? ''))) return TOOL_PATH_REASON
  // cmd expands %variables% (and !variables!) even inside quotes.
  if (terminal === 'cmd' && env === 'wsl' && /[%!]/.test(cwd)) return CMD_FOLDER_REASON
  if (terminal === 'cmd' && /[%!]/.test(inner)) return TOOL_PATH_REASON
  // cmd would start in C:\Windows instead.
  if (terminal === 'cmd' && env === 'windows' && /^[\\/]{2}/.test(cwd)) return CMD_UNC_REASON
  return undefined
}

/** Windows' opt-out from looking for programs in the current folder (honoured by cmd.exe and libuv). */
export const NO_CWD_SEARCH = 'NoDefaultCurrentDirectoryInExePath'

/** Add `ANTHROPIC_API_KEY/u` to WSLENV so wsl.exe passes the key into Linux. */
export function wslenvWithKey(current: string | undefined): string {
  const parts = (current ?? '').split(':').filter(Boolean)
  if (!parts.some((p) => p.split('/')[0] === 'ANTHROPIC_API_KEY')) parts.push('ANTHROPIC_API_KEY/u')
  return parts.join(':')
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id) && id.length <= 128
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * Why a working folder can't be handed to a terminal, or undefined if it can.
 * WSL folders pass through Windows command lines on the way into Linux, where
 * quotes and backslashes change how the rest of the line is read.
 */
export function cwdProblem(env: EnvKind, cwd: string): string | undefined {
  if (CONTROL_RE.test(cwd))
    return "The folder's name contains control characters, so it can't be passed to a terminal safely."
  if (env === 'windows')
    return isAbsoluteWindowsPath(cwd) && !cwd.includes('"')
      ? undefined
      : `Not a full Windows folder path: ${cwd}`
  if (cwd === '~') return undefined
  if (!cwd.startsWith('/')) return `Not a full Linux folder path: ${cwd}`
  if (/["\\]/.test(cwd))
    return "The folder's name contains \" or \\, which can't be passed to wsl.exe safely. Choose another folder."
  return undefined
}

// ---------------------------------------------------------------------------
// Remote Control
//
// `claude --remote-control [name] --resume <id>` resumes a session with Remote
// Control on (Claude Code v2.1.51+, claude.ai sign-in only). The flag and its
// arguments are built here and nowhere else, so changing how Remote Control is
// switched on means changing only this block.

export const REMOTE_CONTROL_FLAG = '--remote-control'
export const REMOTE_CONTROL_MIN_VERSION = '2.1.51'
/** Remote Control refuses to start when either is set ("requires claude.ai subscription auth"). */
export const REMOTE_CONTROL_UNSET_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
export const REMOTE_CONTROL_API_ERROR =
  "Remote Control needs your Claude subscription, so it can't run on an API key. Choose the subscription, or turn Remote Control off."

const RC_NAME_MAX = 80

/**
 * The session name for Remote Control, made safe for every shell it passes
 * through (cmd, PowerShell, Windows Terminal, wsl.exe and bash): letters,
 * digits, spaces and `_ . -` only, never starting with "-" (it would read as
 * a flag). Undefined when nothing is left (Claude Code then picks a name).
 */
export function remoteControlName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const s = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-.\s]+/, '')
    .slice(0, RC_NAME_MAX)
    .trim()
  return s || undefined
}

function remoteControlArgs(rc: RemoteControl | undefined): string[] {
  if (!rc) return []
  const name = remoteControlName(rc.name)
  return name ? [REMOTE_CONTROL_FLAG, name] : [REMOTE_CONTROL_FLAG]
}

/** The prompting mode ("Manual"): asks before edits and commands. */
export const ASK_PERMISSION_ARGS = ['--permission-mode', 'default']

/**
 * What the first message and the handoff folder of Continue fresh may hold:
 * they reach cmd, PowerShell, Windows Terminal and bash, so letters, digits,
 * spaces and `_ . - , @ \ / : ~` only, never starting with "-" (a flag) or a space.
 */
const CONTINUE_ARG_RE = /^[\p{L}\p{N}_.,@\\/:~][\p{L}\p{N} _.,@\\/:~-]*$/u

export function isSafeContinueArg(v: string): boolean {
  return v.length <= 1000 && CONTINUE_ARG_RE.test(v)
}

function continueArgs(c: ContinueFreshArgs): { prompt: string; rest: string[] } {
  if (!isValidSessionId(c.newSessionId)) throw new Error(`Invalid session id: ${c.newSessionId}`)
  if (!isSafeContinueArg(c.prompt))
    throw new Error("The handoff file's location can't be passed to Claude Code safely.")
  if (c.addDir !== undefined && !isSafeContinueArg(c.addDir))
    throw new Error("The handoff folder's location can't be passed to Claude Code safely.")
  return {
    prompt: c.prompt,
    // --add-dir takes several folders: the option after it ends the list.
    rest: [...(c.addDir ? ['--add-dir', c.addDir] : []), '--session-id', c.newSessionId]
  }
}

export function claudeArgs(
  sessionId: string,
  skipPermissions: boolean,
  fork: boolean,
  newSession = false,
  remoteControl?: RemoteControl,
  askPermissions = false,
  modelChoice?: ModelChoice,
  continueFresh?: ContinueFreshArgs
): string[] {
  if (askPermissions && skipPermissions)
    throw new Error("Can't both skip and ask for permission prompts.")
  const rc = remoteControlArgs(remoteControl)
  const ask = askPermissions ? ASK_PERMISSION_ARGS : []
  // Validated again here: these reach every shell on the way to Claude.
  const model = modelArgs(modelChoice?.model, modelChoice?.effort)
  if (continueFresh) {
    // The first message goes first, before any option that takes a value.
    const c = continueArgs(continueFresh)
    return [
      c.prompt,
      ...rc,
      ...ask,
      ...model,
      ...c.rest,
      ...(skipPermissions ? ['--dangerously-skip-permissions'] : [])
    ]
  }
  if (newSession)
    return [...rc, ...ask, ...model, ...(skipPermissions ? ['--dangerously-skip-permissions'] : [])]
  if (!isValidSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  const args = [...rc, ...ask, ...model, '--resume', sessionId]
  if (skipPermissions) args.push('--dangerously-skip-permissions')
  if (fork) args.push('--fork-session')
  return args
}

/** Flags and ids need no quotes; a Remote Control name with spaces does. */
const PLAIN_ARG = /^[A-Za-z0-9_\-./:=]+$/

/** One argument for a bash command line (inside `bash -lic "…"`). */
function bashArg(arg: string): string {
  return PLAIN_ARG.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** One argument for a cmd.exe command line (names are already free of `" % ! ^ & | < >`). */
function cmdArg(arg: string): string {
  return PLAIN_ARG.test(arg) ? arg : `"${arg}"`
}

function psArg(arg: string): string {
  return PLAIN_ARG.test(arg) ? arg : psQuote(arg)
}

/** The `claude …` command as bash reads it (also what's shown as "the claude command"). */
export function claudeCommandLine(args: string[]): string {
  return ['claude', ...args.map(bashArg)].join(' ')
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

/** The arguments as Windows passes them to the program (cmd.exe's are taken as they are). */
export function nativeArgs(cmd: Pick<LaunchCommand, 'args' | 'verbatim'>): string {
  return cmd.verbatim ? cmd.args.join(' ') : cmd.args.map(quoteWindowsArg).join(' ')
}

/**
 * The command shown and copied: PowerShell that opens the same terminal
 * (Start-Process, in the session's folder for cmd and PowerShell). The
 * program, its arguments and the folder appear only inside single-quoted
 * PowerShell strings, so pasting it can't run anything from the session file;
 * Start-Process hands the arguments to the program exactly as written.
 */
export function shownCommand(
  cmd: Pick<LaunchCommand, 'command' | 'args' | 'verbatim' | 'spawnCwd'>
): string {
  const start = `Start-Process -FilePath ${psQuote(cmd.command)} -ArgumentList ${psQuote(nativeArgs(cmd))}`
  return cmd.spawnCwd
    ? `Push-Location -LiteralPath ${psQuote(cmd.spawnCwd)}; ${start}; Pop-Location`
    : start
}

/**
 * PowerShell single-quoted string literal. PowerShell also ends such a string
 * at the typographic single quotes (‘ ’ ‚ ‛), so those are doubled too.
 */
export function psQuote(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`
}

function checkedTool(path: string | undefined, name: string): string {
  if (!path || !isAbsoluteWindowsPath(path) || /["\r\n]/.test(path))
    throw new Error(`${name} wasn't found.`)
  return path
}

const isBatch = (path: string): boolean => /\.(cmd|bat)$/i.test(path)

/**
 * What cmd.exe runs after `/s /k`: Claude by absolute path, then its
 * arguments. npm's claude.cmd starts `node` by name, so for a batch file the
 * line first turns off cmd's look in the current (project) folder.
 */
function cmdClaudeLine(claude: string, cArgs: string[], unset: string[] = []): string {
  const guard = isBatch(claude) ? `set ${NO_CWD_SEARCH}=1& ` : ''
  // `set NAME=` with nothing after it removes NAME (after cmd's AutoRun has run).
  const clear = unset.map((k) => `set ${k}=& `).join('')
  return guard + clear + [`"${claude}"`, ...cArgs.map(cmdArg)].join(' ')
}

/**
 * What bash runs: the claude command, after removing `unset` variables that
 * a login profile (~/.bashrc, ~/.profile) may have exported again. `&&`, not
 * `;`: Windows Terminal reads ";" as its own separator.
 */
function bashClaudeLine(claudeCommand: string, unset: string[]): string {
  return unset.length ? `unset ${unset.join(' ')} && ${claudeCommand}` : claudeCommand
}

export function buildLaunchCommand(input: LaunchInput): LaunchCommand {
  const cmd = build(input)
  return { ...cmd, commandLine: shownCommand(cmd) }
}

function build(input: LaunchInput): Omit<LaunchCommand, 'commandLine'> {
  const cArgs = claudeArgs(
    input.sessionId,
    input.skipPermissions,
    input.fork,
    input.newSession,
    input.remoteControl,
    input.askPermissions,
    input.modelChoice,
    input.continueFresh
  )
  const claudeCommand = claudeCommandLine(cArgs)
  // Remote Control refuses API-key auth: remove the keys in the final shell
  // too, after its startup profile has run (they're also kept out of its
  // environment, see unsetEnv).
  const unset = input.remoteControl ? REMOTE_CONTROL_UNSET_ENV : []
  const bashLine = bashClaudeLine(claudeCommand, unset)
  const problem = cwdProblem(input.env, input.cwd)
  if (problem) throw new Error(problem)
  const tools = input.tools
  let terminalReason: string | undefined
  let env: Record<string, string> | undefined
  const apiKey = input.apiKey
  if (apiKey && input.remoteControl) throw new Error(REMOTE_CONTROL_API_ERROR)
  if (apiKey) {
    if (input.terminal === 'wt') {
      input = { ...input, terminal: 'powershell' }
      terminalReason = WT_API_REASON
    }
    env =
      input.env === 'wsl'
        ? { ANTHROPIC_API_KEY: apiKey, WSLENV: wslenvWithKey(input.wslenv) }
        : { ANTHROPIC_API_KEY: apiKey }
  }
  const folder = folderReason(input.terminal, input.env, input.cwd, tools)
  if (folder) {
    input = { ...input, terminal: 'powershell' }
    terminalReason = folder
  }
  const base = {
    claudeCommand,
    claudeArgs: cArgs,
    terminal: input.terminal,
    ...(env ? { env } : {}),
    ...(input.remoteControl ? { unsetEnv: [...REMOTE_CONTROL_UNSET_ENV] } : {}),
    ...(terminalReason ? { terminalReason } : {})
  }

  if (input.env === 'wsl') {
    const distro = input.distro ?? ''
    if (!isValidDistroName(distro)) throw new Error(`Invalid WSL distro name: ${distro}`)
    const wsl = checkedTool(tools.wsl, 'wsl.exe')
    const wslArgs = ['-d', distro, '--cd', input.cwd, '--', 'bash', '-lic', bashLine]
    switch (input.terminal) {
      case 'wt': {
        const wt = checkedTool(tools.wt, 'Windows Terminal')
        const args = [wsl, ...wslArgs]
        return {
          ...base,
          command: wt,
          args,
          verbatim: false
        }
      }
      case 'powershell': {
        const ps = checkedTool(tools.powershell, 'PowerShell')
        const script = `& ${psQuote(wsl)} -d ${psQuote(distro)} --cd ${psQuote(input.cwd)} -- bash -lic ${psQuote(bashLine)}`
        const args = ['-NoExit', '-Command', script]
        return {
          ...base,
          command: ps,
          args,
          verbatim: false
        }
      }
      case 'cmd': {
        const cmd = checkedTool(tools.cmd, 'cmd.exe')
        const line = `"${wsl}" -d ${distro} --cd "${input.cwd}" -- bash -lic "${bashLine}"`
        const args = ['/s', '/k', `"${line}"`]
        return {
          ...base,
          command: cmd,
          args,
          verbatim: true
        }
      }
    }
  }

  // Windows session
  const claude = checkedTool(tools.claude, 'Claude Code')
  switch (input.terminal) {
    case 'wt': {
      // Windows Terminal puts quotes around an argument with spaces, which
      // gives cmd `/s /k "<line>"`: it drops just those outer quotes.
      const wt = checkedTool(tools.wt, 'Windows Terminal')
      const cmd = checkedTool(tools.cmd, 'cmd.exe')
      const args = ['-d', input.cwd, cmd, '/s', '/k', cmdClaudeLine(claude, cArgs, unset)]
      return {
        ...base,
        command: wt,
        args,
        verbatim: false
      }
    }
    case 'powershell': {
      const ps = checkedTool(tools.powershell, 'PowerShell')
      // PowerShell runs claude.cmd through cmd, which would look for `node` in the folder.
      const script = [
        `Set-Location -LiteralPath ${psQuote(input.cwd)};`,
        ...(isBatch(claude) ? [`$env:${NO_CWD_SEARCH} = '1';`] : []),
        // After the PowerShell profile has run.
        ...unset.map((k) => `Remove-Item Env:${k} -ErrorAction SilentlyContinue;`),
        '&',
        psQuote(claude),
        ...cArgs.map(psArg)
      ].join(' ')
      const args = ['-NoExit', '-Command', script]
      return {
        ...base,
        command: ps,
        args,
        verbatim: false,
        spawnCwd: input.cwd
      }
    }
    case 'cmd': {
      // cmd starts in the folder, so the folder's name never reaches its parser.
      const cmd = checkedTool(tools.cmd, 'cmd.exe')
      const args = ['/s', '/k', `"${cmdClaudeLine(claude, cArgs, unset)}"`]
      return {
        ...base,
        command: cmd,
        args,
        verbatim: true,
        spawnCwd: input.cwd
      }
    }
  }
}

// ---------------------------------------------------------------------------
// "Open terminal here": a plain shell in a session's folder, no Claude.

export interface ShellInput {
  env: EnvKind
  cwd: string
  distro?: string
  terminal: TerminalPref
  tools: LaunchTools
}

/** Why `terminal` can't be given this folder safely for a plain shell (PowerShell is used instead). */
function shellFolderReason(input: ShellInput): string | undefined {
  const { terminal, env, cwd, tools } = input
  if (terminal === 'wt' && /[;%]/.test(cwd)) return WT_FOLDER_REASON
  if (terminal === 'wt' && env === 'wsl' && /[;%]/.test(tools.wsl)) return TOOL_PATH_REASON
  if (terminal === 'cmd' && env === 'wsl' && /[%!]/.test(cwd + tools.wsl)) return CMD_FOLDER_REASON
  if (terminal === 'cmd' && env === 'windows' && /^[\\/]{2}/.test(cwd)) return CMD_UNC_REASON
  return undefined
}

export function buildShellCommand(input: ShellInput): LaunchCommand {
  const problem = cwdProblem(input.env, input.cwd)
  if (problem) throw new Error(problem)
  const reason = shellFolderReason(input)
  if (reason) input = { ...input, terminal: 'powershell' }
  const cmd = buildShell(input)
  return {
    ...cmd,
    claudeCommand: '',
    claudeArgs: [],
    terminal: input.terminal,
    ...(reason ? { terminalReason: reason } : {}),
    commandLine: shownCommand(cmd)
  }
}

function buildShell(
  input: ShellInput
): Pick<LaunchCommand, 'command' | 'args' | 'verbatim' | 'spawnCwd'> {
  const { tools, cwd } = input
  if (input.env === 'wsl') {
    const distro = input.distro ?? ''
    if (!isValidDistroName(distro)) throw new Error(`Invalid WSL distro name: ${distro}`)
    const wsl = checkedTool(tools.wsl, 'wsl.exe')
    switch (input.terminal) {
      case 'wt':
        return {
          command: checkedTool(tools.wt, 'Windows Terminal'),
          args: [wsl, '-d', distro, '--cd', cwd],
          verbatim: false
        }
      case 'powershell':
        return {
          command: checkedTool(tools.powershell, 'PowerShell'),
          args: [
            '-NoExit',
            '-Command',
            `& ${psQuote(wsl)} -d ${psQuote(distro)} --cd ${psQuote(cwd)}`
          ],
          verbatim: false
        }
      case 'cmd':
        return {
          command: checkedTool(tools.cmd, 'cmd.exe'),
          args: ['/s', '/k', `""${wsl}" -d ${distro} --cd "${cwd}""`],
          verbatim: true
        }
    }
  }
  switch (input.terminal) {
    case 'wt':
      // Windows Terminal's default profile, started in the folder.
      return {
        command: checkedTool(tools.wt, 'Windows Terminal'),
        args: ['-d', cwd],
        verbatim: false
      }
    case 'powershell':
      return {
        command: checkedTool(tools.powershell, 'PowerShell'),
        args: ['-NoExit', '-Command', `Set-Location -LiteralPath ${psQuote(cwd)}`],
        verbatim: false,
        spawnCwd: cwd
      }
    case 'cmd':
      // cmd starts in the folder, so the folder's name never reaches its parser.
      return {
        command: checkedTool(tools.cmd, 'cmd.exe'),
        args: ['/k'],
        verbatim: true,
        spawnCwd: cwd
      }
  }
}
