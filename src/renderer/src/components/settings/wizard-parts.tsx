// Building blocks shared by the setup wizards (Connect your phone, Terminal
// access): the ✓ / ✗ marks, status rows, numbered steps and the phone drawing.

import { useEffect, useState, type ReactNode } from 'react'
import { Check as CheckIcon, CircleCheck, CircleDashed, CircleX, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'

export type Check = 'ok' | 'fail' | 'wait' | 'todo'

export interface Step {
  id: string
  title: string
  check: Check
  render: () => ReactNode
}

export function Mark({ c }: { c: Check }) {
  if (c === 'ok')
    return <CircleCheck className="size-4.5 shrink-0 text-success" aria-label="Done" />
  if (c === 'fail')
    return <CircleX className="size-4.5 shrink-0 text-destructive" aria-label="Needs fixing" />
  if (c === 'wait')
    return (
      <Loader2
        className="size-4.5 shrink-0 animate-spin text-muted-foreground"
        aria-label="Checking"
      />
    )
  return (
    <CircleDashed className="size-4.5 shrink-0 text-subtle-foreground" aria-label="Not done yet" />
  )
}

export function Status({ c, children }: { c: Check; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]',
        c === 'ok' && 'border-success/25 bg-success/5',
        c === 'fail' && 'border-destructive/25 bg-destructive/5',
        (c === 'wait' || c === 'todo') && 'border-border bg-secondary/60'
      )}
    >
      <Mark c={c} />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
    </div>
  )
}

export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((t, i) => (
        <li key={i} className="flex items-start gap-2.5 text-[13px] leading-relaxed">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-primary">
            {i + 1}
          </span>
          <span>{t}</span>
        </li>
      ))}
    </ol>
  )
}

/** A simple drawn phone with an app on it, for the "on your phone" steps. */
export function PhonePicture({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[150px] w-[78px] shrink-0 flex-col items-center rounded-[18px] border-[3px] border-foreground/80 bg-background p-1.5 shadow-sm">
      <div className="mb-1.5 h-1 w-6 rounded-full bg-foreground/30" />
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-1.5 rounded-xl bg-secondary text-center text-[9px] leading-tight text-muted-foreground">
        {children}
      </div>
    </div>
  )
}

export function Countdown({ until }: { until: string }) {
  const [left, setLeft] = useState(() => Date.parse(until) - Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setLeft(Date.parse(until) - Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [until])
  if (left <= 0) return <>expired</>
  const s = Math.ceil(left / 1000)
  return (
    <>
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
    </>
  )
}

/** The wizard's frame: steps on the left, the current step on the right. */
export function WizardFrame({
  steps,
  active,
  setActive,
  header,
  footer,
  onDone
}: {
  steps: Step[]
  active: number
  setActive: (i: number) => void
  header?: ReactNode
  footer?: ReactNode
  onDone: () => void
}) {
  const step = steps[Math.min(active, steps.length - 1)]
  return (
    <div className="grid grid-cols-[230px_minmax(0,1fr)] gap-0 border-t border-border">
      <nav className="space-y-0.5 border-r border-border bg-chrome/50 p-3">
        {header}
        {steps.map((st, i) => (
          <button
            key={st.id}
            type="button"
            onClick={() => setActive(i)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]',
              i === active ? 'bg-selected font-medium' : 'hover:bg-hover'
            )}
          >
            <Mark c={st.check} />
            <span className="min-w-0 flex-1">
              <span className="block text-[10.5px] text-subtle-foreground">Step {i + 1}</span>
              {st.title}
            </span>
          </button>
        ))}
        {footer}
      </nav>
      <div className="flex min-h-[420px] min-w-0 flex-col p-5">
        {!step ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking…
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <Mark c={step.check} />
              <h3 className="text-[15px] font-semibold">{step.title}</h3>
            </div>
            <div className="flex-1">{step.render()}</div>
            <WizardNav
              active={active}
              last={active >= steps.length - 1}
              ok={step.check === 'ok'}
              setActive={setActive}
              onDone={onDone}
            />
          </>
        )}
      </div>
    </div>
  )
}

function WizardNav({
  active,
  last,
  ok,
  setActive,
  onDone
}: {
  active: number
  last: boolean
  ok: boolean
  setActive: (i: number) => void
  onDone: () => void
}) {
  return (
    <div className="mt-5 flex items-center justify-between">
      <Button variant="ghost" disabled={active === 0} onClick={() => setActive(active - 1)}>
        Back
      </Button>
      {!last ? (
        <Button variant={ok ? 'primary' : 'outline'} onClick={() => setActive(active + 1)}>
          Next
        </Button>
      ) : (
        <Button variant="primary" onClick={onDone}>
          <CheckIcon /> Done
        </Button>
      )}
    </div>
  )
}
