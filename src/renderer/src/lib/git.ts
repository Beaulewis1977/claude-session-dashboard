// Display helpers for git links (Changes tab, badges, phone).

import { LEVEL_LABEL, type CommitView, type LinkLevel, type LinkReason, type PrLink } from '@shared/git/types'

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** One line per reason, for the confidence badge's tooltip. */
export function reasonText(r: LinkReason): string {
  switch (r.kind) {
    case 'trailer':
      return 'The commit names this session (Claude-Session trailer)'
    case 'seen':
      return r.how === 'commit-line'
        ? "The session's own git commit printed this commit"
        : 'The session printed this SHA right after committing, while the commit was made'
    case 'rewritten':
      return 'A rebased or cherry-picked copy of a commit this session made'
    case 'branch':
      return `On the session's branch (${r.branch})`
    case 'files':
      return `Touches ${r.count} of its ${r.of} file${r.of === 1 ? '' : 's'} that the session edited`
    case 'time':
      return 'Made while the session was active'
    case 'shared':
      return `Also matches ${r.others} other session${r.others === 1 ? '' : 's'} as well (one level lower)`
    case 'subagent':
      return `Made by a subagent of this session${r.title ? ` (${r.title})` : ''}`
  }
}

export function levelTitle(c: Pick<CommitView, 'level' | 'reasons'>): string {
  return [`${LEVEL_LABEL[c.level]} match`, ...c.reasons.map((r) => `• ${reasonText(r)}`)].join('\n')
}

export const LEVEL_CLASS: Record<LinkLevel, string> = {
  exact: 'border-success/30 bg-success/10 text-success',
  high: 'border-primary/25 bg-accent-soft text-primary',
  medium: 'border-info/25 bg-info/5 text-info',
  low: 'border-border bg-secondary text-muted-foreground'
}

export const PR_STATE: Record<NonNullable<PrLink['state']>, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'text-success' },
  draft: { label: 'Draft', cls: 'text-muted-foreground' },
  merged: { label: 'Merged', cls: 'text-[#8250df] dark:text-[#a371f7]' },
  closed: { label: 'Closed', cls: 'text-destructive' }
}

/** The highlight.js language for a file, by its extension (undefined: plain text). */
export function langFor(path: string): string | undefined {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name === 'makefile') return name === 'makefile' ? 'makefile' : undefined
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    md: 'markdown',
    mdx: 'markdown',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    cs: 'csharp',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    sql: 'sql',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    lua: 'lua',
    r: 'r',
    pl: 'perl',
    graphql: 'graphql',
    gql: 'graphql'
  }
  return map[ext]
}
