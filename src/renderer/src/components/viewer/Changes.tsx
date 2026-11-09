// The viewer's "Changes" tab: the commits, files, diffs and pull requests a
// session produced (git links, read-only). The phone shows the same lists
// without diffs (see mobile/ChangesSheet.tsx).

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Info,
  Link2,
  Link2Off,
  LoaderCircle,
  RefreshCw,
  Search,
  TriangleAlert
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDateTime, formatRelative } from '@shared/format'
import {
  LEVEL_LABEL,
  type CommitDiff,
  type CommitView,
  type DiffFile,
  type PrLink
} from '@shared/git/types'
import type { SessionSummary } from '@shared/types'
import { api } from '@/lib/api'
import { copyText } from '@/lib/actions'
import { LEVEL_CLASS, PR_STATE, levelTitle, shortSha } from '@/lib/git'
import { searchCommit, searchTouched, useGitView } from '@/lib/git-view'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { DiffView } from './DiffView'

/** Called after a search is set from the tab (the phone then goes back to its list). */
const AfterSearch = createContext<(() => void) | undefined>(undefined)

function useSearchTouched(): (path: string) => void {
  const after = useContext(AfterSearch)
  return (path) => {
    searchTouched(path)
    after?.()
  }
}

export function LevelBadge({
  c,
  className
}: {
  c: Pick<CommitView, 'level' | 'reasons'>
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded-[5px] border px-1.5 text-[10.5px] font-medium',
        LEVEL_CLASS[c.level],
        className
      )}
      title={levelTitle(c)}
    >
      {LEVEL_LABEL[c.level]}
    </span>
  )
}

export function PrChip({ pr }: { pr: PrLink }) {
  const st = pr.state ? PR_STATE[pr.state] : undefined
  return (
    <button
      type="button"
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-hover"
      title={pr.url}
      onClick={() => void api.openExternal(pr.url)}
    >
      <GitPullRequest className={cn('size-3.5 shrink-0', st?.cls ?? 'text-muted-foreground')} />
      <span className="font-medium">#{pr.number}</span>
      {pr.title && <span className="truncate text-muted-foreground">{pr.title}</span>}
      {st && <span className={cn('shrink-0 text-2xs font-medium', st.cls)}>{st.label}</span>}
      <ExternalLink className="size-3 shrink-0 text-subtle-foreground" />
    </button>
  )
}

function Notice({ tone, children }: { tone: 'info' | 'warning'; children: React.ReactNode }) {
  const Icon = tone === 'info' ? Info : TriangleAlert
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
        tone === 'info' ? 'border-info/25 bg-info/5' : 'border-warning/25 bg-warning-soft'
      )}
    >
      <Icon
        className={cn('mt-px size-3.5 shrink-0', tone === 'info' ? 'text-info' : 'text-warning')}
      />
      <div className="min-w-0 text-foreground/85">{children}</div>
    </div>
  )
}

const STATUS_FALLBACK: Record<string, string> = {
  'no-folder': "This session doesn't record its folder, so its commits can't be looked up.",
  missing: "This session's folder no longer exists.",
  'not-repo': "This session's folder isn't in a git repository.",
  'no-git': "Git wasn't found, so commits can't be looked up.",
  untrusted: "Git doesn't trust this folder.",
  'distro-stopped': "The session's WSL distro isn't running, so its git isn't asked.",
  error: "Git couldn't read this repo."
}

