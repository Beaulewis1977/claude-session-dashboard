// Reading a content answer: every statement must cite at least one snippet
// that was sent with this question ([S3], [S3][S7], [S3, S7] or [S3-S5]).
// Ids that weren't sent are taken out; a statement left without a valid id is
// dropped (and listed, so I can see what was removed). NOT_FOUND, or nothing
// left, means the snippets didn't hold the answer.

import { NOT_FOUND } from './prompt'

export interface CheckedAnswer {
  /** The answer with only valid citations, as [S1][S2] markers. */
  answer: string
  /** Statements removed for citing no valid snippet (citations taken out). */
  dropped: string[]
  /** Valid ids cited, in order of first use. */
  cited: string[]
  notFound: boolean
}

const GROUP = /\[\s*(S\d{1,3}(?:\s*(?:[,;]|[-–]|and)\s*S\d{1,3})*)\s*\]/gi
const MARK = /\[(S\d{1,3})\]/g

/** `[S1, S3]`, `[S2-S4]` → `[S1][S3]`, `[S2][S3][S4]` (ranges up to 20 ids). */
export function normalizeCitations(text: string): string {
  return text.replace(GROUP, (_m, inner: string) => {
    const ids: string[] = []
    for (const part of inner.split(/\s*(?:[,;]|and)\s*/i)) {
      const r = /^S(\d+)\s*[-–]\s*S(\d+)$/i.exec(part.trim())
      if (r) {
        const a = Number(r[1])
        const b = Number(r[2])
        if (b >= a && b - a < 20) for (let i = a; i <= b; i++) ids.push(`S${i}`)
        else ids.push(`S${a}`, `S${b}`)
      } else if (/^S\d+$/i.test(part.trim())) ids.push(part.trim().toUpperCase())
    }
    return ids.map((id) => `[${id}]`).join('')
  })
}

const ABBREV = /\b(?:e\.g|i\.e|etc|vs|approx|incl|cf|no|fig|ca)\.$/i

