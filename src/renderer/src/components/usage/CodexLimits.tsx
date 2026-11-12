// Codex's plan limits in the Usage view: one gauge per window Codex reports
// (named by its window_minutes, never by the slot it came in), the extra
// limits (another limit_id, e.g. one model's own), and the plan, detected
// from the logs or chosen in Settings.

import { useState } from 'react'
import { ChevronDown, Hexagon } from 'lucide-react'
import { formatDuration } from '@shared/format'
import { asOf, freshnessOf, lastKnown, type GaugeState } from '@shared/usage/limits'
import {
  CODEX_LIVE_NOTE,
  CODEX_REFRESH_HINT,
  codexWhyNoReading,
  codeLabel,
  type CodexLimitBucket,
  type CodexLimitsState,
  type CodexWindowGauge
} from '@shared/usage/codex'
import { useNow } from '@/lib/meter-hooks'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Tooltip } from '../ui/tooltip'
import { when } from '@/lib/usage-format'
import { LiveGaugeCard, StaleGaugeCard } from './Hero'
import { Card, CardHeader, RingGauge, Skeleton } from './primitives'

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

const INFO = {
  five_hour: `Codex's 5-hour window, as Codex itself reports it in its session logs (the same % its /status shows). Which window this is comes from its length (window_minutes = 300). ${CODEX_LIVE_NOTE}`,
  seven_day: `Codex's weekly window, as Codex itself reports it in its session logs (the same % its /status shows). Which window this is comes from its length (window_minutes = 10080). ${CODEX_LIVE_NOTE}`
}

/** "Pro $100 (prolite) · detected", with where it came from on hover. */
export function CodexPlanChip({ codex }: { codex: CodexLimitsState }) {
  const set = useApp((s) => s.set)
  const p = codex.plan
  const detail =
    p.setting === 'auto'
      ? p.detectedCode
        ? `Detected from plan_type "${p.detectedCode}" in your Codex logs${p.detectedSince ? ` (first seen ${dayFmt.format(p.detectedSince)})` : ''}. ${p.plan ? '' : "This code isn't one the app knows, so its multiplier is 1x. "}Change it in Settings → Usage & limits → Codex.`
        : 'No plan_type in your Codex logs yet: Plus is assumed. Change it in Settings → Usage & limits → Codex.'
      : `Chosen in Settings${p.detectedCode ? `; the logs say ${codeLabel(p.detectedCode)}` : ''}.`
  return (
    <Tooltip content={`${detail} Limit health multiplier: ${p.mult}x of Plus.`}>
      <button
        type="button"
        onClick={() => set({ view: 'settings', settingsSection: 'usage.codex' })}
        className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-px text-[11px] font-medium text-foreground/80 hover:bg-hover"
      >
        {p.label}
        <span className="text-subtle-foreground">
          · {p.setting === 'auto' ? 'detected' : 'chosen'}
        </span>
      </button>
    </Tooltip>
  )
}

/** One Codex window: live, or "no recent reading" once it reset. */
function WindowCard({
  title,
  info,
  g,
  codex,
  pace,
  compact,
  children
}: {
  title: string
  info: string
  g: GaugeState
  codex: CodexLimitsState
  pace?: CodexLimitsState['pace5h']
  compact?: boolean
  children?: React.ReactNode
}) {
  const t = useNow()
  if (freshnessOf(g, t) === 'stale')
    return (
      <StaleGaugeCard
        compact={compact}
        title={title}
        info={info}
        g={g}
        why={codexWhyNoReading(codex, g.kind, (ts) => asOf(ts, t))}
      >
        {children}
      </StaleGaugeCard>
    )
  return (
    <LiveGaugeCard
      compact={compact}
      title={title}
      info={info}
      g={g}
      paceState={pace}
      refreshHint={CODEX_REFRESH_HINT}
    >
      {children}
    </LiveGaugeCard>
  )
}

/** A small gauge row for an extra limit's window. */
function MiniRow({ w, label }: { w: CodexWindowGauge; label: string }) {
  const t = useNow()
  const g = w.gauge
  const stale = freshnessOf(g, t) === 'stale'
  const pct = stale ? undefined : g.pct
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <RingGauge pct={pct} dim={stale} size={34} stroke={4}>
        <span className="text-[9.5px] font-semibold tabular-nums">
          {pct === undefined ? '–' : Math.round(pct)}
        </span>
      </RingGauge>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{label}</div>
        <div className="text-muted-foreground">
          {w.label}
          {stale
            ? ` · ${lastKnown(g, t)}`
            : g.resetsAt
              ? ` · resets ${when(g.resetsAt, t)} (in ${formatDuration(g.resetsAt - t)})`
              : ''}
        </div>
      </div>
    </div>
  )
}