function FileRow({
  sessionKey,
  sha,
  file,
  canDiff
}: {
  sessionKey: string
  sha: string
  file: CommitView['files'][number]
  canDiff: boolean
}) {
  const touched = useSearchTouched()
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<CommitDiff | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(
    (all: boolean) => {
      setLoading(true)
      void api
        .getGitDiff(sessionKey, sha, file.path, all)
        .then(setDiff)
        .catch((e: Error) =>
          setDiff({ sha, files: [], truncated: false, bytes: 0, error: e.message })
        )
        .finally(() => setLoading(false))
    },
    [sessionKey, sha, file.path]
  )
  const toggle = (): void => {
    if (!canDiff) return
    if (!open && !diff) load(false)
    setOpen(!open)
  }
  const df: DiffFile | undefined = diff?.files.find((f) => f.path === file.path) ?? diff?.files[0]
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="group/file flex items-center gap-2 px-3 py-1 text-xs">
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 text-left',
            canDiff && 'hover:text-foreground'
          )}
          onClick={toggle}
          aria-expanded={canDiff ? open : undefined}
          disabled={!canDiff}
        >
          {canDiff ? (
            open ? (
              <ChevronDown className="size-3 shrink-0 text-subtle-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-subtle-foreground" />
            )
          ) : (
            <FileCode2 className="size-3 shrink-0 text-subtle-foreground" />
          )}
          <span
            className="truncate font-mono text-[11.5px]"
            title={file.from ? `${file.from} → ${file.path}` : file.path}
          >
            {file.from ? `${file.from} → ` : ''}
            {file.path}
          </span>
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {file.add === undefined ? (
            <span className="text-subtle-foreground">binary</span>
          ) : (
            <>
              <span className="text-[var(--hl-addition)]">+{file.add}</span>{' '}
              <span className="text-[var(--hl-deletion)]">−{file.del ?? 0}</span>
            </>
          )}
        </span>
        <Tooltip content="Sessions that touched this file">
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-subtle-foreground opacity-0 group-hover/file:opacity-100 hover:bg-hover hover:text-foreground focus:opacity-100"
            aria-label="Sessions that touched this file"
            onClick={() => touched(file.path)}
          >
            <Search className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      {open && (
        <div className="mx-3 mb-2 overflow-hidden rounded-md border border-code-border bg-code-bg">
          {loading && !diff ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Loading the diff…
            </div>
          ) : diff?.error ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">{diff.error}</div>
          ) : df ? (
            <>
              <DiffView file={df} />
              {diff?.truncated && (
                <button
                  type="button"
                  className="w-full border-t border-code-border/70 py-1.5 text-center text-xs font-medium text-primary hover:bg-hover"
                  onClick={() => load(true)}
                  disabled={loading}
                >
                  This diff was cut at {Math.round(diff.bytes / 1024)} KB. Load the whole diff
                </button>
              )}
            </>
          ) : (
            <div className="px-3 py-2 text-xs text-muted-foreground">No changes to show.</div>
          )}
        </div>
      )}
    </div>
  )
}

