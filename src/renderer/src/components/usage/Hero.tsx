import { CalendarClock, Gauge, KeyRound, PlugZap, TrendingDown, TriangleAlert } from 'lucide-react'
import { ago, formatDuration, formatInt, formatTokens, formatUsd } from '@shared/format'
import {
  freshnessOf,
  lastKnown,
  LIVE_SOURCES_NOTE,
  PLAN_LABEL,
  REFRESH_HINT,
  shownWeeklyBuckets,
  whyNoLiveReading,
  type Freshness,
  type GaugeState,
  type LimitsState
} from '@shared/usage/limits'
import type { CreditsState } from '@shared/usage/credits'
import { PACE_LABEL, type PaceAdvice, type PaceState } from '@shared/usage/pace'
import { cn } from '@/lib/utils'
import { useApp } from '@/lib/store'
import { Button } from '../ui/button'
import { Tooltip } from '../ui/tooltip'
import { levelOf, LEVEL_COLOR, useNow } from '@/lib/meter-hooks'
import { creditsEmptyText } from '@/lib/billing'
import { Card, CardHeader, CountUp, RingGauge, Skeleton, Sparkline } from './primitives'

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
})

function when(ts: number, t: number): string {
  return ts - t < 20 * 3_600_000 && new Date(ts).getDate() === new Date(t).getDate()
    ? timeFmt.format(ts)
    : dayTimeFmt.format(ts)
}

/**
 * A thin bar: how much is used (fill) against the pace target, cap × elapsed
 * ÷ window length (marker), as in claude-usage-pacer.
 */
function PaceLine({ g, pace, t }: { g: GaugeState; pace?: PaceState; t: number }) {
  const span = (g.resetsAt ?? t) - (g.windowStart ?? t)
  const elapsed =
    span > 0 ? Math.min(100, Math.max(0, ((t - (g.windowStart ?? t)) / span) * 100)) : 0
  const target = pace?.target ?? elapsed
  const color = LEVEL_COLOR[levelOf(g.pct)]
  return (
    <Tooltip
      content={
        pace
          ? `${Math.round(g.pct)}% used; the pace target now is ${Math.round(target)}% (${pace.cap}% cap × ${Math.round(elapsed)}% of the window gone)`
          : `${Math.round(g.pct)}% used with ${Math.round(elapsed)}% of the window gone`
      }
    >
      <div className="relative mt-3 h-1 w-full rounded-full bg-[var(--gauge-track)]">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
          style={{ width: `${Math.min(100, g.pct)}%`, background: color }}
        />
        <div
          className="absolute -top-1 h-3 w-[2px] rounded-full bg-foreground/55"
          style={{ left: `calc(${Math.min(100, target)}% - 1px)` }}
        />
        {pace && (
          <div
            className="absolute -top-0.5 h-2 w-px bg-foreground/25"
            style={{ left: `${pace.cap}%` }}
            title={`Cap ${pace.cap}%`}
          />
        )}
      </div>
    </Tooltip>
  )
}

function PaceChip({ pace }: { pace: PaceState }) {
  const tolerance = useApp((s) => s.settings.pace.tolerance)
  const warn = pace.status === 'ahead' || pace.status === 'at-cap'
  return (
    <Tooltip
      content={`Target ${Math.round(pace.target)}% now (±${tolerance} points counts as on pace). Room left: ${pace.roomPerHour.toFixed(1)} points per hour until the reset to stay under ${pace.cap}%.`}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium',
          warn ? 'bg-warning-soft text-[var(--gauge-warn-text)]' : 'bg-secondary text-foreground/70'
        )}
      >
        {PACE_LABEL[pace.status]} ·{' '}
        {pace.roomPerHour >= 10 ? Math.round(pace.roomPerHour) : pace.roomPerHour.toFixed(1)}%/h
        room
      </span>
    </Tooltip>
  )
}

/** One line of pacing advice; the weekly window is the main limit. */
export function PaceAdviceLine({ advice }: { advice: PaceAdvice }) {
  return (
    <div
      className={cn(
        'mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
        advice.tone === 'warn'
          ? 'bg-warning-soft text-[var(--gauge-warn-text)]'
          : 'bg-secondary/60 text-muted-foreground'
      )}
    >
      <Gauge className="size-3.5 shrink-0" />
      <span className="font-medium">{advice.text}</span>
      <span className="ml-auto hidden text-[11px] opacity-80 sm:inline">
        Weekly is the main limit
      </span>
    </div>
  )
}

