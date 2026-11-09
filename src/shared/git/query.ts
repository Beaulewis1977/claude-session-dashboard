// Search filters for git links: `touched:<path>` (sessions that edited or
// committed a file) and `commit:<sha>` (sessions linked to a commit). The
// rest of the query is the usual full-text search.

export interface GitQuery {
  /** The query without the git filters. */
  text: string
  touched: string[]
  commits: string[]
}

const TOKEN = /(?:^|\s)(touched|commit):(?:"([^"]*)"|(\S+))/gi

export function parseGitQuery(q: string): GitQuery {
  const touched: string[] = []
  const commits: string[] = []
  const text = q.replace(TOKEN, (_m, key: string, quoted: string | undefined, bare: string | undefined) => {
    const v = (quoted ?? bare ?? '').trim()
    if (key.toLowerCase() === 'touched') {
      const p = normQueryPath(v)
      if (p) touched.push(p)
    } else if (/^[0-9a-f]{4,64}$/i.test(v)) commits.push(v.toLowerCase())
    return ' '
  })
  return { text: text.replace(/\s+/g, ' ').trim(), touched, commits }
}

export function hasGitFilters(q: GitQuery): boolean {
  return q.touched.length > 0 || q.commits.length > 0
}

/** Forward slashes, lower case, no `./` or leading/trailing slashes. */
export function normQueryPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
}

/**
 * Does a file (normalised the same way, absolute or repo-relative) match a
 * `touched:` path? The whole path, its end (`bridge.ts`, `services/bridge.ts`),
 * or a folder it's in (`src/main`).
 */
export function pathMatches(file: string, query: string): boolean {
  const f = normQueryPath(file)
  if (!query) return false
  return (
    f === query ||
    f.endsWith(`/${query}`) ||
    f.startsWith(`${query}/`) ||
    f.includes(`/${query}/`)
  )
}

/** A `touched:` filter for a file, quoted if it has spaces. */
export function touchedQuery(path: string): string {
  const p = path.replace(/\\/g, '/')
  return /\s|"/.test(p) ? `touched:"${p.replace(/"/g, '')}"` : `touched:${p}`
}
