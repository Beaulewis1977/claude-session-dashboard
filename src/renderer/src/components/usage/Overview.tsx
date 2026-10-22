import { useMemo, type ReactNode } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from 'recharts'
import { ArrowDownRight, ArrowUpRight, Check } from 'lucide-react'
import type {
  BreakdownRow,
  PeriodCard,
  Period,
  SeriesPoint,
  UsageReport
} from '@shared/usage/types'
import { formatInt, formatTokens, formatUsd } from '@shared/format'
import { bucketLabel } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { modelColor, modelLabel, TOKEN_META, TOKEN_ORDER } from '@/lib/usage-colors'
import { Segmented } from '../ui/segmented'
import { Tooltip } from '../ui/tooltip'
import { Card, CardHeader, CountUp, Skeleton, Sparkline } from './primitives'

// ------------------------------------------------------------ summary cards

export function SummaryCards({
  cards,
  active,
  onPick
}: {
  cards: PeriodCard[] | undefined
  active: string | null
  onPick: (c: PeriodCard) => void
}) {
  if (!cards) {
    return (
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="h-[118px] p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-6 w-24" />
            <Skeleton className="mt-4 h-6 w-full" />
          </Card>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
      {cards.map((c) => {
        const up = (c.deltaPct ?? 0) >= 0
        return (
          <Card key={c.id} className="p-4" onClick={() => onPick(c)} active={active === c.id}>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-medium">{c.label}</span>
              {c.deltaPct !== undefined && Number.isFinite(c.deltaPct) && (
                <Tooltip
                  content={`${formatTokens(c.prevTotal ?? 0)} in the same part of the previous ${c.id === 'today' ? 'day' : c.id}`}
                >
                  <span className="inline-flex items-center gap-0.5 tabular-nums">
                    {up ? (
                      <ArrowUpRight className="size-3.5" />
                    ) : (
                      <ArrowDownRight className="size-3.5" />
                    )}
                    {Math.abs(c.deltaPct) >= 999 ? '999+' : Math.round(Math.abs(c.deltaPct))}%
                  </span>
                </Tooltip>
              )}
            </div>
            <Tooltip content={`${formatInt(c.total)} tokens · ${formatUsd(c.cost)} at API prices`}>
              <div className="mt-1.5 w-fit text-[24px] leading-tight font-semibold tracking-[-0.02em] tabular-nums">
                <CountUp value={c.total} format={formatTokens} />
              </div>
            </Tooltip>
            <div className="text-[11px] text-subtle-foreground tabular-nums">
              ≈ {formatUsd(c.cost)} at API prices
            </div>
            <Sparkline
              values={c.spark}
              className="mt-2"
              height={26}
              color="var(--tok-cache-read)"
            />
          </Card>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- chips

export function ModelChips({
  models,
  selected,
  onChange
}: {
  models: string[]
  selected: string[]
  onChange: (m: string[]) => void
}) {
  const all = selected.length === 0
  const chip = (
    key: string,
    label: ReactNode,
    on: boolean,
    onClick: () => void,
    color?: string
  ) => (
    <button
      key={key}
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
        on
          ? 'border-border-strong bg-background text-foreground shadow-xs'
          : 'border-transparent bg-secondary text-muted-foreground hover:text-foreground'
      )}
    >
      {color && <span className="size-2 rounded-full" style={{ background: color }} />}
      {label}
      {on && !color && <Check className="size-3" />}
    </button>
  )
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chip('all', 'All models', all, () => onChange([]))}
      {models.map((m) =>
        chip(
          m,
          modelLabel(m),
          selected.includes(m),
          () => onChange(selected.includes(m) ? selected.filter((x) => x !== m) : [...selected, m]),
          modelColor(m, models)
        )
      )}
    </div>
  )
}

// ----------------------------------------------------------- main chart

function ChartTooltip({
  active,
  payload,
  period
}: {
  active?: boolean
  payload?: { payload: SeriesPoint }[]
  period: Period
}) {
  const p = payload?.[0]?.payload
  if (!active || !p) return null
  return (
    <div className="min-w-[210px] rounded-lg border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-xl">
      <div className="mb-1.5 font-medium">{bucketLabel(p, period, true)}</div>
      <div className="space-y-1">
        {[...TOKEN_ORDER].reverse().map((t) => (
          <div key={t} className="flex items-center gap-2">
            <span className="size-2 rounded-sm" style={{ background: TOKEN_META[t].color }} />
            <span className="flex-1 text-muted-foreground">{TOKEN_META[t].label}</span>
            <span className="tabular-nums">{formatInt(p[t])}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 font-medium">
        <span className="flex-1">Total</span>
        <span className="tabular-nums">{formatInt(p.total)}</span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="flex-1">Cost at API prices</span>
        <span className="tabular-nums">{formatUsd(p.cost)}</span>
      </div>
    </div>
  )
}

export function MainChart({
  report,
  period,
  onPeriod,
  range,
  models,
  selectedModels,
  onModels
}: {
  report: UsageReport | null
  period: Period
  onPeriod: (p: Period) => void
  range: ReactNode
  models: string[]
  selectedModels: string[]
  onModels: (m: string[]) => void
}) {
  const data = report?.series ?? []
  const empty = report && !report.loading && data.every((p) => p.total === 0)
  return (
    <Card className="p-5">
      <CardHeader
        title="Tokens over time"
        subtitle={`How many tokens you used each ${period === 'hour' ? 'hour' : period}, by type`}
        info="Cache reads are tokens Claude re-reads from the prompt cache; they are cheap and make up most of the volume in Claude Code. Each API response is counted once."
        right={
          <>
            {range}
            <Segmented
              ariaLabel="Group by"
              value={period === 'hour' ? 'day' : period}
              onChange={onPeriod}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' }
              ]}
            />
          </>
        }
      />
      <div className="mt-3">
        <ModelChips models={models} selected={selectedModels} onChange={onModels} />
      </div>
      <div className="mt-4 h-[280px]">
        {!report ? (
          <Skeleton className="h-full w-full" />
        ) : empty ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No usage in this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
              <XAxis
                dataKey="start"
                type="category"
                tickFormatter={(v: number) => bucketLabel({ start: v }, period)}
                tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                tickMargin={8}
              />
              <YAxis
                tickFormatter={(v: number) => formatTokens(v)}
                tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <RTooltip
                content={<ChartTooltip period={period} />}
                cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
                isAnimationActive={false}
              />
              {TOKEN_ORDER.map((t) => (
                <Area
                  key={t}
                  type="monotone"
                  dataKey={t}
                  name={TOKEN_META[t].label}
                  stackId="tokens"
                  stroke="var(--card)"
                  strokeWidth={1.5}
                  fill={TOKEN_META[t].color}
                  fillOpacity={0.88}
                  activeDot={false}
                  animationDuration={380}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[...TOKEN_ORDER].reverse().map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: TOKEN_META[t].color }} />
            {TOKEN_META[t].label}
            {report && (
              <span className="text-subtle-foreground tabular-nums">
                {formatTokens(report.totals[t])}
              </span>
            )}
          </span>
        ))}
        {report && (
          <span className="ml-auto tabular-nums">
            {formatTokens(report.totals.total)} total · ≈ {formatUsd(report.totals.cost)}
          </span>
        )}
      </div>
    </Card>
  )
}

// ----------------------------------------------------------- model donut

export function ModelShare({
  rows,
  models
}: {
  rows: BreakdownRow[] | undefined
  models: string[]
}) {
  const top = useMemo(() => {
    if (!rows) return []
    const main = rows.slice(0, 6)
    const rest = rows.slice(6)
    if (rest.length) {
      const total = rest.reduce((a, r) => a + r.total, 0)
      main.push({
        ...rest[0],
        key: '__other',
        label: 'Other',
        total,
        share: rest.reduce((a, r) => a + r.share, 0),
        cost: rest.reduce((a, r) => a + r.cost, 0)
      })
    }
    return main
  }, [rows])
  const color = (k: string): string =>
    k === '__other' ? 'var(--model-other)' : modelColor(k, models)
  return (
    <Card className="flex flex-col p-5">
      <CardHeader title="Models" subtitle="Share of all tokens in this range, by model" />
      {!rows ? (
        <Skeleton className="mt-4 h-[180px] w-full" />
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No usage in this range.
        </div>
      ) : (
        <div className="my-auto flex flex-wrap items-center gap-6 pt-3">
          <div className="relative size-[168px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={top}
                  dataKey="total"
                  nameKey="label"
                  innerRadius={56}
                  outerRadius={80}
                  paddingAngle={top.length > 1 ? 1.2 : 0}
                  stroke="var(--card)"
                  strokeWidth={2}
                  startAngle={90}
                  endAngle={-270}
                  animationDuration={380}
                >
                  {top.map((r) => (
                    <Cell key={r.key} fill={color(r.key)} />
                  ))}
                </Pie>
                <RTooltip
                  isAnimationActive={false}
                  content={({ active, payload }) => {
                    const r = payload?.[0]?.payload as BreakdownRow | undefined
                    if (!active || !r) return null
                    return (
                      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
                        <div className="font-medium">{r.label}</div>
                        <div className="text-muted-foreground tabular-nums">
                          {formatInt(r.total)} tokens · {formatUsd(r.cost)}
                        </div>
                      </div>
                    )
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-[17px] font-semibold tabular-nums">
                {formatTokens(rows.reduce((a, r) => a + r.total, 0))}
              </div>
              <div className="text-[10.5px] text-muted-foreground">tokens</div>
            </div>
          </div>
          <div className="min-w-[180px] flex-1 space-y-1.5">
            {top.map((r) => (
              <div key={r.key} className="flex items-center gap-2 text-xs">
                <span
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ background: color(r.key) }}
                />
                <span className="min-w-0 flex-1 truncate" title={r.detail}>
                  {r.label}
                </span>
                <span className="text-muted-foreground tabular-nums">{formatTokens(r.total)}</span>
                <span className="w-10 text-right font-medium tabular-nums">
                  {Math.round(r.share * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------- top sessions

export function TopSessions({
  rows,
  onOpen
}: {
  rows: BreakdownRow[] | undefined
  onOpen: (key: string) => void
}) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.total))
  return (
    <Card className="p-5">
      <CardHeader
        title="Top sessions"
        subtitle="The sessions that used the most tokens in this range"
      />
      {!rows ? (
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No sessions in this range.
        </div>
      ) : (
        <div className="-mx-2 mt-2">
          {rows.slice(0, 7).map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => onOpen(r.key)}
              className="group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium group-hover:text-foreground">
                  {r.label}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--gauge-track)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(r.total / max) * 100}%`,
                        background: 'var(--tok-cache-read)'
                      }}
                    />
                  </div>
                  <span className="w-[90px] shrink-0 truncate text-[11px] text-subtle-foreground">
                    {r.detail}
                  </span>
                </div>
              </div>
              <Tooltip
                content={`${formatInt(r.total)} tokens · ${formatUsd(r.cost)} at API prices`}
              >
                <span className="w-14 shrink-0 text-right text-xs font-medium tabular-nums">
                  {formatTokens(r.total)}
                </span>
              </Tooltip>
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}
