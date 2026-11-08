// Pieces of "Running now": the status chip, the time line and the actions.

import {
  AppWindow,
  Bell,
  BellOff,
  Copy,
  ExternalLink,
  Smartphone,
  TriangleAlert
} from 'lucide-react'
import { STATE_LABEL, type LiveSession } from '@shared/live'
import { capsOf, providerOf } from '@shared/provider'
import type { SessionSummary } from '@shared/types'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyLiveResume, focusLive, liveMuted, toggleMute } from '@/lib/live-sessions'
import { cn } from '@/lib/utils'
import { QrCode } from '../QrCode'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Tooltip } from '../ui/tooltip'

const CHIP: Record<LiveSession['state'], { box: string; dot: string }> = {
  working: { box: 'bg-info/10 text-info', dot: 'bg-info animate-pulse' },
  approval: { box: 'bg-warning-soft text-warning', dot: 'bg-warning' },
  idle: { box: 'bg-success/10 text-success', dot: 'bg-success' },
  exited: { box: 'bg-secondary text-muted-foreground', dot: 'bg-subtle-foreground' }
}

export function StatusChip({
  live,
  className,
  large
}: {
  live: Pick<LiveSession, 'state' | 'failed' | 'background' | 'guess'>
  className?: string
  large?: boolean
}) {
  const c = CHIP[live.state]
  const label =
    live.failed && live.state !== 'working'
      ? 'Stopped with an error'
      : live.state === 'approval' && live.guess
        ? 'Needs approval?'
        : STATE_LABEL[live.state]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        large ? 'h-6 px-2.5 text-xs' : 'h-[18px] px-1.5 text-[10.5px]',
        live.failed && live.state !== 'working' ? 'bg-destructive/10 text-destructive' : c.box,
        className
      )}
      title={
        live.background
          ? 'A background shell command is still running'
          : live.state === 'approval' && live.guess
            ? 'Probably: a command that needs approval has waited a while. Turn on Codex alerts (Settings → Session alerts) for exact approvals.'
            : undefined
      }
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          live.failed && live.state !== 'working' ? 'bg-destructive' : c.dot
        )}
      />
      {label}
    </span>
  )
}

export function OpenOnPhone({ live, size = 'xs' }: { live: LiveSession; size?: 'xs' | 'sm' }) {
  if (!live.remoteUrl)
    return (
      <Tooltip content="Remote Control isn't on in this session. Run /remote-control in it, or resume it with Remote Control on.">
        <span>
          <Button variant="ghost" size={size} disabled aria-label="Open on phone">
            <Smartphone /> {size === 'sm' && 'Open on phone'}
          </Button>
        </span>
      </Tooltip>
    )
  const url = live.remoteUrl
  return (
    <Popover>
      <Tooltip content="Open on phone (Remote Control)">
        <PopoverTrigger asChild>
          <Button variant="ghost" size={size} aria-label="Open on phone">
            <Smartphone /> {size === 'sm' && 'Open on phone'}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[260px]">
        <div className="flex flex-col items-center gap-2 text-center">
          <QrCode value={url} size={168} label="Remote Control link" />
          <p className="text-xs text-muted-foreground">
            Scan with your phone&apos;s camera to continue this session in the Claude app.
          </p>
          <div className="selectable w-full truncate font-mono text-[10.5px] text-subtle-foreground">
            {url}
          </div>
          <div className="flex gap-2">
            <Button size="xs" variant="outline" onClick={() => void api.copyText(url)}>
              <Copy /> Copy link
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void api.openExternal(url)}>
              Open in browser
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Open a Codex thread in the Codex app (desktop only; `codex://threads/<id>`). */
export function OpenInCodexApp({ live, size = 'xs' }: { live: LiveSession; size?: 'xs' | 'sm' }) {
  return (
    <Tooltip content="Open in the Codex app">
      <Button
        variant="ghost"
        size={size}
        aria-label="Open in Codex app"
        onClick={() =>
          void api
            .openInAgentApp(live.key)
            .catch((err: unknown) =>
              toast.error("Couldn't open the Codex app", { description: (err as Error).message })
            )
        }
      >
        <ExternalLink /> {size === 'sm' && 'Open in Codex app'}
      </Button>
    </Tooltip>
  )
}

/** Focus terminal · Open on phone (Claude) or in the Codex app · Copy resume command · Mute. */
export function LiveActions({
  live,
  summary,
  size = 'xs'
}: {
  live: LiveSession
  summary?: SessionSummary
  size?: 'xs' | 'sm'
}) {
  const muted = liveMuted(live, summary)
  const label = (text: string): string | false => size === 'sm' && text
  const ended = live.state === 'exited'
  const codex = providerOf(live) === 'codex'
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip
        content={
          ended
            ? 'It has ended'
            : live.env === 'wsl'
              ? 'Bring its Windows Terminal tab forward (found by the session name)'
              : codex
                ? 'Bring forward the window of the Codex process that has it open'
                : 'Bring its terminal window (and tab) forward'
        }
      >
        <span>
          <Button
            variant="ghost"
            size={size}
            disabled={ended}
            aria-label="Focus terminal"
            onClick={() => void focusLive(live.key)}
          >
            <AppWindow /> {label('Focus terminal')}
          </Button>
        </span>
      </Tooltip>
      {codex
        ? !api.remote && <OpenInCodexApp live={live} size={size} />
        : capsOf(live).remoteControl && <OpenOnPhone live={live} size={size} />}
      <Tooltip content="Copy resume command">
        <Button
          variant="ghost"
          size={size}
          aria-label="Copy resume command"
          onClick={() => void copyLiveResume(live, summary)}
        >
          <Copy /> {label('Copy resume command')}
        </Button>
      </Tooltip>
      <Tooltip
        content={
          muted ? 'Alerts are muted for this session: turn them on' : 'Mute alerts for this session'
        }
      >
        <Button
          variant="ghost"
          size={size}
          aria-label={muted ? 'Unmute alerts' : 'Mute alerts'}
          aria-pressed={muted}
          onClick={() => void toggleMute(live, summary)}
          className={cn(muted && 'text-warning')}
        >
          {muted ? <BellOff /> : <Bell />} {label(muted ? 'Muted' : 'Mute')}
        </Button>
      </Tooltip>
    </div>
  )
}

export function UnverifiedNote({ live }: { live: LiveSession }) {
  if (!live.unverified) return null
  return (
    <span
      className="inline-flex items-center gap-1 text-warning"
      title={
        providerOf(live) === 'codex'
          ? 'No Codex process has this thread locked (the Codex app may not lock it), so its state comes from recent activity in its session file.'
          : "The app can't check this process (for example, a stopped WSL distro), so it may have ended."
      }
    >
      <TriangleAlert className="size-3" /> unconfirmed
    </span>
  )
}
