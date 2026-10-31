// "Running now": a section at the top of the session list and a full view
// (the sidebar entry). Sessions that need me come first.

import { useState } from 'react'
import { BellRing, ChevronRight, Monitor, Radio, SquareTerminal, Zap } from 'lucide-react'
import { baseName } from '@shared/format'
import type { LiveSession } from '@shared/live'
import type { SessionSummary } from '@shared/types'
import { useLiveList, useNow, liveMuted, liveTitle, timeLine } from '@/lib/live-sessions'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { EnvDot } from '../EnvBadge'
import { Button } from '../ui/button'
import { LiveActions, StatusChip, UnverifiedNote } from './LiveParts'

const SECTION_KEY = 'csd.runningOpen'
const SECTION_MAX = 4

function readOpen(): boolean {
  try {
    return localStorage.getItem(SECTION_KEY) !== '0'
  } catch {
    return true
  }
}

function openSession(l: LiveSession, s: SessionSummary | undefined): void {
  const st = useApp.getState()
  if (!s) return
  st.set({ view: 'sessions' })
  if (!st.sessions.some((x) => x.key === l.key)) return
  st.select(l.key)
}

/** One row in the session list's Running now section. */
function CompactRow({
  live,
  summary,
  t,
  selected
}: {
  live: LiveSession
  summary?: SessionSummary
  t: number
  selected: boolean
}) {
  const time = timeLine(live, t)
  return (
    <div
      role="button"
      tabIndex={0}
      onMouseDown={(e) => e.button === 0 && openSession(live, summary)}
      onKeyDown={(e) => e.key === 'Enter' && openSession(live, summary)}
      className={cn(
        'group mx-2 flex flex-col gap-0.5 rounded-lg px-3 py-1.5 transition-colors',
        selected ? 'bg-selected' : 'hover:bg-hover',
        !summary && 'cursor-default'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <EnvDot env={live.env} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {liveTitle(live, summary)}
        </span>
        <StatusChip live={live} />
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-3.5 text-2xs text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate">
          {live.detail && live.state === 'approval' ? live.detail : time.state}
        </span>
        <span className="hidden group-focus-within:flex group-hover:flex">
          <LiveActions live={live} summary={summary} />
        </span>
      </div>
    </div>
  )
}

/** At the top of the session list. Hidden when nothing runs. */
export function RunningSection() {
  const list = useLiveList()
  const selectedKey = useApp((s) => s.selectedKey)
  const set = useApp((s) => s.set)
  const [open, setOpen] = useState(readOpen)
  const t = useNow()
  if (!list.length) return null
  const toggle = (): void => {
    setOpen(!open)
    try {
      localStorage.setItem(SECTION_KEY, open ? '0' : '1')
    } catch {
      // per-viewer convenience only
    }
  }
  const needs = list.filter((x) => x.live.state === 'approval').length
  return (
    <section aria-label="Running now" className="shrink-0 border-b border-border pt-1 pb-1.5">
      <div className="flex h-7 items-center gap-1 px-4">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-2xs font-medium tracking-wide text-subtle-foreground uppercase hover:text-muted-foreground"
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          Running now
          <span className="ml-1 tabular-nums normal-case">{list.length}</span>
          {needs > 0 && (
            <span className="ml-1 rounded-full bg-warning-soft px-1.5 text-[10px] text-warning normal-case">
              {needs} need{needs === 1 ? 's' : ''} approval
            </span>
          )}
        </button>
        <Button variant="ghost" size="xs" onClick={() => set({ view: 'running' })}>
          View all
        </Button>
      </div>
      {open &&
        list
          .slice(0, SECTION_MAX)
          .map(({ live, summary }) => (
            <CompactRow
              key={live.key}
              live={live}
              summary={summary}
              t={t}
              selected={live.key === selectedKey}
            />
          ))}
      {open && list.length > SECTION_MAX && (
        <button
          type="button"
          onClick={() => set({ view: 'running' })}
          className="mx-2 flex h-6 w-[calc(100%-1rem)] items-center px-3 pl-[26px] text-2xs text-muted-foreground hover:text-foreground"
        >
          {list.length - SECTION_MAX} more running
        </button>
      )}
    </section>
  )
}

function Card({ live, summary, t }: { live: LiveSession; summary?: SessionSummary; t: number }) {
  const time = timeLine(live, t)
  const muted = liveMuted(live, summary)
  return (
    <div
      className={cn(
        'rounded-xl border bg-background px-4 py-3 shadow-xs',
        live.state === 'approval' ? 'border-warning/40' : 'border-border'
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <StatusChip live={live} large />
            <button
              type="button"
              disabled={!summary}
              onClick={() => openSession(live, summary)}
              className="min-w-0 truncate text-left text-[14px] font-semibold enabled:hover:underline"
              title={summary ? 'Open the transcript' : undefined}
            >
              {liveTitle(live, summary)}
            </button>
            {muted && (
              <span className="shrink-0 text-2xs text-warning" title="Alerts muted">
                muted
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className={cn(live.state === 'approval' && 'font-medium text-warning')}>
              {time.state}
            </span>
            {time.run && <span>{time.run}</span>}
            <UnverifiedNote live={live} />
          </div>
          {live.detail && (
            <div className="mt-1 truncate text-xs text-foreground/80" title={live.detail}>
              {live.detail}
            </div>
          )}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-subtle-foreground">
            <span className="inline-flex items-center gap-1">
              {live.env === 'wsl' ? (
                <SquareTerminal className="size-3 text-env-wsl" />
              ) : (
                <Monitor className="size-3 text-env-windows" />
              )}
              {live.env === 'wsl' ? `WSL: ${live.distro ?? ''}` : 'Windows'}
            </span>
            {live.cwd && (
              <span className="max-w-[340px] truncate font-mono" title={live.cwd}>
                {baseName(live.cwd)}
              </span>
            )}
            {summary?.gitBranch && <span className="font-mono">{summary.gitBranch}</span>}
            {live.pid && <span className="tabular-nums">PID {live.pid}</span>}
            {live.remoteUrl && (
              <span className="inline-flex items-center gap-1 text-primary">
                <Radio className="size-3" /> Remote Control
              </span>
            )}
            {live.background && <span>background shell running</span>}
          </div>
        </div>
      </div>
      <div className="mt-2 -ml-2 flex flex-wrap items-center">
        <LiveActions live={live} summary={summary} size="sm" />
      </div>
    </div>
  )
}

function Group({
  title,
  items,
  t
}: {
  title: string
  items: { live: LiveSession; summary?: SessionSummary }[]
  t: number
}) {
  if (!items.length) return null
  return (
    <div className="space-y-2">
      <h2 className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
        {title} <span className="tabular-nums">{items.length}</span>
      </h2>
      {items.map((x) => (
        <Card key={x.live.key} live={x.live} summary={x.summary} t={t} />
      ))}
    </div>
  )
}

/** The full view (sidebar → Running now). */
export function RunningView() {
  const list = useLiveList()
  const hooks = useApp((s) => s.live?.hooks ?? [])
  const set = useApp((s) => s.set)
  const t = useNow()
  const needs = list.filter((x) => x.live.state === 'approval' || x.live.state === 'idle')
  const working = list.filter((x) => x.live.state === 'working')
  const ended = list.filter((x) => x.live.state === 'exited')
  const alertsOn = hooks.some((h) => h.installed)
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-[860px] px-8 pt-6 pb-10">
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-[-0.01em]">
              <Zap className="size-5 text-primary" /> Running now
            </h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Claude Code sessions running on this PC and in WSL, and what each one is doing.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => set({ view: 'settings', settingsSection: 'alerts' })}
          >
            <BellRing /> Alert settings
          </Button>
        </div>
        {!alertsOn && (
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-info/30 bg-info/5 px-3.5 py-2.5 text-xs">
            <BellRing className="mt-0.5 size-4 shrink-0 text-info" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground">
                Turn on session alerts for exact states
              </div>
              <div className="mt-0.5 text-muted-foreground">
                Without them, states come from Claude Code&apos;s session files and recent activity.
                With them, you get &ldquo;needs approval&rdquo; and &ldquo;finished&rdquo; the
                moment they happen, as desktop and phone alerts.
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => set({ view: 'settings', settingsSection: 'alerts' })}
            >
              Set up
            </Button>
          </div>
        )}
        {list.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-background shadow-xs">
              <Zap className="size-5 text-muted-foreground" />
            </div>
            <div className="mt-3 text-sm font-medium">Nothing is running</div>
            <p className="mt-1 max-w-[320px] text-xs text-muted-foreground">
              Start or resume a session and it shows up here within a few seconds.
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            <Group title="Needs you" items={needs} t={t} />
            <Group title="Working" items={working} t={t} />
            <Group title="Recently ended" items={ended} t={t} />
          </div>
        )}
      </div>
    </div>
  )
}
