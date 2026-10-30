import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from 'recharts'
import {
  ArrowLeftRight,
  CalendarRange,
  CircleCheck,
  Hourglass,
  MapPinned,
  Plus,
  Sparkles,
  TrendingDown,
  TriangleAlert,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import {
  planLabel,
  toYmd,
  type CompareRange,
  type HealthCompare,
  type HealthReport,
  type WindowScore,
  type WindowSplit
} from '@shared/usage/health'
import type { CostParts } from '@shared/usage/pricing'
import { whyNoLiveReading, type LimitsState } from '@shared/usage/limits'
import { formatDateTime, formatTokens } from '@shared/format'
import { now } from '@shared/clock'
import { api } from '@/lib/api'
import { useNow } from '@/lib/meter-hooks'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { TOKEN_META } from '@/lib/usage-colors'
import type { AppSettings } from '@shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Segmented } from '../ui/segmented'
import { Tooltip } from '../ui/tooltip'
import { Card, CardHeader, Skeleton } from './primitives'

type Kind = 'five_hour' | 'seven_day'

const tick = { fill: 'var(--chart-axis)', fontSize: 11 }
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})
const shortDate = (ymd: string): string => dateFmt.format(new Date(`${ymd}T12:00:00`))

/** "$0.0139" — enough digits to compare small per-1% values. */
function perPctText(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 10) return `$${n.toFixed(1)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(3)}`
}

function useSaveSettings(): (p: Partial<AppSettings>) => Promise<void> {
  const set = useApp((s) => s.set)
  return async (p) => set({ settings: await api.updateSettings(p) })
}

const MIX_KEYS: { key: keyof CostParts; label: string; color: string }[] = [
  { key: 'cacheRead', label: 'Cache read', color: TOKEN_META.cacheRead.color },
  { key: 'cacheWrite', label: 'Cache write', color: TOKEN_META.cacheWrite.color },
  { key: 'input', label: 'Input', color: TOKEN_META.input.color },
  { key: 'output', label: 'Output', color: TOKEN_META.output.color }
]

/** Share of the API-equivalent cost by token type, as a thin stacked bar. */
export function MixBar({ mix, className }: { mix: CostParts; className?: string }) {
  const total = mix.input + mix.output + mix.cacheRead + mix.cacheWrite || 1
  return (
    <div className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-secondary', className)}>
      {MIX_KEYS.map((k) => (
        <div
          key={k.key}
          style={{ width: `${(mix[k.key] / total) * 100}%`, background: k.color }}
          title={`${k.label} ${Math.round((mix[k.key] / total) * 100)}%`}
        />
      ))}
    </div>
  )
}

function MixLegend({ mix }: { mix: CostParts }) {
  const total = mix.input + mix.output + mix.cacheRead + mix.cacheWrite || 1
  return (
    <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10.5px] text-muted-foreground">
      {MIX_KEYS.map((k) => (
        <span key={k.key} className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full" style={{ background: k.color }} />
          {k.label} {Math.round((mix[k.key] / total) * 100)}%
        </span>
      ))}
    </div>
  )
}

// --------------------------------------------------------------- baseline

function RangeInputs({
  value,
  onChange
}: {
  value: { from: string; to: string }
  onChange: (v: { from: string; to: string }) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="date"
        aria-label="From"
        value={value.from}
        onChange={(e) => onChange({ ...value, from: e.target.value })}
        className="h-7 w-[132px] px-1.5 text-xs"
      />
      <span className="text-xs text-muted-foreground">to</span>
      <Input
        type="date"
        aria-label="To"
        value={value.to}
        onChange={(e) => onChange({ ...value, to: e.target.value })}
        className="h-7 w-[132px] px-1.5 text-xs"
      />
    </div>
  )
}

function BaselinePicker({ report }: { report: HealthReport }) {
  const save = useSaveSettings()
  const s = report.settings
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ from: s.baselineFrom ?? '', to: s.baselineTo ?? '' })
  const b = report.baseline
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft({ from: s.baselineFrom ?? '', to: s.baselineTo ?? '' })
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs">
          <CalendarRange />
          {s.baselineFrom
            ? `Normal: ${shortDate(s.baselineFrom)} – ${shortDate(s.baselineTo ?? s.baselineFrom)}${b ? ` · ${b.n} windows` : ''}`
            : 'Pick normal dates'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="text-[13px] font-medium">Trusted &quot;normal&quot; dates</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Days when your limits felt normal. Their median $ per 1% (per 1x of plan) becomes the
          baseline every window is compared with.
        </p>
        <div className="mt-3">
          <RangeInputs value={draft} onChange={setDraft} />
        </div>
        <div className="mt-3 flex justify-end gap-2">
          {s.baselineFrom && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void save({ health: { ...s, baselineFrom: undefined, baselineTo: undefined } })
                setOpen(false)
              }}
            >
              Clear
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!draft.from}
            onClick={() => {
              void save({
                health: { ...s, baselineFrom: draft.from, baselineTo: draft.to || draft.from }
              })
              setOpen(false)
            }}
          >
            Use these dates
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------- verdict

