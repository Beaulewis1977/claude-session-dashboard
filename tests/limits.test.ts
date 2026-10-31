import { DEFAULT_HEALTH } from '@shared/usage/health'
import { DEFAULT_PACE } from '@shared/usage/pace'
import { createHash } from 'node:crypto'
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURES_NOW, setClockOffset } from '@shared/clock'
import type { BridgeReading } from '@shared/usage/bridge'
import {
  asOf,
  crossedThresholds,
  DEFAULT_WEIGHTS,
  detectCapacityChange,
  freshnessOf,
  gauge,
  gaugeSummary,
  impliedCapacity,
  lastKnown,
  LIVE_SOURCES_NOTE,
  projectWindow,
  REFRESH_HINT,
  weeklyBuckets,
  weightedTokens,
  whyNoLiveReading,
  type CapacityPoint,
  type LimitsState
} from '@shared/usage/limits'
import { parseBridgePayload, sameLimits } from '@shared/usage/bridge'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import type { UsageRecord } from '@shared/usage/types'
import {
  fixturesLayout,
  prepareFixtures,
  seedFixtureBridge,
  seedFixtureData,
  seedFixtureUsage
} from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import {
  BridgeInstaller,
  createBridgeStore,
  envPaths,
  SHIPPED_SCRIPT_SHA256,
  writeBridgeFile
} from '../src/main/services/bridge'
import { LimitsService } from '../src/main/services/limits'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { UsageService, usagePaths } from '../src/main/services/usage'
import { FIXTURES } from './helpers'

const H = 3_600_000
const SCRIPTS_DIR = join(__dirname, '..', 'resources', 'bridge')
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex')
const T0 = Date.parse('2026-10-22T10:00:00Z')

function rec(ts: number, output: number, key = 'windows:s'): UsageRecord {
  return {
    id: `r${ts}${key}`,
    ts,
    key,
    project: 'p',
    env: 'windows',
    model: 'claude-opus-5-5',
    input: 0,
    output,
    cacheWrite: 0,
    cacheRead: 0
  }
}
function reading(
  ts: number,
  pct5: number,
  resets5: number,
  extra: Partial<BridgeReading> = {}
): BridgeReading {
  return {
    ts,
    source: 'windows',
    sessionId: 's',
    fiveHour: { pct: pct5, resetsAt: resets5 },
    ...extra
  }
}

describe('implied capacity', () => {
  it('divides the weighted tokens in the window by the used percentage', () => {
    const resets = T0 + 5 * H
    const records = [rec(T0 + 10 * 60_000, 1000), rec(T0 + 60 * 60_000, 1000), rec(T0 - H, 99999)]
    // 2,000 output tokens × weight 5 = 10,000 weighted at 25% → capacity 40,000.
    const pts = impliedCapacity(
      [reading(T0 + 30 * 60_000, 12, resets), reading(T0 + 61 * 60_000, 25, resets)],
      records,
      'five_hour',
      DEFAULT_WEIGHTS
    )
    expect(pts).toHaveLength(1)
    expect(pts[0]).toMatchObject({ pct: 25, weighted: 10_000, capacity: 40_000, mix: 'opus' })
    expect(
      weightedTokens({ input: 1, output: 1, cacheWrite: 1, cacheRead: 10 }, DEFAULT_WEIGHTS)
    ).toBe(8.25)
  })

  it('skips tiny percentages and API-billed sessions', () => {
    const resets = T0 + 5 * H
    const records = [rec(T0 + 60_000, 1000), rec(T0 + 120_000, 1000, 'wsl:api')]
    expect(
      impliedCapacity([reading(T0 + 3 * 60_000, 4, resets)], records, 'five_hour', DEFAULT_WEIGHTS)
    ).toEqual([])
    const pts = impliedCapacity(
      [reading(T0 + 3 * 60_000, 50, resets)],
      records,
      'five_hour',
      DEFAULT_WEIGHTS,
      {
        isSubscription: (k) => k !== 'wsl:api'
      }
    )
    expect(pts[0].capacity).toBe(10_000)
  })

  it('flags a noticeable drop compared with the previous month', () => {
    const now = Date.parse('2026-10-22T12:00:00Z')
    const pts: CapacityPoint[] = []
    for (let d = 1; d <= 44; d++) {
      const ts = now - d * 86_400_000
      pts.push({
        ts,
        kind: 'five_hour',
        pct: 50,
        weighted: 1,
        capacity: d <= 14 ? 750 : 1000,
        mix: 'opus'
      })
    }
    const c = detectCapacityChange(pts, now)!
    expect(c.changePct).toBeCloseTo(-25)
    expect(c.flagged).toBe(true)
    const steady = detectCapacityChange(
      pts.map((p) => ({ ...p, capacity: 1000 })),
      now
    )!
    expect(steady.flagged).toBe(false)
    expect(detectCapacityChange([], now)).toBeUndefined()
  })
})

