import { CalendarClock, Gauge, KeyRound, PlugZap, TrendingDown } from 'lucide-react'
import { ago, formatDuration, formatInt, formatTokens, formatUsd } from '@shared/format'
import { PLAN_LABEL, type GaugeState, type LimitsState } from '@shared/usage/limits'
import type { CreditsState } from '@shared/usage/credits'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Tooltip } from '../ui/tooltip'
import { levelOf, LEVEL_COLOR, useNow } from '@/lib/meter-hooks'
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

/** A thin bar: how much of the window has passed (marker) vs. how much is used (fill). */
function PaceLine({ g, t }: { g: GaugeState; t: number }) {
  const span = (g.resetsAt ?? t) - (g.windowStart ?? t)
  const elapsed =
    span > 0 ? Math.min(100, Math.max(0, ((t - (g.windowStart ?? t)) / span) * 100)) : 0
  const color = LEVEL_COLOR[levelOf(g.pct)]
  return (
    <Tooltip content={`${Math.round(g.pct)}% used with ${Math.round(elapsed)}% of the window gone`}>
      <div className="relative mt-3 h-1 w-full rounded-full bg-[var(--gauge-track)]">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300"
          style={{ width: `${Math.min(100, g.pct)}%`, background: color }}
        />
        <div
          className="absolute -top-1 h-3 w-[2px] rounded-full bg-foreground/45"
          style={{ left: `calc(${elapsed}% - 1px)` }}
        />
      </div>
    </Tooltip>
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
  const title = kind === 'five_hour' ? '5-hour window' : 'This week'
  const info =
    kind === 'five_hour'
      ? 'The same percentage Claude Code shows in /usage, captured by the status line bridge. Tokens come from your session logs.'
      : 'Your weekly limit, as Claude Code reports it. The week resets at a fixed time, shown below.'

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

  const pace = paceText(g, t)
  const level = levelOf(g.pct)
  const stale = t - g.updatedAt > 60 * 60_000
  return (
    <Card className="p-5">
      <CardHeader
        title={title}
        info={info}
        right={
          <span
            className="text-[11px] text-subtle-foreground"
            title={new Date(g.updatedAt).toLocaleString()}
          >
            Updated {ago(g.updatedAt, t)}
          </span>
        }
      />
      <div className="mt-4 flex items-center gap-5">
        <RingGauge pct={g.pct}>
          <div className="text-[34px] leading-none font-semibold tracking-[-0.03em] tabular-nums">
            <CountUp value={g.pct} format={(n) => `${Math.round(n)}%`} />
          </div>
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            {g.expired
              ? 'Reset since'
              : g.resetsAt
                ? `Resets in ${formatDuration(g.resetsAt - t)}`
                : 'used'}
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
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="size-3.5 shrink-0 text-subtle-foreground" />
              <span className="truncate">Resets {when(g.resetsAt, t)}</span>
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
      {!g.expired && <PaceLine g={g} t={t} />}
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
        {g.expired ? 'This window has reset. Open Claude Code to refresh.' : pace.text}
      </div>
      {stale && !g.expired && (
        <div className="mt-1 text-[11px] text-subtle-foreground">
          Last updated {ago(g.updatedAt, t)} — open Claude Code to refresh
        </div>
      )}
    </Card>
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
    <Card className="flex flex-col p-5" onClick={onOpen}>
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
