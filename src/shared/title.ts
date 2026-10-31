import type { SessionMeta, TitleSource } from './types'

export const TITLE_MAX = 80

/** Collapse whitespace and cut on a word boundary. */
export function truncate(text: string, max = TITLE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** The name given in Claude Code (read from the session file). */
export interface ClaudeName {
  name?: string
  /** When it was set, if known. */
  at?: string
}

function time(v: string | undefined): number | undefined {
  if (!v) return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

/**
 * Does the name given in Claude Code win over the one I set in the dashboard?
 * Only when it is known to be newer. A dashboard name without a time (set
 * before names had one) or a Claude Code rename without one keeps the
 * dashboard name.
 */
export function claudeNameIsNewer(meta: SessionMeta | undefined, claude: ClaudeName): boolean {
  const at = time(claude.at)
  const mine = time(meta?.nameAt)
  return at !== undefined && mine !== undefined && at > mine
}

/**
 * Title order:
 *  1. The newer of my dashboard name and the name given in Claude Code.
 *  2. Claude's automatic title (`summary` / `ai-title`).
 *  3. The first user message, cut short.
 *  4. "Untitled session".
 */
export function computeTitle(
  meta: SessionMeta | undefined,
  claude: ClaudeName | undefined,
  summary: string | undefined,
  firstPrompt: string | undefined
): { title: string; titleSource: TitleSource } {
  const mine = meta?.name?.trim()
  const theirs = claude?.name?.trim()
  if (mine && theirs) {
    // The same text either way (e.g. Remote Control named after my name): mine.
    if (mine !== theirs && claudeNameIsNewer(meta, claude!))
      return { title: theirs, titleSource: 'claude-name' }
    return { title: mine, titleSource: 'name' }
  }
  if (mine) return { title: mine, titleSource: 'name' }
  if (theirs) return { title: theirs, titleSource: 'claude-name' }
  const sum = summary?.trim()
  if (sum) return { title: sum, titleSource: 'summary' }
  const prompt = firstPrompt?.trim()
  if (prompt) return { title: truncate(prompt), titleSource: 'first-prompt' }
  return { title: 'Untitled session', titleSource: 'fallback' }
}

/** Where the title came from, for the name editor. */
export function titleSourceLabel(source: TitleSource): string {
  switch (source) {
    case 'name':
      return 'Set in dashboard'
    case 'claude-name':
      return 'From Claude Code'
    case 'summary':
      return "Auto · Claude's summary"
    case 'first-prompt':
      return 'Auto · first message'
    default:
      return 'Auto'
  }
}

/**
 * "Use name from Claude Code" applies: I set a name in the dashboard and
 * Claude Code has a different one.
 */
export function canUseClaudeName(s: {
  meta: SessionMeta
  claudeName?: string
  titleSource: TitleSource
}): boolean {
  return !!s.meta.name?.trim() && !!s.claudeName && s.titleSource === 'name'
}