describe('gauges and projections', () => {
  it('projects when the window will hit 100% from the recent pace', () => {
    const resets = T0 + 5 * H
    const rs = [reading(T0 + 60 * 60_000, 20, resets), reading(T0 + 120 * 60_000, 40, resets)]
    const p = projectWindow(rs, 'five_hour', T0 + 120 * 60_000)!
    expect(p.pctPerHour).toBeCloseTo(20)
    expect(p.hitsLimitAt).toBe(T0 + 120 * 60_000 + 3 * H)
    expect(p.safe).toBe(true) // 3h from 12:00 is 15:00, the window resets at 15:00
    const fast = [reading(T0 + 60 * 60_000, 20, resets), reading(T0 + 90 * 60_000, 50, resets)]
    expect(projectWindow(fast, 'five_hour', T0 + 90 * 60_000)!.safe).toBe(false)
  })

  it('uses the pace since the window started with a single reading', () => {
    const resets = T0 + 5 * H
    const p = projectWindow([reading(T0 + 2 * H, 40, resets)], 'five_hour', T0 + 2 * H)!
    expect(p.pctPerHour).toBeCloseTo(20)
  })

  it('reports an expired window as reset, and counts tokens in the window', () => {
    const resets = T0 + 5 * H
    const g = gauge(
      [reading(T0 + H, 30, resets)],
      [rec(T0 + 30 * 60_000, 100), rec(T0 - H, 100)],
      'five_hour',
      T0 + 2 * H,
      DEFAULT_WEIGHTS
    )!
    expect(g).toMatchObject({
      pct: 30,
      expired: false,
      tokens: 100,
      weighted: 500,
      windowStart: T0
    })
    const later = gauge(
      [reading(T0 + H, 30, resets)],
      [],
      'five_hour',
      T0 + 6 * H,
      DEFAULT_WEIGHTS
    )!
    expect(later).toMatchObject({ pct: 0, lastPct: 30, expired: true })
    expect(gauge([], [], 'five_hour', T0, DEFAULT_WEIGHTS)).toBeUndefined()
  })

  it('tells fresh, aging and stale readings apart, and never shows a reset window as 0%', () => {
    const resets = T0 + 5 * H
    const g = (t: number) =>
      gauge([reading(T0 + H, 30, resets)], [], 'five_hour', t, DEFAULT_WEIGHTS)!
    expect(freshnessOf(g(T0 + H + 30 * 60_000), T0 + H + 30 * 60_000)).toBe('fresh')
    expect(freshnessOf(g(T0 + 3 * H), T0 + 3 * H)).toBe('aging')
    expect(freshnessOf(g(T0 + 6 * H), T0 + 6 * H)).toBe('stale')
    expect(gaugeSummary('5-hour', g(T0 + H), T0 + H)).toBe('5-hour: 30%')
    expect(gaugeSummary('5-hour', g(T0 + 3 * H), T0 + 3 * H)).toBe('5-hour: 30% · updated 2h ago')
    // The last known value, with the day it was read, instead of a made-up 0%.
    const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      T0 + H
    )
    const later = T0 + 3 * 86_400_000
    expect(lastKnown(g(later), later)).toBe(`30% as of ${day}`)
    expect(gaugeSummary('5-hour', g(later), later)).toBe(
      `5-hour: no recent reading (30% as of ${day})`
    )
    expect(gaugeSummary('Week', undefined, later)).toBe('Week: no data')
  })

  it('shows a time for today and a date for any other local day, across midnight', () => {
    const midnight = new Date(2026, 9, 25, 0, 0, 0).getTime() // local time (a DST change day in many zones)
    const before = midnight - 60_000
    const after = midnight + 60_000
    const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
    const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
    expect(asOf(before, after)).toBe(day.format(before))
    expect(asOf(after, after + 3 * H)).toBe(clock.format(after))
  })

  it('says why there is no current reading', () => {
    const resets = T0 + 5 * H
    const env = { installed: true } as LimitsState['envs'][number]
    const base = { hasBridgeData: true, envs: [env], lastLimitAt: T0 + H, lastReadingAt: T0 + H }
    const stale = gauge([reading(T0 + H, 30, resets)], [], 'five_hour', T0 + 6 * H, DEFAULT_WEIGHTS)
    const fresh = gauge([reading(T0 + H, 30, resets)], [], 'five_hour', T0 + 2 * H, DEFAULT_WEIGHTS)
    expect(whyNoLiveReading({ ...base, fiveHour: fresh }, T0 + 2 * H)).toBeUndefined()
    const why = whyNoLiveReading({ ...base, fiveHour: stale }, T0 + 6 * H, 'five_hour')!
    expect(why).toMatch(/^No reading since .+, before this window started./)
    expect(why).toContain(LIVE_SOURCES_NOTE)
    expect(why).toContain(REFRESH_HINT)
    // The bridge ran later, but the payloads had no limits.
    expect(
      whyNoLiveReading({ ...base, lastReadingAt: T0 + 5 * H, fiveHour: stale }, T0 + 6 * H)
    ).toContain('without data for this window')
    // A missing weekly window is explained on its own, not with the 5-hour reading's time.
    expect(whyNoLiveReading({ ...base, fiveHour: fresh }, T0 + 2 * H, 'seven_day')).toMatch(
      /hasn't reported a weekly limit window yet/
    )
    const oldWeek = gauge(
      [
        {
          ts: T0 - 9 * 86_400_000,
          source: 'windows',
          sevenDay: { pct: 5, resetsAt: T0 - 86_400_000 }
        }
      ],
      [],
      'seven_day',
      T0 + 2 * H,
      DEFAULT_WEIGHTS
    )
    const weekWhy = whyNoLiveReading(
      { ...base, fiveHour: fresh, sevenDay: oldWeek },
      T0 + 2 * H,
      'seven_day'
    )!
    expect(weekWhy).toContain(`No reading since ${asOf(T0 - 9 * 86_400_000, T0 + 2 * H)}`)
    expect(whyNoLiveReading({ ...base, lastLimitAt: undefined }, T0)).toMatch(
      /^No reading with limits has arrived yet/
    )
    expect(whyNoLiveReading({ ...base, hasBridgeData: false, envs: [] }, T0)).toMatch(
      /aren't turned on/
    )
  })

  it('keeps any per-model weekly window next to the all-models one', () => {
    const r = parseBridgePayload(
      JSON.stringify({
        rate_limits: {
          seven_day: { used_percentage: 7, resets_at: 1793656800 },
          seven_day_opus: { used_percentage: 5, resets_at: 1793656800 },
          seven_day_bogus: 'x'
        }
      }),
      { ts: 1793400000000, source: 'windows' }
    )!
    expect(r.sevenDay?.pct).toBe(7)
    expect(r.weeklyBy).toEqual({ seven_day_opus: { pct: 5, resetsAt: 1793656800000 } })
    expect(weeklyBuckets([r], 1793400000000)).toEqual([
      {
        key: 'seven_day_opus',
        label: 'Opus only',
        pct: 5,
        resetsAt: 1793656800000,
        updatedAt: 1793400000000
      }
    ])
    // A change in a per-model window alone is a change, not a repeat.
    const moved = { ...r, weeklyBy: { seven_day_opus: { pct: 6, resetsAt: 1793656800000 } } }
    expect(sameLimits(r, moved)).toBe(false)
    expect(sameLimits(r, { ...r })).toBe(true)
    // Today's payloads have only the documented windows.
    expect(weeklyBuckets([{ ...r, weeklyBy: undefined }], 0)).toEqual([])
  })

  it('finds alert thresholds crossed by a new reading', () => {
    expect(crossedThresholds(70, 80, [75, 90])).toEqual([75])
    expect(crossedThresholds(undefined, 95, [75, 90])).toEqual([75, 90])
    expect(crossedThresholds(80, 85, [75, 90])).toEqual([])
  })
})

