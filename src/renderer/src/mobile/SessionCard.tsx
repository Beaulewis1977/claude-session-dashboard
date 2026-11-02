import { memo, useRef, useState } from 'react'
import { Archive, EyeOff, GitBranch, MessageSquare, Pin, PinOff, Eye } from 'lucide-react'
import type { SessionSummary } from '@shared/types'
import { formatRelative } from '@shared/format'
import { summaryLine } from '@shared/summary'
import { tagColor } from '@/lib/filters'
import { cn } from '@/lib/utils'
import { EnvDot } from '@/components/EnvBadge'
import { RemoteBadge } from '@/components/RemoteBadge'
import { SourceBadge } from '@/components/SourceBadge'
import { ModelChoiceBadge } from '@/components/ModelPicker'
import { useModelChoice } from '@/lib/model-choice'

const ACTIONS_WIDTH = 144

function preview(s: SessionSummary): string {
  if (s.meta.description) return s.meta.description.split('\n')[0]
  // The AI summary's one line (where to pick up, else what was done).
  const line = s.meta.aiSummary ? summaryLine(s.meta.aiSummary) : ''
  if (line) return line
  if (s.titleSource !== 'first-prompt' && s.firstPrompt) return s.firstPrompt
  if (s.titleSource !== 'summary' && s.summary) return s.summary
  return ''
}

/**
 * A session as a card. Tap opens it; swipe left shows Pin and Hide (the same
 * as the desktop's menu).
 */
export const SessionCard = memo(function SessionCard({
  session: s,
  onOpen,
  onPin,
  onHide,
  readOnly
}: {
  session: SessionSummary
  onOpen: (key: string) => void
  onPin: (key: string) => void
  onHide: (key: string) => void
  readOnly: boolean
}) {
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number; dx: number; horizontal?: boolean } | null>(null)
  const tags = s.meta.tags ?? []
  const text = preview(s)
  const choice = useModelChoice(s)

  const end = (): void => {
    const st = start.current
    start.current = null
    setDragging(false)
    if (!st?.horizontal) return
    setDx(dx < -ACTIONS_WIDTH / 2 ? -ACTIONS_WIDTH : 0)
  }

  return (
    <div className="relative mx-3 overflow-hidden rounded-xl">
      {!readOnly && (
        <div
          className="absolute inset-y-0 right-0 flex"
          style={{ width: ACTIONS_WIDTH }}
          aria-hidden={dx === 0}
        >
          <button
            type="button"
            tabIndex={dx === 0 ? -1 : 0}
            onClick={() => {
              setDx(0)
              onPin(s.key)
            }}
            className="flex flex-1 flex-col items-center justify-center gap-1 bg-primary text-[12px] font-medium text-primary-foreground"
          >
            {s.meta.pinned ? <PinOff className="size-5" /> : <Pin className="size-5" />}
            {s.meta.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            type="button"
            tabIndex={dx === 0 ? -1 : 0}
            onClick={() => {
              setDx(0)
              onHide(s.key)
            }}
            className="flex flex-1 flex-col items-center justify-center gap-1 bg-secondary-hover text-[12px] font-medium text-foreground"
          >
            {s.meta.hidden ? <Eye className="size-5" /> : <EyeOff className="size-5" />}
            {s.meta.hidden ? 'Unhide' : 'Hide'}
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          if (dx !== 0) setDx(0)
          else onOpen(s.key)
        }}
        onTouchStart={(e) => {
          const t = e.touches[0]
          start.current = { x: t.clientX, y: t.clientY, dx }
        }}
        onTouchMove={(e) => {
          const st = start.current
          if (!st || readOnly) return
          const t = e.touches[0]
          const mx = t.clientX - st.x
          const my = t.clientY - st.y
          if (st.horizontal === undefined && Math.abs(mx) + Math.abs(my) > 8) {
            st.horizontal = Math.abs(mx) > Math.abs(my)
            setDragging(st.horizontal)
          }
          if (st.horizontal) setDx(Math.max(-ACTIONS_WIDTH - 24, Math.min(0, st.dx + mx)))
        }}
        onTouchEnd={end}
        onTouchCancel={end}
        style={{ transform: `translateX(${dx}px)` }}
        className={cn(
          'relative flex w-full flex-col gap-1 border border-border bg-card px-3.5 py-3 text-left shadow-xs transition-transform duration-150 ease-out active:bg-hover',
          dragging && 'transition-none'
        )}
      >
        <div className="flex w-full items-center gap-2">
          <EnvDot env={s.env} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[15px] font-semibold',
              s.meta.hidden && 'text-muted-foreground'
            )}
          >
            {s.title}
          </span>
          {s.meta.pinned && (
            <Pin className="size-3.5 shrink-0 fill-current text-primary" aria-label="Pinned" />
          )}
          <span className="shrink-0 text-[12px] text-subtle-foreground tabular-nums">
            {formatRelative(s.lastActivityAt ?? s.startedAt)}
          </span>
        </div>
        <div
          className={cn(
            'line-clamp-2 w-full pl-3.5 text-[13px] leading-snug',
            s.meta.description || s.meta.aiSummary
              ? 'text-muted-foreground'
              : 'text-subtle-foreground'
          )}
        >
          {text || <span className="italic">No description</span>}
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pl-3.5 text-[12px] text-muted-foreground">
          <span className="max-w-[55%] truncate font-medium text-foreground/70">
            {s.projectName}
          </span>
          {s.gitBranch && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch className="size-3 shrink-0 text-subtle-foreground" />
              <span className="max-w-[120px] truncate font-mono text-[11px]">{s.gitBranch}</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3 text-subtle-foreground" />
            {s.messageCount}
          </span>
          <RemoteBadge session={s} compact />
          {s.availability !== 'imported' && <ModelChoiceBadge choice={choice} compact />}
          <SourceBadge source={s.source} reason={s.sourceReason} compact />
          {s.availability === 'archived-only' && (
            <span className="inline-flex items-center gap-1 rounded bg-warning-soft px-1 text-[10px] font-medium text-warning">
              <Archive className="size-2.5" /> Archived only
            </span>
          )}
          {s.meta.hidden && <EyeOff className="size-3" aria-label="Hidden" />}
        </div>
        {tags.length > 0 && (
          <div className="flex w-full flex-wrap gap-1.5 pl-3.5">
            {tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-foreground/80"
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: tagColor(t) }} />
                {t}
              </span>
            ))}
            {tags.length > 4 && (
              <span className="text-[11px] text-subtle-foreground">+{tags.length - 4}</span>
            )}
          </div>
        )}
      </button>
    </div>
  )
})
