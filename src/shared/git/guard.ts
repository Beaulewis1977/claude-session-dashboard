// The read-only guard for git and gh: every argument list the app runs is
// checked here first (see main/git/runner.ts, the only place that starts
// either program). Anything not on these allow-lists throws, so no command
// that writes (commit, fetch, checkout, gc, config set, `log --output`, …)
// can ever run, whatever builds the arguments.

import { LOG_FORMAT, REF_FORMAT } from './log'

export class GuardError extends Error {}

/**
 * Settings every git call starts with: no fsmonitor (it can start a program),
 * paths printed as they are, no signature checks (gpg), no colours, no
 * external diff program, no pager.
 */
export const SAFE_GIT_CONFIG = [
  'core.fsmonitor=false',
  'core.quotePath=false',
  'log.showSignature=false',
  'color.ui=false',
  'diff.external=',
  'core.pager=cat',
  // No automatic maintenance or gc (they write), whatever the repo's config says.
  'maintenance.auto=false',
  'gc.auto=0'
] as const

export const GIT_PREFIX: readonly string[] = [
  '--no-pager',
  ...SAFE_GIT_CONFIG.flatMap((c) => ['-c', c])
]

/** A git command for a folder: the safe prefix, `-C <dir>`, then the subcommand. */
export function gitArgs(dir: string, sub: readonly string[]): string[] {
  return [...GIT_PREFIX, '-C', dir, ...sub]
}

const SHA = /^[0-9a-f]{7,64}$/
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

const REV_PARSE_FLAGS = new Set([
  '--path-format=absolute',
  '--show-toplevel',
  '--git-common-dir',
  '--git-dir',
  '--absolute-git-dir',
  '--is-shallow-repository',
  '--is-inside-work-tree',
  '--show-prefix'
])

/** A merge commit is compared with its first parent (what the merge brought in), in history and diffs alike. */
export const DIFF_MERGES = '--diff-merges=first-parent'

/** A submodule's change is its commit id only: its own objects are never read (whatever diff.submodule says). */
export const SUBMODULE_SHORT = '--submodule=short'

/**
 * The settings that make a repo a partial clone (a promisor remote git would
 * fetch missing objects from). Read before anything else of a repo.
 */
export const PARTIAL_CLONE_KEYS = '^(extensions\\.partialclone|remote\\..+\\.promisor)$'

const LOG_FLAGS = new Set([
  '--no-color',
  '--numstat',
  '-M',
  '--no-renames',
  '--date-order',
  '--branches',
  '--remotes',
  '--tags',
  '--not',
  '--ignore-missing',
  '--no-walk',
  '--no-ext-diff',
  '--no-textconv',
  DIFF_MERGES,
  SUBMODULE_SHORT
])

const SHOW_FLAGS = new Set([
  '--patch',
  '--no-color',
  '-M',
  '--no-ext-diff',
  '--no-textconv',
  '--format=',
  DIFF_MERGES,
  SUBMODULE_SHORT,
  '--src-prefix=a/',
  '--dst-prefix=b/'
])

const CONFIG_KEYS = new Set(['user.email', 'remote.origin.url'])
const CONFIG_REGEXPS = new Set(['^remote\\..*\\.url$', PARTIAL_CLONE_KEYS])
const REF_PATTERNS = new Set(['refs/heads', 'refs/remotes', 'refs/tags'])

function fail(why: string): never {
  throw new GuardError(`Refused git command: ${why}`)
}

function noLeadingDash(v: string | undefined, what: string): string {
  if (!v || v.startsWith('-')) fail(`bad ${what}`)
  return v
}

function needs(rest: readonly string[], ...flags: string[]): void {
  for (const f of flags) if (!rest.includes(f)) fail(`missing ${f}`)
}

