// Surgical edits of Claude's settings.json, keeping every other byte
// (formatting, key order, whitespace and comments) unchanged.
//
// Claude Code's settings may hold `//` and `/* */` comments: the scanner
// skips them like whitespace, and `parseJsonc` reads such a file. For a key
// that appears twice, JSON (and Claude Code) uses the last one, and so does
// everything here; the hook installer refuses duplicates of the keys it edits.

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

/** Skip whitespace and comments. */
function skipWs(t: string, i: number): number {
  for (;;) {
    while (i < t.length && WS.test(t[i])) i++
    if (t[i] === '/' && t[i + 1] === '/') {
      const nl = t.indexOf('\n', i)
      i = nl < 0 ? t.length : nl
      continue
    }
    if (t[i] === '/' && t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2)
      if (end < 0) throw new Error('Unterminated comment')
      i = end + 2
      continue
    }
    return i
  }
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
  // Containers are walked element by element, so comments inside them are skipped too.
  if (c === '{') return scanObject(t, i).close + 1
  if (c === '[') return scanArray(t, i).close + 1
  const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 64))
  if (!m) throw new Error(`Unexpected character at ${i}`)
  return i + m[0].length
}

/** Parse JSON that may hold `//` and `/* *\/` comments (outside strings). */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  const t = text.replace(/^\uFEFF/, '')
  while (i < t.length) {
    const c = t[i]
    if (c === '"') {
      const end = skipString(t, i)
      out += t.slice(i, end)
      i = end
    } else if (c === '/' && (t[i + 1] === '/' || t[i + 1] === '*')) {
      const j = skipWs(t, i)
      out += ' '
      i = j
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out)
}

/** Locate the members of the top-level object. Throws on anything that isn't one. */
export function scanTopLevel(text: string): TopLevel {
  const top = scanObject(text, skipWs(text, 0))
  // Nothing but whitespace (and comments) may follow.
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

/** The effective (last) member with this key, like JSON.parse. */
function lastMember(obj: TopLevel, key: string): JsonMember | undefined {
  for (let i = obj.members.length - 1; i >= 0; i--)
    if (obj.members[i].key === key) return obj.members[i]
  return undefined
}

/** Keys that appear more than once in the object at `start` (the top level by default). */
export function duplicateKeys(text: string, start?: number): string[] {
  const obj = start === undefined ? scanTopLevel(text) : scanObject(text, start)
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const m of obj.members) (seen.has(m.key) ? dup : seen).add(m.key)
  return [...dup]
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

/**
 * Where a new item goes after a value at `pos`: after any comment on the
 * same line (`"a": 1 // note`), so the note stays with its line. The comma
 * still goes right after the value.
 */
function afterLineComment(text: string, pos: number): number {
  let i = pos
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++
    if (text[i] === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl < 0) return text.length
      return text[nl - 1] === '\r' ? nl - 1 : nl
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0 || text.slice(i, end).includes('\n')) return pos
      i = end + 2
      continue
    }
    // A block comment that ends its line stays with the value too.
    if (i > pos && (text[i] === '\r' || text[i] === '\n')) return i
    return pos
  }
}

/** The file's own line ending (a Windows file stays CRLF). */
function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Insert `item` after the value ending at `end` (a comma, then the item on its own line). */
function insertAfter(
  text: string,
  end: number,
  item: string,
  multiline: boolean,
  indent: string
): string {
  if (!multiline) return `${text.slice(0, end)}, ${item}${text.slice(end)}`
  const at = afterLineComment(text, end)
  const nl = eolOf(text)
  return `${text.slice(0, end)},${text.slice(end, at)}${nl}${indent}${item.replace(/\n/g, nl)}${text.slice(at)}`
}

/** Raw text of a top-level member's value (the last one, as JSON reads it), or undefined. */
export function rawMember(text: string, key: string): string | undefined {
  const m = lastMember(scanTopLevel(text), key)
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
  const existing = lastMember(top, key)
  if (existing) {
    return text.slice(0, existing.valueStart) + valueText + text.slice(existing.valueEnd)
  }
  const member = `${JSON.stringify(key)}: ${valueText}`
  const last = top.members[top.members.length - 1]
  if (!last) {
    const closeIndent = lineIndent(text, top.close)
    return `${text.slice(0, top.open + 1)}\n${style.base}${member}\n${closeIndent}${text.slice(top.close)}`
  }
  return insertAfter(text, last.valueEnd, member, style.multiline, style.base)
}

