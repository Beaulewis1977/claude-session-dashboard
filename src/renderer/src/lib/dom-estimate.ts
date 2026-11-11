// How many DOM nodes a transcript draws (roughly), from its messages alone:
// the viewer draws a short session in full (text can be selected across the
// whole conversation) and only the turns near the screen of a big one.
// Weights fitted to real sessions (scripts/perf/perf-ui.mjs measures each
// drawn turn); type-only imports, so the harness can run this file as is.

import type { ContentBlock } from '@shared/types'
import type { Turn } from './transcript'

/** What a turn holds, as far as its DOM size goes. */
export interface TurnFeatures {
  /** Messages (each has its bubble, header or action row). */
  messages: number
  /** Text blocks (each a bubble with its Markdown). */
  texts: number
  /** Lines of text outside code blocks. */
  proseLines: number
  /** Code blocks, and their lines (highlighted: several nodes per line). */
  codeBlocks: number
  codeLines: number
  /** Collapsed rows: tool calls, results, thinking, agent messages, images. */
  rows: number
  /** Groups of tool rows (each a box with its own action row). */
  toolGroups: number
}

function addText(f: TurnFeatures, text: string): void {
  f.texts++
  let inCode = false
  let start = 0
  // Line by line without splitting the text into an array.
  while (start <= text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    // A fence: up to three spaces, then ``` or ~~~.
    let i = start
    while (i < end && i - start < 3 && text.charCodeAt(i) === 32) i++
    const c = text.charCodeAt(i)
    const fence =
      (c === 96 || c === 126) && text.charCodeAt(i + 1) === c && text.charCodeAt(i + 2) === c
    if (fence) {
      if (!inCode) f.codeBlocks++
      inCode = !inCode
    } else if (inCode) f.codeLines++
    else if (end > start) f.proseLines++
    start = end + 1
  }
}

function isRow(b: ContentBlock): boolean {
  return b.type !== 'text'
}

export function turnFeatures(t: Turn): TurnFeatures {
  const f: TurnFeatures = {
    messages: 0,
    texts: 0,
    proseLines: 0,
    codeBlocks: 0,
    codeLines: 0,
    rows: 0,
    toolGroups: 0
  }
  const msgs = t.kind === 'assistant' ? t.msgs : [t.msg]
  let inGroup = false
  for (const m of msgs) {
    f.messages++
    for (const b of m.blocks) {
      if (b.type === 'text') {
        addText(f, b.text)
        inGroup = false
      } else if (isRow(b)) {
        f.rows++
        if (!inGroup) f.toolGroups++
        inGroup = true
      }
    }
  }
  return f
}

/**
 * Nodes per feature, fitted to 180 drawn turns of 26 real sessions (median
 * error 8 nodes per turn, 90% within 46). Real sessions had too few code
 * blocks to fit codeLines: highlighted code has a few spans per line.
 */
export const NODE_WEIGHTS: Record<keyof TurnFeatures, number> & { base: number } = {
  base: 9,
  messages: 2,
  texts: 0,
  proseLines: 2.5,
  codeBlocks: 28,
  codeLines: 4,
  rows: 10,
  toolGroups: 17
}

export function estimateTurnNodes(t: Turn, w = NODE_WEIGHTS): number {
  const f = turnFeatures(t)
  let n = w.base
  for (const k of Object.keys(f) as (keyof TurnFeatures)[]) n += f[k] * w[k]
  return n
}

/** The estimate for a whole transcript, stopping once it's past `cap` (all that's asked is whether it is). */
export function estimateNodes(turns: readonly Turn[], cap = Infinity, w = NODE_WEIGHTS): number {
  let n = 0
  for (const t of turns) {
    n += estimateTurnNodes(t, w)
    if (n > cap) break
  }
  return n
}
