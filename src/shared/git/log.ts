// Parsing what the read-only git commands print (see main/git/backend.ts for
// the commands). Pure functions, tested with recorded and real git output.

import type { CommitFile, CommitInfo } from './types'

/** `git log` format: one record per commit, fields split by US, records by RS. */
export const LOG_FORMAT =
  '%x1e%H%x1f%P%x1f%ae%x1f%ce%x1f%at%x1f%ct%x1f%s%x1f%(trailers:unfold,only)%x1f'
/** `git for-each-ref` format (its hex escape is `%1f`, not `%x1f`): object, peeled object (annotated tags), ref name, symbolic target. */
export const REF_FORMAT = '%(objectname)%1f%(*objectname)%1f%(refname)%1f%(symref)'

/** Files kept per commit (a commit touching more is summed up as "N more"). */
export const MAX_COMMIT_FILES = 500

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** A path git printed in C-style quotes (`"a\tb"`), unquoted. */
export function unquotePath(p: string): string {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p
  const body = p.slice(1, -1)
  const bytes: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = body[++i]
    if (n === undefined) break
    if (/[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3)
      bytes.push(parseInt(oct, 8) & 0xff)
      i += oct.length - 1
    } else {
      const map: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        '"': '"',
        '\\': '\\',
        a: '\x07',
        b: '\b',
        f: '\f',
        v: '\v'
      }
      bytes.push(...enc.encode(map[n] ?? n))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** A numstat path: `a.ts`, `old => new`, or `src/{old => new}/x.ts`. */
export function renamePaths(p: string): { path: string; from?: string } {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p)
  if (brace) {
    const [, pre, a, b, post] = brace
    const clean = (s: string): string => s.replace(/\/{2,}/g, '/')
    return { from: clean(pre + a + post), path: clean(pre + b + post) }
  }
  const arrow = /^(.*) => (.*)$/.exec(p)
  if (arrow) return { from: unquotePath(arrow[1]), path: unquotePath(arrow[2]) }
  return { path: unquotePath(p) }
}

/** One `--numstat` line. */
export function parseNumstat(line: string): CommitFile | undefined {
  const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
  if (!m) return undefined
  const f: CommitFile = renamePaths(m[3])
  if (m[1] !== '-') f.add = Number(m[1])
  if (m[2] !== '-') f.del = Number(m[2])
  return f
}

/** `git log --format=LOG_FORMAT --numstat` output, commits only (branches are worked out later). */
export function parseLog(out: string): CommitInfo[] {
  const commits: CommitInfo[] = []
  for (const rec of out.split('\x1e')) {
    const end = rec.lastIndexOf('\x1f')
    if (end < 0) continue
    const f = rec.slice(0, end).split('\x1f')
    if (f.length < 8) continue
    const sha = f[0].trim().toLowerCase()
    if (!SHA_RE.test(sha)) continue
    const at = Number(f[4]) * 1000
    const ct = Number(f[5]) * 1000
    if (!Number.isFinite(at) || !Number.isFinite(ct)) continue
    const files: CommitFile[] = []
    let more = 0
    for (const line of rec.slice(end + 1).split('\n')) {
      const nf = line ? parseNumstat(line.replace(/\r$/, '')) : undefined
      if (!nf) continue
      if (files.length < MAX_COMMIT_FILES) files.push(nf)
      else more++
    }
    commits.push({
      sha,
      parents: f[1].trim() ? f[1].trim().toLowerCase().split(/\s+/) : [],
      authorEmail: f[2].trim(),
      committerEmail: f[3].trim(),
      at,
      ct,
      subject: f[6],
      trailers: f
        .slice(7)
        .join('\x1f')
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 50),
      files,
      ...(more ? { moreFiles: more } : {}),
      branches: []
    })
  }
  return commits
}

export interface RefTip {
  /** Full ref name, e.g. `refs/heads/main`, `refs/remotes/origin/fix/x`. */
  ref: string
  /** The commit it points at (an annotated tag: the tagged commit). */
  sha: string
  /** For a symbolic ref (`refs/remotes/origin/HEAD`), the ref it points at. */
  symref?: string
}

/** `git for-each-ref --format=REF_FORMAT` output. */
export function parseRefs(out: string): RefTip[] {
  const refs: RefTip[] = []
  for (const line of out.split('\n')) {
    const [obj, peeled, ref, symref] = line.replace(/\r$/, '').split('\x1f')
    if (!ref || !obj) continue
    const sha = (peeled?.trim() || obj.trim()).toLowerCase()
    if (!SHA_RE.test(sha)) continue
    refs.push({ ref: ref.trim(), sha, ...(symref?.trim() ? { symref: symref.trim() } : {}) })
  }
  return refs
}

/** `refs/heads/x` → `x`; `refs/remotes/origin/x` → `x`; tags and HEAD → undefined. */
export function branchName(ref: string): string | undefined {
  if (ref.startsWith('refs/heads/')) return ref.slice(11) || undefined
  if (ref.startsWith('refs/remotes/')) {
    const rest = ref.slice(13)
    const slash = rest.indexOf('/')
    const name = slash >= 0 ? rest.slice(slash + 1) : ''
    return name && name !== 'HEAD' ? name : undefined
  }
  return undefined
}

/**
 * Is the repo a partial clone? `git config --null --get-regexp` output for the
 * partial clone settings (each entry `key\nvalue\0`, or `key\0` for a bare
 * key; a remote's name may hold spaces): `extensions.partialclone <remote>`,
 * a remote's `promisor` that isn't false, or any `partialclonefilter` (git
 * makes a remote with one a promisor remote, whatever its value).
 */
export function isPartialClone(configOutput: string): boolean {
  for (const entry of configOutput.split('\0')) {
    if (!entry.trim()) continue
    const nl = entry.indexOf('\n')
    const key = (nl < 0 ? entry : entry.slice(0, nl)).trim().toLowerCase()
    const value = nl < 0 ? '' : entry.slice(nl + 1).trim()
    if (key === 'extensions.partialclone') {
      if (value) return true
    } else if (key.endsWith('.partialclonefilter')) return true
    else if (key.endsWith('.promisor') && !/^(false|no|off|0)$/i.test(value)) return true
  }
  return false
}

/** `git rev-parse --show-toplevel --git-common-dir --git-dir` output. */
export function parseRevParse(
  out: string
): { root: string; commonDir: string; gitDir: string } | undefined {
  const lines = out.split('\n').map((l) => l.replace(/\r$/, '').trim())
  if (lines.length < 3 || !lines[0] || !lines[1] || !lines[2]) return undefined
  return { root: lines[0], commonDir: lines[1], gitDir: lines[2] }
}

/** The `owner/name` of a github.com remote URL (https, ssh or scp-like), else undefined. */
export function githubSlug(url: string | undefined): string | undefined {
  if (!url) return undefined
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(
      url.trim()
    )
  return m ? `${m[1]}/${m[2]}` : undefined
}

/** A remote URL with credentials and `.git` taken off, lower-cased: to compare two remotes. */
export function normalizeRemote(url: string | undefined): string | undefined {
  if (!url) return undefined
  const gh = githubSlug(url)
  if (gh) return `github.com/${gh.toLowerCase()}`
  return url
    .trim()
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, '')
    .replace(/^[^@/]+@([^:]+):/, '$1/')
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}