export function assertReadOnlyGit(args: readonly string[]): void {
  if (args.some((a) => typeof a !== 'string' || a.includes('\0'))) fail('bad argument')
  let i = 0
  let dir = false
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '--no-pager') continue
    if (a === '-c') {
      const v = args[++i]
      if (!(SAFE_GIT_CONFIG as readonly string[]).includes(v)) fail(`config ${v}`)
      continue
    }
    if (a === '-C') {
      noLeadingDash(args[++i], 'folder')
      dir = true
      continue
    }
    if (a.startsWith('-')) fail(`option ${a}`)
    break
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) fail('no command')
  if (sub !== 'version' && !dir) fail('no folder')
  switch (sub) {
    case 'version':
      if (rest.length) fail('version takes no arguments')
      return
    case 'rev-parse':
      for (const a of rest) if (!REV_PARSE_FLAGS.has(a)) fail(`rev-parse ${a}`)
      return
    case 'config':
      if (rest.length === 2 && rest[0] === '--get' && CONFIG_KEYS.has(rest[1])) return
      if (rest.length === 2 && rest[0] === '--get-regexp' && CONFIG_REGEXPS.has(rest[1])) return
      if (
        rest.length === 3 &&
        rest[0] === '--null' &&
        rest[1] === '--get-regexp' &&
        rest[2] === PARTIAL_CLONE_KEYS
      )
        return
      fail('config may only be read')
      return
    case 'for-each-ref':
      if (rest[0] !== `--format=${REF_FORMAT}`) fail('for-each-ref format')
      for (const a of rest.slice(1)) if (!REF_PATTERNS.has(a)) fail(`for-each-ref ${a}`)
      return
    case 'log': {
      needs(rest, '--no-ext-diff', '--no-textconv', SUBMODULE_SHORT)
      for (const a of rest) {
        if (LOG_FLAGS.has(a) || a === 'HEAD' || SHA.test(a)) continue
        if (a === `--format=${LOG_FORMAT}`) continue
        if (/^--max-count=\d{1,6}$/.test(a)) continue
        const since = /^--(?:since|until)=(.*)$/.exec(a)
        if (since && ISO_TIME.test(since[1])) continue
        fail(`log ${a}`)
      }
      return
    }
    case 'show': {
      needs(rest, '--no-ext-diff', '--no-textconv', '--format=', SUBMODULE_SHORT)
      const sep = rest.indexOf('--')
      const opts = sep >= 0 ? rest.slice(0, sep) : rest
      const paths = sep >= 0 ? rest.slice(sep + 1) : []
      let shas = 0
      for (const a of opts) {
        if (SHOW_FLAGS.has(a)) continue
        if (FULL_SHA.test(a)) {
          shas++
          continue
        }
        fail(`show ${a}`)
      }
      if (shas !== 1) fail('show takes one commit')
      if (sep >= 0 && (paths.length < 1 || paths.length > 50)) fail('show paths')
      for (const p of paths) if (!p || p.startsWith(':')) fail('show path')
      return
    }
    case 'cat-file':
      if (rest.length === 2 && (rest[0] === '-e' || rest[0] === '-t') && SHA.test(rest[1])) return
      fail('cat-file')
      return
    case 'worktree':
      if (rest.length === 2 && rest[0] === 'list' && rest[1] === '--porcelain') return
      fail('worktree may only be listed')
      return
    default:
      fail(`"${sub}" isn't a read-only command the app uses`)
  }
}

// --------------------------------------------------------------------- gh

export const GH_PR_FIELDS = 'number,title,url,state,isDraft,headRefName'
const SLUG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const BRANCH = /^[A-Za-z0-9._/+@-]{1,250}$/

export function ghPrListArgs(
  slug: string,
  by: { head: string } | { search: string },
  limit = 20
): string[] {
  return [
    'pr',
    'list',
    '--repo',
    slug,
    '--state',
    'all',
    '--limit',
    String(limit),
    '--json',
    GH_PR_FIELDS,
    ...('head' in by ? ['--head', by.head] : ['--search', by.search])
  ]
}

export const GH_AUTH_ARGS: readonly string[] = ['auth', 'status', '--hostname', 'github.com']

function failGh(why: string): never {
  throw new GuardError(`Refused gh command: ${why}`)
}

/** gh: only `auth status` and `pr list` with fixed flags. Never `gh api` or anything that writes. */
export function assertReadOnlyGh(args: readonly string[]): void {
  if (args.length === GH_AUTH_ARGS.length && args.every((a, i) => a === GH_AUTH_ARGS[i])) return
  if (args.length !== 12) failGh('unexpected arguments')
  const fixed: [number, string][] = [
    [0, 'pr'],
    [1, 'list'],
    [2, '--repo'],
    [4, '--state'],
    [5, 'all'],
    [6, '--limit'],
    [8, '--json'],
    [9, GH_PR_FIELDS]
  ]
  for (const [i, v] of fixed) if (args[i] !== v) failGh(`argument ${i}`)
  if (!SLUG.test(args[3])) failGh('repository')
  if (!/^\d{1,3}$/.test(args[7]) || Number(args[7]) > 100 || Number(args[7]) < 1) failGh('limit')
  const v = args[11]
  if (args[10] === '--head') {
    if (!BRANCH.test(v) || v.startsWith('-') || v.includes('..')) failGh('branch')
  } else if (args[10] === '--search') {
    if (!/^[0-9a-f]{7,40}$/.test(v)) failGh('search')
  } else failGh('filter')
}
