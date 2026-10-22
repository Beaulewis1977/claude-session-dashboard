// Surgical edits of one top-level key in a JSON file (Claude's settings.json),
// keeping every other byte (formatting, key order, whitespace) unchanged.

import type { DiffLine } from '@shared/usage/limits'

export interface JsonMember {
  key: string
  keyStart: number
  valueStart: number
  valueEnd: number
}

export interface TopLevel {
  open: number
  close: number
  members: JsonMember[]
}

const WS = /[ \t\r\n\uFEFF]/

function skipWs(t: string, i: number): number {
  while (i < t.length && WS.test(t[i])) i++
  return i
}

function skipString(t: string, i: number): number {
  // t[i] === '"'
  i++
  while (i < t.length) {
    const c = t[i]
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else i++
  }
  throw new Error('Unterminated string')
}

function skipValue(t: string, i: number): number {
  const c = t[i]
  if (c === '"') return skipString(t, i)
  if (c === '{' || c === '[') {
    let depth = 0
    while (i < t.length) {
      const ch = t[i]
      if (ch === '"') {
        i = skipString(t, i)
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    throw new Error('Unterminated object')
  }
  const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 64))
  if (!m) throw new Error(`Unexpected character at ${i}`)
  return i + m[0].length
}

/** Locate the members of the top-level object. Throws on anything that isn't one. */
export function scanTopLevel(text: string): TopLevel {
  let i = skipWs(text, 0)
  if (text[i] !== '{') throw new Error('Not a JSON object')
  const open = i
  const members: JsonMember[] = []
  i = skipWs(text, i + 1)
  if (text[i] === '}') return { open, close: i, members }
  for (;;) {
    i = skipWs(text, i)
    if (text[i] !== '"') throw new Error(`Expected a key at ${i}`)
    const keyStart = i
    const keyEnd = skipString(text, i)
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string
    i = skipWs(text, keyEnd)
    if (text[i] !== ':') throw new Error(`Expected ":" at ${i}`)
    const valueStart = skipWs(text, i + 1)
    const valueEnd = skipValue(text, valueStart)
    members.push({ key, keyStart, valueStart, valueEnd })
    i = skipWs(text, valueEnd)
    if (text[i] === ',') {
      i++
      continue
    }
    if (text[i] === '}') return { open, close: i, members }
    throw new Error(`Expected "," or "}" at ${i}`)
  }
}

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart, pos))![0]
}

interface Style {
  multiline: boolean
  base: string
  unit: string
}

function styleOf(text: string, top: TopLevel): Style {
  const first = top.members[0]
  if (!first) return { multiline: true, base: '  ', unit: '  ' }
  const between = text.slice(top.open + 1, first.keyStart)
  if (!between.includes('\n')) return { multiline: false, base: '', unit: '' }
  const base = lineIndent(text, first.keyStart)
  return { multiline: true, base, unit: base || '  ' }
}

function formatValue(value: unknown, style: Style): string {
  if (!style.multiline) return JSON.stringify(value)
  return JSON.stringify(value, null, style.unit).replace(/\n/g, `\n${style.base}`)
}

/** Raw text of a top-level member's value, or undefined if the key isn't there. */
export function rawMember(text: string, key: string): string | undefined {
  const m = scanTopLevel(text).members.find((x) => x.key === key)
  return m ? text.slice(m.valueStart, m.valueEnd) : undefined
}

/**
 * Set a top-level key. `rawValue` (exact text) wins over `value` so a
 * previous value can be put back byte for byte.
 */
export function setMember(text: string, key: string, value: unknown, rawValue?: string): string {
  const top = scanTopLevel(text)
  const style = styleOf(text, top)
  const valueText = rawValue ?? formatValue(value, style)
  // The last occurrence wins in JSON.parse, so edit that one.
  const existing = [...top.members].reverse().find((m) => m.key === key)
  if (existing) {
    return text.slice(0, existing.valueStart) + valueText + text.slice(existing.valueEnd)
  }
  const member = `${JSON.stringify(key)}: ${valueText}`
  const last = top.members[top.members.length - 1]
  if (!last) {
    const closeIndent = lineIndent(text, top.close)
    return `${text.slice(0, top.open + 1)}\n${style.base}${member}\n${closeIndent}${text.slice(top.close)}`
  }
  const sep = style.multiline ? `,\n${style.base}` : ', '
  return text.slice(0, last.valueEnd) + sep + member + text.slice(last.valueEnd)
}

/** Remove a top-level key (all occurrences), including its comma. */
export function removeMember(text: string, key: string): string {
  let out = text
  for (;;) {
    const top = scanTopLevel(out)
    const idx = top.members.findIndex((m) => m.key === key)
    if (idx < 0) return out
    const m = top.members[idx]
    if (idx > 0) {
      // Remove from the end of the previous value through this value.
      const prev = top.members[idx - 1]
      out = out.slice(0, prev.valueEnd) + out.slice(m.valueEnd)
    } else if (top.members.length > 1) {
      out = out.slice(0, m.keyStart) + out.slice(top.members[1].keyStart)
    } else {
      // Only member: leave an empty object with the original closing line.
      const closeIndent = lineIndent(out, top.close)
      const nl = out.slice(top.open, top.close).includes('\n')
      out = out.slice(0, top.open + 1) + (nl ? `\n${closeIndent}` : '') + out.slice(top.close)
    }
  }
}

// ------------------------------------------------------------------- diff

/** Line diff (LCS). Settings files are small, so the O(n·m) table is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  if (a.length * b.length > 4_000_000) {
    return [
      ...a.map((text) => ({ type: 'remove' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text }))
    ]
  }
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'remove', text: a[i++] })
    } else {
      out.push({ type: 'add', text: b[j++] })
    }
  }
  while (i < n) out.push({ type: 'remove', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}
