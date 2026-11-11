// Main-process cost of the Usage screen's IPC calls, the Codex fork dedupe and
// the session search index, on a COPY of the app's own data (CSD_BENCH_DATA:
// usage/, settings.json, limits-history.ndjson, optionally cache/sessions-v*.json).
// Nothing is scanned and nothing is written back: the session service is a stub
// with no sources. Prints numbers only (no titles, paths or text). See README.md.
/* eslint-disable */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session } from 'node:inspector/promises'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'
import MiniSearch from 'minisearch'
import { UsageService, usagePaths } from '../../src/main/services/usage'
import { LimitsService } from '../../src/main/services/limits'
import { CodexLimitsService } from '../../src/main/services/codex-limits'
import { appPaths, createSettingsStore } from '../../src/main/services/store'
import { SearchIndex } from '../../src/main/services/search'
import { codexUsageSettings } from '../../src/shared/usage/codex-settings'
import { buildTrends } from '../../src/shared/usage/trends'
import { buildCodexTrends } from '../../src/shared/usage/codex-trends'
import { localTimeZone } from '../../src/shared/usage/time'
import { fiveHourBlocks } from '../../src/shared/usage/aggregate'

const DATA = process.env.CSD_BENCH_DATA!
const OUT = process.env.CSD_BENCH_OUT ?? DATA

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const kb = (v: unknown) => Math.round((JSON.stringify(v)?.length ?? 0) / 1024)
const mb = (b: number) => Math.round(b / 1048576)

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void
const heapMb = () => {
  gc()
  gc()
  return mb(process.memoryUsage().heapUsed)
}

