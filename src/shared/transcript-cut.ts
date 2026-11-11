// A transcript for the viewer without the bulk of long tool outputs: the
// viewer shows at most 24 lines / 4,000 characters of a result until "Show
// all", so results longer than CUT_CHARS are sent cut, with their full size,
// and the full text is asked for when it's needed (Show all, Copy output, a
// find match in the hidden part). Nothing else changes.

import type { ChatMessage, ContentBlock, ToolResult } from './types'

/** Tool results longer than this are sent cut (well past what the viewer shows at first). */
export const CUT_CHARS = 8000

/** A block's id in the viewer: a tool call's own id, else message id and position. */
export function blockIdOf(m: Pick<ChatMessage, 'id'>, b: ContentBlock, i: number): string {
  return b.type === 'tool_use' ? b.id : `${m.id}:${i}`
}

function lineCount(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

function cutResult(r: ToolResult, max: number): ToolResult {
  if (r.text.length <= max) return r
  return {
    ...r,
    text: r.text.slice(0, max),
    cut: { chars: r.text.length, lines: lineCount(r.text) }
  }
}

/** The messages with long tool results cut (new objects only where something was cut). */
export function cutTranscript(messages: ChatMessage[], max = CUT_CHARS): ChatMessage[] {
  return messages.map((m) => {
    let blocks: ContentBlock[] | undefined
    m.blocks.forEach((b, i) => {
      const r = b.type === 'tool_use' ? b.result : b.type === 'tool_result' ? b.result : undefined
      if (!r || r.text.length <= max) return
      blocks ??= [...m.blocks]
      blocks[i] = { ...b, result: cutResult(r, max) } as ContentBlock
    })
    return blocks ? { ...m, blocks } : m
  })
}

/** A tool result, in full, by its block id (unique: never by an orphan's tool call id). */
export function toolResultOf(messages: ChatMessage[], id: string): ToolResult | undefined {
  for (const m of messages)
    for (let i = 0; i < m.blocks.length; i++) {
      const b = m.blocks[i]
      if ((b.type === 'tool_use' || b.type === 'tool_result') && blockIdOf(m, b, i) === id)
        return b.result
    }
  return undefined
}

/** Blocks whose result holds `query` only in the part a cut leaves out (case-insensitive). */
export function matchesInCut(messages: ChatMessage[], query: string, max = CUT_CHARS): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: string[] = []
  for (const m of messages)
    m.blocks.forEach((b, i) => {
      const r = b.type === 'tool_use' ? b.result : b.type === 'tool_result' ? b.result : undefined
      if (!r || r.text.length <= max) return
      const text = r.text.toLowerCase()
      // A match that starts before the cut ends past it: in the hidden part too.
      if (text.includes(q) && !text.slice(0, max).includes(q)) out.push(blockIdOf(m, b, i))
    })
  return out
}