function paceText(g: GaugeState, t: number): { text: string; tone: 'calm' | 'warn' | 'crit' } {
  if (g.pct >= 100) return { text: 'Limit reached', tone: 'crit' }
  const p = g.projection
  if (!p || p.pctPerHour <= 0.05) return { text: 'Not using much right now', tone: 'calm' }
  if (p.safe || !p.hitsLimitAt) return { text: 'On pace to stay under the limit', tone: 'calm' }
  const left = p.hitsLimitAt - t
  return {
    text: `On pace to hit 100% at ${when(p.hitsLimitAt, t)} (in ~${formatDuration(left)})`,
    tone: left < 3_600_000 ? 'crit' : 'warn'
  }
}

export function LimitCard({
  kind,
  limits,
  onEnable
}: {
  kind: 'five_hour' | 'seven_day'
  limits: LimitsState | null
  onEnable: () => void
}) {
  const t = useNow()
  const g = kind === 'five_hour' ? limits?.fiveHour : limits?.sevenDay
  const title = kind === 'five_hour' ? '5-hour window' : 'This week · all models'
  const info =
    kind === 'five_hour'
      ? `The same percentage Claude Code shows in /usage, captured by the status line bridge. Tokens come from your session logs. ${LIVE_SOURCES_NOTE}`
      : `Your weekly limit across all models (Claude Code's seven_day window), as Claude Code reports it. The week resets at a fixed time, shown below. ${LIVE_SOURCES_NOTE}`

  if (!limits) {
    return (
      <Card className="p-5">
        <Skeleton className="h-4 w-28" />
        <div className="mt-4 flex items-center gap-5">
          <Skeleton className="size-[148px] rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      </Card>
    )
  }

  // No bridge data: log-only estimate for the 5-hour window, a prompt for the week.
  if (!g) {
    const b = kind === 'five_hour' ? limits.block : undefined
    return (
      <Card className="p-5">
        <CardHeader title={title} info={info} subtitle="Estimate from session logs" />
        <div className="mt-4 flex items-center gap-5">
          <RingGauge pct={undefined} dim>
            {b ? (
              <>
                <div className="text-[26px] leading-none font-semibold tracking-tight tabular-nums">
                  {formatTokens(b.total)}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">tokens this block</div>
              </>
            ) : (
              <Gauge className="size-6 text-subtle-foreground" />
            )}
          </RingGauge>
          <div className="min-w-0 flex-1 space-y-2 text-xs text-muted-foreground">
            {b ? (
              <div>
                Block ends at {when(b.end, t)} · {formatUsd(b.cost)} at API prices
              </div>
            ) : (
              <div>No activity in the current 5-hour block.</div>
            )}
            <p className="leading-relaxed">
              Enable live limits to see your real {PLAN_LABEL[limits.plan]} usage.
            </p>
            <Button variant="outline" size="sm" onClick={onEnable}>
              <PlugZap /> Enable live limits
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  const freshness = freshnessOf(g, t)
  // The window has reset since the newest reading: its % says nothing about now.
  if (freshness === 'stale') {
    const b = kind === 'five_hour' ? limits.block : undefined
    return (
      <Card className="p-5">
        <CardHeader
          title={title}
          info={info}
          right={<UpdatedLabel ts={g.updatedAt} t={t} freshness={freshness} />}
        />
        <div className="mt-4 flex items-center gap-5">
          <RingGauge pct={undefined} dim>
            <div className="px-4 text-center text-[13px] leading-tight font-medium text-muted-foreground">
              No recent reading
            </div>
          </RingGauge>
          <div className="min-w-0 flex-1 space-y-2 text-xs text-muted-foreground">
            <div>
              <div className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
                Last known
              </div>
              <div className="text-[15px] font-semibold text-foreground tabular-nums">
                {lastKnown(g, t)}
              </div>
            </div>
            {b && (
              <div>
                {formatTokens(b.total)} tokens in your logs this block · ends {when(b.end, t)}
              </div>
            )}
            <p className="leading-relaxed">{whyNoLiveReading(limits, t, kind)}</p>
          </div>
        </div>
        {kind === 'seven_day' && <WeeklyBuckets limits={limits} t={t} />}
      </Card>
    )
  }

  const pace = paceText(g, t)
  const paceState = kind === 'five_hour' ? limits.pace5h : limits.pace7d
  const level = levelOf(g.pct)
  const stale = freshness === 'aging'
  return (
    <Card className="p-5">
      <CardHeader
        title={title}
        info={info}
        right={<UpdatedLabel ts={g.updatedAt} t={t} freshness={freshness} />}
      />
      <div className="mt-4 flex items-center gap-5">
        <RingGauge pct={g.pct} target={paceState?.target}>
          <div className="text-[34px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
            <CountUp value={g.pct} format={(n) => `${Math.round(n)}%`} />
          </div>
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            {g.resetsAt ? `Resets in ${formatDuration(g.resetsAt - t)}` : 'used'}
          </div>
        </RingGauge>
        <div className="min-w-0 flex-1 space-y-2.5">
          <div>
            <div className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
              In this window
            </div>
            <Tooltip content={`${formatInt(g.tokens)} tokens from your session logs`}>
              <div className="w-fit text-[15px] font-semibold tabular-nums">
                {formatTokens(g.tokens)}{' '}
                <span className="text-xs font-normal text-muted-foreground">tokens</span>
              </div>
            </Tooltip>
          </div>
          {g.resetsAt && (
            <div>
              <div className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
                Resets
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                <CalendarClock className="size-3.5 shrink-0 text-subtle-foreground" />
                <span className="truncate">{when(g.resetsAt, t)}</span>
              </div>
            </div>
          )}
          {level !== 'calm' && (
            <div
              className="text-xs font-medium"
              style={{ color: level === 'crit' ? 'var(--gauge-crit)' : 'var(--gauge-warn-text)' }}
            >
              {level === 'crit' ? 'Almost at the limit' : 'Getting close'}
            </div>
          )}
        </div>
      </div>
      <PaceLine g={g} pace={paceState} t={t} />
      <div
        className={cn(
          'mt-2 text-xs',
          pace.tone === 'calm' ? 'text-muted-foreground' : 'font-medium'
        )}
        style={
          pace.tone === 'crit'
            ? { color: 'var(--gauge-crit)' }
            : pace.tone === 'warn'
              ? { color: 'var(--gauge-warn-text)' }
              : undefined
        }
      >
        {pace.text}
      </div>
      {paceState && (
        <div className="mt-1.5">
          <PaceChip pace={paceState} />
        </div>
      )}
      {stale && (
        <div className="mt-1 text-[11px] font-medium text-[var(--gauge-warn-text)]">
          Last updated {ago(g.updatedAt, t)}. {REFRESH_HINT}
        </div>
      )}
      {kind === 'seven_day' && <WeeklyBuckets limits={limits} t={t} />}
    </Card>
  )
}

/** "Updated 5 min ago": amber after an hour, a "Stale" chip once the window has reset. */
export function UpdatedLabel({
  ts,
  t,
  freshness
}: {
  ts: number
  t: number
  freshness: Freshness
}) {
  const full = new Date(ts).toLocaleString()
  if (freshness === 'stale') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-1.5 py-px text-[10.5px] font-medium text-[var(--gauge-warn-text)]"
        title={`Newest reading: ${full}`}
      >
        <TriangleAlert className="size-3" /> Stale · {ago(ts, t)}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'text-[11px]',
        freshness === 'aging'
          ? 'font-medium text-[var(--gauge-warn-text)]'
          : 'text-subtle-foreground'
      )}
      title={full}
    >
      Updated {ago(ts, t)}
    </span>
  )
}

