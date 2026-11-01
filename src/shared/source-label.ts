// Which product ran a session: the terminal CLI, VS Code, JetBrains, the
// desktop app, the SDK / `claude -p`, or a cloud session teleported here.
//
// Signals, strongest first (checked against real transcripts):
// - `entrypoint` on each event (Claude Code 2.x): "cli", "sdk-cli" (claude -p),
//   "sdk-ts", "sdk-py", "claude-vscode", "claude-desktop", "local-agent",
//   "remote", "remote_mobile", "remote_desktop", … for cloud sessions.
// - A `remote_session_change` attachment (a claude.ai/code session link).
// - IDE attachments (`ide_opened_file`, `ide_selection`, …) and the IDE's name
//   in them, for the CLI running inside an IDE's terminal.
// - How the app launched it, then the environment and cwd.

import type { EnvKind } from './types'

export type SourceLabel =
  | 'terminal-windows'
  | 'terminal-wsl'
  | 'vscode'
  | 'jetbrains'
  | 'desktop'
  | 'sdk'
  | 'cloud'
  | 'unknown'
  | 'ask-claude'
  | 'claude-ai'

export const SOURCE_LABELS: Record<SourceLabel, string> = {
  'terminal-windows': 'Terminal (Windows)',
  'terminal-wsl': 'Terminal (WSL)',
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  desktop: 'Desktop (local)',
  sdk: 'SDK / claude -p',
  cloud: 'Cloud (teleported)',
  unknown: 'Local · unknown',
  'ask-claude': 'Ask Claude (dashboard)',
  'claude-ai': 'claude.ai'
}

/** Labels a person can pick by hand. */
export const MANUAL_LABELS: SourceLabel[] = [
  'terminal-windows',
  'terminal-wsl',
  'vscode',
  'jetbrains',
  'desktop',
  'sdk',
  'cloud',
  'unknown'
]

export function isSourceLabel(v: unknown): v is SourceLabel {
  return typeof v === 'string' && v in SOURCE_LABELS
}

/** Start of every prompt the dashboard's "Ask Claude" sends, so those runs can be recognised. */
export const ASK_MARKER = '[claude-session-dashboard:ask-claude]'
/** Start of every session summary prompt (summary.ts re-exports it). */
export const SUMMARY_PROMPT_MARKER = '[claude-session-dashboard:summary]'

export interface SourceHints {
  /** Distinct `entrypoint` values, in order of appearance (at most 6). */
  entrypoints: string[]
  /** A cloud session link or a remote entrypoint was seen. */
  remote: boolean
  /** IDE context (opened file, selection) was attached. */
  ide: boolean
  /** IDE family named in IDE context, when it says. */
  ideName?: 'vscode' | 'jetbrains'
}

const IDE_ATTACHMENT = /^(ide_|selected_lines_in_ide|opened_file_in_ide|queued_ide)/
const IDE_TAG = /<(ide_opened_file|ide_selection)[\s>]/
const JETBRAINS_RE =
  /\b(JetBrains|IntelliJ|PyCharm|WebStorm|GoLand|PhpStorm|RubyMine|CLion|Rider|DataGrip|Android Studio)\b/
const VSCODE_RE = /\b(VS ?Code|Visual Studio Code|Cursor|Windsurf|VSCodium)\b/

export function emptyHints(): SourceHints {
  return { entrypoints: [], remote: false, ide: false }
}

