// Words for the Ask index (docs/ROADMAP.md, feature 7): what a passage is
// found by. The same function splits passages and questions, so they meet.
//
// - Lower case. Paths, file names, snake_case, kebab-case and camelCase are
//   split into their parts, and a file name (`bridge.ts`), a version
//   (`1.15.2`) or an identifier (`wslPath`) is also kept whole: asking for
//   `bridge.ts` finds that file before every other "bridge".
// - A light English stemmer, so "fixed", "fixes" and "fixing" meet "fix",
//   and "pricing" meets "prices".
// - Common words (and question words) are left out.
// - Chinese, Japanese and Korean text (no spaces) is split into pairs of
//   characters.

/** Bumped whenever the words change: an index built with older words is rebuilt. */
export const TOKENIZER_VERSION = 1

const STOP = new Set(
  (
    'a an and are as at be but by can do does did done for from had has have he her his how i if in into is it its ' +
    'just me my no not of on or our she so that the their them then there these they this to too us was we were ' +
    'what when where which who whom whose why will with you your yes ok okay please let lets also would could should ' +
    'been being am than via up out about all any some get got im ive id dont didnt doesnt isnt wasnt cant wont ' +
    'here hey hi thanks thank sure now very much more most other such only own same each few both again further ' +
    'once over under while during before after above below off between through until whether'
  ).split(' ')
)

/** Is this a common word the index leaves out? */
export function isStopword(w: string): boolean {
  return STOP.has(w)
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const RAW = /[\p{L}\p{N}][\p{L}\p{N}_.\-/\\]*/gu
const CAMEL = /([a-z0-9])([A-Z])|([A-Z]+)([A-Z][a-z])/g
const FILE_LIKE = /\.[a-z][a-z0-9]{0,6}$/
const VERSION = /^v?\d+(?:\.\d+){1,3}$/
const SHA = /^[0-9a-f]{7,40}$/

/** A light English stemmer (suffixes only; never shorter than 3 letters). */
export function stem(t: string): string {
  if (t.length <= 3 || /[^a-z]/.test(t)) return t
  let w = t
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('ied') && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (w.endsWith('ing') && w.length - 3 >= 3) w = w.slice(0, -3)
  else if (w.endsWith('ed') && w.length - 2 >= 3) w = w.slice(0, -2)
  else if (w.endsWith('es') && w.length - 2 >= 3 && /(?:[sxz]|ch|sh)es$/.test(w)) w = w.slice(0, -2)
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length - 1 >= 3)
    w = w.slice(0, -1)
  if (w.endsWith('e') && w.length >= 4) w = w.slice(0, -1)
  if (w.length >= 4 && /([bdgmnprt])\1$/.test(w)) w = w.slice(0, -1)
  return w
}

function keep(w: string): boolean {
  if (w.length < 2 || w.length > 40) return false
  if (STOP.has(w)) return false
  // Long numbers (ids, timestamps) are noise; short ones (ports, PR numbers) stay.
  if (/^\d+$/.test(w) && w.length > 6) return false
  return true
}

/**
 * The words of `text`, each with how often it appears, added to `out`.
 * Returns the number of words (the passage length BM25 uses).
 */
export function addTokens(text: string, out: Map<string, number>): number {
  let n = 0
  const push = (w: string): void => {
    if (!keep(w)) return
    out.set(w, (out.get(w) ?? 0) + 1)
    n++
  }
  // Common words are left out before stemming ("where" isn't "wher").
  const word = (w: string): void => {
    if (!STOP.has(w)) push(stem(w))
  }
  for (const m of text.matchAll(RAW)) {
    const raw = m[0].replace(/[._\-/\\]+$/, '')
    if (!raw) continue
    if (CJK.test(raw)) {
      // No spaces between words: pairs of characters.
      const chars = [...raw.toLowerCase()].filter((c) => CJK.test(c))
      if (chars.length === 1) push(chars[0])
      for (let i = 0; i + 1 < chars.length; i++) push(chars[i] + chars[i + 1])
      continue
    }
    const lower = raw.toLowerCase()
    const camel = raw !== lower && /[a-z][A-Z]/.test(raw)
    if (!/[._\-/\\]/.test(raw) && !camel) {
      word(lower)
      continue
    }
    // A compound: its parts (stemmed), and the whole when it names a file,
    // a version, a commit or an identifier.
    const parts = raw
      .replace(CAMEL, (_m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
      .toLowerCase()
      .split(/[\s._\-/\\]+/)
      .filter(Boolean)
    for (const p of parts) word(p)
    const last = lower.split(/[/\\]/).pop() ?? ''
    if (FILE_LIKE.test(last) && last.length <= 40) push(last)
    else if (VERSION.test(lower)) push(lower)
    else if (!/[/\\]/.test(lower) && lower.length <= 40) push(lower)
  }
  return n
}

/** The distinct words of a question, in order. */
export function queryTokens(text: string): string[] {
  const m = new Map<string, number>()
  addTokens(text, m)
  return [...m.keys()]
}

/** A short hex id of a commit, as the tokenizer keeps it. */
export function isShaToken(w: string): boolean {
  return SHA.test(w) && /\d/.test(w) && /[a-f]/.test(w)
}
