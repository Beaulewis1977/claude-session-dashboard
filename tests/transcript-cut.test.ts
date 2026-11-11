import { describe, expect, it } from 'vitest'
import {
  blockIdOf,
  CUT_CHARS,
  cutTranscript,
  matchesInCut,
  toolResultOf
} from '@shared/transcript-cut'
import type { ChatMessage } from '@shared/types'

const long = `${'line\n'.repeat(3000)}tail needle`
const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: 'hi' }] },
  {
    id: 'a1',
    role: 'assistant',
    kind: 'response',
    blocks: [
      { type: 'text', text: 'ok' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        label: 'Bash: x',
        input: {},
        result: { text: long, isError: false }
      },
      {
        type: 'tool_use',
        id: 't2',
        name: 'Bash',
        label: 'Bash: y',
        input: {},
        result: { text: 'short needle', isError: false }
      }
    ]
  },
  {
    id: 'u2',
    role: 'user',
    kind: 'prompt',
    blocks: [{ type: 'tool_result', toolUseId: 'tx', result: { text: long, isError: true } }]
  }
]

describe('cut transcripts', () => {
  it('cuts only long tool outputs, keeping their size, and leaves everything else as it is', () => {
    const cut = cutTranscript(messages)
    expect(cut[0]).toBe(messages[0])
    const t1 = cut[1].blocks[1]
    expect(t1.type === 'tool_use' && t1.result).toEqual({
      text: long.slice(0, CUT_CHARS),
      isError: false,
      cut: { chars: long.length, lines: 3001 }
    })
    expect(cut[1].blocks[2]).toBe(messages[1].blocks[2])
    const r = cut[2].blocks[0]
    expect(r.type === 'tool_result' && r.result.cut?.chars).toBe(long.length)
    expect(r.type === 'tool_result' && r.result.isError).toBe(true)
    // The original isn't changed.
    const o = messages[1].blocks[1]
    expect(o.type === 'tool_use' && o.result?.text).toBe(long)
  })

  it('gives a result back in full by its block id', () => {
    expect(toolResultOf(messages, 't1')?.text).toBe(long)
    expect(toolResultOf(messages, blockIdOf(messages[2], messages[2].blocks[0], 0))?.text).toBe(
      long
    )
    // A tool_result by its tool call id (a group's Copy asks that way).
    expect(toolResultOf(messages, 'tx')?.text).toBe(long)
    expect(toolResultOf(messages, 'nope')).toBeUndefined()
  })

  it('finds a query only in the part a cut leaves out', () => {
    expect(matchesInCut(messages, 'NEEDLE')).toEqual(['t1', 'u2:0'])
    // In the part that is sent: nothing to ask for.
    expect(matchesInCut(messages, 'line')).toEqual([])
    expect(matchesInCut(messages, '  ')).toEqual([])
  })
})
