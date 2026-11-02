import { SourceBadge } from '../SourceBadge'
import { memo, type MouseEvent } from 'react'
import {
  Archive,
  CornerDownRight,
  EyeOff,
  GitBranch,
  GitFork,
  MessageSquare,
  Pin,
  Sparkles,
  WifiOff
} from 'lucide-react'
import { summaryLine } from '@shared/summary'
import type { SearchHit } from '@shared/api'
import type { SessionSummary } from '@shared/types'
import { formatDateTime, formatRelative } from '@shared/format'
import { tagColor } from '@/lib/filters'
import { cn } from '@/lib/utils'
import { EnvDot } from '../EnvBadge'
import { BillingBadge } from '../BillingPicker'
import { RemoteBadge } from '../RemoteBadge'
import { ModelChoiceBadge } from '../ModelPicker'
import { useModelChoice } from '@/lib/model-choice'

export const ROW_HEIGHT = 104

function dateSpan(s: SessionSummary): string {
  const start = formatDateTime(s.startedAt)
  if (!s.lastActivityAt) return start
  const end = formatDateTime(s.lastActivityAt)
  const sameDay =
    s.startedAt &&
    new Date(s.startedAt).toDateString() === new Date(s.lastActivityAt).toDateString()
  return `${start} → ${sameDay ? end.replace(/^.*?\d{4} /, '') : end}`
}

function preview(s: SessionSummary): { text: string; muted: boolean; summary?: boolean } {
  if (s.meta.description) return { text: s.meta.description.split('\n')[0], muted: false }
  // The AI summary's one line (where to pick up, else what was done).
  if (s.meta.aiSummary) {
    const line = summaryLine(s.meta.aiSummary)
    if (line) return { text: line, muted: false, summary: true }
  }
  // My dashboard name is the title: show what Claude Code calls it.
  if (s.titleSource === 'name' && s.claudeName && s.claudeName !== s.title)
    return { text: `Claude Code: ${s.claudeName}`, muted: true }
  if (s.titleSource !== 'first-prompt' && s.firstPrompt) return { text: s.firstPrompt, muted: true }
  if (s.titleSource !== 'summary' && s.summary) return { text: s.summary, muted: true }
  return { text: '', muted: true }
}