function Verdict({ report }: { report: HealthReport }) {
  const v = report.verdict
  const icon =
    v.status === 'normal' ? (
      <CircleCheck className="size-5 text-[var(--gauge-calm)]" />
    ) : v.status === 'possible-reduction' ? (
      <TrendingDown className="size-5 text-[var(--gauge-warn-text)]" />
    ) : (
      <Hourglass className="size-5 text-subtle-foreground" />
    )
  return (
    <div className="flex items-start gap-3">
      <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary">
        {icon}
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            'text-[22px] leading-tight font-semibold tracking-[-0.02em]',
            v.status === 'possible-reduction' && 'text-[var(--gauge-warn-text)]',
            (v.status === 'not-enough-data' || v.status === 'needs-baseline') &&
              'text-foreground/80'
          )}
        >
          {v.headline}
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{v.detail}</div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ chart

interface BarRow {
  i: number
  w: WindowScore
  perPct: number
  expected?: number
  flag?: number
  plan: string
}

function WindowTooltip({ w, threshold }: { w: WindowScore; threshold: number }) {
  return (
    <div className="w-64 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
      <div className="font-medium">
        {w.closed ? 'Window ended' : 'Open window, resets'} {dateTimeFmt.format(w.resetsAt)}
      </div>
      <div className="mt-1 space-y-0.5 text-muted-foreground tabular-nums">
        <div>
          {Math.round(w.pct)}% used · {perPctText(w.perPct)} per 1% ·{' '}
          {formatTokens(
            w.tokens.input + w.tokens.output + w.tokens.cacheRead + w.tokens.cacheWrite
          )}{' '}
          tokens
        </div>
        {w.ratio !== undefined && (
          <div className={cn(w.low && 'font-medium text-[var(--gauge-warn-text)]')}>
            {w.ratio.toFixed(2)}× the baseline for {w.plan}
            {w.low ? ` (below 1/${threshold})` : ''}
          </div>
        )}
        {w.untrackedPct >= 1 && (
          <div>
            ~{Math.round(w.untrackedPct)} pts not explained by local usage
            {w.untrackedEstimated ? '' : ' (rose while nothing ran here)'}
          </div>
        )}
        {w.from === 'usage-command' && <div>From /usage output in an old transcript</div>}
      </div>
      <MixBar mix={w.mix} className="mt-2" />
      <MixLegend mix={w.mix} />
      {w.warning && (
        <div className="mt-1.5 text-[11px] leading-snug text-foreground/80">{w.warning}</div>
      )}
    </div>
  )
}

