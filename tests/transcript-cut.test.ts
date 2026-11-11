import { describe, expect, it } from 'vitest'
import {
  blockIdOf,
  CUT,
  cutForViewer,
  cutInput,
  LAZY,
  cutTranscript,
  matchesInCut,
  previewText,
  toolInputOf,
  toolResultOf
} from '@shared/transcript-cut'
import type { ChatMessage } from '@shared/types'
import { truncateText } from '../src/renderer/src/lib/transcript'

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
      // What the viewer shows before Show all: its first 24 lines.
      text: truncateText(long).text,
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
    // Never by an orphan result's tool call id (it can be empty or shared).
    expect(toolResultOf(messages, 'tx')).toBeUndefined()
    expect(toolResultOf(messages, 'nope')).toBeUndefined()
  })

  it('sends a short output whole, and a long one only past what it shows', () => {
    const r = (text: string): ChatMessage => ({
      id: 'x',
      role: 'assistant',
      kind: 'response',
      blocks: [
        {
          type: 'tool_use',
          id: 'x',
          name: 'Bash',
          label: 'Bash',
          input: {},
          result: { text, isError: false }
        }
      ]
    })
    // 40 short lines: under the minimum, sent whole (the viewer cuts it itself).
    const short = 'ab\n'.repeat(40)
    const s0 = cutTranscript([r(short)])[0].blocks[0]
    expect(s0.type === 'tool_use' && s0.result?.cut).toBeUndefined()
    // One long line: its first 4,000 characters.
    const wide = 'x'.repeat(10_000)
    const s1 = cutTranscript([r(wide)])[0].blocks[0]
    expect(s1.type === 'tool_use' && s1.result).toEqual({
      text: 'x'.repeat(4000),
      isError: false,
      cut: { chars: 10_000, lines: 1 }
    })
  })

  it('previews text exactly as the viewer does', () => {
    let seed = 5
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let i = 0; i < 2000; i++) {
      const text = Array.from({ length: rnd(60) }, () => 'y'.repeat(rnd(400))).join('\n')
      const lines = 1 + rnd(40)
      const chars = 1 + rnd(6000)
      expect(previewText(text, lines, chars)).toBe(truncateText(text, lines, chars).text)
    }
  })

  it('finds a query only in the part a cut leaves out', () => {
    expect(matchesInCut(messages, 'NEEDLE')).toEqual(['t1', 'u2:0'])
    // In the part that is sent: nothing to ask for.
    expect(matchesInCut(messages, 'line')).toEqual([])
    expect(matchesInCut(messages, '  ')).toEqual([])
  })
})

