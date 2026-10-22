import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from 'recharts'
import { toast } from 'sonner'
import { CalendarClock, Download, OctagonAlert } from 'lucide-react'
import type { Dimension, UsageQuery, UsageReport } from '@shared/usage/types'
import type { LimitsState } from '@shared/usage/limits'
import type { CreditsState } from '@shared/usage/credits'
import { formatDateTime, formatInt, formatTokens, formatUsd } from '@shared/format'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { modelColor, modelLabel, TOKEN_META } from '@/lib/usage-colors'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Segmented } from '../ui/segmented'
import { Tooltip } from '../ui/tooltip'
import { Card, CardHeader } from './primitives'
import { ElsewhereCard } from './LimitHealth'

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const tick = { fill: 'var(--chart-axis)', fontSize: 11 }

// ------------------------------------------------------------ limit history

export function LimitHistoryTab({
  limits,
  report
}: {
  limits: LimitsState | null
  report: UsageReport | null
}) {
  const blocks = [...(report?.blocks ?? [])].reverse().slice(0, 8)
  return (
    <div className="space-y-4">
      <ElsewhereCard />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <CardHeader
            title="Limit messages"
            subtitle="Every “usage limit reached” message found in your sessions"
          />
          <div className="mt-3 space-y-1">
            {(limits?.limitHits ?? []).slice(0, 10).map((h) => (
              <div
                key={h.id}
                className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-hover"
              >
                <OctagonAlert className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{h.text}</div>
                  <div className="text-muted-foreground">
                    {formatDateTime(new Date(h.ts).toISOString())} · {formatTokens(h.windowTokens)}{' '}
                    tokens in that window
                  </div>
                </div>
                <Badge variant="muted">
                  {h.kind === 'weekly' ? 'Weekly' : h.kind === 'five_hour' ? '5-hour' : 'Limit'}
                </Badge>
              </div>
            ))}
            {limits && limits.limitHits.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No limit messages found. Nice.
              </div>
            )}
          </div>
        </Card>
        <Card className="p-5">
          <CardHeader
            title="Recent 5-hour blocks"
            subtitle="From your session logs, grouped like ccusage blocks"
            info="A block starts at the hour of its first message and lasts 5 hours. Works without the status line bridge."
          />
          <div className="mt-3 space-y-1">
            {blocks.map((b) => (
              <div
                key={b.start}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs hover:bg-hover"
              >
                <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 whitespace-nowrap tabular-nums">
                  {dateFmt.format(b.start)}, {timeFmt.format(b.start)} – {timeFmt.format(b.end)}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1">
                  {b.models.slice(0, 3).map((m) => (
                    <span
                      key={m}
                      className="size-2 rounded-full"
                      title={modelLabel(m)}
                      style={{ background: modelColor(m, report?.models ?? []) }}
                    />
                  ))}
                  {b.active && (
                    <Badge variant="accent" className="ml-1">
                      Active
                    </Badge>
                  )}
                </span>
                <span className="font-medium tabular-nums">{formatTokens(b.total)}</span>
                <span className="w-14 text-right text-muted-foreground tabular-nums">
                  {formatUsd(b.cost)}
                </span>
              </div>
            ))}
            {report && blocks.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No activity in the last week.
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ credits

export function CreditsTab({ credits }: { credits: CreditsState | null }) {
  const set = useApp((s) => s.set)
  const select = useApp((s) => s.select)
  if (!credits) return null
  const standard = credits.accounts.filter((a) => a.kind === 'standard')
  if (!credits.accounts.length) {
    return (
      <Card className="p-8 text-center">
        <div className="text-sm font-medium">No API keys yet</div>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Add an API key in Settings → Accounts to run sessions on API credits, enter your credit
          grants, and see how long they last.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => set({ view: 'settings' })}
        >
          Open Settings
        </Button>
      </Card>
    )
  }
  return (
    <div className="space-y-4">
      {standard.map((a) => {
        const s = credits.summaries.find((x) => x.accountId === a.id)
        if (!s) return null
        return (
          <Card key={a.id} className="p-5">
            <CardHeader
              title={a.nickname}
              subtitle={`${a.masked} · ${s.sessions} API-billed session${s.sessions === 1 ? '' : 's'}`}
              info="Spending comes from Claude Code's own cost figure (status line bridge) for each API-billed session, or the price table × tokens when that's missing. The oldest-expiring grant is used first."
            />
            <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-4">
              {[
                ['Remaining', formatUsd(s.remaining)],
                ['Spent this week', formatUsd(s.spentThisWeek)],
                ['Spent this month', formatUsd(s.spentThisMonth)],
                ['Burn rate', `${formatUsd(s.burnPerDay)}/day`],
                [
                  'Lasts',
                  s.daysLeft === undefined ? '—' : `~${Math.max(1, Math.round(s.daysLeft))} days`
                ]
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
                    {k}
                  </div>
                  <div className="mt-0.5 text-[17px] font-semibold tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            {(s.uncovered > 0.005 || s.lost > 0.005) && (
              <div className="mt-3 text-xs text-muted-foreground">
                {s.uncovered > 0.005 && (
                  <>
                    {formatUsd(s.uncovered)} spent with no active grant (billed to your card, or a
                    grant is missing).{' '}
                  </>
                )}
                {s.lost > 0.005 && <>{formatUsd(s.lost)} expired unused.</>}
              </div>
            )}
            <div className="mt-4 text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
              Grants
            </div>
            <div className="mt-1 space-y-1">
              {s.grants.map((g) => (
                <div key={g.id} className="flex items-center gap-3 text-xs">
                  <span className="w-16 font-medium tabular-nums">{formatUsd(g.amountUsd)}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--gauge-track)]">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (g.spent / g.amountUsd) * 100)}%`,
                        background: 'var(--tok-input)'
                      }}
                    />
                  </div>
                  <span className="w-24 text-right text-muted-foreground tabular-nums">
                    {formatUsd(g.remaining)} left
                  </span>
                  <span className="w-32 text-muted-foreground">
                    {g.expiresAt ? `expires ${dateFmt.format(new Date(g.expiresAt))}` : 'no expiry'}
                  </span>
                  {g.expiresSoon ? (
                    <Badge variant="warning">Soon</Badge>
                  ) : g.expired ? (
                    <Badge variant="muted">Expired</Badge>
                  ) : (
                    <span className="w-[42px]" />
                  )}
                </div>
              ))}
              {s.grants.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No grants entered (Settings → Accounts).
                </div>
              )}
            </div>
          </Card>
        )
      })}

      {credits.admin.map((a) => (
        <Card key={a.accountId} className="p-5">
          <CardHeader
            title={`${a.nickname} · Admin API`}
            subtitle={
              a.error
                ? a.error
                : a.fetchedAt
                  ? `Organization cost report · updated ${timeFmt.format(a.fetchedAt)}${a.sample ? ' · sample data' : ''}`
                  : 'Not loaded yet'
            }
            info="The authoritative figure from Anthropic's Usage & Cost Admin API for the whole organization (all keys), not just this computer."
            right={
              <Button variant="ghost" size="sm" onClick={() => void api.refreshAdmin(a.accountId)}>
                Refresh
              </Button>
            }
          />
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-4">
            {[
              ['Today (UTC)', formatUsd(a.todayUsd)],
              ['This week', formatUsd(a.weekUsd)],
              ['This month', formatUsd(a.monthUsd)],
              ['Tokens this month', formatTokens(a.monthTokens)]
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
                  {k}
                </div>
                <div className="mt-0.5 text-[17px] font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          {a.daily.length > 0 && (
            <div className="mt-4 h-[150px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={a.daily} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => dateFmt.format(new Date(`${v}T12:00:00Z`))}
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tickFormatter={(v: number) => `$${Math.round(v)}`}
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <RTooltip
                    isAnimationActive={false}
                    cursor={{ fill: 'var(--hover)' }}
                    content={({ active, payload }) => {
                      const d = payload?.[0]?.payload as
                        { date: string; usd: number; tokens: number } | undefined
                      if (!active || !d) return null
                      return (
                        <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
                          <div className="font-medium">
                            {dateFmt.format(new Date(`${d.date}T12:00:00Z`))}
                          </div>
                          <div className="text-muted-foreground tabular-nums">
                            {formatUsd(d.usd)} · {formatTokens(d.tokens)} tokens
                          </div>
                        </div>
                      )
                    }}
                  />
                  <Bar
                    dataKey="usd"
                    fill="var(--tok-input)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={20}
                    animationDuration={380}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {a.byModel.slice(0, 5).map((m) => (
              <span key={m.model} className="inline-flex items-center gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{
                    background: modelColor(
                      m.model,
                      a.byModel.map((x) => x.model)
                    )
                  }}
                />
                {modelLabel(m.model)} <span className="tabular-nums">{formatUsd(m.usd)}</span>
              </span>
            ))}
          </div>
        </Card>
      ))}

      {credits.apiSessions.length > 0 && (
        <Card className="p-5">
          <CardHeader
            title="API-billed sessions"
            subtitle="Sessions launched with an API key, or that the status line reported as API-billed"
          />
          <div className="-mx-2 mt-2">
            {credits.apiSessions.slice(0, 12).map((s) => (
              <button
                key={s.key}
                type="button"
                className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-hover"
                onClick={() => {
                  set({ view: 'sessions' })
                  select(s.key)
                }}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                <span className="text-muted-foreground">
                  {credits.accounts.find((a) => a.id === s.accountId)?.nickname ?? 'API'}
                </span>
                <Tooltip
                  content={
                    s.source === 'bridge'
                      ? "Claude Code's own cost figure"
                      : 'Estimated from the price table'
                  }
                >
                  <span className="w-16 text-right font-medium tabular-nums">
                    {s.source === 'estimate' ? '≈ ' : ''}
                    {formatUsd(s.usd)}
                  </span>
                </Tooltip>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ----------------------------------------------------------------- raw table

const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: 'model', label: 'Model' },
  { value: 'session', label: 'Session' },
  { value: 'project', label: 'Project' },
  { value: 'env', label: 'Environment' },
  { value: 'version', label: 'Version' },
  { value: 'billing', label: 'Billing' },
  { value: 'source', label: 'Source' }
]

export function RawTableTab({
  report,
  query,
  groupBy,
  onGroupBy
}: {
  report: UsageReport | null
  query: UsageQuery
  groupBy: Dimension
  onGroupBy: (d: Dimension) => void
}) {
  const exportCsv = async (perRecord: boolean): Promise<void> => {
    const res = await api.exportUsageCsv(query, perRecord)
    if (res.saved) toast.success('Usage exported', { description: res.path })
    else if (res.error) toast.error('Export failed', { description: res.error })
  }
  const num = 'px-2 py-1.5 text-right tabular-nums'
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <CardHeader
          title="Breakdown"
          subtitle="Every token type for the selected range, grouped by"
          right={
            <>
              <Segmented
                ariaLabel="Group by"
                value={groupBy}
                onChange={onGroupBy}
                options={DIMENSIONS}
              />
            </>
          }
        />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="text-subtle-foreground">
              <tr className="border-b border-border">
                <th className="px-2 py-1.5 text-left font-medium">
                  {DIMENSIONS.find((d) => d.value === groupBy)?.label}
                </th>
                {(['input', 'output', 'cacheWrite', 'cacheRead'] as const).map((t) => (
                  <th key={t} className="px-2 py-1.5 text-right font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2 rounded-sm"
                        style={{ background: TOKEN_META[t].color }}
                      />
                      {TOKEN_META[t].label}
                    </span>
                  </th>
                ))}
                <th className="px-2 py-1.5 text-right font-medium">Total</th>
                <th className="px-2 py-1.5 text-right font-medium">Share</th>
                <th className="px-2 py-1.5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {(report?.breakdown ?? []).slice(0, 50).map((r) => (
                <tr key={r.key} className="border-b border-border last:border-0 hover:bg-hover">
                  <td
                    className="max-w-[260px] truncate px-2 py-1.5 font-medium"
                    title={r.detail ?? r.key}
                  >
                    {r.label}
                  </td>
                  <td className={num}>{formatTokens(r.input)}</td>
                  <td className={num}>{formatTokens(r.output)}</td>
                  <td className={num}>{formatTokens(r.cacheWrite)}</td>
                  <td className={num}>{formatTokens(r.cacheRead)}</td>
                  <td className={cn(num, 'font-medium')} title={formatInt(r.total)}>
                    {formatTokens(r.total)}
                  </td>
                  <td className={num}>{(r.share * 100).toFixed(1)}%</td>
                  <td className={num}>{formatUsd(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="p-5">
        <CardHeader
          title="Responses"
          subtitle={`The ${Math.min(500, report?.raw.length ?? 0)} most recent API responses in the range`}
          right={
            <>
              <Button variant="outline" size="sm" onClick={() => void exportCsv(false)}>
                <Download /> CSV by day
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void exportCsv(true)}>
                <Download /> Every response
              </Button>
            </>
          }
        />
        <div className="mt-3 max-h-[420px] overflow-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="sticky top-0 bg-card text-subtle-foreground">
              <tr className="border-b border-border">
                <th className="px-2 py-1.5 text-left font-medium">Time</th>
                <th className="px-2 py-1.5 text-left font-medium">Project</th>
                <th className="px-2 py-1.5 text-left font-medium">Model</th>
                <th className="px-2 py-1.5 text-right font-medium">Input</th>
                <th className="px-2 py-1.5 text-right font-medium">Output</th>
                <th className="px-2 py-1.5 text-right font-medium">Cache write</th>
                <th className="px-2 py-1.5 text-right font-medium">Cache read</th>
                <th className="px-2 py-1.5 text-left font-medium">Stop</th>
                <th className="px-2 py-1.5 text-left font-medium">Version</th>
              </tr>
            </thead>
            <tbody>
              {(report?.raw ?? []).map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-hover">
                  <td className="px-2 py-1 whitespace-nowrap tabular-nums">
                    {formatDateTime(new Date(r.ts).toISOString())}
                  </td>
                  <td className="max-w-[140px] truncate px-2 py-1">{r.project}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{modelLabel(r.model)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.input)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.output)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.cacheWrite)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.cacheRead)}</td>
                  <td className="px-2 py-1 text-muted-foreground">{r.stop ?? ''}</td>
                  <td className="px-2 py-1 text-muted-foreground">{r.version ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report && report.extraFields.length > 0 && (
            <div className="mt-2 text-[11px] text-subtle-foreground">
              Other usage fields seen: {report.extraFields.join(', ')}. They&apos;re kept with each
              response in the app&apos;s data.
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
