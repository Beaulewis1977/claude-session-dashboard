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
import { ago } from '@shared/format'
import { LIVE_SOURCES_NOTE, PLAN_LABEL, type BridgeEnv } from '@shared/usage/limits'
import { CODEX_LIVE_NOTE } from '@shared/usage/codex'
import { DEFAULT_CODEX_PRICES, unpricedModels } from '@shared/usage/pricing'
import { PROVIDER_LABEL } from '@shared/provider'
import type { Dimension, PeriodCard, Period, UsageQuery, UsageReport } from '@shared/usage/types'
import { api } from '@/lib/api'
import { useNow } from '@/lib/meter-hooks'
import { useApp } from '@/lib/store'
import { useEnabledProviders, useScope } from '@/lib/scope'
import { modelLabel } from '@/lib/usage-colors'
import { useMobileScope, usePhoneProviders, usePhoneScope } from '@/mobile/scope'
import { ProviderBadge, ProviderSwitch } from '../ProviderSwitch'
import { Segmented } from '../ui/segmented'
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
import { CreditsEmptyState, CreditsHeroCard, LimitCard } from './Hero'
import { MainChart, ModelShare, SummaryCards, TopSessions } from './Overview'
import { CreditsTab, LimitHistoryTab, RawTableTab } from './Tabs'
import { LimitHealthCard, WhereItWent } from './LimitHealth'
import { PaceAdviceLine } from './Hero'
import { TrendsTab } from './Trends'
import { CodexLimitCards, CodexPlanChip } from './CodexLimits'
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

/** A labelled group of one provider's gauges (the All view). */
function ProviderGroup({
  provider,
  chip,
  children
}: {
  provider: 'claude' | 'codex'
  chip?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-label={`${PROVIDER_LABEL[provider]} limits`} className="min-w-0">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium">
        <ProviderBadge provider={provider} />
        <span>{PROVIDER_LABEL[provider]}</span>
        {chip}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(270px,100%),1fr))] gap-3">
        {children}
      </div>
    </section>
  )
}

/** "New Codex model detected": models in the logs without a price (their cost shows as $0). */
function UnpricedNotice({ models, onOpen }: { models: string[]; onOpen?: () => void }) {
  if (!models.length) return null
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-secondary/50 px-4 py-2.5 text-[12.5px]">
      <Sparkles className="size-4 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">
          New Codex model{models.length === 1 ? '' : 's'} detected:
        </span>{' '}
        {models.map((m) => modelLabel(m)).join(', ')}.{' '}
        <span className="text-muted-foreground">
          {models.length === 1 ? 'It has' : 'They have'} no price yet, so{' '}
          {models.length === 1 ? 'its' : 'their'} tokens count but cost shows as $0. Prices are
          never downloaded.
        </span>
      </span>
      {onOpen && (
        <Button variant="outline" size="sm" onClick={onOpen}>
          Add prices
        </Button>
      )}
    </div>
  )
}

