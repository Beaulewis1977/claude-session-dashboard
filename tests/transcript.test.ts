import { describe, expect, it } from 'vitest'
import { buildMessages, parseJsonl } from '@shared/jsonl'
import { blocksMatching, groupTurns, truncateText } from '@/lib/transcript'
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
