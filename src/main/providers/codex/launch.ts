// Codex's own command for Resume and Fork, checked with `codex --help`,
// `codex resume --help` and `codex fork --help` (codex-cli 0.163 in WSL,
// 0.164 on Windows):
//   codex resume [OPTIONS] [SESSION_ID]   continue a session
//   codex fork   [OPTIONS] [SESSION_ID]   a new session with the same history
//   -m, --model <MODEL>
//   -c model_reasoning_effort=<level>     (a bare word is taken as a string)
//   -c service_tier=fast                  fast mode (no flag of its own, 0.166)
//   -a, --ask-for-approval on-request     the model decides when to ask (0.166 has only
//                                         on-request and never: nothing asks for every command)
//   -s, --sandbox workspace-write | read-only
//   --dangerously-bypass-approvals-and-sandbox
//   -C, --cd <DIR>                        the folder to work in (see passCwd)
// The terminal starts in the session's folder (as for Claude Code). Built as an
// argument array; nothing is ever joined into a shell string except for
// display (core/launch.ts).

import { codexModelArgs } from '@shared/model-choice'
import {
  agentCommandLine,
  buildAgentLaunch,
  isSafeContinueArg,
  isValidSessionId,
  type LaunchCommand,
  type LaunchInput
} from '../../core/launch'
import type { CliInput } from '../types'

export const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox'
/**
 * Launches from a phone: approval on request (the model decides when to ask) and the
 * workspace sandbox, whatever config.toml says; never the bypass.
 */
export const CODEX_ASK_ARGS = ['-a', 'on-request', '-s', 'workspace-write']
/**
 * A WSL-only folder run with Windows Codex: the read-only sandbox, so a command can only
 * read unless it's approved (Codex asks when a command needs more). Codex has no policy
 * that asks before every command.
 */
export const CODEX_READONLY_ARGS = ['-a', 'on-request', '-s', 'read-only']

export interface CodexArgsInput {
  sessionId: string
  fork: boolean
  /** --dangerously-bypass-approvals-and-sandbox (never with askPermissions). */
  bypass: boolean
  askPermissions?: boolean
  /** With askPermissions: the read-only sandbox instead of workspace-write. */
  readOnly?: boolean
  modelChoice?: { model?: string; effort?: string; fast?: boolean }
  /**
   * `-C <dir>`: the folder, given to Codex explicitly. For a session whose recorded
   * folder was translated (`/mnt/c/x` run as `C:\x`): without it Codex asks which
   * folder to use, offering its own (wrong) conversion of the recorded one.
   */
  cd?: string
}

/**
 * Continue fresh: a new interactive session (`codex [OPTIONS] [PROMPT]`)
 * whose first message asks Codex to read the handoff file. The summary itself
 * is in the file, never on the command line. Codex picks the new session's
 * id; `newSessionId` is only the handoff's. No --add-dir: Codex's sandbox can
 * read the app's data folder (it limits writes), and --add-dir would make the
 * folder writable.
 */
export interface CodexContinueInput {
  prompt: string
  bypass: boolean
  askPermissions?: boolean
  readOnly?: boolean
  modelChoice?: { model?: string; effort?: string; fast?: boolean }
  cd?: string
}

export function codexContinueArgs(i: CodexContinueInput): string[] {
  if (i.askPermissions && i.bypass)
    throw new Error("Can't both bypass approvals and ask before running commands.")
  // It reaches cmd, PowerShell, Windows Terminal and bash: the same characters as Claude Code's.
  if (!isSafeContinueArg(i.prompt))
    throw new Error("The handoff file's location can't be passed to Codex safely.")
  checkCd(i.cd)
  return [
    ...(i.cd ? ['-C', i.cd] : []),
    ...(i.askPermissions ? (i.readOnly ? CODEX_READONLY_ARGS : CODEX_ASK_ARGS) : []),
    ...codexModelArgs(i.modelChoice?.model, i.modelChoice?.effort, i.modelChoice?.fast === true),
    ...(i.bypass ? [CODEX_BYPASS_FLAG] : []),
    // The prompt last, after every option ("--" isn't needed: it never starts with "-").
    i.prompt
  ]
}

function checkCd(cd: string | undefined): void {
  // eslint-disable-next-line no-control-regex
  if (cd !== undefined && (!cd || /[\u0000-\u001f]/.test(cd) || cd.startsWith('-')))
    throw new Error(`This folder can't be passed to Codex: ${cd}`)
}

export function codexArgs(i: CodexArgsInput): string[] {
  if (!isValidSessionId(i.sessionId)) throw new Error(`Invalid session id: ${i.sessionId}`)
  if (i.askPermissions && i.bypass)
    throw new Error("Can't both bypass approvals and ask before running commands.")
  checkCd(i.cd)
  return [
    i.fork ? 'fork' : 'resume',
    ...(i.cd ? ['-C', i.cd] : []),
    ...(i.askPermissions ? (i.readOnly ? CODEX_READONLY_ARGS : CODEX_ASK_ARGS) : []),
    ...codexModelArgs(i.modelChoice?.model, i.modelChoice?.effort, i.modelChoice?.fast === true),
    ...(i.bypass ? [CODEX_BYPASS_FLAG] : []),
    i.sessionId
  ]
}

function argsOf(
  i: Pick<
    CliInput,
    | 'sessionId'
    | 'fork'
    | 'skipPermissions'
    | 'askPermissions'
    | 'readOnly'
    | 'modelChoice'
    | 'newSession'
    | 'continueFresh'
    | 'remoteControl'
  >,
  cd?: string
): string[] {
  if (i.newSession)
    throw new Error('A new session in this folder is started from Claude Code only, for now.')
  if (i.remoteControl) throw new Error("Remote Control isn't available for Codex sessions.")
  if (i.continueFresh)
    return codexContinueArgs({
      prompt: i.continueFresh.prompt,
      bypass: i.skipPermissions && i.askPermissions !== true,
      askPermissions: i.askPermissions === true,
      ...(i.readOnly ? { readOnly: true } : {}),
      modelChoice: i.modelChoice,
      ...(cd ? { cd } : {})
    })
  return codexArgs({
    sessionId: i.sessionId,
    fork: i.fork,
    bypass: i.skipPermissions && i.askPermissions !== true,
    askPermissions: i.askPermissions === true,
    ...(i.readOnly ? { readOnly: true } : {}),
    modelChoice: i.modelChoice,
    ...(cd ? { cd } : {})
  })
}

export function buildCodexLaunch(input: LaunchInput): LaunchCommand {
  if (input.apiKey) throw new Error("Codex sessions can't be launched on an API account from here.")
  return buildAgentLaunch(input, {
    product: 'Codex',
    // WSL: the real binary, never a shell function or alias of the same name. A
    // `codex()` wrapper in ~/.bashrc that sets its own CODEX_HOME would otherwise
    // replace the one given here and look in the wrong home.
    bin: input.env === 'wsl' ? 'command codex' : 'codex',
    program: input.tools.codex,
    args: argsOf(input, input.passCwd ? input.cwd : undefined)
  })
}

export function codexCommandLine(i: CliInput): string {
  return agentCommandLine('codex', argsOf(i))
}
