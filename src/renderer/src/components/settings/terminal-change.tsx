// Terminal access: the status hook, and the dialog that shows exactly what a
// change will run before it runs (then Windows asks for administrator rights).

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ShieldCheck, SquareTerminal } from 'lucide-react'
import type { PreparedChange, TerminalAction, TerminalStatus } from '@shared/terminal'
import { api } from '@/lib/api'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'

export function useTerminalStatus(pollMs = 0): {
  status: TerminalStatus | null
  refresh: () => Promise<void>
} {
  const [status, setStatus] = useState<TerminalStatus | null>(null)
  const refresh = useCallback(async () => {
    setStatus(await api.terminalStatus())
  }, [])
  useEffect(() => {
    let alive = true
    let running = false
    const load = (): void => {
      // The probe takes a few seconds: never stack them up.
      if (running) return
      running = true
      void api
        .terminalStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined)
        .finally(() => (running = false))
    }
    load()
    const off = api.onTerminalChanged(load)
    const t = pollMs ? window.setInterval(load, pollMs) : undefined
    return () => {
      alive = false
      off()
      if (t) window.clearInterval(t)
    }
  }, [pollMs])
  return { status, refresh }
}

/**
 * `change(action)`: work the change out, show it, and run it if confirmed.
 * Render `dialog` somewhere in the component.
 */
export function useChange(onDone?: () => void): {
  change: (a: TerminalAction) => Promise<boolean>
  busy: string | null
  dialog: React.ReactNode
} {
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<{
    prep: PreparedChange
    resolve: (ok: boolean) => void
  } | null>(null)

  const change = useCallback(
    async (a: TerminalAction): Promise<boolean> => {
      setBusy(a.kind)
      try {
        const prep = await api.terminalPrepare(a)
        if ('error' in prep) {
          toast.error('Nothing was changed', { description: prep.error })
          return false
        }
        const yes = await new Promise<boolean>((resolve) => setPending({ prep, resolve }))
        if (!yes) return false
        const r = await api.terminalApply(prep.token)
        if (r.ok)
          toast.success(prep.title.replace(/\?$/, '') + ': done', {
            description: r.simulated ? 'Fixtures mode: nothing on this PC was changed.' : undefined
          })
        else if (!r.cancelled) toast.error('That didn’t work', { description: r.error })
        else toast('Cancelled', { description: r.error })
        return r.ok
      } catch (err) {
        toast.error('That didn’t work', { description: (err as Error).message })
        return false
      } finally {
        setBusy(null)
        onDone?.()
      }
    },
    [onDone]
  )

  const close = (ok: boolean): void => {
    pending?.resolve(ok)
    setPending(null)
  }

  const dialog = pending ? (
    <Dialog open onOpenChange={(o) => !o && close(false)}>
      <DialogContent className="max-w-[680px]">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <SquareTerminal className="size-4" />
            </div>
          }
          title={pending.prep.title}
          description="Nothing has changed yet. This is exactly what will run."
        />
        <div className="space-y-3 border-t border-border px-5 py-4">
          <p className="text-[13px] leading-relaxed whitespace-pre-line">{pending.prep.summary}</p>
          <pre className="selectable max-h-[300px] overflow-auto rounded-lg border border-border bg-secondary/60 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre">
            {pending.prep.script}
          </pre>
          {pending.prep.elevate && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
              Windows will ask for administrator rights next. Every change is logged and can be
              undone in Settings → Terminal access (SSH).
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => close(true)}>
            {pending.prep.okLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  return { change, busy, dialog }
}