/**
 * Remove item `idx` of a list (object members or array elements), with its
 * comma. Comments around it stay. Removing what `insertAfter` added gives
 * back the text exactly as it was.
 */
function removeItem(
  text: string,
  items: { start: number; end: number }[],
  idx: number,
  open: number,
  close: number
): string {
  const it = items[idx]
  const hasComment = (s: string): boolean => /\/[/*]/.test(s)
  const dropComma = (s: string): string => s.replace(',', '')
  if (idx > 0) {
    const prev = items[idx - 1]
    const gap = text.slice(prev.end, it.start)
    if (!hasComment(gap)) return text.slice(0, prev.end) + text.slice(it.end)
    // Keep the comments; a newline follows anyway, so trailing blanks can go.
    let kept = dropComma(gap)
    if (/^[ \t]*(\r?\n|$)/.test(text.slice(it.end))) kept = kept.replace(/[ \t\r\n]+$/, '')
    return text.slice(0, prev.end) + kept + text.slice(it.end)
  }
  if (items.length > 1) {
    const gap = text.slice(it.end, items[1].start)
    return (
      text.slice(0, it.start) + (hasComment(gap) ? dropComma(gap) : '') + text.slice(items[1].start)
    )
  }
  // The only item: an empty container, keeping any comments inside.
  const before = text.slice(open + 1, it.start)
  const after = text.slice(it.end, close)
  if (!hasComment(before) && !hasComment(after)) return text.slice(0, open + 1) + text.slice(close)
  return text.slice(0, open + 1) + before + after + text.slice(close)
}

const memberItems = (o: TopLevel) => o.members.map((m) => ({ start: m.keyStart, end: m.valueEnd }))

/** Remove a top-level key (all occurrences), including its comma. */
export function removeMember(text: string, key: string): string {
  let out = text
  for (;;) {
    const top = scanTopLevel(out)
    const idx = top.members.findIndex((m) => m.key === key)
    if (idx < 0) return out
    if (top.members.length === 1) {
      // Only member: an empty object with the original closing line.
      const closeIndent = lineIndent(out, top.close)
      const inner = out.slice(top.open + 1, top.close)
      const nl = inner.includes('\n')
      if (!/\/[/*]/.test(inner))
        out = out.slice(0, top.open + 1) + (nl ? `\n${closeIndent}` : '') + out.slice(top.close)
      else out = removeItem(out, memberItems(top), idx, top.open, top.close)
      continue
    }
    out = removeItem(out, memberItems(top), idx, top.open, top.close)
  }
}

// ------------------------------------------------------- nested appends

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
    const nl = eolOf(text)
    return `${text.slice(0, open + 1)}${nl}${inner}${member.replace(/\n/g, nl)}${nl}${outer}${text.slice(obj.close)}`
  }
  const multiline = fmt.multiline && text.slice(open + 1, obj.members[0].keyStart).includes('\n')
  const indent = multiline ? lineIndent(text, obj.members[0].keyStart) : ''
  const member = `${JSON.stringify(key)}: ${formatAt(value, multiline, fmt.unit, indent)}`
  return insertAfter(text, last.valueEnd, member, multiline, indent)
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
    const nl = eolOf(text)
    return `${text.slice(0, open + 1)}${nl}${inner}${el.replace(/\n/g, nl)}${nl}${outer}${text.slice(arr.close)}`
  }
  const multiline = fmt.multiline && text.slice(open + 1, arr.elements[0].start).includes('\n')
  const indent = multiline ? lineIndent(text, arr.elements[0].start) : ''
  const el = formatAt(value, multiline, fmt.unit, indent)
  return insertAfter(text, last.end, el, multiline, indent)
}

/**
 * Why `hooks` can't be edited safely, or undefined: `hooks` (or one of its
 * events) appears twice, or isn't the object / list Claude Code expects.
 */
export function hooksProblem(text: string): string | undefined {
  const top = scanTopLevel(text)
  if (duplicateKeys(text).includes('hooks')) return '"hooks" appears twice in settings.json'
  const hooks = lastMember(top, 'hooks')
  if (!hooks) return undefined
  if (text[hooks.valueStart] !== '{') return '"hooks" in settings.json is not an object'
  const dup = duplicateKeys(text, hooks.valueStart)
  if (dup.length) return `"hooks.${dup[0]}" appears twice in settings.json`
  for (const ev of scanObject(text, hooks.valueStart).members)
    if (text[ev.valueStart] !== '[') return `"hooks.${ev.key}" in settings.json is not a list`
  return undefined
}

/**
 * Append hook groups to settings.json's `hooks`, one per event: each goes
 * at the end of `hooks.<event>` (created if missing, `hooks` too). Everything
 * already there stays exactly as it was, byte for byte: nothing is replaced,
 * reordered or reformatted, comments included. Throws if `hooks` isn't what
 * Claude Code expects (see hooksProblem), so such a file is never changed.
 */
export function appendHookGroups(text: string, groups: [event: string, group: unknown][]): string {
  const problem = hooksProblem(text)
  if (problem) throw new Error(problem)
  const fmt = indentUnit(text)
  let out = text
  for (const [event, group] of groups) {
    const top = scanTopLevel(out)
    const hooks = lastMember(top, 'hooks')
    if (!hooks) {
      out = addToObject(out, top.open, 'hooks', { [event]: [group] }, fmt)
      continue
    }
    const ev = lastMember(scanObject(out, hooks.valueStart), event)
    if (!ev) {
      out = addToObject(out, hooks.valueStart, event, [group], fmt)
      continue
    }
    out = appendToArray(out, ev.valueStart, group, fmt)
  }
  return out
}

/**
 * Take exactly the handlers `isOurs` picks out of `hooks`, as text: every
 * other byte stays (other hooks, formatting, comments). A group goes too when
 * all its handlers were ours and it has nothing else; an event list the app
 * created (`dropEvent`) goes when it's left empty; `hooks` itself when it's
 * left empty and `dropHooks`. Returns undefined when nothing of the app's was
 * found. A handler whose text can't be read is never touched.
 */
export function removeHookHandlers(
  text: string,
  isOurs: (handler: unknown) => boolean,
  opts: { dropEvent: (event: string) => boolean; dropHooks: boolean }
): string | undefined {
  const problem = hooksProblem(text)
  if (problem) throw new Error(problem)
  const read = (s: string): unknown => {
    try {
      return parseJsonc(s)
    } catch {
      return undefined
    }
  }
  const touched = new Set<string>()
  let out = text
  // One removal at a time, scanning again after each (files are small).
  for (let guard = 0; guard < 10_000; guard++) {
    const hooks = lastMember(scanTopLevel(out), 'hooks')
    if (!hooks) break
    let next: string | undefined
    for (const ev of scanObject(out, hooks.valueStart).members) {
      const groups = scanArray(out, ev.valueStart)
      groups.elements.forEach((g, gi) => {
        if (next !== undefined || out[g.start] !== '{') return
        const gobj = scanObject(out, g.start)
        const hm = lastMember(gobj, 'hooks')
        if (!hm || out[hm.valueStart] !== '[') return
        const handlers = scanArray(out, hm.valueStart)
        const ours = handlers.elements
          .map((h, hi) => (isOurs(read(out.slice(h.start, h.end))) ? hi : -1))
          .filter((hi) => hi >= 0)
        if (!ours.length) return
        touched.add(ev.key)
        next =
          ours.length === handlers.elements.length && gobj.members.length === 1
            ? removeItem(out, groups.elements, gi, groups.open, groups.close)
            : removeItem(out, handlers.elements, ours[0], handlers.open, handlers.close)
      })
      if (next !== undefined) break
    }
    if (next === undefined) break
    out = next
  }
  if (!touched.size) return undefined
  // Event lists the app created, now empty.
  for (const event of touched) {
    if (!opts.dropEvent(event)) continue
    const hooks = lastMember(scanTopLevel(out), 'hooks')!
    const obj = scanObject(out, hooks.valueStart)
    const idx = obj.members.findIndex((m) => m.key === event)
    if (idx < 0 || scanArray(out, obj.members[idx].valueStart).elements.length) continue
    out = removeItem(out, memberItems(obj), idx, obj.open, obj.close)
  }
  const hooks = lastMember(scanTopLevel(out), 'hooks')!
  if (opts.dropHooks && !scanObject(out, hooks.valueStart).members.length)
    out = removeMember(out, 'hooks')
  return out
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
