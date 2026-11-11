import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from 'recharts'
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, FlaskConical } from 'lucide-react'
import { now } from '@shared/clock'
import {
  METRICS,
  type CompareResult,
  type CompareSide,
  type MetricDef,
  type TrendGroupBy,
  type TrendMarker,
  type TrendsReport
} from '@shared/usage/trends'
import { CODEX_METRICS } from '@shared/usage/codex-trends'
import { SPEED_CAVEAT } from '@shared/usage/speed'
import type { ProviderId } from '@shared/provider'
import { api } from '@/lib/api'
import { formatMetric } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { modelColor } from '@/lib/usage-colors'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Card, CardHeader, InfoTip, Skeleton } from './primitives'

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const tick = { fill: 'var(--chart-axis)', fontSize: 10.5 }

/** Versions are ordered, so they get one hue from light (older) to dark (newer). */
const VERSION_RAMP = ['#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95']

/** A report of either provider's metrics (Claude Code's or Codex's own ids). */
type AnyReport = TrendsReport<string>
type AnyMetric = MetricDef<string>

/** Each provider's metrics, compare call and wording (Codex trends are kept apart). */
const PROVIDER_TRENDS = {
  claude: {
    metrics: METRICS as AnyMetric[],
    product: 'Claude Code',
    requests: 'requests',
    trends: (g: TrendGroupBy): Promise<AnyReport> => api.getTrends(g),
    compare: (a: CompareSide, b: CompareSide): Promise<CompareResult<string>> =>
      api.compareTrends(a, b)
  },
  codex: {
    metrics: CODEX_METRICS as AnyMetric[],
    product: 'Codex',
    requests: 'prompts',
    trends: (g: TrendGroupBy): Promise<AnyReport> => api.getCodexTrends(g),
    compare: (a: CompareSide, b: CompareSide): Promise<CompareResult<string>> =>
      api.compareCodexTrends(a, b)
  }
} as const

/** A fast-mode line ("…-fast" model, or a "|fast" group): drawn dashed, in its normal line's colour. */
const isFastGroup = (key: string): boolean => key.endsWith('-fast') || key.endsWith('|fast')
const baseGroup = (key: string): string =>
  key.endsWith('|fast') ? key.slice(0, -5) : key.endsWith('-fast') ? key.slice(0, -5) : key

function groupColor(report: AnyReport, key: string, i: number): string {
  if (isFastGroup(key)) return groupColor(report, baseGroup(key), i)
  if (report.groupBy === 'model') return modelColor(key, report.models)
  if (report.groupBy === 'version') {
    const order = [...report.groups]
      .map((g) => g.key)
      .sort((a, b) => report.versions.indexOf(a) - report.versions.indexOf(b))
    const idx = order.indexOf(key)
    return VERSION_RAMP[
      Math.min(
        VERSION_RAMP.length - 1,
        Math.round((idx / Math.max(1, order.length - 1)) * (VERSION_RAMP.length - 1))
      )
    ]
  }
  return ['var(--gauge-calm)'][i] ?? 'var(--gauge-calm)'
}

function markerStyle(k: TrendMarker['kind']): { stroke: string; opacity: number } {
  if (k === 'capacity') return { stroke: 'var(--foreground)', opacity: 0.55 }
  if (k === 'model') return { stroke: 'var(--model-opus)', opacity: 0.6 }
  if (k === 'plan') return { stroke: 'var(--primary)', opacity: 0.6 }
  return { stroke: 'var(--chart-axis)', opacity: 0.5 }
}

/** A short line sample for a legend: solid, or dashed for fast mode. */
function LegendLine({ color, dashed }: { color: string; dashed: boolean }) {
  return (
    <svg width="14" height="3" aria-hidden className="shrink-0">
      <line
        x1="0"
        y1="1.5"
        x2="14"
        y2="1.5"
        stroke={color}
        strokeWidth="3"
        strokeDasharray={dashed ? '3 2' : undefined}
      />
    </svg>
  )
}

