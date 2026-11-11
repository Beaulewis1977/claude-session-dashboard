// A transcript for the viewer without the bulk of long tool outputs and
// inputs. A tool output is sent as what the viewer shows of it before "Show
// all" (its first lines), with its full size. Long strings in a tool call's
// input (a written file, an edit's old and new text, a patch) are sent cut
// the same way, each with its place in the input and its full size. The full
// text is asked for when it's needed (Show all / Show full, Copy, a find
// match in the hidden part). Nothing else changes.
// (Type-only imports: the perf harness runs this file as it is.)

import type { ChatMessage, ContentBlock, InputCut, ToolResult } from './types'

export interface CutLimits {
  /** A tool output longer than outMin characters is sent as its first outLines lines / outChars characters. */
  outLines: number
  outChars: number
  outMin: number
  /** A string in a tool call's input longer than inMin characters is sent as its first inLines lines / inChars characters. */
  inLines: number
  inChars: number
  inMin: number
}

/**
 * Outputs: what the viewer shows before Show all (truncateText's 24 lines /
 * 4,000 characters), so a cut output looks the same until it's opened.
 * Inputs: what the viewer shows of a file being written before Show full.
 */
export const CUT: CutLimits = {
  outLines: 24,
  outChars: 4000,
  outMin: 2000,
  inLines: 60,
  inChars: 6000,
  inMin: 2000
}

/**
 * A very long transcript (its tool bodies over LAZY_FROM characters even cut
 * as above) is sent with one-line placeholders instead: the viewer loads a
 * tool call's output and input when it's opened, and draws them as usual.
 */
export const LAZY: CutLimits = {
  outLines: 1,
  outChars: 120,
  outMin: 120,
  inLines: 1,
  inChars: 120,
  inMin: 120
}
export const LAZY_FROM = 3_000_000

type ToolUse = Extract<ContentBlock, { type: 'tool_use' }>

/** A block's id in the viewer: a tool call's own id, else message id and position. */
export function blockIdOf(m: Pick<ChatMessage, 'id'>, b: ContentBlock, i: number): string {
  return b.type === 'tool_use' ? b.id : `${m.id}:${i}`
}

function lineCount(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/**
 * The text's first `lines` lines, then at most `chars` characters of them:
 * exactly the viewer's truncateText(text, lines, chars).text (without
 * splitting the whole text into lines).
 */
export function previewText(text: string, lines: number, chars: number): string {
  let end = -1
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1))
    if (++n === lines) {
      end = i
      break
    }
  const out = end === -1 ? text : text.slice(0, end)
  return out.length > chars ? out.slice(0, chars) : out
}

/** Where to cut a string at most `max` long without splitting a surrogate pair. */
function cutAt(text: string, max: number): number {
  if (text.length <= max) return text.length
  const c = text.charCodeAt(max - 1)
  return c >= 0xd800 && c <= 0xdbff ? max - 1 : max
}

/** A tool output as it's sent: whole, or its preview with its full size. */
function cutResult(r: ToolResult, limits: CutLimits, lazy = false): ToolResult {
  if (r.text.length <= limits.outMin) return r
  const text = previewText(r.text, limits.outLines, limits.outChars)
  if (text.length === r.text.length) return r
  const cut = { chars: r.text.length, lines: lineCount(r.text) }
  return { ...r, text, cut: lazy ? { ...cut, lazy: true } : cut }
}

/** A string of an input as it's sent (its first lines, never half a surrogate pair). */
function cutString(v: string, limits: CutLimits): string {
  if (v.length <= limits.inMin) return v
  const head = previewText(v, limits.inLines, v.length)
  return head.slice(0, cutAt(head, limits.inChars))
}

/**
 * A value with every long string cut (new objects only along the way to a
 * cut; keys keep their order). Pushes one entry per cut.
 */
function cutStrings(
  v: unknown,
  limits: CutLimits,
  path: (string | number)[],
  cuts: InputCut[]
): unknown {
  if (typeof v === 'string') {
    const out = cutString(v, limits)
    if (out.length === v.length) return v
    cuts.push({ path: [...path], chars: v.length, lines: lineCount(v) })
    return out
  }
  if (Array.isArray(v)) {
    let out: unknown[] | undefined
    for (let i = 0; i < v.length; i++) {
      path.push(i)
      const x = cutStrings(v[i], limits, path, cuts)
      path.pop()
      if (x !== v[i]) (out ??= [...v])[i] = x
    }
    return out ?? v
  }
  if (v && typeof v === 'object') {
    let out: Record<string, unknown> | undefined
    for (const k of Object.keys(v)) {
      const before = (v as Record<string, unknown>)[k]
      path.push(k)
      const x = cutStrings(before, limits, path, cuts)
      path.pop()
      if (x !== before) (out ??= { ...(v as Record<string, unknown>) })[k] = x
    }
    return out ?? v
  }
  return v
}

/** A tool call's input with its long strings cut, or undefined when none is that long. */
export function cutInput(
  input: unknown,
  limits: CutLimits = CUT
): { input: unknown; cuts: InputCut[] } | undefined {
  const cuts: InputCut[] = []
  const out = cutStrings(input, limits, [], cuts)
  return cuts.length ? { input: out, cuts } : undefined
}

