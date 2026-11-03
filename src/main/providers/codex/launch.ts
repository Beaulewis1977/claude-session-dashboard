// Codex's own command for Resume and Fork, checked with `codex --help`,
// `codex resume --help` and `codex fork --help` (codex-cli 0.163 in WSL,
// 0.164 on Windows):
//   codex resume [OPTIONS] [SESSION_ID]   continue a session
//   codex fork   [OPTIONS] [SESSION_ID]   a new session with the same history
//   -m, --model <MODEL>
//   -c model_reasoning_effort=<level>     (a bare word is taken as a string)
//   -a, --ask-for-approval on-request     ask before running what the model decides needs it
//   -s, --sandbox workspace-write
//   --dangerously-bypass-approvals-and-sandbox
// The terminal starts in the session's folder (as for Claude Code), so no
// `--cd` is needed. Built as an argument array; nothing is ever joined into
// a shell string except for display (core/launch.ts).

import { codexModelArgs } from '@shared/model-choice'
import {
  agentCommandLine,
  buildAgentLaunch,
  isValidSessionId,
  type LaunchCommand,
  type LaunchInput
} from '../../core/launch'
import type { CliInput } from '../types'

export const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox'
/** Launches from a phone: Codex asks before it acts, in the workspace sandbox, whatever config.toml says. */
export const CODEX_ASK_ARGS = ['-a', 'on-request', '-s', 'workspace-write']

export interface CodexArgsInput {
  sessionId: string
  fork: boolean
  /** --dangerously-bypass-approvals-and-sandbox (never with askPermissions). */
  bypass: boolean
  askPermissions?: boolean
  modelChoice?: { model?: string; effort?: string }
}

export function codexArgs(i: CodexArgsInput): string[] {
  if (!isValidSessionId(i.sessionId)) throw new Error(`Invalid session id: ${i.sessionId}`)
  if (i.askPermissions && i.bypass)
    throw new Error("Can't both bypass approvals and ask before running commands.")
  return [
    i.fork ? 'fork' : 'resume',
    ...(i.askPermissions ? CODEX_ASK_ARGS : []),
    ...codexModelArgs(i.modelChoice?.model, i.modelChoice?.effort),
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
    | 'modelChoice'
    | 'newSession'
    | 'continueFresh'
    | 'remoteControl'
  >
): string[] {
  if (i.newSession)
    throw new Error('A new session in this folder is started from Claude Code only, for now.')
  if (i.continueFresh) throw new Error("Continue fresh isn't available for Codex sessions yet.")
  if (i.remoteControl) throw new Error("Remote Control isn't available for Codex sessions.")
  return codexArgs({
    sessionId: i.sessionId,
    fork: i.fork,
    bypass: i.skipPermissions && i.askPermissions !== true,
    askPermissions: i.askPermissions === true,
    modelChoice: i.modelChoice
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
    args: argsOf(input)
  })
}

export function codexCommandLine(i: CliInput): string {
  return agentCommandLine('codex', argsOf(i))
}