/** Collect source hints from one event (call for every event in order). */
export function addHints(h: SourceHints, e: Record<string, unknown>): void {
  const ep = e.entrypoint
  if (typeof ep === 'string' && ep && !h.entrypoints.includes(ep) && h.entrypoints.length < 6) {
    h.entrypoints.push(ep)
    if (ep.startsWith('remote')) h.remote = true
  }
  if (e.type === 'attachment') {
    const a = e.attachment as Record<string, unknown> | undefined
    const t = typeof a?.type === 'string' ? a.type : ''
    if (t === 'remote_session_change') h.remote = true
    if (IDE_ATTACHMENT.test(t)) {
      h.ide = true
      if (!h.ideName) {
        const text = JSON.stringify(a).slice(0, 4000)
        if (JETBRAINS_RE.test(text)) h.ideName = 'jetbrains'
        else if (VSCODE_RE.test(text)) h.ideName = 'vscode'
      }
    }
    return
  }
  if (e.type === 'user' && !h.ide) {
    const m = e.message as Record<string, unknown> | undefined
    const c = m?.content
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
          : ''
    if (IDE_TAG.test(text)) h.ide = true
  }
}

export interface SourceContext {
  env: EnvKind
  cwd?: string
  /** Linux user of a WSL source (cloud sessions run as "user" in /home/user). */
  sourceUser?: string
  firstPrompt?: string
  /** The app started it in a terminal (Resume / Fork / New session). */
  launchedByApp?: boolean
  imported?: boolean
}

export interface DetectedSource {
  label: SourceLabel
  /** Plain-English reason, shown in a tooltip. */
  reason: string
}

export function detectSource(h: SourceHints | undefined, ctx: SourceContext): DetectedSource {
  const terminal: SourceLabel = ctx.env === 'wsl' ? 'terminal-wsl' : 'terminal-windows'
  if (ctx.imported) return { label: 'claude-ai', reason: 'Imported from a claude.ai data export' }
  if (ctx.firstPrompt?.startsWith(ASK_MARKER))
    return { label: 'ask-claude', reason: "Started by the dashboard's Ask Claude" }
  // Summaries run with --no-session-persistence; one that is saved anyway is hidden the same way.
  if (ctx.firstPrompt?.startsWith(SUMMARY_PROMPT_MARKER))
    return { label: 'ask-claude', reason: "Started by the dashboard's session summaries" }
  const eps = h?.entrypoints ?? []
  if (h?.remote)
    return {
      label: 'cloud',
      reason: eps.some((e) => e.startsWith('remote'))
        ? `Ran in a cloud session (entrypoint "${eps.find((e) => e.startsWith('remote'))}")`
        : 'Linked to a claude.ai/code cloud session'
    }
  const has = (...names: string[]): string | undefined => eps.find((e) => names.includes(e))
  let ep: string | undefined
  if ((ep = has('claude-vscode'))) return { label: 'vscode', reason: `entrypoint "${ep}"` }
  if ((ep = has('claude-desktop', 'claude-desktop-3p', 'local-agent', 'local_agent')))
    return { label: 'desktop', reason: `entrypoint "${ep}"` }
  if ((ep = has('sdk-cli', 'sdk-ts', 'sdk-py')))
    return { label: 'sdk', reason: `entrypoint "${ep}"` }
  if (has('cli')) {
    if (h?.ideName === 'jetbrains')
      return { label: 'jetbrains', reason: 'CLI with JetBrains IDE context attached' }
    if (h?.ideName === 'vscode')
      return { label: 'vscode', reason: 'CLI with VS Code context attached' }
    return {
      label: terminal,
      reason: h?.ide
        ? 'entrypoint "cli", connected to an IDE (which one isn\'t recorded)'
        : 'entrypoint "cli"'
    }
  }
  if (eps.length) return { label: 'unknown', reason: `Unrecognised entrypoint "${eps[0]}"` }
  // Older Claude Code versions don't record an entrypoint.
  if (ctx.cwd && /^\/home\/user(\/|$)/.test(ctx.cwd) && ctx.sourceUser && ctx.sourceUser !== 'user')
    return { label: 'cloud', reason: 'Working folder /home/user/… is where cloud sessions run' }
  if (ctx.launchedByApp) return { label: terminal, reason: 'Launched from this app in a terminal' }
  if (h?.ide) return { label: 'unknown', reason: 'IDE context attached, no entrypoint recorded' }
  return {
    label: 'unknown',
    reason: 'No entrypoint recorded (older Claude Code version)'
  }
}
