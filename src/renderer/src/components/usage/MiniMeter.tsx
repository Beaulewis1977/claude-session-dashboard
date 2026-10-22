import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { setClockOffset } from '@shared/clock'
import { formatDuration, formatUsd } from '@shared/format'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from '@/lib/api'
import { useLiveData } from '@/lib/live'
import { useNow } from '@/lib/meter-hooks'
import { useApp } from '@/lib/store'
import { useThemeEffect } from '@/lib/theme'
import { RingGauge } from './primitives'

/** The always-on-top mini meter window (#mini). Drag it anywhere; it remembers where. */
export function MiniMeter() {
  const set = useApp((s) => s.set)
  const settings = useApp((s) => s.settings)
  const [ready, setReady] = useState(false)
  useThemeEffect(ready ? settings.theme : DEFAULT_SETTINGS.theme)
  useEffect(() => {
    void Promise.all([api.getInfo(), api.getSettings()]).then(([info, s]) => {
      setClockOffset(info.clockOffset)
      set({ info, settings: s })
      setReady(true)
    })
  }, [set])
  useLiveData(ready)
  if (!ready) return <div className="h-full bg-background" />
  return <MiniMeterBody />
}

function MiniMeterBody() {
  const limits = useApp((s) => s.limits)
  const credits = useApp((s) => s.credits)
  const t = useNow(30_000)
  const remaining = credits?.summaries.reduce((a, s) => a + s.remaining, 0) ?? 0
  const hasCredits = !!credits?.summaries.some((s) => s.granted > 0)

  const gauge = (
    label: string,
    g: typeof limits extends null ? never : NonNullable<typeof limits>['fiveHour']
  ) => (
    <div className="flex items-center gap-2.5">
      <RingGauge pct={g ? (g.expired ? 0 : g.pct) : undefined} dim={!g} size={58} stroke={6}>
        <span className="text-[14px] font-semibold tabular-nums">
          {g ? `${Math.round(g.expired ? 0 : g.pct)}%` : '–'}
        </span>
      </RingGauge>
      <div className="min-w-0 text-[11px] leading-tight">
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground">
          {g?.resetsAt && !g.expired
            ? `in ${formatDuration(g.resetsAt - t)}`
            : g
              ? 'reset'
              : 'no data'}
        </div>
      </div>
    </div>
  )

  return (
    <div className="drag flex h-full flex-col justify-center gap-2 border border-border bg-background px-3.5 py-3 select-none">
      <button
        type="button"
        aria-label="Close mini meter"
        onClick={() => void api.closeMiniMeter()}
        className="no-drag absolute top-1.5 right-1.5 rounded p-0.5 text-subtle-foreground hover:bg-hover hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex items-center gap-4">
        {gauge('5-hour', limits?.fiveHour)}
        {gauge('Week', limits?.sevenDay)}
      </div>
      {hasCredits && (
        <div className="flex items-center justify-between border-t border-border pt-1.5 text-[11px]">
          <span className="text-muted-foreground">API credits</span>
          <span className="font-medium tabular-nums">{formatUsd(remaining)} left</span>
        </div>
      )}
    </div>
  )
}
