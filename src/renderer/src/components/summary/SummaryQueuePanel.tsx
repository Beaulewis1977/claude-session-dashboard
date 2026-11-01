// The summary queue: what's being summarized, what's next, and the limits
// guard (a paused queue, with Resume). Shown in the corner while there's
// anything to show.

import { useState } from 'react'
import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Loader2,
  OctagonPause,
  Play,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide-react'
import type { SummaryJob } from '@shared/summary-queue'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { estimateText } from '@/lib/summary-format'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Tooltip } from '../ui/tooltip'

function JobIcon({ j }: { j: SummaryJob }) {
  switch (j.status) {
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-primary" />
    case 'done':
      return <Check className="size-3.5 text-success" />
    case 'failed':
      return <TriangleAlert className="size-3.5 text-destructive" />
    case 'cancelled':
      return <Ban className="size-3.5 text-subtle-foreground" />
    default:
      return <Circle className="size-3 text-subtle-foreground" />
  }
}

export function SummaryQueuePanel() {
  const q = useApp((s) => s.summaryQueue)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const [open, setOpen] = useState(true)
  if (!q.jobs.length) return null
  const active = q.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const runningJob = q.jobs.find((j) => j.status === 'running')
  const done = q.jobs.filter((j) => j.status === 'done').length
  const failed = q.jobs.filter((j) => j.status === 'failed').length
  const show = (key: string): void => {
    const st = useApp.getState()
    if (st.query.trim()) st.set({ query: '', hits: null, sort: st.sortBeforeSearch })
    st.set({ view: 'sessions' })
    st.select(key)
  }
  const title = q.paused
    ? 'Summaries paused'
    : active.length
      ? `Summarizing ${q.jobs.length - active.length + 1} of ${q.jobs.length}`
      : `Summaries: ${done} done${failed ? `, ${failed} failed` : ''}`

  return (
    <div
      role="region"
      aria-label="Summary queue"
      className={cn(
        'fixed bottom-4 z-40 w-[320px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl transition-[left] duration-200',
        // Clear of the sidebar (its Settings link), over the bottom of the list.
        sidebarOpen ? 'left-[244px]' : 'left-4'
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {q.paused ? (
          <OctagonPause className="size-4 text-warning" />
        ) : active.length ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : (
          <Sparkles className="size-4 text-primary" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium tabular-nums">
          {title}
        </span>
        {q.simulated && <span className="text-2xs text-subtle-foreground">samples</span>}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
        {!active.length && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void api.summaryClearFinished()}
            aria-label="Close"
          >
            <X />
          </Button>
        )}
      </div>
      {runningJob?.estimate && !q.paused && (
        <div className="border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
          {runningJob.origin === 'auto' ? 'Auto-summarize · ' : ''}
          {estimateText(runningJob.estimate)}
        </div>
      )}
      {q.paused && (
        <div className="border-b border-warning/25 bg-warning-soft px-3 py-2 text-xs text-foreground/85">
          The 5-hour limit is at {Math.round(q.paused.pct)}%, above your {q.paused.limit}% pause
          line. Nothing more is sent until you resume.
          <div className="mt-2 flex gap-2">
            <Button variant="outline" size="xs" onClick={() => void api.summaryResume()}>
              <Play /> Resume anyway
            </Button>
            <Button variant="ghost" size="xs" onClick={() => void api.summaryCancel()}>
              Cancel the rest
            </Button>
          </div>
        </div>
      )}
      {open && (
        <ul className="max-h-56 overflow-y-auto py-1">
          {q.jobs.map((j) => (
            <li key={j.id} className="group flex items-center gap-2 px-3 py-1 text-xs">
              <JobIcon j={j} />
              <button
                type="button"
                onClick={() => show(j.key)}
                className={cn(
                  'min-w-0 flex-1 truncate text-left hover:underline',
                  j.status === 'cancelled' && 'text-muted-foreground'
                )}
                title={j.estimate ? `${j.title} · ${estimateText(j.estimate)}` : j.title}
              >
                {j.title}
              </button>
              {j.origin === 'auto' && <span className="text-2xs text-subtle-foreground">auto</span>}
              {j.error && j.status !== 'cancelled' && (
                <Tooltip content={j.error}>
                  <span className="max-w-[90px] truncate text-2xs text-destructive">{j.error}</span>
                </Tooltip>
              )}
              {(j.status === 'queued' || j.status === 'running') && (
                <button
                  type="button"
                  onClick={() => void api.summaryCancel(j.key)}
                  className="rounded p-0.5 text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-foreground"
                  aria-label={`Cancel ${j.title}`}
                >
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && active.length > 1 && !q.paused && (
        <div className="border-t border-border px-3 py-1.5 text-right">
          <Button variant="ghost" size="xs" onClick={() => void api.summaryCancel()}>
            Cancel all
          </Button>
        </div>
      )}
      {q.override && active.length > 0 && (
        <div className="border-t border-border px-3 py-1.5 text-2xs text-muted-foreground">
          Going on above the pause line until the queue is done.
        </div>
      )}
    </div>
  )
}