export const SessionRow = memo(function SessionRow({
  session: s,
  selected,
  checked = false,
  multi = false,
  hit,
  depth = 0,
  branches = 0,
  onSelect,
  onOpen
}: {
  session: SessionSummary
  selected: boolean
  /** Picked for a bulk action. */
  checked?: boolean
  /** Sessions are being picked: `selected` is then only the focused row. */
  multi?: boolean
  hit?: SearchHit
  /** > 0: shown as a branch under the row above. */
  depth?: number
  /** Number of sessions branched from this one. */
  branches?: number
  /** Gets the mouse event, for Ctrl/Shift+click and right-click. */
  onSelect: (key: string, e: MouseEvent) => void
  onOpen: (key: string) => void
}) {
  const p = preview(s)
  const tags = s.meta.tags ?? []
  const indent = Math.min(depth, 3) * 14
  const choice = useModelChoice(s)
  return (
    <div
      role="option"
      aria-selected={multi ? checked : selected}
      id={`row-${s.key}`}
      onMouseDown={(e) => onSelect(s.key, e)}
      onDoubleClick={() => onOpen(s.key)}
      className={cn(
        'group relative mx-2 flex h-[98px] flex-col justify-center gap-[3px] rounded-lg px-3 transition-colors duration-75',
        checked || (selected && !multi) ? 'bg-selected' : 'hover:bg-hover',
        // The focused row while picking, when it isn't picked itself.
        multi && selected && !checked && 'ring-1 ring-primary/50 ring-inset'
      )}
      style={indent ? { paddingLeft: 12 + indent } : undefined}
    >
      {selected && (
        <span className="absolute top-3 bottom-3 left-0 w-[3px] rounded-full bg-primary" />
      )}
      <div className="flex items-center gap-2">
        {depth > 0 ? (
          <CornerDownRight
            className="-ml-0.5 size-3 shrink-0 text-subtle-foreground"
            aria-label="Branch"
          />
        ) : (
          <EnvDot env={s.env} />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] font-medium',
            s.meta.hidden && 'text-muted-foreground'
          )}
        >
          {s.title}
        </span>
        {s.meta.pinned && (
          <Pin className="size-3 shrink-0 fill-current text-primary" aria-label="Pinned" />
        )}
        <span
          className="shrink-0 text-2xs text-subtle-foreground tabular-nums"
          title={formatDateTime(s.lastActivityAt)}
        >
          {formatRelative(s.lastActivityAt ?? s.startedAt)}
        </span>
      </div>
      <div
        className={cn(
          'truncate pl-3.5 text-xs',
          p.muted ? 'text-subtle-foreground' : 'text-muted-foreground'
        )}
      >
        {p.summary && (
          <Sparkles className="mr-1 -mt-px inline size-3 text-primary/80" aria-label="Summary" />
        )}
        {p.text || <span className="italic">No description</span>}
      </div>
      <div className="flex min-w-0 items-center gap-2.5 pl-3.5 text-2xs text-muted-foreground">
        <span
          className="max-w-[40%] shrink-0 truncate font-medium text-foreground/70"
          title={s.cwd}
        >
          {s.projectName}
        </span>
        {s.gitBranch && (
          <span className="inline-flex min-w-0 items-center gap-1">
            <GitBranch className="size-3 shrink-0 text-subtle-foreground" />
            <span className="truncate font-mono text-[10.5px]">{s.gitBranch}</span>
          </span>
        )}
        <span className="inline-flex shrink-0 items-center gap-1">
          <MessageSquare className="size-3 text-subtle-foreground" />
          {s.messageCount}
        </span>
        {tags.length > 0 && (
          <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden">
            {tags.slice(0, 3).map((t) => (
              <span key={t} className="inline-flex shrink-0 items-center gap-1">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: tagColor(t) }} />
                {t}
              </span>
            ))}
            {tags.length > 3 && <span className="text-subtle-foreground">+{tags.length - 3}</span>}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-3.5 text-2xs text-subtle-foreground">
        <span className="truncate tabular-nums">{dateSpan(s)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {branches > 0 && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1 text-[10px] font-medium text-primary tabular-nums"
              title={`${branches} branch${branches === 1 ? '' : 'es'}`}
            >
              <GitFork className="size-2.5" />
              {branches}
            </span>
          )}
          <RemoteBadge session={s} compact />
          {s.availability !== 'imported' && <ModelChoiceBadge choice={choice} compact />}
          <SourceBadge source={s.source} reason={s.sourceReason} compact />
          <BillingBadge billing={s.billing} compact />
          {hit &&
            hit.fields.includes('text') &&
            !hit.fields.some((f) => f !== 'text' && f !== 'project') && (
              <span className="rounded bg-accent-soft px-1 text-[10px] font-medium text-primary">
                in messages
              </span>
            )}
          {s.availability === 'archived-only' && (
            <span
              className="inline-flex items-center gap-1 rounded bg-warning-soft px-1 text-[10px] font-medium text-warning"
              title="The original file is gone; only the app's archive copy remains"
            >
              <Archive className="size-2.5" /> Archived only
            </span>
          )}
          {s.availability === 'source-offline' && (
            <span
              className="inline-flex items-center gap-1 rounded bg-secondary px-1 text-[10px] font-medium"
              title="Source can't be read right now"
            >
              <WifiOff className="size-2.5" /> Offline
            </span>
          )}
          {s.meta.hidden && <EyeOff className="size-3" aria-label="Hidden" />}
        </span>
      </div>
    </div>
  )
})