// ----------------------------------------------------- service on fixtures

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-limits-'))
  setClockOffset(FIXTURES_NOW - Date.now())
})
afterEach(async () => {
  setClockOffset(0)
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

/** The fixture sources with the bridge installed for Windows and WSL (beau). */
async function fixtureLimits() {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  const sessions = new SessionService(platform, paths, metadata, settings)
  await sessions.start()
  await sessions.idle()
  const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
    weekStart: 'monday',
    prices: DEFAULT_PRICES
  }))
  const store = createBridgeStore(paths.dataDir)
  await store.load()
  const installer = new BridgeInstaller(store, {
    dataDir: paths.dataDir,
    scriptsDir: join(__dirname, '..', 'resources', 'bridge'),
    gitBash: async () => undefined
  })
  await seedFixtureBridge(paths.dataDir, sessions, installer)
  const limits = new LimitsService(
    sessions,
    usage,
    installer,
    store,
    join(paths.dataDir, 'limits-history.ndjson'),
    paths.dataDir,
    () => ({
      plan: 'max5',
      alertsEnabled: false,
      alertThresholds: [75, 90],
      weights: DEFAULT_WEIGHTS,
      prices: DEFAULT_PRICES,
      health: DEFAULT_HEALTH,
      planHistory: [],
      pace: DEFAULT_PACE,
      elsewhere: []
    }),
    () => undefined
  )
  await limits.start()
  limits.stop()
  return { limits, installer, sessions, usage, paths }
}

