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
  const top = scanObject(text, skipWs(text, 0))
  // Nothing but whitespace may follow.
  if (skipWs(text, top.close + 1) < text.length) throw new Error('Unexpected text after the object')
  return top
}

/** Locate the members of the object that starts at `start` (text[start] is "{"). */
export function scanObject(text: string, start: number): TopLevel {
  let i = start
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

// ------------------------------------------------------- nested appends

interface ArrayScan {
  open: number
  close: number
  elements: { start: number; end: number }[]
}

/** Locate the elements of the array that starts at `start` (text[start] is "["). */
function scanArray(text: string, start: number): ArrayScan {
  if (text[start] !== '[') throw new Error('Not a JSON array')
  const elements: ArrayScan['elements'] = []
  let i = skipWs(text, start + 1)
  if (text[i] === ']') return { open: start, close: i, elements }
  for (;;) {
    i = skipWs(text, i)
    const end = skipValue(text, i)
    elements.push({ start: i, end })
    i = skipWs(text, end)
    if (text[i] === ',') {
      i++
      continue
    }
    if (text[i] === ']') return { open: start, close: i, elements }
    throw new Error(`Expected "," or "]" at ${i}`)
  }
}

/** The file's own indent unit ("  ", "    ", "\t"), or '' for a one-line file. */
function indentUnit(text: string): { multiline: boolean; unit: string } {
  const top = scanTopLevel(text)
  const s = styleOf(text, top)
  return { multiline: s.multiline, unit: s.unit }
}

function formatAt(value: unknown, multiline: boolean, unit: string, indent: string): string {
  if (!multiline) return JSON.stringify(value)
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`)
}

/** Add `"key": value` at the end of the object at `open` (the key isn't there yet). */
function addToObject(
  text: string,
  open: number,
  key: string,
  value: unknown,
  fmt: { multiline: boolean; unit: string }
): string {
  const obj = scanObject(text, open)
  const last = obj.members[obj.members.length - 1]
  if (!last) {
    const outer = lineIndent(text, open)
    const inner = outer + fmt.unit
    const member = `${JSON.stringify(key)}: ${formatAt(value, fmt.multiline, fmt.unit, inner)}`
    if (!fmt.multiline) return `${text.slice(0, open + 1)}${member}${text.slice(obj.close)}`
    return `${text.slice(0, open + 1)}\n${inner}${member}\n${outer}${text.slice(obj.close)}`
  }
  const multiline = fmt.multiline && text.slice(open + 1, obj.members[0].keyStart).includes('\n')
  const indent = multiline ? lineIndent(text, obj.members[0].keyStart) : ''
  const member = `${JSON.stringify(key)}: ${formatAt(value, multiline, fmt.unit, indent)}`
  const sep = multiline ? `,\n${indent}` : ', '
  return text.slice(0, last.valueEnd) + sep + member + text.slice(last.valueEnd)
}

/** Add `value` at the end of the array at `open`. */
function appendToArray(
  text: string,
  open: number,
  value: unknown,
  fmt: { multiline: boolean; unit: string }
): string {
  const arr = scanArray(text, open)
  const last = arr.elements[arr.elements.length - 1]
  if (!last) {
    const outer = lineIndent(text, open)
    const inner = outer + fmt.unit
    const el = formatAt(value, fmt.multiline, fmt.unit, inner)
    if (!fmt.multiline) return `${text.slice(0, open + 1)}${el}${text.slice(arr.close)}`
    return `${text.slice(0, open + 1)}\n${inner}${el}\n${outer}${text.slice(arr.close)}`
  }
  const multiline = fmt.multiline && text.slice(open + 1, arr.elements[0].start).includes('\n')
  const indent = multiline ? lineIndent(text, arr.elements[0].start) : ''
  const el = formatAt(value, multiline, fmt.unit, indent)
  const sep = multiline ? `,\n${indent}` : ', '
  return text.slice(0, last.end) + sep + el + text.slice(last.end)
}

/**
 * Append hook groups to settings.json's `hooks`, one per event: each goes
 * at the end of `hooks.<event>` (created if missing, `hooks` too). Everything
 * already there stays exactly as it was, byte for byte: nothing is replaced,
 * reordered or reformatted. Throws if `hooks` (or an event in it) isn't the
 * object/array Claude Code expects, so a file the app doesn't understand is
 * never changed.
 */
export function appendHookGroups(text: string, groups: [event: string, group: unknown][]): string {
  const fmt = indentUnit(text)
  let out = text
  for (const [event, group] of groups) {
    const top = scanTopLevel(out)
    const hooks = [...top.members].reverse().find((m) => m.key === 'hooks')
    if (!hooks) {
      out = addToObject(out, top.open, 'hooks', { [event]: [group] }, fmt)
      continue
    }
    if (out[hooks.valueStart] !== '{') throw new Error('"hooks" in settings.json is not an object')
    const obj = scanObject(out, hooks.valueStart)
    const ev = [...obj.members].reverse().find((m) => m.key === event)
    if (!ev) {
      out = addToObject(out, hooks.valueStart, event, [group], fmt)
      continue
    }
    if (out[ev.valueStart] !== '[')
      throw new Error(`"hooks.${event}" in settings.json is not a list`)
    out = appendToArray(out, ev.valueStart, group, fmt)
  }
  return out
}

/**
 * The `hooks` value without the handlers `isOurs` picks (JSON level). Groups
 * left with no handlers are dropped; so are events left empty if `dropEmpty`
 * says so (only the ones the app created). Returns undefined when nothing of
 * the app's was found.
 */
export function withoutHandlers(
  hooks: unknown,
  isOurs: (handler: unknown) => boolean,
  dropEmpty: (event: string) => boolean
): Record<string, unknown> | undefined {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return undefined
  let found = false
  const out: Record<string, unknown> = {}
  for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      out[event] = list
      continue
    }
    const kept: unknown[] = []
    for (const group of list) {
      const g = group as Record<string, unknown> | null
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
        kept.push(group)
        continue
      }
      const handlers = (g.hooks as unknown[]).filter((h) => !isOurs(h))
      if (handlers.length === g.hooks.length) {
        kept.push(group)
        continue
      }
      found = true
      if (handlers.length) kept.push({ ...g, hooks: handlers })
    }
    if (kept.length || !dropEmpty(event)) out[event] = kept
  }
  return found ? out : undefined
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
