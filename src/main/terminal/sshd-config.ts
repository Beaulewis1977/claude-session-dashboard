// sshd_config: read and set the global PasswordAuthentication setting.
//
// sshd uses the first value it reads for a keyword, and settings after a
// `Match` line only apply to that match. So the global setting is the first
// active PasswordAuthentication line before any Match block. The edit changes
// only that one line (or adds it); every other line stays exactly as it was.

const KEY_RE = /^\s*PasswordAuthentication\s+(\S+)/i
const COMMENTED_RE = /^\s*#\s*PasswordAuthentication\b/i
const MATCH_RE = /^\s*Match\s/i

function lines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { lines: text.split(/\r?\n/), eol }
}

/** Index of the first Match line (the end of the global section). */
function globalEnd(ls: string[]): number {
  const i = ls.findIndex((l) => MATCH_RE.test(l))
  return i < 0 ? ls.length : i
}

/** The global value, or 'yes' when it isn't set (sshd's default). */
export function passwordAuthSetting(text: string): 'yes' | 'no' {
  const { lines: ls } = lines(text)
  const end = globalEnd(ls)
  for (let i = 0; i < end; i++) {
    const m = KEY_RE.exec(ls[i])
    if (m) return m[1].toLowerCase() === 'no' ? 'no' : 'yes'
  }
  return 'yes'
}

/**
 * The same text with the global PasswordAuthentication set to `value`: the
 * first active line before any Match block is changed in place; otherwise a
 * line is added after the commented-out default (or before the first Match).
 */
export function setPasswordAuth(text: string, value: 'yes' | 'no'): string {
  const { lines: ls, eol } = lines(text)
  const end = globalEnd(ls)
  const line = `PasswordAuthentication ${value}`
  for (let i = 0; i < end; i++) {
    if (KEY_RE.test(ls[i])) {
      ls[i] = ls[i].replace(/^(\s*PasswordAuthentication\s+)\S+/i, `$1${value}`)
      return ls.join(eol)
    }
  }
  const commented = ls.slice(0, end).findIndex((l) => COMMENTED_RE.test(l))
  if (commented >= 0) ls.splice(commented + 1, 0, line)
  else if (end < ls.length) ls.splice(end, 0, line, '')
  else {
    // No Match block: append, keeping a final newline if there was one.
    if (ls.at(-1) === '') ls.splice(ls.length - 1, 0, line)
    else ls.push(line)
  }
  return ls.join(eol)
}

/**
 * What changes between two versions, for the confirmation: the lines that
 * differ ("- old" / "+ new"), after the first line number, with the common
 * start and end left out.
 */
export function lineDiff(before: string, after: string): string {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  const lines = [
    ...a.slice(i, a.length - j).map((l) => `- ${l}`),
    ...b.slice(i, b.length - j).map((l) => `+ ${l}`)
  ]
  return lines.length ? [`Line ${i + 1}:`, ...lines].join('\n') : '(no change)'
}