describe('LimitsService (fixtures)', () => {
  it('shows live gauges, detects the October limit cut and enables the bridge', async () => {
    await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
    await prepareFixtures(root, { usageHistory: true })
    const layout = fixturesLayout(root)
    const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
    const paths = appPaths(layout.dataDir)
    const metadata = createMetadataStore(paths)
    const settings = createSettingsStore(paths)
    await metadata.load()
    await settings.load()
    await seedFixtureData(root, paths.archiveDir, metadata)
    await seedFixtureUsage(root, paths.dataDir)
    const sessions = new SessionService(platform, paths, metadata, settings)
    await sessions.start()
    await sessions.idle()
    const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
      weekStart: 'monday',
      prices: DEFAULT_PRICES
    }))
    await usage.start()
    const store = createBridgeStore(paths.dataDir)
    await store.load()
    const installer = new BridgeInstaller(store, {
      dataDir: paths.dataDir,
      scriptsDir: join(__dirname, '..', 'resources', 'bridge'),
      gitBash: async () => undefined
    })
    const notes: string[] = []
    const limits = new LimitsService(
      sessions,
      usage,
      installer,
      store,
      join(paths.dataDir, 'limits-history.ndjson'),
      paths.dataDir,
      () => ({
        plan: 'max5',
        alertsEnabled: true,
        alertThresholds: [75, 90],
        weights: DEFAULT_WEIGHTS,
        prices: DEFAULT_PRICES,
        health: { ...DEFAULT_HEALTH, baselineFrom: '2026-09-01', baselineTo: '2026-09-30' },
        planHistory: [],
        pace: DEFAULT_PACE,
        elsewhere: []
      }),
      (t) => notes.push(t)
    )
    await limits.start()
    limits.stop()
    await seedFixtureBridge(paths.dataDir, sessions, installer)

    const s = await limits.state()
    expect(s.hasBridgeData).toBe(true)
    expect(s.fiveHour?.pct).toBeCloseTo(47.1)
    expect(s.fiveHour?.expired).toBe(false)
    expect(s.fiveHour?.tokens).toBeGreaterThan(1_000_000)
    expect(s.sevenDay?.pct).toBeCloseTo(29.8)
    expect(s.stale).toBe(false)
    expect(s.change5h?.flagged).toBe(true)
    expect(s.change5h?.changePct).toBeLessThan(-18)
    expect(s.change5h?.changePct).toBeGreaterThan(-32)
    expect(s.capacity5h.length).toBeGreaterThan(30)
    // Limit health: baseline from September, the Oct 1 cut (~25%) shows as ~0.8x,
    // under the default flag line (1 ÷ 1.5 = 0.67x), so the verdict stays normal.
    expect(s.health5h?.baseline?.n).toBeGreaterThan(10)
    const oct = s.health5h!.windows.filter((w) => w.closed && w.resetsAt > Date.parse('2026-10-02'))
    const avg = oct.reduce((a, w) => a + w.ratio!, 0) / oct.length
    expect(avg).toBeGreaterThan(0.68)
    expect(avg).toBeLessThan(0.88)
    expect(s.health5h?.verdict.status).toBe('normal')
    expect(s.health7d?.windows.length).toBeGreaterThan(8)
    expect(s.pace7d?.status).toBe('behind')
    expect(s.split5h?.pct).toBeCloseTo(47.1)
    expect(s.limitHits.length).toBeGreaterThan(0)
    expect(s.envs.find((e) => e.sourceId === 'wsl-Ubuntu-beau')?.installed).toBe(true)
    expect(s.envs.find((e) => e.sourceId === 'windows')).toMatchObject({
      installed: true,
      chained: '~/.claude/statusline.sh'
    })
    expect(s.envs.find((e) => e.sourceId === 'wsl-Ubuntu-root')?.installed).toBe(false)
    // API-billed fixture sessions are recognised from their payloads (cost, no rate_limits).
    const apiSession = limits.readings().find((r) => r.costUsd && !r.fiveHour)
    expect(apiSession && limits.billingOf(apiSession.sessionId!)).toBe('api')
    expect(notes).toEqual([]) // nothing over 75% right now
    await sessions.idle()
    await usage.idle()
  })

  // Regression: statusline.ps1 left every update after a session's first one
  // behind as .tmp.<pid>.<name>.json (the first payload has no limits), so the
  // gauges froze. The app now imports those once and cleans them up.
  it('salvages readings from the bridge temp files and deletes only what it handled', async () => {
    const { limits, installer, sessions, paths } = await fixtureLimits()
    const win = sessions.source('windows')!
    const live = join(envPaths(win)!.bridgeDir, 'live')
    await mkdir(live, { recursive: true })
    const payload = (sid: string, pct: number, extra: object = {}) =>
      JSON.stringify({
        session_id: sid,
        rate_limits: {
          five_hour: { used_percentage: pct, resets_at: FIXTURES_NOW / 1000 + 3600 },
          seven_day: { used_percentage: 7, resets_at: FIXTURES_NOW / 1000 + 86_400 }
        },
        ...extra
      })
    const real = Date.now()
    const put = async (name: string, text: string, agoMs: number) => {
      const f = join(live, name)
      await writeFile(f, text)
      const t = new Date(real - agoMs)
      await utimes(f, t, t)
    }
    await put('.tmp.100.sess-a.json', payload('sess-a', 10), 3 * H)
    await put('.tmp.100.latest.json', payload('sess-a', 10), 3 * H - 5) // copy of the one above
    await put('.tmp.101.sess-a.json', payload('sess-a', 10), 2 * H) // unchanged repeat
    await put('.tmp.102.sess-a.json', payload('sess-a', 12), 1 * H)
    await put('.tmp.103.sess-b.json', '{"session_id":"sess-b","cost":{"total_cost_usd":0}}', H)
    await put('.tmp.104.sess-c.json', '', H)
    await put('.tmp.105.sess-d.json', '{"session_id": "sess-d", "rate_lim', H) // torn: left alone
    await put('.tmp.106.sess-e.json', payload('sess-e', 3), 10_000) // may still be in use
    await put('notes.json', '{}', H) // not a temp file

    const before = limits.readings().length
    const res = await limits.salvageOrphans()
    expect(res).toMatchObject({ imported: 2, repeats: 2, deleted: 6, failed: 1 })
    expect(res.to! - res.from!).toBe(2 * H)
    expect((await readdir(live)).sort()).toEqual(
      expect.arrayContaining(['.tmp.105.sess-d.json', '.tmp.106.sess-e.json', 'notes.json'])
    )
    expect((await readdir(live)).filter((n) => n.startsWith('.tmp.'))).toHaveLength(2)
    const added = limits.readings().filter((r) => r.sessionId === 'sess-a')
    expect(added.map((r) => r.fiveHour?.pct)).toEqual([10, 12])
    expect(limits.readings().length).toBe(before + 2)

    // Running again (every start does) changes nothing.
    expect(await limits.salvageOrphans()).toMatchObject({ imported: 0, deleted: 0, failed: 1 })

    // Saved in the history: a fresh start loads them, in order.
    const again = new LimitsService(
      sessions,
      limits['usage'],
      installer,
      createBridgeStore(paths.dataDir),
      join(paths.dataDir, 'limits-history.ndjson'),
      paths.dataDir,
      limits['settings'],
      () => undefined
    )
    await again.start()
    again.stop()
    const ts = again.readings().map((r) => r.ts)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    expect(again.readings().filter((r) => r.sessionId === 'sess-a')).toHaveLength(2)
  })

  it('upgrades only a bridge script it recognises, and keeps one someone changed', async () => {
    const { installer, sessions } = await fixtureLimits()
    const script = join(envPaths(sessions.source('windows')!)!.bridgeDir, 'bin', 'statusline.ps1')
    const current = await readFile(script, 'utf8')
    expect(installer.record('windows')?.scriptSha256).toBe(sha256(current))

    // A script the app wrote earlier (its hash is on record) is replaced.
    const older = '# an older bridge script\r\n'
    installer['store'].update((d) => {
      d.installs.windows.scriptSha256 = sha256(older)
    })
    await writeFile(script, older)
    expect(await installer.refreshScripts(sessions.sources)).toEqual(['windows'])
    expect(await readFile(script, 'utf8')).toBe(current)
    expect(installer.record('windows')?.scriptSha256).toBe(sha256(current))
    expect(await installer.refreshScripts(sessions.sources)).toEqual([])

    // A script someone edited (a local workaround) is left exactly as it is.
    const mine = `${current}# my own tweak\r\n`
    await writeFile(script, mine)
    expect(await installer.refreshScripts(sessions.sources)).toEqual([])
    expect(await readFile(script, 'utf8')).toBe(mine)

    // Every script an earlier version shipped is recognised.
    expect(SHIPPED_SCRIPT_SHA256['statusline.ps1']).toHaveLength(1)
    expect(SHIPPED_SCRIPT_SHA256['statusline.sh']).toContain(
      sha256((await readFile(join(SCRIPTS_DIR, 'statusline.sh'), 'utf8')).replace(/\r\n/g, '\n'))
    )

    // Not installed for root: no script is written there.
    const root = envPaths(sessions.source('wsl-Ubuntu-root')!)!
    await expect(readFile(join(root.bridgeDir, 'bin', 'statusline.sh'))).rejects.toThrow()
  })

  it('never leaves its temp file behind when a bridge file cannot be replaced', async () => {
    const bin = join(root, 'home', '.claude-session-dashboard', 'bin')
    // A folder where the script should be: the rename can't replace it.
    await mkdir(join(bin, 'statusline.ps1', 'inside'), { recursive: true })
    await expect(writeBridgeFile(join(bin, 'statusline.ps1'), 'x')).rejects.toThrow()
    expect(await readdir(bin)).toEqual(['statusline.ps1'])
  })

  it('refuses to read or delete through a link into .claude', async () => {
    const { limits, sessions } = await fixtureLimits()
    const bridgeDir = envPaths(sessions.source('windows')!)!.bridgeDir
    const live = join(bridgeDir, 'live')
    await rm(live, { recursive: true, force: true })
    // live/ is a junction to a folder inside .claude.
    const inside = join(root, 'home', '.claude', 'projects', 'p')
    await mkdir(inside, { recursive: true })
    await symlink(inside, live, 'junction')
    const victim = join(inside, '.tmp.100.sess-a.json')
    await writeFile(victim, '')
    const t = new Date(Date.now() - H)
    await utimes(victim, t, t)
    expect(await limits.salvageOrphans()).toMatchObject({ imported: 0, deleted: 0 })
    expect(await readdir(inside)).toEqual(['.tmp.100.sess-a.json'])
    // A single temp file that is a link is skipped too.
    await rm(live)
    await mkdir(live)
    await symlink(victim, join(live, '.tmp.101.sess-a.json'), 'file').catch(() => undefined)
    await limits.salvageOrphans()
    expect(await readdir(inside)).toEqual(['.tmp.100.sess-a.json'])
  })

  it('keeps salvaged readings after a torn history line, and deletes nothing if saving fails', async () => {
    const { limits, sessions, installer, paths } = await fixtureLimits()
    const live = join(envPaths(sessions.source('windows')!)!.bridgeDir, 'live')
    await mkdir(live, { recursive: true })
    const put = async (name: string, pct: number) => {
      const f = join(live, name)
      await writeFile(
        f,
        JSON.stringify({
          session_id: 'sess-t',
          rate_limits: { five_hour: { used_percentage: pct, resets_at: FIXTURES_NOW / 1000 } }
        })
      )
      const t = new Date(Date.now() - H)
      await utimes(f, t, t)
    }
    const history = join(paths.dataDir, 'limits-history.ndjson')
    // The last line was cut off (power loss mid-append).
    await appendFile(history, '{"ts":1,"source":"windows","sess')
    await put('.tmp.200.sess-t.json', 20)
    expect(await limits.salvageOrphans()).toMatchObject({ imported: 1, deleted: 1 })
    const again = new LimitsService(
      sessions,
      limits['usage'],
      installer,
      createBridgeStore(paths.dataDir),
      history,
      paths.dataDir,
      limits['settings'],
      () => undefined
    )
    await again.start()
    again.stop()
    expect(again.readings().filter((r) => r.sessionId === 'sess-t')).toHaveLength(1)

    // The history can't be written: the temp file stays.
    await put('.tmp.201.sess-t.json', 30)
    const broken = new LimitsService(
      sessions,
      limits['usage'],
      installer,
      createBridgeStore(paths.dataDir),
      paths.dataDir, // a folder, not a file: appending fails
      paths.dataDir,
      limits['settings'],
      () => undefined
    )
    await expect(broken.salvageOrphans()).rejects.toThrow()
    expect(await readdir(live)).toContain('.tmp.201.sess-t.json')
  })

  it('imports a latest.json temp whose session copy is missing, and runs one salvage at a time', async () => {
    const { limits, sessions, paths } = await fixtureLimits()
    const live = join(envPaths(sessions.source('windows')!)!.bridgeDir, 'live')
    await mkdir(live, { recursive: true })
    const put = async (name: string, sid: string, pct: number) => {
      const f = join(live, name)
      await writeFile(
        f,
        JSON.stringify({
          session_id: sid,
          rate_limits: { five_hour: { used_percentage: pct, resets_at: FIXTURES_NOW / 1000 } }
        })
      )
      const t = new Date(Date.now() - H)
      await utimes(f, t, t)
    }
    // Only the latest.json copy survived for sess-l.
    await put('.tmp.300.latest.json', 'sess-l', 15)
    await put('.tmp.301.sess-m.json', 'sess-m', 16)
    // Startup and a manual rescan at the same moment.
    const [a, b] = await Promise.all([limits.salvageOrphans(), limits.salvageOrphans()])
    expect(a).toBe(b)
    expect(a).toMatchObject({ imported: 2, deleted: 2 })
    const rows = (await readFile(join(paths.dataDir, 'limits-history.ndjson'), 'utf8'))
      .split('\n')
      .filter((l) => l.includes('"sess-l"') || l.includes('"sess-m"'))
    expect(rows).toHaveLength(2)
  })
})
