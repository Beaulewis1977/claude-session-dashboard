// "Already running on your PC" in the phone's launch sheet: the session (or a
// fork / continuation of it) is open on the PC already. With Remote Control on,
// "Open in Claude app" goes straight to it; without, typing /rc in that
// terminal turns it on (the link shows up here within a few seconds, from
// Running now). "Start another copy anyway" only after a confirm.

import { useState } from 'react'
import { toast } from 'sonner'
import {
  AppWindow,
  Copy,
  ExternalLink,
  Loader2,
  MonitorSmartphone,
  MonitorUp,
  RefreshCw,
  TriangleAlert
} from 'lucide-react'
import { runningAdvice, type RunningAction, type RunningCopy } from '@shared/running'
import { phone } from '@/lib/web-api'
import { Button } from '@/components/ui/button'

const LABEL: Record<RunningAction, string> = {
  'open-remote': 'Open in Claude app',
  focus: 'Focus terminal on PC',
  'open-codex-app': 'Open in Codex app on PC',
  another: 'Start another copy anyway…'
}

export function RunningBlock({
  running,
  readOnly,
  onRefresh,
  onAnother,
  onDone
}: {
  running: RunningCopy
  readOnly: boolean
  onRefresh: () => void
  /** Confirmed: launch again with `force`. */
  onAnother: () => void
  /** Something was opened on the PC (the sheet can close). */
  onDone: () => void
}) {
  const advice = runningAdvice(running, 'phone')
  // 'another', or the Codex app for a thread a terminal still runs: confirmed first.
  const [confirm, setConfirm] = useState<'another' | 'codex-app' | null>(null)
  const [busy, setBusy] = useState<RunningAction | null>(null)

  const ask = async (a: 'focus' | 'open-codex-app', force = false): Promise<void> => {
    setBusy(a)
    try {
      const r = await phone.launch({
        key: running.key,
        kind: a === 'focus' ? 'focus' : 'codex-app',
        ...(force ? { force: true as const } : {})
      })
      if (r.ok) {
        toast.success(
          r.simulated
            ? 'Fixtures mode: nothing happened on the PC'
            : a === 'focus'
              ? 'Its terminal is in front on your PC'
              : 'Opened in the Codex app on your PC'
        )
        onDone()
      } else toast.error(r.error ?? "That didn't work.")
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const run = (a: RunningAction): void => {
    if (a === 'another') return setConfirm('another')
    if (a === 'open-remote') return
    if (a === 'open-codex-app' && running.where === 'terminal') return setConfirm('codex-app')
    void ask(a)
  }

  return (
    <div className="space-y-3 rounded-xl border border-warning/40 bg-warning-soft px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 text-[14px] leading-relaxed">
          <div className="font-semibold">{advice.title}</div>
          {running.title && running.relation !== 'self' && (
            <div className="truncate text-[13px] text-muted-foreground">“{running.title}”</div>
          )}
          <div className="text-[13px] text-muted-foreground">{advice.body}</div>
        </div>
      </div>
      {confirm ? (
        <div className="space-y-2">
          <p className="text-[13px] leading-relaxed">
            {confirm === 'another'
              ? 'Start a second copy on your PC? Both write into the same session, and they can get out of step.'
              : 'It’s still open in a terminal on your PC. Opening it in the Codex app too means two copies of one thread. Open it anyway?'}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" className="h-11 flex-1" onClick={() => setConfirm(null)}>
              Back
            </Button>
            <Button
              variant="outline"
              className="h-11 flex-[2]"
              disabled={readOnly || !!busy}
              onClick={() => {
                if (confirm === 'another') onAnother()
                else void ask('open-codex-app', true)
                setConfirm(null)
              }}
            >
              <Copy /> {confirm === 'another' ? 'Start another copy' : 'Open in Codex app anyway'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {advice.actions.map((a, i) =>
            a === 'open-remote' && running.remoteUrl ? (
              <a
                key={a}
                href={running.remoteUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onDone}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground active:bg-primary-hover"
              >
                <MonitorSmartphone className="size-5" /> {LABEL[a]}{' '}
                <ExternalLink className="size-4 opacity-80" />
              </a>
            ) : (
              <Button
                key={a}
                variant={a === 'another' ? 'ghost' : i === 0 ? 'primary' : 'outline'}
                className="h-11 w-full text-[14px]"
                disabled={(readOnly && a !== 'another') || !!busy}
                onClick={() => run(a)}
              >
                {busy === a ? (
                  <Loader2 className="animate-spin" />
                ) : a === 'focus' ? (
                  <MonitorUp />
                ) : a === 'open-codex-app' ? (
                  <AppWindow />
                ) : (
                  <Copy />
                )}
                {LABEL[a]}
              </Button>
            )
          )}
          {running.provider === 'claude' && !running.remoteUrl && (
            <Button variant="ghost" className="h-10 w-full text-[13px]" onClick={onRefresh}>
              <RefreshCw /> Refresh
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
