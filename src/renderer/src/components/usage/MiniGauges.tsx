import { Gauge } from 'lucide-react'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { levelOf, LEVEL_COLOR } from '@/lib/meter-hooks'
import { Tooltip } from '../ui/tooltip'

function Dot({ pct, label }: { pct: number | undefined; label: string }) {
  const r = 6
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={16} height={16} className="-rotate-90" aria-hidden>
        <circle cx={8} cy={8} r={r} fill="none" stroke="var(--gauge-track)" strokeWidth={2.5} />
        {pct !== undefined && (
          <circle
            cx={8}
            cy={8}
            r={r}
            fill="none"
            stroke={LEVEL_COLOR[levelOf(v)]}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - v / 100)}
          />
        )}
      </svg>
      <span className="text-subtle-foreground">{label}</span>
      <span className="font-medium text-foreground/80 tabular-nums">
        {pct === undefined ? '–' : `${Math.round(pct)}%`}
      </span>
    </span>
  )
}

/** The usage gauges, small, for the app's title (status) bar. */
export function MiniGauges() {
  const limits = useApp((s) => s.limits)
  const view = useApp((s) => s.view)
  const set = useApp((s) => s.set)
  if (!limits) return null
  const five =
    limits.fiveHour && !limits.fiveHour.expired
      ? limits.fiveHour.pct
      : limits.fiveHour
        ? 0
        : undefined
  const week =
    limits.sevenDay && !limits.sevenDay.expired
      ? limits.sevenDay.pct
      : limits.sevenDay
        ? 0
        : undefined
  return (
    <Tooltip content="Usage & limits" shortcut="Ctrl+U">
      <button
        type="button"
        onClick={() => set({ view: view === 'usage' ? 'sessions' : 'usage' })}
        className={cn(
          'no-drag flex h-7 items-center gap-3 rounded-md px-2 text-2xs transition-colors hover:bg-hover',
          view === 'usage' && 'bg-selected'
        )}
      >
        {five === undefined && week === undefined ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Gauge className="size-3.5" /> Usage
          </span>
        ) : (
          <>
            <Dot pct={five} label="5h" />
            <Dot pct={week} label="Week" />
          </>
        )}
      </button>
    </Tooltip>
  )
}
