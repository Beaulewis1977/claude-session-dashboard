// Running now on the phone: the same list as the desktop's, as cards, with
// push alerts one tap away. Tapping a card opens the transcript.

import { useState } from 'react'
import { toast } from 'sonner'
import { Bell, BellOff, BellRing, Copy, Radio, Smartphone, Zap } from 'lucide-react'
import { baseName } from '@shared/format'
import type { LiveSession } from '@shared/live'
import type { SessionSummary } from '@shared/types'
import { api } from '@/lib/api'
import {
  copyLiveResume,
  liveMuted,
  liveTitle,
  timeLine,
  toggleMute,
  useLiveList,
  useNow
} from '@/lib/live-sessions'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusChip, UnverifiedNote } from '@/components/live/LiveParts'
import { useMobile } from './state'
import { turnPushOn, usePushState } from './push'

function PushBanner() {
  const [state, reload] = usePushState()
  const [busy, setBusy] = useState(false)
  if (state === null || state === 'on') return null
  return (
    <div className="mx-3 mb-3 flex items-start gap-3 rounded-xl border border-info/30 bg-info/5 px-3.5 py-3">
      <BellRing className="mt-0.5 size-5 shrink-0 text-info" />
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="font-medium">Get alerts on this phone</div>
        <div className="mt-0.5 text-muted-foreground">
          {state === 'denied'
            ? 'Notifications are blocked for this app. Allow them in your browser or phone settings.'
            : state === 'unsupported'
              ? /iPhone|iPad|iPod/.test(navigator.userAgent)
                ? 'On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then open it from there.'
                : "This browser can't receive push alerts."
              : 'When a session needs your approval or finishes, even when this app is closed. Alerts say only what happened; details load from your PC.'}
        </div>
        {state === 'off' && (
          <Button
            size="sm"
            variant="primary"
            className="mt-2 h-8"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void turnPushOn(reload).finally(() => setBusy(false))
            }}
          >
            Turn on push alerts
          </Button>
        )}
      </div>
    </div>
  )
}

function Card({ live, summary, t }: { live: LiveSession; summary?: SessionSummary; t: number }) {
  const select = useApp((s) => s.select)
  const readOnly = useMobile((s) => s.me?.readOnly) ?? false
  const time = timeLine(live, t)
  const muted = liveMuted(live, summary)
  return (
    <div
      className={cn(
        'mx-3 mb-2.5 rounded-xl border bg-card px-4 py-3',
        live.state === 'approval' ? 'border-warning/50' : 'border-border'
      )}
    >
      <button
        type="button"
        className="block w-full min-w-0 text-left"
        disabled={!summary}
        onClick={() => summary && select(live.key)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <StatusChip live={live} large />
          {muted && <BellOff className="size-3.5 shrink-0 text-warning" aria-label="Muted" />}
          <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
            {live.env === 'wsl' ? `WSL: ${live.distro ?? ''}` : 'Windows'}
          </span>
        </div>
        <div className="mt-1.5 truncate text-[16px] font-semibold">{liveTitle(live, summary)}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[13px] text-muted-foreground">
          <span className={cn(live.state === 'approval' && 'font-medium text-warning')}>
            {time.state}
          </span>
          {time.run && <span>{time.run}</span>}
          <UnverifiedNote live={live} />
        </div>
        {live.detail && (
          <div className="mt-1 line-clamp-2 text-[13px] text-foreground/80">{live.detail}</div>
        )}
        {live.cwd && (
          <div className="mt-1 truncate font-mono text-[12px] text-subtle-foreground">
            {baseName(live.cwd)}
          </div>
        )}
      </button>
      <div className="mt-2.5 flex items-center gap-2">
        {live.remoteUrl ? (
          <Button
            variant="primary"
            size="sm"
            className="h-9"
            onClick={() => void api.openExternal(live.remoteUrl!)}
          >
            <Smartphone /> Open in Claude
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 text-[12px] text-subtle-foreground">
            <Radio className="size-3.5" /> No Remote Control
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-9"
          onClick={() => void copyLiveResume(live, summary)}
          aria-label="Copy resume command"
        >
          <Copy />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9', muted && 'text-warning')}
          aria-label={muted ? 'Unmute alerts' : 'Mute alerts'}
          aria-pressed={muted}
          onClick={() =>
            readOnly
              ? toast('Read-only mode is on', { description: 'Change it on your PC.' })
              : void toggleMute(live, summary)
          }
        >
          {muted ? <BellOff /> : <Bell />}
        </Button>
      </div>
    </div>
  )
}

export function RunningTab() {
  const list = useLiveList()
  const loaded = useApp((s) => s.live !== null)
  const t = useNow()
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-border bg-chrome/95 px-4 pt-[calc(env(safe-area-inset-top)+10px)] pb-3 backdrop-blur">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Running now</h1>
        <p className="text-[13px] text-muted-foreground">
          {list.length
            ? `${list.filter((x) => x.live.state !== 'exited').length} running on your PC`
            : 'Claude Code sessions on your PC'}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-3 pb-4">
        <PushBanner />
        {!loaded ? (
          <div className="space-y-3 px-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[130px] animate-pulse rounded-xl bg-secondary" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center px-8 pt-16 text-center text-muted-foreground">
            <Zap className="size-8 text-subtle-foreground" />
            <div className="mt-3 text-[15px] font-medium text-foreground">Nothing is running</div>
            <p className="mt-1 text-[13px]">
              Sessions show up here a few seconds after they start.
            </p>
          </div>
        ) : (
          list.map(({ live, summary }) => (
            <Card key={live.key} live={live} summary={summary} t={t} />
          ))
        )}
      </div>
    </div>
  )
}
