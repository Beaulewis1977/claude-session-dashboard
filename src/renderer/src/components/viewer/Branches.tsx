import { useMemo } from 'react'
import {
  ArrowUpRight,
  CornerLeftUp,
  GitBranch,
  GitBranchPlus,
  Info,
  MessageSquare
} from 'lucide-react'
import type { LineageVia } from '@shared/lineage'
import type { BranchPreview, SessionSummary } from '@shared/types'
import { formatDateTime, formatRelative } from '@shared/format'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Tooltip } from '../ui/tooltip'

const VIA_LABEL: Record<LineageVia, string> = {
  app: 'Branched in this app',
  fork: 'Forked in this app',
  continue: 'Continued fresh from a summary',
  'claude-branch': "Claude Code's /branch",
  copy: 'Copied by Claude Code',
  'shared-history': 'Fork found from shared messages'
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'a tool'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function snapNote(b: BranchPreview, mode: 'include' | 'before'): string | undefined {
  const tools = list(b.snapTools)
  const many = b.snapTools.length > 1
  if (b.snapped === 'forward')
    return `This message calls ${tools}. ${many ? 'Their results are' : 'Its result is'} included too, so each tool call stays with its result.`
  if (b.snapped === 'backward')
    return mode === 'before'
      ? `The message just before this one is waiting for ${tools} to finish, so the branch ends at the last point where every tool call has its result.`
      : `${tools} in this message ${many ? 'finish' : 'finishes'} only after a later message, so the branch ends at the last point before it where every tool call has its result.`
  return undefined
}

/** What a new branch will keep, shown in the launch dialog. */
export function BranchPointCard({
  branch,
  mode
}: {
  branch?: BranchPreview
  mode: 'include' | 'before'
}) {
  if (!branch) {
    return (
      <div className="h-[104px] animate-pulse rounded-lg border border-border bg-secondary/60" />
    )
  }
  const note = snapNote(branch, mode)
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="bg-secondary/60 px-3 py-2.5">
        <div className="flex items-center gap-2 text-2xs text-subtle-foreground">
          <span className="font-medium text-muted-foreground">
            {branch.atRole === 'user' ? 'You' : 'Claude'}
          </span>
          {branch.atTime && <span>{formatDateTime(branch.atTime)}</span>}
          <span className="ml-auto inline-flex items-center gap-1 tabular-nums">
            <MessageSquare className="size-3" />
            Keeps {branch.keptMessages} of {branch.totalMessages} messages
          </span>
        </div>
        <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-foreground/90">
          {branch.atPreview || <span className="italic text-muted-foreground">(no text)</span>}
        </div>
      </div>
      {note && (
        <div className="flex items-start gap-2 border-t border-info/20 bg-info/5 px-3 py-2 text-xs text-foreground/85">
          <Info className="mt-px size-3.5 shrink-0 text-info" />
          {note}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs">
        <GitBranchPlus className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{branch.name}</span>
        <span
          className="selectable min-w-0 truncate font-mono text-[11px] text-muted-foreground"
          title={branch.targetPath}
        >
          …
          {branch.targetPath
            .split(/[\\/]/)
            .slice(-2)
            .join(branch.targetPath.includes('\\') ? '\\' : '/')}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail panel: where this session came from, and its family tree.

interface TreeRow {
  s: SessionSummary
  depth: number
  /** For each ancestor level: does a line continue past this row? */
  guides: boolean[]
  last: boolean
}

function buildTree(
  rootKey: string,
  byKey: Map<string, SessionSummary>,
  children: Map<string, SessionSummary[]>,
  limit = 60
): TreeRow[] {
  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const walk = (key: string, depth: number, guides: boolean[], last: boolean): void => {
    const s = byKey.get(key)
    if (!s || seen.has(key) || rows.length >= limit) return
    seen.add(key)
    rows.push({ s, depth, guides, last })
    const kids = children.get(key) ?? []
    kids.forEach((c, i) =>
      walk(c.key, depth + 1, depth === 0 ? [] : [...guides, !last], i === kids.length - 1)
    )
  }
  walk(rootKey, 0, [], true)
  return rows
}

const LINE = 'absolute left-[7px] w-px bg-border-strong'

function TreeLine({ row }: { row: TreeRow }) {
  return (
    <>
      {row.guides.map((g, i) => (
        <span key={i} className="relative w-4 shrink-0 self-stretch">
          {g && <span className={cn(LINE, 'top-0 bottom-0')} />}
        </span>
      ))}
      {row.depth > 0 && (
        <span className="relative w-4 shrink-0 self-stretch">
          <span className={cn(LINE, 'top-0', row.last ? 'h-1/2' : 'bottom-0')} />
          <span className="absolute top-1/2 left-[7px] h-px w-[7px] bg-border-strong" />
        </span>
      )}
    </>
  )
}

function useFamily(session: SessionSummary) {
  const sessions = useApp((s) => s.sessions)
  return useMemo(() => {
    const byKey = new Map(sessions.map((s) => [s.key, s]))
    const children = new Map<string, SessionSummary[]>()
    for (const s of sessions) {
      const p = s.lineage?.parentKey
      if (!p || !byKey.has(p)) continue
      const c = children.get(p) ?? []
      c.push(s)
      children.set(p, c)
    }
    const when = (s: SessionSummary) => s.meta.branch?.createdAt ?? s.lastActivityAt ?? ''
    for (const c of children.values()) c.sort((a, b) => when(a).localeCompare(when(b)))
    let root = session.key
    const seen = new Set([root])
    for (let p = byKey.get(root)?.lineage?.parentKey; p && byKey.has(p) && !seen.has(p);) {
      seen.add(p)
      root = p
      p = byKey.get(root)?.lineage?.parentKey
    }
    const parentKey = session.lineage?.parentKey
    return {
      parent: parentKey ? byKey.get(parentKey) : undefined,
      children: children.get(session.key) ?? [],
      rows: buildTree(root, byKey, children)
    }
  }, [sessions, session])
}

export function BranchesPanel({
  session,
  atPreview
}: {
  session: SessionSummary
  /** Text of the branch point message, if the transcript is loaded. */
  atPreview?: string
}) {
  const select = useApp((s) => s.select)
  const { parent, children, rows } = useFamily(session)
  const lineage = session.lineage
  if (!lineage && children.length === 0) return null
  const at = lineage ? (session.meta.branch?.atPreview ?? atPreview) : undefined

  return (
    <section
      aria-label="Branches"
      className="mt-3 overflow-hidden rounded-lg border border-border bg-background"
    >
      <div className="flex items-center gap-2 border-b border-border bg-secondary/50 px-3 py-1.5">
        <GitBranch className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Branches</span>
        <span className="text-2xs text-subtle-foreground">
          {rows.length > 1
            ? `${rows.length} sessions in this family`
            : `${children.length} branch${children.length === 1 ? '' : 'es'}`}
        </span>
        {lineage?.atMessageId && (
          <button
            type="button"
            onClick={() =>
              document
                .getElementById('branch-start')
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            Jump to branch point
          </button>
        )}
      </div>

      {lineage && (
        <div className="flex items-start gap-2 border-b border-border px-3 py-2 text-xs">
          <CornerLeftUp className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-muted-foreground">
                {lineage.via === 'continue' ? 'Continued from' : 'Branched from'}
              </span>
              {parent ? (
                <button
                  type="button"
                  onClick={() => select(parent.key)}
                  className="inline-flex min-w-0 items-center gap-0.5 truncate font-medium text-primary hover:underline"
                >
                  <span className="truncate">{parent.title}</span>
                  <ArrowUpRight className="size-3 shrink-0" />
                </button>
              ) : (
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  a session that's no longer available ({lineage.parentSessionId.slice(0, 8)})
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-2xs text-subtle-foreground">
              {at ? (
                <>after “{at}” · </>
              ) : lineage.atTime ? (
                <>after the message from {formatDateTime(lineage.atTime)} · </>
              ) : null}
              {lineage.shared ? `${lineage.shared} shared messages · ` : ''}
              {VIA_LABEL[lineage.via]}
              {session.meta.branch?.snapped && ' · moved to keep tool calls whole'}
            </div>
          </div>
        </div>
      )}

      {rows.length > 1 && (
        <div className="max-h-56 overflow-y-auto p-1" role="tree" aria-label="Branch tree">
          {rows.map((row) => {
            const current = row.s.key === session.key
            return (
              <button
                key={row.s.key}
                type="button"
                role="treeitem"
                aria-current={current || undefined}
                onClick={() => select(row.s.key)}
                className={cn(
                  'flex h-7 w-full items-stretch rounded-md px-1.5 text-left text-xs transition-colors',
                  current ? 'bg-selected' : 'hover:bg-hover'
                )}
              >
                <TreeLine row={row} />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      current ? 'bg-primary' : 'border border-border-strong bg-background'
                    )}
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      current ? 'font-medium text-foreground' : 'text-foreground/85'
                    )}
                  >
                    {row.s.title}
                  </span>
                  {current && <span className="shrink-0 text-2xs text-primary">This session</span>}
                  <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums">
                    {row.s.messageCount} msgs · {formatRelative(row.s.lastActivityAt)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Markers in the transcript

export interface BranchMark {
  /** 'start': this session branched off here. 'child': another session branched off here. */
  kind: 'start' | 'child'
  key?: string
  title: string
  time?: string
}

export function BranchMarks({ marks }: { marks: BranchMark[] }) {
  const select = useApp((s) => s.select)
  const start = marks.find((m) => m.kind === 'start')
  const kids = marks.filter((m) => m.kind === 'child')
  return (
    <div className="mt-4 space-y-1.5">
      {start && (
        <div id="branch-start" className="flex items-center gap-3 text-2xs text-subtle-foreground">
          <div className="h-px flex-1 bg-primary/30" />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-accent-soft px-2.5 py-0.5 font-medium text-primary">
            <GitBranchPlus className="size-3" />
            Branch starts here
            {start.key ? (
              <Tooltip content="Everything above is shared with this session">
                <button
                  type="button"
                  onClick={() => start.key && select(start.key)}
                  className="max-w-[260px] truncate font-normal text-primary/80 hover:underline"
                >
                  · from {start.title}
                </button>
              </Tooltip>
            ) : null}
          </span>
          <div className="h-px flex-1 bg-primary/30" />
        </div>
      )}
      {kids.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {kids.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => k.key && select(k.key)}
              title={k.time ? `Branched ${formatDateTime(k.time)}` : undefined}
              className="inline-flex max-w-[320px] items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-0.5 text-2xs text-muted-foreground shadow-xs transition-colors hover:bg-hover hover:text-foreground"
            >
              <GitBranch className="size-3 shrink-0 text-primary" />
              <span className="truncate">
                <span className="font-medium text-foreground/85">{k.title}</span> branched here
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
