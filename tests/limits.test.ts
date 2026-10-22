import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURES_NOW, setClockOffset } from '@shared/clock'
import type { BridgeReading } from '@shared/usage/bridge'
import {
  crossedThresholds,
  DEFAULT_WEIGHTS,
  detectCapacityChange,
  gauge,
  impliedCapacity,
  projectWindow,
  weightedTokens,
  type CapacityPoint
} from '@shared/usage/limits'
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
import { BridgeInstaller, createBridgeStore } from '../src/main/services/bridge'
import { LimitsService } from '../src/main/services/limits'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { UsageService, usagePaths } from '../src/main/services/usage'
import { FIXTURES } from './helpers'

const H = 3_600_000
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
    expect(later).toMatchObject({ pct: 0, expired: true })
    expect(gauge([], [], 'five_hour', T0, DEFAULT_WEIGHTS)).toBeUndefined()
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
  await rm(root, { recursive: true, force: true })
})

describe('LimitsService (fixtures)', () => {
  it('shows live gauges, detects the October limit cut and enables the WSL bridge', async () => {
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
        prices: DEFAULT_PRICES
      }),
      (t) => notes.push(t)
    )
    await limits.start()
    limits.stop()
    await seedFixtureBridge(paths.dataDir, sessions, installer)

    const s = await limits.state()
    expect(s.hasBridgeData).toBe(true)
    expect(s.fiveHour?.pct).toBeCloseTo(49.3)
    expect(s.fiveHour?.expired).toBe(false)
    expect(s.fiveHour?.tokens).toBeGreaterThan(1_000_000)
    expect(s.sevenDay?.pct).toBeCloseTo(48.6)
    expect(s.stale).toBe(false)
    expect(s.change5h?.flagged).toBe(true)
    expect(s.change5h?.changePct).toBeLessThan(-18)
    expect(s.change5h?.changePct).toBeGreaterThan(-32)
    expect(s.capacity5h.length).toBeGreaterThan(30)
    expect(s.limitHits.length).toBeGreaterThan(0)
    expect(s.envs.find((e) => e.sourceId === 'wsl-Ubuntu-beau')?.installed).toBe(true)
    expect(s.envs.find((e) => e.sourceId === 'windows')).toMatchObject({ installed: false })
    // API-billed fixture sessions are recognised from their payloads (cost, no rate_limits).
    const apiSession = limits.readings().find((r) => r.costUsd && !r.fiveHour)
    expect(apiSession && limits.billingOf(apiSession.sessionId!)).toBe('api')
    expect(notes).toEqual([]) // nothing over 75% right now
    await sessions.idle()
    await usage.idle()
  })
})
