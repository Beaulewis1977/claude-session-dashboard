import { Gauge } from 'lucide-react'
import { freshnessOf, gaugeSummary, type Freshness, type GaugeState } from '@shared/usage/limits'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { levelOf, LEVEL_COLOR, useNow } from '@/lib/meter-hooks'
import { Tooltip } from '../ui/tooltip'
import { PROVIDER_ICON } from '@/lib/provider-icons'
import { codexGaugeLine } from '@/lib/codex-meter'

function Dot({
  pct,
  label,
  freshness
}: {
  pct: number | undefined
  label: string
  freshness?: Freshness
}) {
  const r = 6
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, pct ?? 0))
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={16} height={16} className="-rotate-90" aria-hidden>
        <circle
          cx={8}
          cy={8}
          r={r}
          fill="none"
          stroke={freshness === 'stale' ? 'var(--gauge-warn)' : 'var(--gauge-track)'}
          strokeWidth={2.5}
          strokeDasharray={freshness === 'stale' ? '2 2' : undefined}
        />
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
      <span
        className={cn(
          'font-medium tabular-nums',
          freshness && freshness !== 'fresh'
            ? 'text-[var(--gauge-warn-text)]'
            : 'text-foreground/80'
        )}
      >
        {pct === undefined ? '–' : `${Math.round(pct)}%`}
      </span>
    </span>
  )
}

/** Codex's windows as dots: the 5-hour one only while Codex reports it. */
function CodexDots({ t, withIcon }: { t: number; withIcon?: boolean }) {
  const codex = useApp((s) => s.codexLimits)
  if (!codex?.hasData) return null
  const Icon = PROVIDER_ICON.codex
  const dot = (label: string, g: typeof codex.fiveHour) => {
    const f = g && freshnessOf(g, t)
    return <Dot pct={g && f !== 'stale' ? g.pct : undefined} label={label} freshness={f} />
  }
  return (
    <span className="inline-flex items-center gap-3">
      {withIcon && <Icon className="size-3 text-subtle-foreground" aria-label="Codex" />}
      {codex.fiveHourRecent && dot('5h', codex.fiveHour)}
      {dot('Week', codex.sevenDay)}
    </span>
  )
}

/** The usage gauges, small, for the app's title (status) bar. */
export function MiniGauges() {
  const mp = useApp((s) => s.settings.meterProvider ?? 'claude')
  if (mp === 'claude') return <ClaudeMiniGauges />
  return <ProviderMiniGauges both={mp === 'both'} />
}

/** Codex's (or both providers') gauges in the status bar. */
function ProviderMiniGauges({ both }: { both: boolean }) {
  const limits = useApp((s) => s.limits)
  const codex = useApp((s) => s.codexLimits)
  const view = useApp((s) => s.view)
  const set = useApp((s) => s.set)
  const t = useNow()
  const ClaudeIcon = PROVIDER_ICON.claude
  const lines = [
    ...(both && limits
      ? [
          gaugeSummary('Claude 5-hour', limits.fiveHour, t),
          gaugeSummary('Claude week', limits.sevenDay, t)
        ]
      : []),
    ...(codex?.fiveHourRecent ? [codexGaugeLine('Codex 5-hour', codex.fiveHour, t)] : []),
    codexGaugeLine('Codex week', codex?.sevenDay, t)
  ]
  const claude = (g: GaugeState | undefined) => {
    const f = g && freshnessOf(g, t)
    return { pct: g && f !== 'stale' ? g.pct : undefined, f }
  }
  const c5 = claude(limits?.fiveHour)
  const c7 = claude(limits?.sevenDay)
  return (
    <Tooltip content={lines.join(' · ')} shortcut="Ctrl+U">
      <button
        type="button"
        onClick={() => set({ view: view === 'usage' ? 'sessions' : 'usage' })}
        className={cn(
          'no-drag flex h-7 items-center gap-3 rounded-md px-2 text-2xs transition-colors hover:bg-hover',
          view === 'usage' && 'bg-selected'
        )}
      >
        {both && limits && (limits.fiveHour || limits.sevenDay) && (
          <span className="inline-flex items-center gap-3">
            <ClaudeIcon className="size-3 text-subtle-foreground" aria-label="Claude" />
            <Dot pct={c5.pct} label="5h" freshness={c5.f} />
            <Dot pct={c7.pct} label="Week" freshness={c7.f} />
          </span>
        )}
        {codex?.hasData ? (
          <CodexDots t={t} withIcon />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Gauge className="size-3.5" /> Usage
          </span>
        )}
      </button>
    </Tooltip>
  )
}

function ClaudeMiniGauges() {
  const limits = useApp((s) => s.limits)
  const view = useApp((s) => s.view)
  const set = useApp((s) => s.set)
  const t = useNow()
  if (!limits) return null
  const f5 = limits.fiveHour && freshnessOf(limits.fiveHour, t)
  const f7 = limits.sevenDay && freshnessOf(limits.sevenDay, t)
  // A window that reset since its reading shows "–", never a made-up 0%.
  const five = limits.fiveHour && f5 !== 'stale' ? limits.fiveHour.pct : undefined
  const week = limits.sevenDay && f7 !== 'stale' ? limits.sevenDay.pct : undefined
  const anyGauge = !!limits.fiveHour || !!limits.sevenDay
  const notFresh = [f5, f7].some((f) => f && f !== 'fresh')
  return (
    <Tooltip
      content={
        anyGauge && notFresh
          ? [
              gaugeSummary('5-hour', limits.fiveHour, t),
              gaugeSummary('Week', limits.sevenDay, t)
            ].join(' · ')
          : 'Usage & limits'
      }
      shortcut="Ctrl+U"
    >
      <button
        type="button"
        onClick={() => set({ view: view === 'usage' ? 'sessions' : 'usage' })}
        className={cn(
          'no-drag flex h-7 items-center gap-3 rounded-md px-2 text-2xs transition-colors hover:bg-hover',
          view === 'usage' && 'bg-selected'
        )}
      >
        {!anyGauge ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Gauge className="size-3.5" /> Usage
          </span>
        ) : (
          <>
            <Dot pct={five} label="5h" freshness={f5} />
            <Dot pct={week} label="Week" freshness={f7} />
          </>
        )}
      </button>
    </Tooltip>
  )
}