/** Limits other than the main one: recent ones as small gauges, older ones folded away. */
export function ExtraLimits({ limits }: { limits: CodexLimitBucket[] }) {
  const [open, setOpen] = useState(false)
  const recent = limits.filter((l) => l.recent)
  const older = limits.filter((l) => !l.recent)
  if (!limits.length) return null
  return (
    <div className="mt-4 border-t border-border pt-3">
      {recent.length > 0 && (
        <div className="space-y-2.5">
          <div className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
            Separate limits
          </div>
          {recent.flatMap((l) =>
            l.windows.map((w) => (
              <MiniRow key={`${l.limitId}:${w.minutes}`} w={w} label={l.label} />
            ))
          )}
        </div>
      )}
      {older.length > 0 && (
        <div className={cn(recent.length > 0 && 'mt-3')}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
            Other limits ({older.length}, no reading in the last 30 days)
          </button>
          {open && (
            <div className="mt-2 space-y-2.5">
              {older.flatMap((l) =>
                l.windows.map((w) => (
                  <MiniRow key={`${l.limitId}:${w.minutes}`} w={w} label={l.label} />
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Codex's gauge cards for the hero row (in the Codex view, or next to Claude's in All). */
export function CodexLimitCards({
  codex,
  compact
}: {
  codex: CodexLimitsState | null
  compact?: boolean
}) {
  const t = useNow()
  if (!codex) {
    return (
      <Card className="p-5">
        <Skeleton className="h-4 w-28" />
        <div className="mt-4 flex items-center gap-5">
          <Skeleton className={cn('rounded-full', compact ? 'size-[112px]' : 'size-[148px]')} />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      </Card>
    )
  }
  if (!codex.hasData) {
    return (
      <Card className="p-5">
        <CardHeader title="Codex limits" info={CODEX_LIVE_NOTE} />
        <div className="mt-4 flex items-center gap-5">
          <RingGauge pct={undefined} dim {...(compact ? { size: 112, stroke: 9 } : {})}>
            <Hexagon className="size-6 text-subtle-foreground" />
          </RingGauge>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            {codexWhyNoReading(codex, 'seven_day', (ts) => asOf(ts, t))}
          </p>
        </div>
      </Card>
    )
  }
  const extra = <ExtraLimits limits={codex.extraLimits} />
  const show5h = !!codex.fiveHour && (codex.fiveHourRecent || !codex.fiveHour.expired)
  const cards: React.ReactNode[] = []
  if (show5h)
    cards.push(
      <WindowCard
        key="5h"
        compact={compact}
        title="Codex · 5-hour window"
        info={INFO.five_hour}
        g={codex.fiveHour!}
        codex={codex}
        pace={codex.pace5h}
      />
    )
  if (codex.sevenDay)
    cards.push(
      <WindowCard
        key="week"
        compact={compact}
        title="Codex · Weekly"
        info={INFO.seven_day}
        g={codex.sevenDay}
        codex={codex}
        pace={codex.pace7d}
      >
        {!show5h && (
          <div className="mt-3 text-[11px] leading-relaxed text-subtle-foreground">
            No 5-hour window: Codex hasn&apos;t reported one in the last 30 days (Pro plans have
            none).
          </div>
        )}
        {extra}
      </WindowCard>
    )
  for (const w of codex.otherWindows)
    cards.push(
      <WindowCard
        key={`m${w.minutes}`}
        compact={compact}
        title={`Codex · ${w.label}`}
        info={`A window of ${w.minutes} minutes, as Codex reports it in its session logs. ${CODEX_LIVE_NOTE}`}
        g={w.gauge}
        codex={codex}
      />
    )
  if (!codex.sevenDay && codex.extraLimits.length)
    cards.push(
      <Card key="extra" className="p-5">
        <CardHeader title="Codex · separate limits" info={CODEX_LIVE_NOTE} />
        {extra}
      </Card>
    )
  return <>{cards}</>
}