function MetricChart({
  report,
  metric,
  product,
  height = 150
}: {
  report: AnyReport
  metric: AnyMetric
  /** Whose version the version markers are ("Claude Code", "Codex"). */
  product: string
  height?: number
}) {
  const note = report.notes?.[metric.id]
  const data = useMemo(() => {
    const rows = report.weeks.map(
      (w) => ({ start: w.start, week: w.week }) as Record<string, number | string | undefined>
    )
    for (const s of report.series) {
      if (s.metric !== metric.id) continue
      s.points.forEach((p, i) => {
        rows[i][s.group] = p.value
      })
    }
    return rows
  }, [report, metric.id])
  const hasData = report.series.some(
    (s) => s.metric === metric.id && s.points.some((p) => p.value !== undefined)
  )
  return (
    <Card className="p-4">
      <CardHeader
        title={metric.title}
        subtitle={metric.subtitle}
        info={
          metric.info || note ? (
            <>
              {metric.info}
              {note && <span className="mt-1 block font-medium">{note}</span>}
            </>
          ) : undefined
        }
      />
      <div className="mt-3" style={{ height }}>
        {!hasData ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Not enough data yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
              <XAxis
                dataKey="start"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(v: number) => dateFmt.format(v)}
                tick={tick}
                tickLine={false}
                axisLine={false}
                minTickGap={30}
                tickMargin={6}
              />
              <YAxis
                tickFormatter={(v: number) =>
                  metric.unit === 'tps' ? String(Math.round(v)) : formatMetric(metric, v)
                }
                tick={tick}
                tickLine={false}
                axisLine={false}
                width={42}
                domain={metric.unit === 'percent' ? [0, 'auto'] : ['auto', 'auto']}
              />
              {report.markers.map((m, i) => {
                const st = markerStyle(m.kind)
                return (
                  <ReferenceLine
                    key={`${m.kind}${i}`}
                    x={m.start}
                    stroke={st.stroke}
                    strokeOpacity={st.opacity}
                    strokeWidth={1}
                    ifOverflow="discard"
                  />
                )
              })}
              <RTooltip
                isAnimationActive={false}
                cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const marks = report.markers.filter((m) => m.start === label)
                  return (
                    <div className="min-w-[170px] rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
                      <div className="mb-1 font-medium">
                        Week of {dateFmt.format(Number(label))}
                      </div>
                      {payload.map((p) => {
                        const g = report.groups.find((x) => x.key === p.dataKey)
                        return (
                          <div key={String(p.dataKey)} className="flex items-center gap-2">
                            <span className="size-2 rounded-full" style={{ background: p.color }} />
                            <span className="flex-1 text-muted-foreground">
                              {g?.label ?? String(p.dataKey)}
                            </span>
                            <span className="tabular-nums">
                              {formatMetric(metric, p.value as number, true)}
                            </span>
                          </div>
                        )
                      })}
                      {marks.map((m) => (
                        <div
                          key={m.label}
                          className="mt-1 border-t border-border pt-1 text-muted-foreground"
                        >
                          {m.kind === 'model'
                            ? 'New model: '
                            : m.kind === 'version'
                              ? `${product} `
                              : ''}
                          {m.label}
                        </div>
                      ))}
                    </div>
                  )
                }}
              />
              {report.groups.map((g, i) => (
                <Line
                  key={g.key}
                  type="monotone"
                  dataKey={g.key}
                  stroke={groupColor(report, g.key, i)}
                  strokeWidth={2}
                  strokeDasharray={isFastGroup(g.key) ? '5 3' : undefined}
                  dot={false}
                  activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  )
}

// ----------------------------------------------------------- compare mode

type CompareMode = 'dates' | 'versions'
const DAY = 86_400_000

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const toInput = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fromInput = (s: string, end = false): number | undefined =>
  s ? new Date(`${s}T00:00:00`).getTime() + (end ? DAY : 0) : undefined

function VersionPicker({
  value,
  versions,
  onChange
}: {
  value: string
  versions: string[]
  onChange: (v: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-[120px] justify-between font-mono">
          {value ? `v${value}` : 'Pick a version'} <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {[...versions].reverse().map((v) => (
            <DropdownMenuRadioItem key={v} value={v} className="font-mono">
              v{v}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Compare({ versions, provider }: { versions: string[]; provider: ProviderId }) {
  const p = PROVIDER_TRENDS[provider]
  const t = now()
  const [mode, setMode] = useState<CompareMode>('dates')
  const [a, setA] = useState({
    from: toInput(startOfDay(t) - 41 * DAY),
    to: toInput(startOfDay(t) - 14 * DAY)
  })
  const [b, setB] = useState({
    from: toInput(startOfDay(t) - 13 * DAY),
    to: toInput(startOfDay(t))
  })
  const [va, setVa] = useState(versions[Math.max(0, versions.length - 8)] ?? '')
  const [vb, setVb] = useState(versions[versions.length - 1] ?? '')
  const [res, setRes] = useState<CompareResult<string> | null>(null)

  useEffect(() => {
    const A: CompareSide =
      mode === 'dates' ? { from: fromInput(a.from), to: fromInput(a.to, true) } : { version: va }
    const B: CompareSide =
      mode === 'dates' ? { from: fromInput(b.from), to: fromInput(b.to, true) } : { version: vb }
    let cancelled = false
    void p.compare(A, B).then((r) => !cancelled && setRes(r))
    return () => {
      cancelled = true
    }
  }, [mode, a, b, va, vb, p])

  const rangeInputs = (
    v: { from: string; to: string },
    set: (x: { from: string; to: string }) => void,
    label: string
  ) => (
    <div className="flex items-center gap-1.5">
      <span className="w-4 text-xs font-semibold text-muted-foreground">{label}</span>
      <Input
        type="date"
        className="h-7 w-[138px] text-xs"
        value={v.from}
        onChange={(e) => set({ ...v, from: e.target.value })}
      />
      <ArrowRight className="size-3 text-subtle-foreground" />
      <Input
        type="date"
        className="h-7 w-[138px] text-xs"
        value={v.to}
        onChange={(e) => set({ ...v, to: e.target.value })}
      />
    </div>
  )

  return (
    <Card className="p-5">
      <CardHeader
        title="Compare"
        subtitle={`Two date ranges or two ${p.product} versions, side by side`}
        info="The same caveat applies: different weeks usually mean different work. Look for large, consistent changes."
        right={
          <Segmented
            ariaLabel="Compare"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'dates', label: 'Date ranges' },
              { value: 'versions', label: 'Versions' }
            ]}
          />
        }
      />
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {mode === 'dates' ? (
          <>
            {rangeInputs(a, setA, 'A')}
            {rangeInputs(b, setB, 'B')}
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <span className="w-4 text-xs font-semibold text-muted-foreground">A</span>
              <VersionPicker value={va} versions={versions} onChange={setVa} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 text-xs font-semibold text-muted-foreground">B</span>
              <VersionPicker value={vb} versions={versions} onChange={setVb} />
            </div>
          </>
        )}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="text-subtle-foreground">
            <tr className="border-b border-border">
              <th className="py-1.5 pr-2 text-left font-medium">Metric</th>
              <th className="px-2 py-1.5 text-right font-medium">
                A
                {res ? (
                  <span className="font-normal">
                    {' '}
                    · {res.samples.a.requests} {p.requests}
                  </span>
                ) : null}
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                B
                {res ? (
                  <span className="font-normal">
                    {' '}
                    · {res.samples.b.requests} {p.requests}
                  </span>
                ) : null}
              </th>
              <th className="py-1.5 pl-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {p.metrics.map((m) => {
              const row = res?.rows.find((r) => r.metric === m.id)
              // Fast-mode rows only when there's fast-mode data.
              if (m.compareOnly && !row) return null
              const c = row?.changePct
              const meaningful = c !== undefined && Math.abs(c) >= 5
              const better =
                c === undefined || m.better === 'neutral'
                  ? undefined
                  : c > 0 === (m.better === 'higher')
              return (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="py-1.5 pr-2">{m.title}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatMetric(m, row?.a)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatMetric(m, row?.b)}</td>
                  <td className="py-1.5 pl-2 text-right whitespace-nowrap tabular-nums">
                    {c === undefined ? (
                      <span className="text-subtle-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1',
                          meaningful ? 'font-medium text-foreground' : 'text-muted-foreground'
                        )}
                      >
                        {c > 0 ? (
                          <ArrowUpRight className="size-3.5" />
                        ) : c < 0 ? (
                          <ArrowDownRight className="size-3.5" />
                        ) : null}
                        {Math.abs(c) >= 999 ? '999+' : Math.abs(c).toFixed(0)}%
                        {meaningful && better !== undefined && (
                          <span
                            className={cn(
                              'ml-1 rounded px-1 text-[10px] font-medium',
                              better ? 'bg-good/12 text-good' : 'bg-warning-soft text-warning'
                            )}
                          >
                            {better ? 'better' : 'worse'}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ------------------------------------------------------------------- tab

export function TrendsTab({ provider = 'claude' }: { provider?: ProviderId }) {
  const p = PROVIDER_TRENDS[provider]
  const codex = provider === 'codex'
  const [groupBy, setGroupBy] = useState<TrendGroupBy>('model')
  const [report, setReport] = useState<AnyReport | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => api.onUsageChanged(() => setVersion((v) => v + 1)), [])
  useEffect(() => {
    let cancelled = false
    void p.trends(groupBy).then((r) => !cancelled && setReport(r))
    return () => {
      cancelled = true
    }
  }, [groupBy, version, p])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-card">
        <FlaskConical className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-[13px]">
          <span className="font-medium">Trend indicators, not proof.</span>{' '}
          <span className="text-muted-foreground">
            They depend on what you were working on. Look for big, lasting changes that line up with
            a new model or version.
          </span>
        </div>
        <InfoTip side="left">
          {codex
            ? 'Weekly values per model or Codex CLI version, from Codex’s own logs (token counts, turn events and tool outcomes, never their text). Vertical lines mark a new model and a Codex update. Subagents count per response, not per prompt.'
            : 'Weekly values per model or Claude Code version, from your session logs (and the status line for context use). Vertical lines mark a new model, a Claude Code update, a plan change, and a change in how much work each 1% of your limit buys (limit health).'}
        </InfoTip>
        <Segmented
          ariaLabel="Group trends by"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'all', label: 'All' },
            { value: 'model', label: 'By model' },
            { value: 'version', label: 'By version' }
          ]}
        />
      </div>

      {report && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-muted-foreground">
          {report.groups.map((g, i) => (
            <span key={g.key} className="inline-flex items-center gap-1.5">
              <LegendLine color={groupColor(report, g.key, i)} dashed={isFastGroup(g.key)} />
              {g.label}
            </span>
          ))}
          <span className="ml-auto inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-px" style={{ background: 'var(--model-opus)' }} /> New model
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-px" style={{ background: 'var(--chart-axis)' }} /> {p.product}{' '}
              update
            </span>
            {!codex && (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-3 w-px bg-foreground/60" /> $/1% change
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-3 w-px" style={{ background: 'var(--primary)' }} /> Plan change
                </span>
              </>
            )}
          </span>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(330px,1fr))] gap-4">
        {report
          ? p.metrics
              .filter((m) => !m.compareOnly)
              .map((m) => <MetricChart key={m.id} report={report} metric={m} product={p.product} />)
          : [0, 1, 2, 3].map((i) => (
              <Card key={i} className="p-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-4 h-[140px] w-full" />
              </Card>
            ))}
      </div>

      {report && <Compare key={provider} versions={report.versions} provider={provider} />}
    </div>
  )
}

// ------------------------------------------------- both agents' speeds

const SPEED_BY_MODEL: AnyMetric = {
  id: 'outputSpeed',
  title: 'Output speed by model',
  subtitle:
    'Claude Code and Codex models together: median output tokens per second of each response, by week',
  unit: 'tps',
  better: 'higher',
  info: `Each model’s own line, whichever agent ran it, so speeds can be compared across providers. Fast mode is its own (dashed) line. ${SPEED_CAVEAT}`
}

/** One chart of every model's output speed, Claude Code's and Codex's together (the "All" view). */
export function SpeedByModelChart() {
  const [report, setReport] = useState<AnyReport | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => api.onUsageChanged(() => setVersion((v) => v + 1)), [])
  useEffect(() => {
    let cancelled = false
    void api.getSpeedTrends().then((r) => !cancelled && setReport(r))
    return () => {
      cancelled = true
    }
  }, [version])
  if (!report)
    return (
      <Card className="p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-[180px] w-full" />
      </Card>
    )
  return (
    <div className="space-y-2">
      <MetricChart report={report} metric={SPEED_BY_MODEL} product="" height={190} />
      {report.groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-muted-foreground">
          {report.groups.map((g, i) => (
            <span key={g.key} className="inline-flex items-center gap-1.5">
              <LegendLine color={groupColor(report, g.key, i)} dashed={isFastGroup(g.key)} />
              {g.label}
              <span className="rounded border border-border px-1 text-[10px] leading-4 text-subtle-foreground">
                {g.provider === 'codex' ? 'Codex' : 'Claude Code'}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