export function UsageView() {
  const limits = useApp((s) => s.limits)
  const codexLimits = useApp((s) => s.codexLimits)
  const credits = useApp((s) => s.credits)
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const select = useApp((s) => s.select)
  // On a phone (the companion), PC-only actions are hidden, and the switch is the phone's own.
  const remote = api.remote === true
  const desktopScope = useScope()
  const phoneScope = useMobileScope()
  const view = (remote ? phoneScope : desktopScope).view
  const desktopEnabled = useEnabledProviders()
  const phoneEnabled = usePhoneProviders()
  const enabled = remote ? phoneEnabled : desktopEnabled
  const setPhoneView = usePhoneScope((s) => s.setView)
  const splitMode = settings.usageSplit ?? 'stacked'
  const showClaude = view !== 'codex'
  const showCodex = view !== 'claude'

  const [report, setReport] = useState<UsageReport | null>(null)
  const [splitReports, setSplitReports] = useState<{
    claude: UsageReport
    codex: UsageReport
  } | null>(null)
  const [range, setRange] = useState<RangeId>('30d')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [period, setPeriod] = useState<Period>('day')
  // Model chips per view: a model picked in one view isn't in another's list.
  const [modelsBy, setModelsBy] = useState<Record<string, string[]>>({})
  const models = useMemo(() => modelsBy[view] ?? [], [modelsBy, view])
  const setModels = (m: string[]): void => setModelsBy((p) => ({ ...p, [view]: m }))
  const [groupBy, setGroupBy] = useState<Dimension>('model')
  const [tab, setTab] = useState<Tab>('trends')
  const [bridge, setBridge] = useState<BridgeEnv | null>(null)
  const [version, setVersion] = useState(0)
  const [ask, setAsk] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const scan = useApp((s) => s.scan)
  const t = useNow()

  useEffect(() => api.onUsageChanged(() => setVersion((v) => v + 1)), [])

  const query: UsageQuery = useMemo(() => {
    const r = rangeOf(range, report?.cards, custom)
    const q: UsageQuery = { ...r, period, models, groupBy }
    if (view !== 'claude') q.provider = view
    return q
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, custom, period, models, groupBy, view, report?.cards?.[0]?.from])

  useEffect(() => {
    let cancelled = false
    void api.getUsageReport(query).then((r) => !cancelled && setReport(r))
    return () => {
      cancelled = true
    }
  }, [query, version])

  // All, split: one chart per provider, each from its own report.
  const wantSplit = view === 'all' && splitMode === 'split'
  useEffect(() => {
    if (!wantSplit) return
    let cancelled = false
    // The same model filter as the chips above (a Claude model leaves Codex's chart empty).
    const base = { ...query, groupBy: 'model' as Dimension }
    void Promise.all([
      api.getUsageReport({ ...base, provider: undefined }),
      api.getUsageReport({ ...base, provider: 'codex' })
    ]).then(([claude, codex]) => !cancelled && setSplitReports({ claude, codex }))
    return () => {
      cancelled = true
    }
  }, [wantSplit, query, version])

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
  // Codex models in this report that have no price yet.
  const unpriced = useMemo(
    () =>
      showCodex && report
        ? unpricedModels(
            report.models.filter((m) => !m.startsWith('claude-')),
            settings.codexPrices ?? DEFAULT_CODEX_PRICES
          )
        : [],
    [showCodex, report, settings.codexPrices]
  )
  const openPrices = remote
    ? undefined
    : () => set({ view: 'settings', settingsSection: 'codex-usage' })

  const subtitle =
    view === 'codex'
      ? `${codexLimits?.plan.label ?? 'Codex'} · every token from Codex's session logs, plus your plan limits`
      : view === 'all'
        ? `${PLAN_LABEL[settings.plan]} and ${codexLimits?.plan.label ?? 'Codex'} · every token from both agents' logs, plus each plan's limits`
        : `${PLAN_LABEL[settings.plan]} · every token from your session logs, plus your live plan limits`
  const note =
    view === 'codex'
      ? CODEX_LIVE_NOTE
      : view === 'all'
        ? `${LIVE_SOURCES_NOTE} ${CODEX_LIVE_NOTE}`
        : LIVE_SOURCES_NOTE

  const tabs: [Tab, string][] = [
    ...(showClaude ? ([['trends', 'Trends']] as [Tab, string][]) : []),
    ['limits', 'Limit history'],
    ...(showClaude ? ([['credits', 'Credits']] as [Tab, string][]) : []),
    ['raw', 'Raw table']
  ]
  const shownTab: Tab = tabs.some(([id]) => id === tab) ? tab : tabs[0][0]

  const chart = (
    r: UsageReport | null,
    opts: {
      byProvider?: boolean
      provider?: 'claude' | 'codex'
      title?: string
      extraRight?: React.ReactNode
      withModels?: boolean
    } = {}
  ) => (
    <MainChart
      report={r}
      period={period}
      onPeriod={setPeriod}
      range={
        opts.withModels === false ? null : (
          <RangePicker value={range} onChange={setRange} custom={custom} onCustom={setCustom} />
        )
      }
      models={opts.withModels === false ? [] : (report?.models ?? [])}
      selectedModels={opts.withModels === false ? [] : models}
      onModels={setModels}
      byProvider={opts.byProvider}
      provider={opts.provider}
      title={opts.title}
      extraRight={opts.extraRight}
    />
  )
  const splitSwitch = view === 'all' && (
    <Segmented
      ariaLabel="Providers"
      value={splitMode}
      onChange={(v) => {
        set({ settings: { ...settings, usageSplit: v } })
        void api.updateSettings({ usageSplit: v })
      }}
      options={[
        { value: 'stacked', label: 'Stacked' },
        { value: 'split', label: 'Split' }
      ]}
    />
  )

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
            <p className="mt-0.5 text-[13px] text-muted-foreground">{subtitle}</p>
            <p className="mt-0.5 text-[11.5px] text-subtle-foreground">
              {note}
              {scan.finishedAt !== undefined && (
                <span title={new Date(scan.finishedAt).toLocaleString()}>
                  {' '}
                  · Last scan {ago(scan.finishedAt, t)}
                </span>
              )}
            </p>
          </div>
          {remote && enabled.length > 1 && (
            <div className="w-full">
              <ProviderSwitch value={view} onChange={setPhoneView} enabled={enabled} />
            </div>
          )}
          {!remote && (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={rescanning || scan.phase === 'scanning'}
                onClick={async () => {
                  setRescanning(true)
                  try {
                    set({ limits: await api.rescanLimits() })
                    setVersion((v) => v + 1)
                  } catch (err) {
                    toast.error('Rescan failed', { description: (err as Error).message })
                  } finally {
                    setRescanning(false)
                  }
                }}
              >
                <RefreshCw className={cn(rescanning && 'animate-spin')} />
                {rescanning ? 'Rescanning…' : 'Rescan now'}
              </Button>
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

        {showClaude && noBridge && firstEnv && (
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
        {view === 'claude' && (
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
        )}
        {view === 'codex' && (
          <>
            {codexLimits && (
              <div className="mt-5 flex items-center gap-2 text-[12px] text-muted-foreground">
                Plan <CodexPlanChip codex={codexLimits} />
              </div>
            )}
            <div
              data-shot="hero"
              className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4"
            >
              <CodexLimitCards codex={codexLimits} />
            </div>
          </>
        )}
        {view === 'all' && (
          <div data-shot="hero" className="mt-5 grid gap-5 xl:grid-cols-2">
            <ProviderGroup
              provider="claude"
              chip={
                <span className="text-[11px] font-normal text-muted-foreground">
                  · {PLAN_LABEL[settings.plan]}
                </span>
              }
            >
              <LimitCard
                compact
                kind="five_hour"
                limits={limits}
                onEnable={() => firstEnv && setBridge(firstEnv)}
              />
              <LimitCard
                compact
                kind="seven_day"
                limits={limits}
                onEnable={() => firstEnv && setBridge(firstEnv)}
              />
            </ProviderGroup>
            <ProviderGroup
              provider="codex"
              chip={codexLimits && <CodexPlanChip codex={codexLimits} />}
            >
              <CodexLimitCards codex={codexLimits} compact />
            </ProviderGroup>
          </div>
        )}

        {showClaude && !hasCredits && (
          <CreditsEmptyState
            credits={credits}
            onSetup={
              remote ? undefined : () => set({ view: 'settings', settingsSection: 'accounts' })
            }
          />
        )}
        {view === 'all' && hasCredits && credits && (
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
            <CreditsHeroCard credits={credits} onOpen={() => setTab('credits')} />
          </div>
        )}

        {showClaude && limits?.advice && (
          <PaceAdviceLine
            advice={
              view === 'all'
                ? { ...limits.advice, text: `Claude: ${limits.advice.text}` }
                : limits.advice
            }
          />
        )}
        {showCodex && codexLimits?.advice && (
          <PaceAdviceLine
            advice={
              view === 'all'
                ? { ...codexLimits.advice, text: `Codex: ${codexLimits.advice.text}` }
                : codexLimits.advice
            }
          />
        )}

        <UnpricedNotice models={unpriced} onOpen={openPrices} />

        {view === 'claude' && (
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
        )}
        {view === 'codex' && (
          <div
            data-shot="health"
            className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]"
          >
            <LimitHealthCard
              limits={null}
              codex={codexLimits}
              onAsk={() => (remote ? toast('Ask Claude runs in the app on your PC') : setAsk(true))}
            />
            <WhereItWent limits={null} codex={codexLimits} />
          </div>
        )}
        {view === 'all' && (
          <div data-shot="health" className="mt-4 grid gap-4 xl:grid-cols-2">
            <LimitHealthCard
              limits={limits}
              onAsk={() => (remote ? toast('Ask Claude runs in the app on your PC') : setAsk(true))}
            />
            <LimitHealthCard
              limits={null}
              codex={codexLimits}
              onAsk={() => (remote ? toast('Ask Claude runs in the app on your PC') : setAsk(true))}
            />
            <WhereItWent limits={limits} />
            <WhereItWent limits={null} codex={codexLimits} />
          </div>
        )}

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
          {view === 'all' && splitMode === 'split' ? (
            <div className="space-y-4">
              {chart(splitReports?.claude ?? null, {
                provider: 'claude',
                title: 'Claude Code · tokens over time',
                extraRight: splitSwitch
              })}
              {chart(splitReports?.codex ?? null, {
                provider: 'codex',
                title: 'Codex · tokens over time',
                withModels: false
              })}
            </div>
          ) : (
            chart(report, {
              byProvider: view === 'all',
              provider: view === 'all' ? undefined : view,
              extraRight: splitSwitch
            })
          )}
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
            {tabs.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={shownTab === id}
                onClick={() => setTab(id)}
                className={cn(
                  '-mb-px border-b-2 px-3 pt-1 pb-2 text-[13px] font-medium transition-colors',
                  shownTab === id
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
                  void api.recalculateUsage().then((s) =>
                    toast.success('Usage recalculated', {
                      description: `${s.records} responses${s.codexRecords ? ` · ${s.codexRecords} Codex responses` : ''}`
                    })
                  )
                }}
              >
                <RefreshCw /> Recalculate
              </Button>
            </span>
          </div>
          {shownTab === 'trends' && (
            <>
              {view === 'all' && (
                <p className="mb-3 text-xs text-muted-foreground">Trends cover Claude Code only.</p>
              )}
              <TrendsTab />
            </>
          )}
          {shownTab === 'limits' && view === 'claude' && (
            <LimitHistoryTab limits={limits} report={report} />
          )}
          {shownTab === 'limits' && view === 'codex' && (
            <LimitHistoryTab limits={null} report={report} codex={codexLimits} />
          )}
          {shownTab === 'limits' && view === 'all' && (
            <div className="space-y-6">
              <LimitHistoryTab limits={limits} report={report} />
              <LimitHistoryTab limits={null} report={null} codex={codexLimits} hideBlocks />
            </div>
          )}
          {shownTab === 'credits' && <CreditsTab credits={credits} />}
          {shownTab === 'raw' && (
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