/** The messages with long tool outputs and inputs cut (new objects only where something was cut). */
export function cutTranscript(
  messages: ChatMessage[],
  limits: CutLimits = CUT,
  lazy = false
): ChatMessage[] {
  return messages.map((m) => {
    let blocks: ContentBlock[] | undefined
    m.blocks.forEach((b, i) => {
      const r = b.type === 'tool_use' ? b.result : b.type === 'tool_result' ? b.result : undefined
      const sent = r ? cutResult(r, limits, lazy) : undefined
      const inp = b.type === 'tool_use' ? cutInput(b.input, limits) : undefined
      if (sent === r && !inp) return
      blocks ??= [...m.blocks]
      let nb = { ...b } as ContentBlock
      if (sent !== r) nb = { ...nb, result: sent } as ContentBlock
      if (inp)
        nb = {
          ...(nb as ToolUse),
          input: inp.input,
          inputCut: inp.cuts,
          ...(lazy ? { inputLazy: true as const } : {})
        }
      blocks[i] = nb
    })
    return blocks ? { ...m, blocks } : m
  })
}

/** Characters of a value's strings. */
function stringChars(v: unknown): number {
  if (typeof v === 'string') return v.length
  let n = 0
  if (Array.isArray(v)) for (const x of v) n += stringChars(x)
  else if (v && typeof v === 'object')
    for (const k in v) n += stringChars((v as Record<string, unknown>)[k])
  return n
}

/** Characters the tool outputs and inputs of cut messages take. */
function bodyChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages)
    for (const b of m.blocks) {
      if (b.type === 'tool_use') n += stringChars(b.input) + (b.result?.text.length ?? 0)
      else if (b.type === 'tool_result') n += b.result.text.length
    }
  return n
}

/**
 * The transcript the viewer is sent, and the limits it was cut with: CUT,
 * or LAZY placeholders for a very long one (see LAZY_FROM).
 */
export function cutForViewer(
  messages: ChatMessage[],
  lazyFrom = LAZY_FROM
): { messages: ChatMessage[]; limits: CutLimits } {
  const cut = cutTranscript(messages, CUT)
  if (bodyChars(cut) <= lazyFrom) return { messages: cut, limits: CUT }
  return { messages: cutTranscript(messages, LAZY, true), limits: LAZY }
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

/** A tool call's input, in full, by its id (wrapped: an input can itself be null). */
export function toolInputOf(messages: ChatMessage[], id: string): { input: unknown } | undefined {
  for (const m of messages)
    for (const b of m.blocks) if (b.type === 'tool_use' && b.id === id) return { input: b.input }
  return undefined
}

/** Added to a matched block's id: which of its parts holds the match past its cut. */
export const OUTPUT_MATCH = '#output'
export const INPUT_MATCH = '#input'

/**
 * `text`, of which the first `sentLen` characters were sent, holds `q`
 * (lower-cased) somewhere that isn't wholly inside what was sent: also when
 * the sent part holds it too (a later one is still hidden).
 */
export function holdsPast(text: string, sentLen: number, q: string): boolean {
  if (!q || sentLen >= text.length) return false
  const from = text.slice(0, sentLen).toLowerCase().length
  return text.toLowerCase().indexOf(q, Math.max(0, from - q.length + 1)) !== -1
}

/** The value at a cut's path in an input. */
function at(v: unknown, path: (string | number)[]): unknown {
  let x = v
  for (const k of path) x = (x as Record<string | number, unknown> | undefined)?.[k]
  return x
}

/** A string as it shows inside JSON (an input the viewer draws as JSON): its escapes. */
const escaped = (v: string): string => JSON.stringify(v).slice(1, -1)

/**
 * The blocks whose result or input holds `query` past the part a cut sent
 * (case-insensitive), each by its id and by its id with OUTPUT_MATCH or
 * INPUT_MATCH for the part. An input's strings are looked at as the viewer
 * shows them: as they are (a command, a file, an edit) and as JSON.
 */
export function matchesInCut(
  messages: ChatMessage[],
  query: string,
  limits: CutLimits = CUT
): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: string[] = []
  for (const m of messages)
    m.blocks.forEach((b, i) => {
      const id = blockIdOf(m, b, i)
      let found = false
      const r = b.type === 'tool_use' ? b.result : b.type === 'tool_result' ? b.result : undefined
      if (r) {
        const sent = cutResult(r, limits)
        if (sent !== r && holdsPast(r.text, sent.text.length, q)) {
          out.push(id, id + OUTPUT_MATCH)
          found = true
        }
      }
      if (b.type !== 'tool_use') return
      const inp = cutInput(b.input, limits)
      if (!inp) return
      const hit = inp.cuts.some((c) => {
        const full = at(b.input, c.path)
        const sent = at(inp.input, c.path)
        if (typeof full !== 'string' || typeof sent !== 'string') return false
        return holdsPast(full, sent.length, q) || holdsPast(escaped(full), escaped(sent).length, q)
      })
      if (hit) {
        if (!found) out.push(id)
        out.push(id + INPUT_MATCH)
      }
    })
  return out
}