/** Extra weekly windows (e.g. one model only), if Claude Code reports any. */
function WeeklyBuckets({ limits, t }: { limits: LimitsState; t: number }) {
  const list = shownWeeklyBuckets(limits, t)
  if (!list.length) return null
  return (
    <div className="mt-3 space-y-1 border-t border-border pt-2.5 text-xs">
      {list.map((b) => (
        <div
          key={b.key}
          className="flex items-baseline justify-between gap-3"
          title={`Read ${new Date(b.updatedAt).toLocaleString()}`}
        >
          <span className="text-muted-foreground">This week · {b.label}</span>
          <span
            className={cn(
              'font-medium tabular-nums',
              b.freshness !== 'fresh' && 'text-[var(--gauge-warn-text)]'
            )}
          >
            {Math.round(b.pct)}%
            {b.asOf ? (
              <span
                className={cn(
                  'ml-1.5 font-normal',
                  b.freshness === 'fresh' ? 'text-subtle-foreground' : 'font-medium'
                )}
              >
                {b.asOf}
              </span>
            ) : (
              b.resetsAt && (
                <span className="ml-1.5 font-normal text-subtle-foreground">
                  resets {when(b.resetsAt, t)}
                </span>
              )
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

export function CreditsHeroCard({
  credits,
  onOpen
}: {
  credits: CreditsState
  onOpen: () => void
}) {
  const sums = credits.summaries.filter((s) => s.granted > 0 || s.spent > 0)
  if (!sums.length) return null
  const remaining = sums.reduce((a, s) => a + s.remaining, 0)
  const granted = sums.reduce((a, s) => a + s.granted, 0)
  const burn = sums.reduce((a, s) => a + s.burnPerDay, 0)
  const spark = sums[0].spark.map((_, i) => sums.reduce((a, s) => a + s.spark[i], 0))
  const soon = sums.flatMap((s) => s.grants.filter((g) => g.expiresSoon))
  const names = sums
    .map((s) => credits.accounts.find((a) => a.id === s.accountId)?.nickname)
    .filter(Boolean)
    .join(', ')
  const admin = credits.admin.find((a) => a.monthUsd > 0)
  const days = burn > 0 ? remaining / burn : undefined
  return (
    <Card className="flex flex-col p-5" onClick={onOpen} label="Open API credits details">
      <CardHeader
        title="API credits"
        subtitle={names}
        info="Balance = your credit grants minus spending of API-billed sessions (Claude Code's own cost figure, or the price table when that's missing). There's no API for the real balance."
        right={<KeyRound className="size-4 text-subtle-foreground" />}
      />
      <div className="mt-4 flex items-baseline gap-2">
        <div className="text-[34px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
          <CountUp value={remaining} format={(n) => formatUsd(n)} />
        </div>
        <div className="text-xs text-muted-foreground">left of {formatUsd(granted)}</div>
      </div>
      <div className="mt-3">
        <Sparkline values={spark} color="var(--tok-input)" height={34} />
        <div className="mt-1 flex justify-between text-[10.5px] text-subtle-foreground">
          <span>Spend, last 30 days</span>
          <span className="tabular-nums">{formatUsd(burn)}/day</span>
        </div>
      </div>
      <div className="mt-auto space-y-1 pt-3 text-xs">
        <div className="font-medium">
          {days === undefined
            ? 'No spending in the last 2 weeks'
            : `Lasts ~${Math.max(1, Math.round(days))} days at this pace`}
        </div>
        {soon.length > 0 && (
          <div className="flex items-center gap-1.5 text-warning">
            <CalendarClock className="size-3.5" />
            {formatUsd(soon.reduce((a, g) => a + g.remaining, 0))} expires{' '}
            {new Date(soon[0].expiresAt!).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric'
            })}
          </div>
        )}
        {admin && (
          <Tooltip
            content={`${admin.nickname}: organization cost from the Admin API (authoritative)`}
          >
            <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <TrendingDown className="size-3.5 shrink-0" />
              <span className="truncate">
                Org: {formatUsd(admin.monthUsd)} this month · Admin API
              </span>
            </div>
          </Tooltip>
        )}
      </div>
    </Card>
  )
}

export function CreditsEmptyState({
  credits,
  onSetup
}: {
  credits: CreditsState | null | undefined
  /** Opens Settings → Accounts & API credits; unset on a phone (keys stay on the PC). */
  onSetup?: () => void
}) {
  const text = creditsEmptyText(credits)
  if (!text) return null
  return (
    <div
      data-testid="credits-empty"
      className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-border px-4 py-2.5"
    >
      <KeyRound className="size-4 shrink-0 text-subtle-foreground" />
      <div className="min-w-0 flex-1 text-[13px] text-muted-foreground">
        {text}
        {!onSetup && <span className="text-subtle-foreground"> (in the app on your PC)</span>}
      </div>
      {onSetup && (
        <Button variant="outline" size="sm" onClick={onSetup}>
          Accounts &amp; API credits
        </Button>
      )}
    </div>
  )
}