/** Sentences of one line, each with the citations that follow it attached. */
function sentences(line: string): string[] {
  const out: string[] = []
  let start = 0
  const re = /([.!?])(\s+)(?=[A-Z0-9"'`*_([])/g
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const end = m.index + 1
    const piece = line.slice(start, end)
    // "e.g. Foo" or "v1. Next": not a sentence end.
    if (ABBREV.test(piece) || /\b[A-Z]\.$/.test(piece)) continue
    out.push(piece)
    start = end + m[2].length
  }
  out.push(line.slice(start))
  // Citations written after the full stop ("Done. [S2] Next…") belong to the sentence before.
  const merged: string[] = []
  for (const s of out) {
    let rest = s
    const lead = /^\s*((?:\[S\d+\]\s*)+)[.!?]?/i.exec(rest)
    if (lead && merged.length) {
      merged[merged.length - 1] += ` ${lead[1].trim()}`
      rest = rest.slice(lead[0].length)
    }
    if (rest.trim()) merged.push(rest.trim())
  }
  return merged
}

function strip(text: string): string {
  return text
    .replace(MARK, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

interface Line {
  raw: string
  /** Kept as it is (blank, rule, code fence content follows its statement). */
  structural?: 'blank' | 'heading' | 'leadin' | 'code' | 'table-head'
  kept?: boolean
}

/**
 * Check an answer against the snippet ids sent with it. `valid`: the ids
 * ("S1", "S2", …) of the snippets that were sent.
 */
export function checkCitations(raw: string, valid: ReadonlySet<string>): CheckedAnswer {
  const text = normalizeCitations(raw.replace(/\r\n?/g, '\n')).trim()
  const notFoundOnly = new RegExp(`^\\W*${NOT_FOUND}\\W*$`)
  if (!text || notFoundOnly.test(text))
    return { answer: '', dropped: [], cited: [], notFound: true }
  const dropped: string[] = []
  const cited: string[] = []
  const cite = (id: string): void => {
    if (!cited.includes(id)) cited.push(id)
  }
  const lines: Line[] = []
  let inCode = false
  for (const rawLine of text.split('\n')) {
    if (/^\s*```/.test(rawLine)) {
      inCode = !inCode
      lines.push({ raw: rawLine, structural: 'code' })
      continue
    }
    if (inCode) {
      lines.push({ raw: rawLine, structural: 'code' })
      continue
    }
    if (!rawLine.trim() || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(rawLine)) {
      lines.push({ raw: rawLine, structural: 'blank' })
      continue
    }
    // A bare NOT_FOUND line among other text says nothing.
    if (notFoundOnly.test(rawLine)) continue
    const heading = /^\s*#{1,6}\s/.test(rawLine)
    const tableSep = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(rawLine)
    const hasCite = /\[S\d+\]/i.test(rawLine)
    if (tableSep) {
      lines.push({ raw: rawLine, structural: 'table-head' })
      continue
    }
    if ((heading || /:\s*$/.test(rawLine)) && !hasCite) {
      lines.push({ raw: rawLine, structural: heading ? 'heading' : 'leadin' })
      continue
    }
    // A statement line: list marker (or quote) kept, each sentence checked.
    const m = /^(\s*(?:[-*+]|\d+[.)]|>)\s+)?(.*)$/.exec(rawLine) ?? ['', '', rawLine]
    const prefix = m[1] ?? ''
    const body = m[2] ?? ''
    const kept: string[] = []
    if (body.trim().startsWith('|')) {
      // A table row: one statement (its own cells' citations).
      const ids = [...body.matchAll(MARK)].map((x) => x[1].toUpperCase())
      const ok = ids.filter((id) => valid.has(id))
      if (ok.length) {
        ok.forEach(cite)
        kept.push(body.replace(MARK, (all, id: string) => (valid.has(id.toUpperCase()) ? all : '')))
      } else if (!lines.some((l) => l.kept && l.raw.trim().startsWith('|'))) {
        // The header row (before any kept row): structural.
        lines.push({ raw: rawLine, structural: 'table-head' })
        continue
      } else dropped.push(strip(body))
    } else {
      for (const s of sentences(body)) {
        const ids = [...s.matchAll(MARK)].map((x) => x[1].toUpperCase())
        const ok = ids.filter((id) => valid.has(id))
        if (!ok.length) {
          const t = strip(s)
          if (t) dropped.push(t)
          continue
        }
        ok.forEach(cite)
        kept.push(
          s
            .replace(MARK, (_m, id: string) => (valid.has(id.toUpperCase()) ? `[${id.toUpperCase()}]` : ''))
            .replace(/\s+([.,;:!?])/g, '$1')
            .trim()
        )
      }
    }
    lines.push({ raw: kept.length ? `${prefix}${kept.join(' ')}` : '', kept: kept.length > 0 })
  }
  // Headings and lead-in lines stay only if something under them stays; code
  // blocks only after a kept statement; table headers only with a kept row.
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.kept) out.push(l.raw)
    else if (l.structural === 'blank') out.push('')
    else if (l.structural === 'heading' || l.structural === 'leadin' || l.structural === 'table-head') {
      let j = i + 1
      let keep = false
      for (; j < lines.length; j++) {
        const n = lines[j]
        if (n.kept) {
          keep = true
          break
        }
        if (n.structural === 'heading' && l.structural !== 'table-head') break
      }
      if (keep) out.push(l.raw)
    } else if (l.structural === 'code') {
      // The code block follows the nearest statement above it.
      let k = i - 1
      while (k >= 0 && lines[k].structural === 'code') k--
      while (k >= 0 && lines[k].structural === 'blank') k--
      if (k >= 0 && lines[k].kept) out.push(l.raw)
    }
  }
  const answer = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { answer: cited.length ? answer : '', dropped, cited, notFound: cited.length === 0 }
}