test('bench', async () => {
  if (!DATA) throw new Error('Set CSD_BENCH_DATA to a copy of the app data folder')
  const lines: string[] = []
  const log = (s: string) => {
    lines.push(s)
    console.log(s)
  }
  const inspector = new Session()
  inspector.connect()
  /** Bytes allocated while fn runs (sampled, garbage included); with CSD_BENCH_ALLOC_TOP, the top sites. */
  const allocated = async (fn: () => unknown, label = ''): Promise<number> => {
    await inspector.post('HeapProfiler.enable')
    await inspector.post('HeapProfiler.startSampling', {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true
    } as any)
    await fn()
    const { profile } = (await inspector.post('HeapProfiler.stopSampling')) as any
    let total = 0
    const walk = (n: any) => {
      total += n.selfSize
      for (const c of n.children) walk(c)
    }
    walk(profile.head)
    if (process.env.CSD_BENCH_ALLOC_TOP && label) {
      const self = new Map<string, number>()
      const add = (n: any) => {
        const f = n.callFrame
        const name = `${f.functionName || '(anon)'} ${f.url.split(/[\/]/).slice(-2).join('/')}:${f.lineNumber + 1}`
        self.set(name, (self.get(name) ?? 0) + n.selfSize)
        for (const c of n.children) add(c)
      }
      add(profile.head)
      log(`  top allocation sites: ${label}`)
      for (const [name, b] of [...self].sort((x, y) => y[1] - x[1]).slice(0, 12))
        log(`    ${String(mb(b)).padStart(5)} MB  ${name}`)
    }
    return total
  }

  const paths = appPaths(DATA)
  const settingsStore = createSettingsStore(paths)
  await settingsStore.load()
  const settings = settingsStore.value
  const codex = codexUsageSettings(settings)
  const sessions: any = {
    list: () => [],
    get: () => undefined,
    on: () => sessions,
    sources: [],
    source: () => undefined
  }
  const heap0 = heapMb()
  const usage = new UsageService(sessions, usagePaths(DATA, join(DATA, 'archive')), () => ({
    weekStart: settings.weekStart,
    prices: settings.prices,
    codexPrices: codex.codexPrices
  }))
  // Never write anything back.
  ;(usage as any).flush = async () => undefined
  ;(usage as any).scheduleSave = () => undefined

  let t = performance.now()
  await usage.whenLoaded()
  log(`load usage data: ${Math.round(performance.now() - t)} ms`)
  log(
    `records: claude ${usage.allRecords().length}, codex ${usage.codexRecords().length}; turns: claude ${usage.allTurns().length}, codex ${usage.codexTurns().length}; codex limit readings ${usage.codexLimitReadings().length}`
  )

  const limits = new LimitsService(
    sessions,
    usage,
    { describe: async () => undefined } as any,
    { value: {} } as any,
    join(DATA, 'limits-history.ndjson'),
    DATA,
    () =>
      ({
        plan: settings.plan,
        alertsEnabled: false,
        alertThresholds: settings.alertThresholds,
        weights: settings.capacityWeights,
        prices: settings.prices,
        health: settings.health,
        planHistory: settings.planHistory,
        pace: settings.pace,
        elsewhere: settings.elsewhere
      }) as any,
    () => undefined
  )
  ;(limits as any).salvageOrphans = async () => ({ imported: 0, repeats: 0, deleted: 0, failed: 0 })
  ;(limits as any).persist = async () => undefined
  t = performance.now()
  await limits.start()
  limits.stop()
  log(
    `load limit history: ${Math.round(performance.now() - t)} ms, ${limits.readings().length} readings`
  )

  const codexLimits = new CodexLimitsService(
    usage as any,
    () =>
      ({
        plan: codex.codexPlan,
        accounts: codex.codexAccounts,
        mults: codex.codexPlanMults,
        health: codex.codexHealth,
        elsewhere: codex.codexElsewhere,
        prices: codex.codexPrices,
        pace: settings.pace,
        weights: settings.capacityWeights,
        alertsEnabled: false,
        alertThresholds: settings.alertThresholds
      }) as any,
    () => undefined
  )
  codexLimits.start()

  // ------------------------------------------------------------ results (for before/after parity)
  {
    const { createHash } = await import('node:crypto')
    const hash = (v: unknown) =>
      createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
    // A fixed "now" (the data's last record), so two runs give the same reports.
    const fixed =
      Math.max(usage.allRecords().at(-1)?.ts ?? 0, usage.codexRecords().at(-1)?.ts ?? 0) + 3_600_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixed)
    try {
      log(
        `hash: codex records ${hash(usage.codexRecords())}, readings ${hash(usage.codexLimitReadings())}, turns ${hash(usage.codexTurns())}`
      )
      log(
        `hash: claude records ${hash(usage.allRecords())}, all records ${hash(usage.recordsOf('all'))}`
      )
      const DAY = 86_400_000
      const qs: [string, any][] = []
      for (const provider of [undefined, 'codex', 'all'])
        for (const period of ['hour', 'day', 'week', 'month'])
          for (const from of [undefined, fixed - 30 * DAY, fixed - 2 * DAY])
            for (const groupBy of ['model', 'session', 'project', 'version', 'provider'])
              qs.push([
                `${provider ?? 'claude'} ${period} ${from ? 'from' : 'all'} ${groupBy}`,
                { provider, period, from, groupBy }
              ])
      qs.push([
        'all week models',
        {
          provider: 'all',
          period: 'week',
          models: usage
            .recordsOf('all')
            .slice(-3)
            .map((r) => r.model)
        }
      ])
      const reports = qs.map(([, q]) => usage.report(q))
      log(
        `hash: ${qs.length} reports ${hash(reports)} (each: ${reports.map((r) => hash(r).slice(0, 4)).join(' ')})`
      )
      log(`hash: speed trends ${hash(usage.speedTrends())}`)
    } finally {
      spy.mockRestore()
    }
  }

  // ------------------------------------------------------------ memory
  log(`mem: usage data loaded ${heapMb() - heap0} MB (heap ${heapMb()} MB)`)
  for (const v of ['claude', 'codex', 'all'] as const)
    usage.report({ period: 'day', groupBy: 'model', ...(v === 'claude' ? {} : { provider: v }) })
  log(`mem: after reports (indexes, cost tables) heap ${heapMb()} MB`)
  await limits.state()
  codexLimits.state()
  usage.speedTrends()
  log(`mem: after limits + speed heap ${heapMb()} MB`)
  {
    const before = heapMb()
    for (let i = 0; i < 20; i++) usage.report({ period: 'day', groupBy: 'model', provider: 'all' })
    log(`mem: 20 more All reports leave ${heapMb() - before} MB`)
  }

  // ------------------------------------------------------------ allocations
  const store: any = (usage as any).codex
  /** As after any Codex file changed: the dedupe and everything built on its lists runs again. */
  const codexChanged = () => {
    store.winners = undefined
    store.turnList = undefined
  }
  for (let i = 0; i < 3; i++) {
    codexChanged()
    const a = performance.now()
    usage.codexRecords()
    const b = performance.now()
    usage.codexTurns()
    log(
      `codex dedupe (after any Codex file changed): records ${Math.round(b - a)} ms, turns ${Math.round(performance.now() - b)} ms`
    )
  }
  {
    codexChanged()
    const bytes = await allocated(() => {
      usage.codexRecords()
      usage.codexTurns()
    }, 'codex dedupe')
    log(`alloc: one codex dedupe run ${mb(bytes)} MB`)
  }
  const reportAlloc = async (label: string, q: any, changed: boolean) => {
    // Warm: the same report once before (its lists, indexes and costs are there).
    if (changed) codexChanged()
    else usage.report(q)
    const bytes = await allocated(() => usage.report(q), label)
    log(`alloc: ${label.padEnd(48)} ${String(mb(bytes)).padStart(5)} MB`)
  }
  await reportAlloc(
    'usage:report all all/week (warm)',
    { period: 'week', groupBy: 'model', provider: 'all' },
    false
  )
  await reportAlloc(
    'usage:report all all/week (after a Codex change)',
    { period: 'week', groupBy: 'model', provider: 'all' },
    true
  )
  await reportAlloc(
    'usage:report codex all/day (warm)',
    { period: 'day', groupBy: 'model', provider: 'codex' },
    false
  )
  await reportAlloc(
    'usage:report claude all/day (warm)',
    { period: 'day', groupBy: 'model' },
    false
  )
  {
    const before = heapMb()
    codexChanged()
    usage.report({ period: 'week', groupBy: 'model', provider: 'all' })
    log(`mem: a Codex change + All report leaves ${heapMb() - before} MB`)
  }

  // ------------------------------------------------------------ the session search index
  const cacheDir = join(DATA, 'cache')
  const cacheFile = existsSync(cacheDir)
    ? readdirSync(cacheDir)
        .filter((f) => /^sessions-v\d+\.json$/.test(f))
        .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0]
    : undefined
  if (cacheFile) {
    const before = heapMb()
    let raw: string | undefined = readFileSync(join(cacheDir, cacheFile), 'utf8')
    const fileMb = mb(raw.length)
    let parsed: any = JSON.parse(raw)
    raw = undefined
    const searchJson: string = parsed.search
    const entries = parsed.entries?.length ?? 0
    parsed = undefined
    const withJson = heapMb()
    const idx = new SearchIndex()
    const tl = performance.now()
    idx.load(searchJson)
    const loadMs = Math.round(performance.now() - tl)
    const inner: any = (idx as any).index as MiniSearch
    log(
      `search index: cache file ${fileMb} MB (${entries} sessions), serialised index ${mb(searchJson.length)} MB, load ${loadMs} ms`
    )
    log(
      `search index: ${inner.documentCount} documents, ${inner.termCount} terms; heap with the index ${heapMb() - withJson} MB (the serialised string ${withJson - before} MB more)`
    )
    const tq = performance.now()
    for (const q of ['test', 'npm run', 'session', 'error fix']) idx.search?.(q)
    log(`search index: 4 queries ${Math.round(performance.now() - tq)} ms`)
    ;(globalThis as any).__keep = idx
  }

  // ------------------------------------------------------------ timings
  const N = Number(process.env.CSD_BENCH_N ?? 5)
  const time = async (label: string, fn: () => unknown) => {
    const xs: number[] = []
    let res: unknown
    let first = 0
    for (let i = 0; i < N; i++) {
      const a = performance.now()
      res = await fn()
      const d = performance.now() - a
      if (i === 0) first = d
      xs.push(d)
    }
    log(
      `${label.padEnd(44)} first ${String(Math.round(first)).padStart(5)} ms  median ${String(Math.round(median(xs))).padStart(5)} ms  ${String(kb(res)).padStart(6)} KB`
    )
    return res
  }
  const DAY = 86_400_000
  const now = Date.now()
  const sod = (x: number) => {
    const d = new Date(x)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const ranges: [string, any][] = [
    ['30d/day', { from: sod(now - 29 * DAY), period: 'day' }],
    ['7d/day', { from: sod(now - 6 * DAY), period: 'day' }],
    ['today/hour', { from: sod(now), period: 'hour' }],
    ['90d/week', { from: sod(now - 89 * DAY), period: 'week' }],
    ['1y/month', { from: sod(now - 364 * DAY), period: 'month' }],
    ['all/week', { period: 'week' }],
    ['all/day', { period: 'day' }]
  ]
  log('--- usage:report (one per range switch / Day-Week-Month switch)')
  for (const view of ['claude', 'codex', 'all'] as const)
    for (const [name, r] of ranges)
      await time(`usage:report ${view} ${name}`, () =>
        usage.report({ ...r, groupBy: 'model', ...(view === 'claude' ? {} : { provider: view }) })
      )
  log('--- after a Codex change (first report)')
  for (const view of ['codex', 'all'] as const)
    await time(`usage:report ${view} all/week, Codex changed`, () => {
      codexChanged()
      return usage.report({ period: 'week', groupBy: 'model', provider: view })
    })
  log('--- limits')
  await time('limits:state', () => limits.state())
  await time('codexLimits:state', () => codexLimits.state())
  await time('  fiveHourBlocks(all records)', () =>
    fiveHourBlocks(usage.allRecords(), now, settings.prices)
  )
  log('--- trends tab')
  for (const by of ['all', 'model', 'version'] as const)
    await time(`usage:trends ${by}`, () => {
      const health = limits.health('five_hour')
      return buildTrends({
        records: usage.allRecords(),
        turns: usage.allTurns(),
        readings: limits.readings(),
        capacity: health.windows
          .filter((w: any) => w.closed && !w.excluded && w.dollars > 0)
          .map((w: any) => ({
            ts: w.resetsAt,
            kind: 'five_hour',
            pct: w.pct,
            weighted: w.dollars,
            capacity: w.perPct / w.mult,
            mix: ''
          })),
        plans: health.plans,
        timeZone: localTimeZone(),
        weekStart: settings.weekStart,
        groupBy: by
      } as any)
    })
  for (const by of ['all', 'model', 'version'] as const)
    await time(`usage:codexTrends ${by}`, () =>
      buildCodexTrends({
        records: usage.codexRecords(),
        turns: usage.codexTurns(),
        timeZone: localTimeZone(),
        weekStart: settings.weekStart,
        groupBy: by
      } as any)
    )
  await time('usage:speedTrends', () => usage.speedTrends())
  inspector.disconnect()
  writeFileSync(join(OUT, 'bench-main.txt'), lines.join('\n') + '\n')
}, 900_000)
