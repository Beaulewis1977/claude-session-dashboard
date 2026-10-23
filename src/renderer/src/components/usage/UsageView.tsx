import { useEffect, useMemo, useState } from 'react'
import {
  Calendar,
  ChevronDown,
  Download,
  PictureInPicture2,
  PlugZap,
  RefreshCw,
  Sparkles
} from 'lucide-react'
import { toast } from 'sonner'
import { now } from '@shared/clock'
import { PLAN_LABEL, type BridgeEnv } from '@shared/usage/limits'
import type { Dimension, PeriodCard, Period, UsageQuery, UsageReport } from '@shared/usage/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { BridgeDialog } from '../settings/BridgeDialog'
import { CreditsHeroCard, LimitCard } from './Hero'
import { MainChart, ModelShare, SummaryCards, TopSessions } from './Overview'
import { CreditsTab, LimitHistoryTab, RawTableTab } from './Tabs'
import { LimitHealthCard, WhereItWent } from './LimitHealth'
import { PaceAdviceLine } from './Hero'
import { TrendsTab } from './Trends'
import { AskClaudePanel } from './AskClaude'

type RangeId = 'today' | 'week' | 'month' | '7d' | '30d' | '90d' | '1y' | 'all' | 'custom'

const RANGE_LABEL: Record<RangeId, string> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '1y': 'Last 12 months',
  all: 'All time',
  custom: 'Custom range'
}

const DAY = 86_400_000

function startOfLocalDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function rangeOf(
  id: RangeId,
  cards: PeriodCard[] | undefined,
  custom: { from: string; to: string }
): { from?: number; to?: number } {
  const t = now()
  const card = (cid: PeriodCard['id']) => cards?.find((c) => c.id === cid)
  switch (id) {
    case 'today':
      return { from: card('today')?.from ?? startOfLocalDay(t) }
    case 'week':
      return { from: card('week')?.from ?? startOfLocalDay(t - 6 * DAY) }
    case 'month':
      return { from: card('month')?.from ?? startOfLocalDay(t - 29 * DAY) }
    case '7d':
      return { from: startOfLocalDay(t - 6 * DAY) }
    case '30d':
      return { from: startOfLocalDay(t - 29 * DAY) }
    case '90d':
      return { from: startOfLocalDay(t - 89 * DAY) }
    case '1y':
      return { from: startOfLocalDay(t - 364 * DAY) }
    case 'all':
      return {}
    case 'custom': {
      const from = custom.from ? new Date(`${custom.from}T00:00:00`).getTime() : undefined
      const to = custom.to ? new Date(`${custom.to}T00:00:00`).getTime() + DAY : undefined
      return { from, to }
    }
  }
}

