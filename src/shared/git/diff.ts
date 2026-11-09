// Parsing a commit's patch (`git show --format= --patch`) for the diff viewer.

import { unquotePath } from './log'
import type { DiffFile, DiffHunk } from './types'

/** Lines kept per file (the viewer shows fewer until "Show all"); more are counted in `cut`. */
export const MAX_DIFF_LINES = 20_000
/** Lines kept per file when the whole diff was asked for. */
export const MAX_DIFF_LINES_ALL = 1_000_000

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string {
  const u = unquotePath(p.trim())
  return u.startsWith(prefix) ? u.slice(2) : u
}

/** The two paths of a `diff --git a/x b/y` line (each may be quoted). */
function gitLinePaths(line: string): { a?: string; b?: string } {
  const rest = line.slice('diff --git '.length)
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest)
  if (quoted) return { a: stripPrefix(quoted[1], 'a/'), b: stripPrefix(quoted[2], 'b/') }
  // Unquoted paths with spaces: `a/x y b/x y` (the same path twice for a plain change).
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half)
    const b = rest.slice(half + 1)
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2))
      return { a: a.slice(2), b: b.slice(2) }
  }
  return {}
}

export function parsePatch(text: string, maxLines = MAX_DIFF_LINES): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  let oldNo = 0
  let newNo = 0
  let kept = 0
  for (const raw of text.replace(/\r?\n$/, '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      const p = gitLinePaths(line)
      file = { path: p.b ?? p.a ?? '', status: 'modified', hunks: [], add: 0, del: 0 }
      if (p.a && p.b && p.a !== p.b) file.from = p.a
      files.push(file)
      hunk = undefined
      kept = 0
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.from = unquotePath(line.slice(12))
        file.status = 'renamed'
      } else if (line.startsWith('rename to ')) {
        file.path = unquotePath(line.slice(10))
        file.status = 'renamed'
      } else if (line.startsWith('Binary files ') || line === 'GIT binary patch')
        file.status = 'binary'
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        const p = stripPrefix(line.slice(4), 'b/')
        if (p) file.path = p
      }
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (h) {
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      oldNo = Number(h[1])
      newNo = Number(h[2])
      continue
    }
    if (!hunk) continue
    const t = line[0]
    // Past the limit, lines are only counted (the file says how many weren't kept).
    const keep = (): boolean => {
      if (kept++ < maxLines) return true
      file!.cut = (file!.cut ?? 0) + 1
      return false
    }
    if (t === '+') {
      file.add++
      if (keep()) hunk.lines.push({ t: '+', text: line.slice(1), newNo: newNo })
      newNo++
    } else if (t === '-') {
      file.del++
      if (keep()) hunk.lines.push({ t: '-', text: line.slice(1), oldNo: oldNo })
      oldNo++
    } else if (t === ' ' || line === '') {
      // A blank line inside a hunk is a context line whose space was trimmed.
      if (keep()) hunk.lines.push({ t: ' ', text: line.slice(1), oldNo: oldNo, newNo: newNo })
      oldNo++
      newNo++
    } else if (t === '\\') {
      if (keep()) hunk.lines.push({ t: '\\', text: line.slice(1).trim() })
    }
  }
  return files
}
