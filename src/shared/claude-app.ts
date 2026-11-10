// "Open in: Claude desktop app" for Claude Code sessions (desktop only).
//
// The Claude desktop app has no link that opens an existing session (its
// `claude://` routes only start new ones), but Claude Code itself can hand a
// session over: `claude --desktop --resume <id>` (2.1.285 and newer) opens the
// same session in the desktop app's Code tab and exits; `claude --resume`
// still finds it afterwards. Only for Windows sessions: the desktop app's
// session list covers this PC's own sessions, not WSL ones. Pure, so it can
// be tested; the launcher runs it (see services/claude-app.ts).

import { versionAtLeast } from './mobile'

export const CLAUDE_DESKTOP_MIN_VERSION = '2.1.285'

/**
 * `--fork-session` together with `--desktop` (checked on a real session before
 * it's offered; off until then).
 */
export const CLAUDE_APP_FORK = false

export interface ClaudeAppPreview {
  /** It can open there now. */
  available: boolean
  /** Why it can't (shown under the choice). */
  reason?: string
  /** The command the app runs (for display). */
  commandLine?: string
}

export interface ClaudeAppFacts {
  env: 'windows' | 'wsl'
  provider: string
  /** A view-only session (imported, Cowork). */
  viewOnly: boolean
  fork: boolean
  /** Branch / Continue fresh / a new session: not offered. */
  other: boolean
  /** The desktop app registered its `claude:` link handler. */
  installed: boolean
  /** Claude Code for Windows, as `claude --version` reports it. */
  version?: string
  /** Claude Code for Windows was found. */
  cliFound: boolean
}

/** Should the choice be shown at all? (Hidden where it could never work.) */
export function claudeAppOffered(
  f: Pick<ClaudeAppFacts, 'provider' | 'viewOnly' | 'other' | 'fork'>
): boolean {
  return f.provider === 'claude' && !f.viewOnly && !f.other && (!f.fork || CLAUDE_APP_FORK)
}

export function claudeAppPreview(
  f: ClaudeAppFacts,
  sessionId: string
): ClaudeAppPreview | undefined {
  if (!claudeAppOffered(f)) return undefined
  const no = (reason: string): ClaudeAppPreview => ({ available: false, reason })
  if (f.env !== 'windows')
    return no("The Claude desktop app opens this PC's Windows sessions only, not WSL ones.")
  if (!f.installed) return no("The Claude desktop app isn't installed on this PC.")
  if (!f.cliFound) return no("Claude Code for Windows wasn't found.")
  if (!versionAtLeast(f.version, CLAUDE_DESKTOP_MIN_VERSION))
    return no(
      `Needs Claude Code ${CLAUDE_DESKTOP_MIN_VERSION} or newer${f.version ? ` (this PC has ${f.version})` : ''}. Run claude update.`
    )
  return { available: true, commandLine: `claude ${claudeAppArgs(sessionId, f.fork).join(' ')}` }
}

/** The only arguments the app ever passes for it. */
export function claudeAppArgs(sessionId: string, fork: boolean): string[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
    throw new Error('Not a Claude Code session id')
  return [
    '--desktop',
    '--resume',
    sessionId,
    ...(fork && CLAUDE_APP_FORK ? ['--fork-session'] : [])
  ]
}
