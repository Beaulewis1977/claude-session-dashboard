import { describe, expect, it } from 'vitest'
import { buildMessages, parseJsonl } from '@shared/jsonl'
import { blocksMatching, blocksOfMessages, groupTurns, truncateText } from '@/lib/transcript'
import type { ChatMessage } from '@shared/types'
import { SESSIONS, read } from './helpers'

describe('transcript helpers', () => {
  const messages = buildMessages(parseJsonl(read(SESSIONS.safari)).events)

  it('groups consecutive assistant messages into one turn', () => {
    const turns = groupTurns(messages)
    expect(turns.map((t) => t.kind)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('finds collapsed blocks that contain the find query', () => {
    const open = blocksMatching(messages, 'SAMESITE')
    expect(open.size).toBeGreaterThan(0)
    expect(blocksMatching(messages, '   ').size).toBe(0)
  })

  it('truncates long tool output by lines and characters', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const t = truncateText(long)
    expect(t.truncated).toBe(true)
    expect(t.totalLines).toBe(100)
    expect(t.text.split('\n')).toHaveLength(24)
    expect(truncateText('x'.repeat(10_000)).text).toHaveLength(4000)
    expect(truncateText('short').truncated).toBe(false)
  })
})

describe('opening what an Ask citation points at (review fix)', () => {
  const msgs: ChatMessage[] = [
    {
      id: 'a1',
      role: 'assistant',
      kind: 'response',
      blocks: [
        { type: 'thinking', text: 'secret thoughts' },
        { type: 'text', text: 'Running it' },
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'Bash',
          label: 'npm test',
          input: { command: 'npm test' }
        }
      ]
    },
    {
      id: 'a2',
      role: 'assistant',
      kind: 'response',
      blocks: [
        { type: 'tool_use', id: 'tu2', name: 'Read', label: 'a.ts', input: { file_path: 'a.ts' } }
      ]
    }
  ]

  it("opens only the cited messages' tool calls, never thinking", () => {
    expect([...blocksOfMessages(msgs, ['a1'])]).toEqual(['tu1'])
    expect([...blocksOfMessages(msgs, ['a1', 'a2'])].sort()).toEqual(['tu1', 'tu2'])
    expect(blocksOfMessages(msgs, []).size).toBe(0)
  })
})
