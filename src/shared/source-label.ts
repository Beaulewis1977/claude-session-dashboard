// Which product ran a session: the terminal CLI, VS Code, JetBrains, the
// desktop app, the SDK / `claude -p`, or a cloud session teleported here.
//
// Signals, strongest first (checked against real transcripts):
// - `entrypoint` on each event (Claude Code 2.x): "cli", "sdk-cli" (claude -p),
//   "sdk-ts", "sdk-py", "claude-vscode", "claude-desktop", "local-agent",
//   "remote", "remote_mobile", "remote_desktop", … for cloud sessions.
// - A `remote_session_change` attachment with a claude.ai/code link, in a
//   session that never had Remote Control. Claude Code writes this attachment
//   into ordinary local sessions too (with `url: null`), and Remote Control
//   puts its own link there: neither makes a local session a cloud one.
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
  | 'cowork'
  | 'sdk'
  | 'cloud'
  | 'unknown'
  | 'ask-claude'
  | 'claude-ai'
  | CodexSourceLabel

/** Which Codex product ran a session (see providers/codex/source.ts). */
export type CodexSourceLabel =
  | 'codex-cli'
  | 'codex-vscode'
  | 'codex-desktop'
  | 'codex-exec'
  | 'codex-subagent'
  | 'codex-claude-code'
  | 'codex-unknown'

export const SOURCE_LABELS: Record<SourceLabel, string> = {
  'terminal-windows': 'Terminal (Windows)',
  'terminal-wsl': 'Terminal (WSL)',
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  desktop: 'Claude desktop',
  cowork: 'Claude desktop (Cowork)',
  sdk: 'SDK / claude -p',
  cloud: 'Cloud (teleported)',
  unknown: 'Local · unknown',
  'ask-claude': 'Ask Claude (dashboard)',
  'claude-ai': 'claude.ai',
  'codex-cli': 'Codex CLI',
  'codex-vscode': 'Codex · VS Code',
  'codex-desktop': 'Codex desktop app',
  'codex-exec': 'Codex exec',
  'codex-subagent': 'Codex subagent',
  'codex-claude-code': 'Codex · from Claude Code',
  'codex-unknown': 'Codex · unknown'
}

/** Labels a person can pick by hand. */
export const MANUAL_LABELS: SourceLabel[] = [
  'terminal-windows',
  'terminal-wsl',
  'vscode',
  'jetbrains',
  'desktop',
  'cowork',
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
  /** A remote entrypoint was seen (the session ran in the cloud). */
  remote: boolean
  /** A `remote_session_change` attachment carried a claude.ai/code link. */
  cloudLink?: boolean
  /** Remote Control was on at some point (a `bridge_status` entry): links are its own. */
  bridge?: boolean
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
    if (
      t === 'remote_session_change' &&
      typeof a?.url === 'string' &&
      /^https:\/\/claude\.ai\/code\//.test(a.url)
    )
      h.cloudLink = true
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
  if (e.type === 'system' && e.subtype === 'bridge_status') h.bridge = true
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
  /** The Claude desktop app's Code tab lists it (its own session index names this session). */
  desktopIndexed?: boolean
  /** From the optional Claude desktop (Cowork) source. */
  cowork?: boolean
}

/** Entrypoints the dashboard's own `claude -p` runs (Ask Claude, summaries) can have. */
const OWN_RUN_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py'])

/**
 * Could this be one of the dashboard's own runs (hidden as "Ask Claude")? Only a
 * `claude -p` run whose first prompt starts with the app's marker, never a
 * session the Claude desktop app or a terminal ran (those are real sessions).
 */
export function couldBeOwnRun(h: SourceHints | undefined, ctx: SourceContext): boolean {
  if (ctx.desktopIndexed || ctx.cowork || ranInCloud(h) || h?.ide) return false
  return (h?.entrypoints ?? []).every((e) => OWN_RUN_ENTRYPOINTS.has(e))
}

export interface DetectedSource {
  label: SourceLabel
  /** Plain-English reason, shown in a tooltip. */
  reason: string
}

/** It ran in a cloud session (teleported here): a remote entrypoint, or a cloud link without Remote Control. */
export function ranInCloud(h: SourceHints | undefined): boolean {
  return !!h && (h.remote || (!!h.cloudLink && !h.bridge))
}

export function detectSource(h: SourceHints | undefined, ctx: SourceContext): DetectedSource {
  const terminal: SourceLabel = ctx.env === 'wsl' ? 'terminal-wsl' : 'terminal-windows'
  if (ctx.imported) return { label: 'claude-ai', reason: 'Imported from a claude.ai data export' }
  if (ctx.cowork)
    return { label: 'cowork', reason: 'From the Claude desktop app’s Cowork sessions folder' }
  const own = couldBeOwnRun(h, ctx)
  if (own && ctx.firstPrompt?.startsWith(ASK_MARKER))
    return { label: 'ask-claude', reason: "Started by the dashboard's Ask Claude" }
  // Summaries run with --no-session-persistence; one that is saved anyway is hidden the same way.
  if (own && ctx.firstPrompt?.startsWith(SUMMARY_PROMPT_MARKER))
    return { label: 'ask-claude', reason: "Started by the dashboard's session summaries" }
  const eps = h?.entrypoints ?? []
  // The desktop app's Code tab can run sessions through the SDK (entrypoint "sdk-cli"):
  // its own session index says which ones are its.
  if (ctx.desktopIndexed && !ranInCloud(h))
    return { label: 'desktop', reason: 'Listed in the Claude desktop app’s Code tab' }
  if (ranInCloud(h))
    return {
      label: 'cloud',
      reason: eps.some((e) => e.startsWith('remote'))
        ? `Ran in a cloud session (entrypoint "${eps.find((e) => e.startsWith('remote'))}")`
        : 'Linked to a claude.ai/code cloud session'
    }
  const has = (...names: string[]): string | undefined => eps.find((e) => names.includes(e))
  let ep: string | undefined
  if ((ep = has('claude-vscode'))) return { label: 'vscode', reason: `entrypoint "${ep}"` }
  if ((ep = has('claude-desktop', 'claude-desktop-3p')))
    return { label: 'desktop', reason: `entrypoint "${ep}"` }
  if ((ep = has('local-agent', 'local_agent')))
    return { label: 'cowork', reason: `entrypoint "${ep}" (Claude desktop Cowork)` }
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
