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

/**
 * Title fallback: my name → Claude's summary → first user message (cut short)
 * → "Untitled session".
 */
export function computeTitle(
  meta: SessionMeta | undefined,
  summary: string | undefined,
  firstPrompt: string | undefined
): { title: string; titleSource: TitleSource } {
  const name = meta?.name?.trim()
  if (name) return { title: name, titleSource: 'name' }
  const sum = summary?.trim()
  if (sum) return { title: sum, titleSource: 'summary' }
  const prompt = firstPrompt?.trim()
  if (prompt) return { title: truncate(prompt), titleSource: 'first-prompt' }
  return { title: 'Untitled session', titleSource: 'fallback' }
}