function HealthChart({ report }: { report: HealthReport }) {
  const keep = report.kind === 'five_hour' ? 40 : 16
  const rows: BarRow[] = useMemo(
    () =>
      report.windows.slice(-keep).map((w, i) => ({
        i,
        w,
        perPct: w.perPct,
        expected: w.expected,
        flag: w.expected ? w.expected / report.settings.threshold : undefined,
        plan: w.plan
      })),
    [report, keep]
  )
  if (!rows.length) {
    return (
      <div className="flex h-[220px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
        No scored windows yet. A window is scored once it reaches {report.settings.minPct}% with
        live limits on.
      </div>
    )
  }
  const planStarts = rows.filter((r, i) => i > 0 && r.plan !== rows[i - 1].plan)
  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={rows}
          margin={{ top: 14, right: 6, bottom: 0, left: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="i"
            tickFormatter={(i: number) => (rows[i] ? dateFmt.format(rows[i].w.resetsAt) : '')}
            tick={tick}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={(v: number) => perPctText(v)}
            tick={tick}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <RTooltip
            isAnimationActive={false}
            cursor={{ fill: 'var(--hover)' }}
            content={({ active, payload }) => {
              const r = payload?.[0]?.payload as BarRow | undefined
              return active && r ? (
                <WindowTooltip w={r.w} threshold={report.settings.threshold} />
              ) : null
            }}
          />
          <Bar dataKey="perPct" radius={[3, 3, 0, 0]} animationDuration={380}>
            {rows.map((r) => (
              <Cell
                key={r.i}
                fill={
                  r.w.excluded
                    ? 'var(--gauge-track)'
                    : r.w.low
                      ? 'var(--gauge-warn)'
                      : 'var(--gauge-calm)'
                }
                fillOpacity={r.w.closed ? 0.9 : 0.45}
                stroke={r.w.excluded ? 'var(--chart-axis)' : undefined}
                strokeDasharray={r.w.excluded ? '3 2' : undefined}
              />
            ))}
          </Bar>
          <Line
            type="stepAfter"
            dataKey="expected"
            stroke="var(--foreground)"
            strokeOpacity={0.55}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            name="Baseline"
          />
          <Line
            type="stepAfter"
            dataKey="flag"
            stroke="var(--gauge-warn-text)"
            strokeOpacity={0.7}
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
            name="Flag line"
          />
          {planStarts.map((r) => (
            <ReferenceLine
              key={r.i}
              x={r.i}
              stroke="var(--primary)"
              strokeOpacity={0.6}
              label={{
                value: r.plan,
                position: 'insideTopRight',
                fill: 'var(--primary)',
                fontSize: 10
              }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------- compare

function CompareSide({ label, side }: { label: string; side: HealthCompare['a'] }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2.5">
      <div className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
        {label} · {shortDate(side.from)} – {shortDate(side.to)}
      </div>
      <div className="mt-1 text-[20px] font-semibold tracking-tight tabular-nums">
        {perPctText(side.perPct)}
        <span className="ml-1 text-xs font-normal text-muted-foreground">per 1% (1x)</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {side.n} window{side.n === 1 ? '' : 's'}
        {side.plans.length ? ` · ${side.plans.join(', ')}` : ''}
        {side.rawPerPct !== undefined && side.plans.some((p) => p !== 'Pro')
          ? ` · ${perPctText(side.rawPerPct)} as measured`
          : ''}
      </div>
      {side.mixShare && (
        <>
          <MixBar mix={side.mixShare} className="mt-2" />
          <MixLegend mix={side.mixShare} />
        </>
      )}
    </div>
  )
}

function CompareBox({ kind, report }: { kind: Kind; report: HealthReport }) {
  const back = (d: number): string => toYmd(now() - d * 86_400_000)
  const [a, setA] = useState<CompareRange>(() => ({
    from: report.settings.baselineFrom ?? back(60),
    to: report.settings.baselineTo ?? back(31)
  }))
  const [b, setB] = useState<CompareRange>(() => ({ from: back(13), to: back(0) }))
  const [res, setRes] = useState<HealthCompare | null>(null)
  useEffect(() => {
    // Wait until both ranges are filled in: a half-typed date isn't a range.
    if (!a.from || !a.to || !b.from || !b.to) return
    let off = false
    void api.compareHealth(kind, a, b).then((r) => {
      if (!off && r) setRes(r)
    })
    return () => {
      off = true
    }
  }, [kind, a, b, report])
  const ch = res?.changePct
  return (
    <div className="mt-4 rounded-xl border border-border bg-surface/50 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">A</span>
          <RangeInputs value={a} onChange={setA} />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">B</span>
          <RangeInputs value={b} onChange={setB} />
        </div>
      </div>
      {res && (
        <div className="mt-3 flex flex-wrap items-stretch gap-3">
          <CompareSide label="A" side={res.a} />
          <div className="flex w-24 shrink-0 flex-col items-center justify-center text-center">
            <ArrowLeftRight className="size-4 text-subtle-foreground" />
            <div
              className={cn(
                'mt-1 text-[18px] font-semibold tabular-nums',
                ch !== undefined && ch <= -10 && 'text-[var(--gauge-warn-text)]'
              )}
            >
              {ch === undefined ? '—' : `${ch > 0 ? '+' : '−'}${Math.abs(ch).toFixed(0)}%`}
            </div>
            <div className="text-[10.5px] leading-tight text-muted-foreground">
              {ch === undefined
                ? 'needs windows on both sides'
                : ch < 0
                  ? 'less work per 1%'
                  : 'more work per 1%'}
            </div>
          </div>
          <CompareSide label="B" side={res.b} />
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- card

const EXPLAIN =
  'Each window gets one score: the API-equivalent dollars of your local Claude Code usage since it started (tokens priced at your price table, one rate per model family), divided by the % of the limit it reached. That is "$ per 1%": how much work 1% buys. The baseline is the median on your normal dates, per 1x of plan, so Pro, Max 5x and Max 20x share one baseline. A possible reduction is flagged only when several windows in a row fall below baseline ÷ threshold. Usage outside this computer (claude.ai, mobile, cloud) makes 1% look smaller, so windows with clear outside usage are left out. Big token-mix shifts can move the score too. A trend indicator, not proof.'

export function LimitHealthCard({
  limits,
  onAsk
}: {
  limits: LimitsState | null
  onAsk: () => void
}) {
  const [kind, setKind] = useState<Kind>('five_hour')
  const [compare, setCompare] = useState(false)
  const report = kind === 'five_hour' ? limits?.health5h : limits?.health7d
  const t = useNow()
  if (!limits) {
    return (
      <Card className="p-5">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="mt-4 h-8 w-48" />
        <Skeleton className="mt-4 h-[180px] w-full" />
      </Card>
    )
  }
  return (
    <Card className="p-5">
      <CardHeader
        title="Limit health"
        info={EXPLAIN}
        subtitle="How much work each 1% of your limit buys, per window, against your normal"
        right={
          <>
            <Button variant="ghost" size="xs" onClick={onAsk}>
              <Sparkles className="text-primary" /> Ask Claude
            </Button>
            <Segmented
              ariaLabel="Window"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'five_hour', label: '5-hour' },
                { value: 'seven_day', label: 'Weekly' }
              ]}
            />
          </>
        }
      />
      {limits.hasBridgeData && whyNoLiveReading(limits, t, kind) && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-[var(--gauge-warn-text)]">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            <span className="font-medium">The current window isn't scored yet.</span>{' '}
            {whyNoLiveReading(limits, t, kind)}
          </span>
        </div>
      )}
      {report ? (
        <>
          <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
            <Verdict report={report} />
            <div className="flex flex-wrap items-center gap-2">
              <BaselinePicker report={report} />
              <Button
                variant={compare ? 'secondary' : 'ghost'}
                size="xs"
                aria-pressed={compare}
                onClick={() => setCompare((v) => !v)}
              >
                <ArrowLeftRight /> Compare
              </Button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-[var(--gauge-calm)]" /> Window
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-[var(--gauge-warn)]" /> Below flag line
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-sm border border-dashed border-[var(--chart-axis)]" />{' '}
              Left out (used elsewhere, or a plan change)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 bg-foreground/55" /> Baseline × plan
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0 w-3 border-t border-dashed border-[var(--gauge-warn-text)]" />{' '}
              Flag line (÷ {report.settings.threshold})
            </span>
            {report.baseline && (
              <span className="ml-auto tabular-nums">
                Baseline {perPctText(report.baseline.value)} per 1% per 1x
              </span>
            )}
          </div>
          <div className="mt-2">
            <HealthChart report={report} />
          </div>
          {report.plans.length > 1 && (
            <div className="mt-1 text-[11px] text-subtle-foreground">
              Plans:{' '}
              {report.plans.map((p) => `${planLabel(p)} from ${shortDate(p.from)}`).join(' · ')}
            </div>
          )}
          {compare && <CompareBox kind={kind} report={report} />}
        </>
      ) : (
        <div className="px-6 py-8 text-center text-sm leading-relaxed text-muted-foreground">
          {whyNoLiveReading(limits, t, kind) ?? 'No windows to score yet.'}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------- where it went

const SOURCE_SHADES = [
  'var(--gauge-calm)',
  'var(--tok-input)',
  'var(--tok-cache-write)',
  'var(--tok-output)',
  'var(--tok-cache-read)'
]

function SplitRow({
  title,
  split,
  reason
}: {
  title: string
  split?: WindowSplit
  /** Why there's no split for this window. */
  reason?: string
}) {
  if (!split) {
    return (
      <div>
        <div className="text-xs font-medium">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {reason ?? 'No usage from this computer in this window yet.'}
        </div>
      </div>
    )
  }
  const parts = [
    ...split.bySource.map((s, i) => ({
      label: s.label,
      pct: s.pct,
      color: SOURCE_SHADES[i % SOURCE_SHADES.length],
      dashed: false
    })),
    ...(split.elsewhere >= 0.5
      ? [
          {
            label: 'Elsewhere (cloud, claude.ai, mobile)',
            pct: split.elsewhere,
            color: 'var(--model-other)',
            dashed: true
          }
        ]
      : [])
  ]
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground tabular-nums">{Math.round(split.pct)}% used</span>
      </div>
      <div className="mt-1.5 flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--gauge-track)]">
        {parts.map((p) => (
          <Tooltip key={p.label} content={`${p.label}: ${p.pct.toFixed(1)} pts`}>
            <div
              style={{
                width: `${Math.min(100, p.pct)}%`,
                background: p.dashed
                  ? `repeating-linear-gradient(135deg, ${p.color} 0 3px, transparent 3px 6px)`
                  : p.color
              }}
            />
          </Tooltip>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1 tabular-nums">
            <span
              className="size-2 rounded-sm"
              style={{
                background: p.dashed
                  ? `repeating-linear-gradient(135deg, ${p.color} 0 2px, transparent 2px 4px)`
                  : p.color
              }}
            />
            {p.label} {p.pct.toFixed(p.pct < 10 ? 1 : 0)}
          </span>
        ))}
      </div>
    </div>
  )
}

export function WhereItWent({ limits }: { limits: LimitsState | null }) {
  const t = useNow()
  if (!limits) return null
  const est = limits.split5h?.estimated || limits.split7d?.estimated
  return (
    <Card className="p-5">
      <CardHeader
        title="Where your limits went"
        subtitle="The current windows, split by the product that used them"
        info={`Local usage is split by each source's share of the API-equivalent cost. "Elsewhere" is the part of the % your local logs don't explain: claude.ai, the mobile or desktop apps, cloud sessions or another computer.${est ? ' It is estimated from your baseline $ per 1%, so a smaller limit would also show up here.' : ' Without a baseline, only rises while nothing ran here count.'}`}
      />
      <div className="mt-4 space-y-4">
        <SplitRow
          title="5-hour window"
          split={limits.split5h}
          reason={whyNoLiveReading(limits, t, 'five_hour')}
        />
        <SplitRow
          title="This week · all models"
          split={limits.split7d}
          reason={whyNoLiveReading(limits, t, 'seven_day')}
        />
      </div>
    </Card>
  )
}

// --------------------------------------------------- "used Claude elsewhere"

const toLocalInput = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ElsewhereCard() {
  const settings = useApp((s) => s.settings)
  const save = useSaveSettings()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => ({
    from: toLocalInput(now() - 2 * 3_600_000),
    to: toLocalInput(now()),
    note: ''
  }))
  const list = settings.elsewhere
  return (
    <Card className="p-5">
      <CardHeader
        title="Used Claude elsewhere"
        subtitle="Times you used claude.ai, the apps or a cloud session, so they don't read as a cut"
        info="Windows that overlap these times are left out of the baseline and the verdict. Saved in the app's settings only."
        right={
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="xs">
                <Plus /> Mark a time
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              <div className="space-y-2">
                <label className="block">
                  <span className="mb-1 block text-2xs text-muted-foreground">From</span>
                  <Input
                    type="datetime-local"
                    value={draft.from}
                    onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-2xs text-muted-foreground">To</span>
                  <Input
                    type="datetime-local"
                    value={draft.to}
                    onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-2xs text-muted-foreground">Note (optional)</span>
                  <Input
                    value={draft.note}
                    placeholder="e.g. claude.ai on my phone"
                    onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                  />
                </label>
                <Button
                  variant="primary"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    const from = new Date(draft.from).getTime()
                    const to = new Date(draft.to).getTime()
                    if (!(to > from)) {
                      toast.error('The end must be after the start')
                      return
                    }
                    void save({
                      elsewhere: [
                        ...list,
                        { id: `e-${from}-${to}`, from, to, note: draft.note || undefined }
                      ]
                    })
                    setOpen(false)
                  }}
                >
                  Save
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        }
      />
      <div className="mt-3 space-y-1">
        {list.length === 0 && (
          <div className="py-4 text-center text-sm text-muted-foreground">Nothing marked.</div>
        )}
        {[...list].reverse().map((e) => (
          <div
            key={e.id}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-hover"
          >
            <MapPinned className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {formatDateTime(new Date(e.from).toISOString())} – {dateTimeFmt.format(e.to)}
              {e.note ? <span className="text-muted-foreground"> · {e.note}</span> : null}
            </span>
            <button
              type="button"
              aria-label="Remove"
              className="rounded p-0.5 text-subtle-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => void save({ elsewhere: list.filter((x) => x.id !== e.id) })}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Card>
  )
}