function CommitRow({
  sessionKey,
  c,
  github,
  action
}: {
  sessionKey: string
  c: CommitView
  github?: string
  action: 'unlink' | 'relink' | 'none'
}) {
  const [open, setOpen] = useState(false)
  const canDiff = !api.remote && !c.unknown
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded p-0.5 text-subtle-foreground hover:bg-hover hover:text-foreground disabled:opacity-40"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? 'Hide files' : 'Show files'}
          disabled={!c.files.length}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium" title={c.subject}>
              {c.subject || <span className="italic text-muted-foreground">(no message)</span>}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted-foreground">
            <LevelBadge c={c} />
            <button
              type="button"
              className="inline-flex items-center gap-1 font-mono text-[11px] hover:text-foreground"
              title="Copy the full SHA"
              onClick={() => void copyText(c.sha, 'SHA copied ✓')}
            >
              <GitCommitHorizontal className="size-3" />
              {shortSha(c.sha)}
            </button>
            <span title={c.at}>{formatDateTime(c.at)}</span>
            {c.branches.slice(0, 3).map((b) => (
              <span
                key={b}
                className="inline-flex max-w-48 items-center gap-1 truncate font-mono text-[11px]"
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{b}</span>
              </span>
            ))}
            {c.pr !== undefined && github && (
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => void api.openExternal(`https://github.com/${github}/pull/${c.pr}`)}
              >
                <GitPullRequest className="size-3" /> #{c.pr}
              </button>
            )}
            {!c.unknown && (
              <span className="font-mono text-[11px] tabular-nums">
                <span className="text-[var(--hl-addition)]">+{c.add}</span>{' '}
                <span className="text-[var(--hl-deletion)]">−{c.del}</span>
                <span className="ml-1.5 text-subtle-foreground">
                  {c.files.length + (c.moreFiles ?? 0)} file
                  {c.files.length + (c.moreFiles ?? 0) === 1 ? '' : 's'}
                </span>
              </span>
            )}
            {c.unknown && (
              <span className="italic">seen in the session; the repo isn't available</span>
            )}
            {c.parents > 1 && <span className="text-subtle-foreground">merge</span>}
          </div>
        </div>
        {!api.remote && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="Commit actions"
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => void copyText(c.sha, 'SHA copied ✓')}>
                <Copy /> Copy SHA
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void searchCommit(c.sha)}>
                <Search /> Sessions linked to this commit
              </DropdownMenuItem>
              {action === 'unlink' && (
                <DropdownMenuItem
                  onSelect={() =>
                    void api
                      .unlinkCommit(sessionKey, c.sha)
                      .then(() =>
                        toast.success('Unlinked', {
                          description: "It's listed under Unlinked, where you can link it again."
                        })
                      )
                  }
                >
                  <Link2Off /> Unlink from this session
                </DropdownMenuItem>
              )}
              {action === 'relink' && (
                <DropdownMenuItem onSelect={() => void api.relinkCommit(sessionKey, c.sha)}>
                  <Link2 /> Link again
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {open && c.files.length > 0 && (
        <div className="border-t border-border/70 pb-1">
          {c.files.map((f) => (
            <FileRow
              key={`${f.from ?? ''}>${f.path}`}
              sessionKey={sessionKey}
              sha={c.sha}
              file={f}
              canDiff={canDiff}
            />
          ))}
          {c.moreFiles ? (
            <div className="px-3 py-1 text-2xs text-subtle-foreground">
              …and {c.moreFiles} more files
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  count,
  defaultOpen,
  children,
  hint
}: {
  title: string
  count: number
  defaultOpen: boolean
  children: React.ReactNode
  hint?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (!count) return null
  return (
    <section className="mt-5">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title}
        <span className="font-normal tabular-nums">({count})</span>
      </button>
      {hint && open && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </section>
  )
}

/** The "Look up PRs with the GitHub CLI?" question, asked once (desktop). */
function GhQuestion() {
  const [busy, setBusy] = useState(false)
  const choose = (gh: 'on' | 'off'): void => {
    setBusy(true)
    void api
      .updateGitSettings({ gh })
      .catch((e: Error) => toast.error("Couldn't save", { description: e.message }))
      .finally(() => setBusy(false))
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/25 bg-accent-soft px-3 py-2.5 text-xs sm:flex-row sm:items-center">
      <GitPullRequest className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 text-foreground/85">
        <span className="font-medium">Look up pull requests with your GitHub CLI?</span> The app
        runs <code className="font-mono">gh pr list</code> (read-only) for the branches of sessions
        in GitHub repos. gh talks to GitHub; nothing else leaves your PC. You can change this in
        Settings → Git.
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => choose('on')}>
          Look up PRs
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => choose('off')}>
          Not now
        </Button>
      </div>
    </div>
  )
}

export function ChangesPanel({
  session,
  className,
  onSearch
}: {
  session: SessionSummary
  className?: string
  /** After "Sessions that touched this file" set the search (the phone goes back to its list). */
  onSearch?: () => void
}) {
  return (
    <AfterSearch.Provider value={onSearch}>
      <Changes session={session} className={className} />
    </AfterSearch.Provider>
  )
}

function Changes({ session, className }: { session: SessionSummary; className?: string }) {
  const touched = useSearchTouched()
  const version = `${session.sizeBytes}|${session.lastActivityAt}|${session.git?.commits ?? 0}|${session.meta.gitUnlinked?.length ?? 0}`
  const view = useGitView(session.key, version)
  const [refreshing, setRefreshing] = useState(false)
  const files = useMemo(() => {
    const m = new Map<string, { path: string; commits: number; add: number; del: number }>()
    for (const c of view?.commits ?? [])
      for (const f of c.files) {
        const e = m.get(f.path) ?? { path: f.path, commits: 0, add: 0, del: 0 }
        e.commits++
        e.add += f.add ?? 0
        e.del += f.del ?? 0
        m.set(f.path, e)
      }
    return [...m.values()].sort((a, b) => a.path.localeCompare(b.path))
  }, [view])

  if (view === undefined)
    return (
      <div className="mx-auto flex max-w-[860px] items-center gap-2 px-8 py-10 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Looking for this session's commits…
      </div>
    )
  if (view === null)
    return (
      <div className="mx-auto max-w-[860px] px-8 py-10 text-sm text-muted-foreground">
        No git information for this session.
      </div>
    )
  if (!view.enabled)
    return (
      <div className="mx-auto max-w-[860px] px-8 py-10 text-sm text-muted-foreground">
        Git links are off. Turn them on in Settings → Git to see the commits and pull requests each
        session made.
      </div>
    )

  const totals = view.commits.reduce((t, c) => ({ add: t.add + c.add, del: t.del + c.del }), {
    add: 0,
    del: 0
  })
  const refresh = (): void => {
    setRefreshing(true)
    void api.refreshGit(session.key).finally(() => setRefreshing(false))
  }
  const busy = refreshing || view.busy

  return (
    <div className={cn('mx-auto max-w-[860px] px-8 pt-5 pb-16', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {view.repo ? (
          <span
            className="inline-flex min-w-0 items-center gap-1.5"
            title={view.repo.remote ?? view.repo.root}
          >
            <FolderGit2 className="size-3.5 shrink-0 text-subtle-foreground" />
            <span className="selectable truncate font-mono text-[11.5px]">{view.repo.root}</span>
            <span className="shrink-0 text-subtle-foreground">· {view.repo.env}</span>
            {view.repo.github && (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 hover:text-foreground"
                onClick={() => void api.openExternal(`https://github.com/${view.repo!.github}`)}
              >
                · {view.repo.github} <ExternalLink className="size-3" />
              </button>
            )}
          </span>
        ) : null}
        {view.branches.length > 0 && (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <GitBranch className="size-3.5 shrink-0 text-subtle-foreground" />
            <span className="truncate font-mono text-[11.5px]">{view.branches.join(', ')}</span>
          </span>
        )}
        <span className="ml-auto inline-flex shrink-0 items-center gap-2">
          {view.checkedAt && (
            <span className="text-subtle-foreground">Checked {formatRelative(view.checkedAt)}</span>
          )}
          {!api.remote && (
            <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
              <RefreshCw className={cn(busy && 'animate-spin')} /> Refresh
            </Button>
          )}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {view.status !== 'ok' && view.status !== 'pending' && (
          <Notice
            tone={view.status === 'not-repo' || view.status === 'no-folder' ? 'info' : 'warning'}
          >
            {view.message ?? STATUS_FALLBACK[view.status]}
          </Notice>
        )}
        {view.repo?.note && <Notice tone="info">{view.repo.note}</Notice>}
        {view.repo?.truncated && (
          <Notice tone="info">
            This repo has a lot of history: only the latest 5,000 commits of its sessions' time were
            read, so older matches may be missing.
          </Notice>
        )}
        {!api.remote && view.gh === 'ask' && view.repo?.github && <GhQuestion />}
        {view.gh === 'missing' && view.repo?.github && (
          <Notice tone="info">
            The GitHub CLI (gh) isn't installed, so PR links come only from the session's own output
            and merge commits.
          </Notice>
        )}
        {view.gh === 'signed-out' && view.repo?.github && (
          <Notice tone="info">
            The GitHub CLI isn't signed in (run <code className="font-mono">gh auth login</code>),
            so PR links come only from the session's own output and merge commits.
          </Notice>
        )}
      </div>

      {view.prs.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {view.prs.map((p) => (
            <PrChip key={p.number} pr={p} />
          ))}
        </div>
      )}

      {view.commits.length > 0 ? (
        <section className="mt-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Commits <span className="font-normal tabular-nums">({view.commits.length})</span>
            </h3>
            {files.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
                <span className="text-[var(--hl-addition)]">+{totals.add}</span>{' '}
                <span className="text-[var(--hl-deletion)]">−{totals.del}</span>
              </span>
            )}
          </div>
          <div className="mt-2 space-y-2">
            {view.commits.map((c) => (
              <CommitRow
                key={c.sha}
                sessionKey={session.key}
                c={c}
                github={view.repo?.github}
                action={c.unknown ? 'none' : 'unlink'}
              />
            ))}
          </div>
        </section>
      ) : (
        view.status === 'ok' && (
          <div className="mt-6 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {view.busy ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="size-4 animate-spin" /> Reading the repo…
              </span>
            ) : (
              <>
                No commits were linked to this session.
                <div className="mt-1 text-xs">
                  Commits count when the session's own output shows them, or when they were made
                  while it was active (on its branch, or touching files it edited).
                </div>
              </>
            )}
          </div>
        )
      )}

      <Section title="Files changed" count={files.length} defaultOpen={false}>
        <div className="rounded-lg border border-border bg-card">
          {files.map((f) => (
            <div
              key={f.path}
              className="group/file flex items-center gap-2 border-t border-border/60 px-3 py-1 text-xs first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={f.path}>
                {f.path}
              </span>
              <span className="shrink-0 text-2xs text-subtle-foreground">
                {f.commits} commit{f.commits === 1 ? '' : 's'}
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums">
                <span className="text-[var(--hl-addition)]">+{f.add}</span>{' '}
                <span className="text-[var(--hl-deletion)]">−{f.del}</span>
              </span>
              <Tooltip content="Sessions that touched this file">
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-subtle-foreground hover:bg-hover hover:text-foreground"
                  aria-label="Sessions that touched this file"
                  onClick={() => touched(f.path)}
                >
                  <Search className="size-3.5" />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Edited, not in a linked commit"
        count={view.uncommitted.length}
        defaultOpen={false}
        hint="Files the session edited that none of its linked commits changed (not committed yet, committed later by someone else, or reverted)."
      >
        <div className="rounded-lg border border-border bg-card">
          {view.uncommitted.map((p) => (
            <div
              key={p}
              className="flex items-center gap-2 border-t border-border/60 px-3 py-1 text-xs first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={p}>
                {p}
              </span>
              <Tooltip content="Sessions that touched this file">
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-subtle-foreground hover:bg-hover hover:text-foreground"
                  aria-label="Sessions that touched this file"
                  onClick={() => touched(p)}
                >
                  <Search className="size-3.5" />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Possible"
        count={view.possible.length}
        defaultOpen={false}
        hint="Made while this session was active, with nothing else pointing to it. Not counted in the session's badge."
      >
        {view.possible.map((c) => (
          <CommitRow
            key={c.sha}
            sessionKey={session.key}
            c={c}
            github={view.repo?.github}
            action="unlink"
          />
        ))}
      </Section>

      <Section
        title="Unlinked"
        count={view.unlinked.length}
        defaultOpen={false}
        hint="Commits you unlinked from this session."
      >
        {view.unlinked.map((c) => (
          <CommitRow
            key={c.sha}
            sessionKey={session.key}
            c={c}
            github={view.repo?.github}
            action="relink"
          />
        ))}
      </Section>
    </div>
  )
}