describe('cut tool inputs', () => {
  const file = `${'const x = 1\n'.repeat(1000)}// input needle`
  const patch = `*** Begin Patch\n${'+added line\n'.repeat(800)}*** End Patch`
  const edits = [
    { old_string: 'a', new_string: file },
    { old_string: file, new_string: 'b' }
  ]
  const tools: ChatMessage[] = [
    {
      id: 'a1',
      role: 'assistant',
      kind: 'response',
      blocks: [
        {
          type: 'tool_use',
          id: 'w1',
          name: 'Write',
          label: 'Write a.ts',
          input: { file_path: '/p/a.ts', content: file }
        },
        { type: 'tool_use', id: 'p1', name: 'apply_patch', label: 'Patch', input: patch },
        {
          type: 'tool_use',
          id: 'm1',
          name: 'MultiEdit',
          label: 'MultiEdit a.ts',
          input: { file_path: '/p/a.ts', edits }
        },
        {
          type: 'tool_use',
          id: 's1',
          name: 'Bash',
          label: 'Bash: ls',
          input: { command: 'ls', n: 3, ok: true, none: null }
        },
        {
          type: 'tool_use',
          id: 'r1',
          name: 'Bash',
          label: 'Bash: cat',
          input: { command: 'cat' },
          result: { text: `${'x'.repeat(CUT.outChars)} result needle`, isError: false }
        }
      ]
    }
  ]

  /** Puts the full strings back where the cuts say they were. */
  const restore = (cut: unknown, full: unknown, paths: (string | number)[][]): unknown => {
    if (!paths.length) return cut
    const at = (v: unknown, p: (string | number)[]) =>
      p.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], v)
    if (paths.some((p) => !p.length)) return full
    const out = structuredClone(cut) as Record<string, unknown>
    for (const p of paths) {
      const parent = at(out, p.slice(0, -1)) as Record<string | number, unknown>
      parent[p[p.length - 1]] = at(full, p)
    }
    return out
  }

  it('cuts every long string of an input, records where and how long it was, and keeps the rest', () => {
    const cut = cutTranscript(tools)
    const [w, p, m, sh, r] = cut[0].blocks
    // Its first 60 lines (what the viewer shows of a file being written).
    expect(w.type === 'tool_use' && w.input).toEqual({
      file_path: '/p/a.ts',
      content: truncateText(file, CUT.inLines, CUT.inChars).text
    })
    expect(w.type === 'tool_use' && w.inputCut).toEqual([
      { path: ['content'], chars: file.length, lines: 1001 }
    ])
    // The input itself is the string.
    expect(p.type === 'tool_use' && p.input).toBe(
      truncateText(patch, CUT.inLines, CUT.inChars).text
    )
    expect(p.type === 'tool_use' && p.inputCut).toEqual([
      { path: [], chars: patch.length, lines: 802 }
    ])
    // Nested in an array, in order; keys keep their order.
    expect(m.type === 'tool_use' && m.inputCut?.map((c) => c.path)).toEqual([
      ['edits', 0, 'new_string'],
      ['edits', 1, 'old_string']
    ])
    expect(m.type === 'tool_use' && JSON.stringify(m.input).indexOf('"file_path"')).toBe(1)
    // Nothing long: the same block.
    expect(sh).toBe(tools[0].blocks[3])
    // A long result alone: the input is left as it is.
    expect(r.type === 'tool_use' && r.inputCut).toBeUndefined()
    expect(r.type === 'tool_use' && r.result?.cut).toBeDefined()
    // The original isn't changed.
    const o = tools[0].blocks[0]
    expect(o.type === 'tool_use' && (o.input as { content: string }).content).toBe(file)
  })

  it('round-trips: the full input asked for by id, put back where the cuts were, is the original', () => {
    const cut = cutTranscript(tools)
    cut[0].blocks.forEach((b, i) => {
      if (b.type !== 'tool_use') return
      const orig = tools[0].blocks[i]
      if (orig.type !== 'tool_use') return
      const full = toolInputOf(tools, b.id)
      expect(full).toEqual({ input: orig.input })
      expect(
        restore(
          b.input,
          full!.input,
          (b.inputCut ?? []).map((c) => c.path)
        )
      ).toEqual(orig.input)
    })
    expect(toolInputOf(tools, 'nope')).toBeUndefined()
    expect(cutInput({ a: 'short', b: [1, 'x'] })).toBeUndefined()
  })

  it('never splits a surrogate pair', () => {
    const s = `${'a'.repeat(CUT.inChars - 1)}😀${'b'.repeat(10)}`
    const c = cutInput({ s })!
    expect((c.input as { s: string }).s).toBe('a'.repeat(CUT.inChars - 1))
    expect(c.cuts[0].chars).toBe(s.length)
  })

  it('finds a query that is only past an input cut (as find sees an input: its JSON)', () => {
    expect(matchesInCut(tools, 'INPUT NEEDLE')).toEqual(['w1', 'm1'])
    expect(matchesInCut(tools, 'result needle')).toEqual(['r1'])
    // In what is sent: nothing to ask for.
    expect(matchesInCut(tools, 'const x')).toEqual([])
    expect(matchesInCut(tools, 'begin patch')).toEqual([])
  })
})

describe('very long transcripts', () => {
  const big = `${'row of output\n'.repeat(400)}deep needle`
  const msgs: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
    id: `a${i}`,
    role: 'assistant' as const,
    kind: 'response' as const,
    blocks: [
      {
        type: 'tool_use' as const,
        id: `t${i}`,
        name: 'Write',
        label: 'Write f.ts',
        input: { file_path: 'f.ts', content: big },
        result: { text: big, isError: false }
      }
    ]
  }))

  it('are cut as usual up to the limit, and get placeholders past it', () => {
    const usual = cutForViewer(msgs)
    expect(usual.limits).toBe(CUT)
    const b = usual.messages[0].blocks[0]
    expect(b.type === 'tool_use' && b.result?.cut?.lazy).toBeUndefined()
    expect(b.type === 'tool_use' && b.inputLazy).toBeUndefined()

    const lazy = cutForViewer(msgs, 10_000)
    expect(lazy.limits).toBe(LAZY)
    const l = lazy.messages[0].blocks[0]
    expect(l.type === 'tool_use' && l.result).toEqual({
      text: 'row of output',
      isError: false,
      cut: { chars: big.length, lines: 401, lazy: true }
    })
    expect(l.type === 'tool_use' && l.inputLazy).toBe(true)
    expect(l.type === 'tool_use' && (l.input as { content: string }).content).toBe('row of output')
    // The full text is there as usual.
    expect(toolResultOf(msgs, 't0')?.text).toBe(big)
    expect(toolInputOf(msgs, 't0')).toEqual({
      input: msgs[0].blocks[0].type === 'tool_use' && msgs[0].blocks[0].input
    })
  })

  it('find looks past the same cut the viewer got', () => {
    // Shown in the usual preview, but past a placeholder.
    expect(matchesInCut(msgs, 'row of output\nrow', CUT)).toEqual([])
    expect(matchesInCut(msgs, 'output\nrow', LAZY)).toHaveLength(30)
    expect(matchesInCut(msgs, 'deep needle', LAZY)).toHaveLength(30)
  })
})