function RangePicker({
  value,
  onChange,
  custom,
  onCustom
}: {
  value: RangeId
  onChange: (r: RangeId) => void
  custom: { from: string; to: string }
  onCustom: (c: { from: string; to: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(custom)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Calendar /> {RANGE_LABEL[value]} <ChevronDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              <DropdownMenuRadioGroup
                value={value}
                onValueChange={(v) => (v === 'custom' ? setOpen(true) : onChange(v as RangeId))}
              >
                {(['today', 'week', 'month'] as RangeId[]).map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {RANGE_LABEL[r]}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuSeparator />
                {(['7d', '30d', '90d', '1y', 'all'] as RangeId[]).map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    {RANGE_LABEL[r]}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuRadioItem value="custom">Custom range…</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-64">
        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-2xs text-muted-foreground">From</span>
            <Input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-2xs text-muted-foreground">To (inclusive)</span>
            <Input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </label>
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            disabled={!draft.from}
            onClick={() => {
              onCustom(draft)
              onChange('custom')
              setOpen(false)
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

type Tab = 'trends' | 'limits' | 'credits' | 'raw'

export function UsageView() {
  const limits = useApp((s) => s.limits)
  const credits = useApp((s) => s.credits)
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const select = useApp((s) => s.select)

  const [report, setReport] = useState<UsageReport | null>(null)
  const [range, setRange] = useState<RangeId>('30d')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [period, setPeriod] = useState<Period>('day')
  const [models, setModels] = useState<string[]>([])
  const [groupBy, setGroupBy] = useState<Dimension>('model')
  const [tab, setTab] = useState<Tab>('trends')
  const [bridge, setBridge] = useState<BridgeEnv | null>(null)
  const [version, setVersion] = useState(0)
  const [ask, setAsk] = useState(false)

  useEffect(() => api.onUsageChanged(() => setVersion((v) => v + 1)), [])

  const query: UsageQuery = useMemo(() => {
    const r = rangeOf(range, report?.cards, custom)
    return { ...r, period, models, groupBy }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, custom, period, models, groupBy, report?.cards?.[0]?.from])

  useEffect(() => {
    let cancelled = false
    void api.getUsageReport(query).then((r) => !cancelled && setReport(r))
    return () => {
      cancelled = true
    }
  }, [query, version])

  const pickCard = (c: PeriodCard): void => {
    if (range === c.id) {
      setRange('30d')
      setPeriod('day')
      return
    }
    setRange(c.id === 'all' ? 'all' : c.id)
    setPeriod(c.id === 'today' ? 'hour' : c.id === 'all' ? 'week' : 'day')
  }

  const firstEnv = limits?.envs.find((e) => !e.installed && !e.unavailable)
  const noBridge = limits && !limits.hasBridgeData && !limits.envs.some((e) => e.installed)
  const hasCredits = !!credits?.summaries.some((s) => s.granted > 0 || s.spent > 0)
  // On a phone (the companion), PC-only actions are hidden.
  const remote = api.remote === true

  return (
    <div className="h-full overflow-y-auto bg-surface" data-scroll="usage">
      <div
        className={cn(
          'mx-auto max-w-[1180px] pt-7 pb-16 lg:px-8',
          remote ? 'px-4 pt-4 pb-6' : 'px-6'
        )}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Usage &amp; limits</h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {PLAN_LABEL[settings.plan]} · every token from your session logs, plus your live plan
              limits
            </p>
          </div>
          {!remote && (
            <>
              <Button variant="outline" size="sm" onClick={() => setAsk(true)}>
                <Sparkles className="text-primary" /> Ask Claude
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void api.toggleMiniMeter()}>
                <PictureInPicture2 /> Mini meter
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const res = await api.exportUsageCsv(query, false)
                  if (res.saved) toast.success('Usage exported', { description: res.path })
                }}
              >
                <Download /> Export CSV
              </Button>
            </>
          )}
        </div>

        {noBridge && firstEnv && (
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-primary/25 bg-accent-soft px-4 py-3">
            <PlugZap className="size-4 text-primary" />
            <div className="min-w-0 flex-1 text-[13px]">
              <span className="font-medium">
                Enable live limits to see your real {PLAN_LABEL[settings.plan]} usage.
              </span>{' '}
              <span className="text-muted-foreground">
                Until then, the 5-hour gauge is an estimate from your session logs.
              </span>
            </div>
            {!remote && (
              <Button variant="primary" size="sm" onClick={() => setBridge(firstEnv)}>
                Enable live limits
              </Button>
            )}
          </div>
        )}

        {/* 1. Hero row */}
        <div
          data-shot="hero"
          className={cn(
            'mt-5 grid gap-4',
            hasCredits
              ? 'grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))]'
              : 'grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))]'
          )}
        >
          <LimitCard
            kind="five_hour"
            limits={limits}
            onEnable={() => firstEnv && setBridge(firstEnv)}
          />
          <LimitCard
            kind="seven_day"
            limits={limits}
            onEnable={() => firstEnv && setBridge(firstEnv)}
          />
          {hasCredits && credits && (
            <CreditsHeroCard credits={credits} onOpen={() => setTab('credits')} />
          )}
        </div>

        {limits?.advice && <PaceAdviceLine advice={limits.advice} />}

        <div
          data-shot="health"
          className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]"
        >
          <LimitHealthCard
            limits={limits}
            onAsk={() => (remote ? toast('Ask Claude runs in the app on your PC') : setAsk(true))}
          />
          <WhereItWent limits={limits} />
        </div>

        {/* 2. Summary cards */}
        <div className="mt-4">
          <SummaryCards
            cards={report?.cards}
            active={['today', 'week', 'month', 'all'].includes(range) ? range : null}
            onPick={pickCard}
          />
        </div>

        {/* 3. Main chart */}
        <div className="mt-4">
          <MainChart
            report={report}
            period={period}
            onPeriod={setPeriod}
            range={
              <RangePicker value={range} onChange={setRange} custom={custom} onCustom={setCustom} />
            }
            models={report?.models ?? []}
            selectedModels={models}
            onModels={setModels}
          />
        </div>

        {/* 4. Two columns */}
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <ModelShare rows={report?.byModel} models={report?.models ?? []} />
          <TopSessions
            rows={report?.topSessions}
            onOpen={(key) => {
              set({ view: 'sessions' })
              select(key)
            }}
          />
        </div>

        {/* 5. Tabs */}
        <div className="mt-8">
          <div
            role="tablist"
            aria-label="Details"
            data-shot="tabs"
            className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-border"
          >
            {(
              [
                ['trends', 'Trends'],
                ['limits', 'Limit history'],
                ['credits', 'Credits'],
                ['raw', 'Raw table']
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  '-mb-px border-b-2 px-3 pt-1 pb-2 text-[13px] font-medium transition-colors',
                  tab === id
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
            <span className={cn('ml-auto pb-2', remote && 'hidden')}>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  void api
                    .recalculateUsage()
                    .then((s) =>
                      toast.success('Usage recalculated', { description: `${s.records} responses` })
                    )
                }}
              >
                <RefreshCw /> Recalculate
              </Button>
            </span>
          </div>
          {tab === 'trends' && <TrendsTab />}
          {tab === 'limits' && <LimitHistoryTab limits={limits} report={report} />}
          {tab === 'credits' && <CreditsTab credits={credits} />}
          {tab === 'raw' && (
            <RawTableTab report={report} query={query} groupBy={groupBy} onGroupBy={setGroupBy} />
          )}
        </div>
      </div>
      {bridge && !remote && (
        <BridgeDialog env={bridge} action="install" onClose={() => setBridge(null)} />
      )}
      {!remote && <AskClaudePanel open={ask} onClose={() => setAsk(false)} />}
    </div>
  )
}
