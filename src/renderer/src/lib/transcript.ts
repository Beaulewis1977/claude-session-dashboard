// Pure helpers for rendering a transcript.

import type { ChatMessage, ContentBlock } from '@shared/types'

export type Turn =
  | { kind: 'user'; id: string; msg: ChatMessage }
  | { kind: 'assistant'; id: string; msgs: ChatMessage[] }
  | { kind: 'event'; id: string; msg: ChatMessage }

export function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const last = turns[turns.length - 1]
      if (last?.kind === 'assistant') last.msgs.push(m)
      else turns.push({ kind: 'assistant', id: m.id, msgs: [m] })
    } else if (m.role === 'user' && m.kind === 'prompt') {
      // A user message made only of orphan tool results belongs to the assistant flow.
      if (m.blocks.every((b) => b.type === 'tool_result')) {
        const last = turns[turns.length - 1]
        if (last?.kind === 'assistant') {
          last.msgs.push(m)
          continue
        }
      }
      turns.push({ kind: 'user', id: m.id, msg: m })
    } else {
      turns.push({ kind: 'event', id: m.id, msg: m })
    }
  }
  return turns
}

export function turnTime(t: Turn): string | undefined {
  return t.kind === 'assistant' ? t.msgs[0].timestamp : t.msg.timestamp
}

export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

/** A block's text as find sees it (tool calls: label, input and output). */
export function searchText(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
    case 'thinking':
      return b.text
    case 'tool_use':
      return `${b.label}\n${JSON.stringify(b.input)}\n${b.result?.text ?? ''}`
    case 'tool_result':
      return b.result.text
    case 'agent_message':
      return `${b.author} → ${b.recipient}\n${b.text}`
    default:
      return ''
  }
}

/** Ids of collapsible blocks whose content matches the find query. */
export function blocksMatching(messages: ChatMessage[], query: string): Set<string> {
  const out = new Set<string>()
  const q = query.trim().toLowerCase()
  if (!q) return out
  for (const m of messages) {
    m.blocks.forEach((b, i) => {
      if (
        (b.type === 'tool_use' ||
          b.type === 'thinking' ||
          b.type === 'tool_result' ||
          b.type === 'agent_message') &&
        searchText(b).toLowerCase().includes(q)
      ) {
        out.add(blockId(m, b, i))
      }
    })
    if (
      m.kind === 'compact' &&
      searchText(m.blocks[0] ?? { type: 'text', text: '' })
        .toLowerCase()
        .includes(q)
    )
      out.add(m.id)
  }
  return out
}

/**
 * Ids of the collapsible blocks of the messages an Ask citation points at
 * (their tool calls, agent messages and results; never thinking), and of a
 * cited compaction summary, so what was cited is open when it's shown.
 */
export function blocksOfMessages(messages: ChatMessage[], ids: readonly string[]): Set<string> {
  const out = new Set<string>()
  if (!ids.length) return out
  const want = new Set(ids)
  for (const m of messages) {
    if (!want.has(m.id)) continue
    m.blocks.forEach((b, i) => {
      if (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'agent_message')
        out.add(blockId(m, b, i))
    })
    if (m.kind === 'compact') out.add(m.id)
  }
  return out
}

export function blockId(m: ChatMessage, b: ContentBlock, i: number): string {
  return b.type === 'tool_use' ? b.id : `${m.id}:${i}`
}

const RESULT_LINES = 24
const RESULT_CHARS = 4000

export function truncateText(text: string, maxLines = RESULT_LINES, maxChars = RESULT_CHARS) {
  const lines = text.split('\n')
  let out = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text
  if (out.length > maxChars) out = out.slice(0, maxChars)
  return { text: out, truncated: out.length < text.length, totalLines: lines.length }
}
