// Live limits: reads what the status line bridge saved in each Claude home's
// `.claude-session-dashboard/live/` folder, keeps every reading forever in
// `limits-history.ndjson`, and turns them into gauges, projections, alerts
// and the implied-capacity history.

import { EventEmitter } from 'node:events'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { clockOffset, now } from '@shared/clock'
import { fiveHourBlocks } from '@shared/usage/aggregate'
import {
  inferBilling,
  parseBridgePayload,
  sameLimits,
  type BillingGuess,
  type BridgeReading
} from '@shared/usage/bridge'
import {
  crossedThresholds,
  detectCapacityChange,
  gauge,
  impliedCapacity,
  type CapacityWeights,
  type LimitsState,
  type Plan
} from '@shared/usage/limits'
import type { ModelPrice } from '@shared/usage/pricing'
import type { JsonStore } from '../core/json-store'
import { appendNdjson, readNdjson } from '../core/ndjson'
import { envPaths, type BridgeFile, type BridgeInstaller } from './bridge'
import type { SessionService } from './sessions'
import type { UsageService } from './usage'

export interface LimitsSettings {
  plan: Plan
  alertsEnabled: boolean
  alertThresholds: number[]
  weights: CapacityWeights
  prices: ModelPrice[]
}

const STALE_MS = 60 * 60_000
const isUnc = (p: string): boolean => /^[\\/]{2}/.test(p)

export class LimitsService extends EventEmitter<{ changed: [] }> {
  private history: BridgeReading[] = []
  private bySession = new Map<string, BridgeReading[]>()
  private latestByFile = new Map<string, number>()
  private lastFullScan = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  private scanning = false

  constructor(
    private readonly sessions: SessionService,
    private readonly usage: UsageService,
    private readonly installer: BridgeInstaller,
    private readonly bridgeStore: JsonStore<BridgeFile>,
    private readonly historyFile: string,
    private readonly dataDir: string,
    private readonly settings: () => LimitsSettings,
    private readonly notify: (title: string, body: string) => void,
    /** Sessions the app knows are billed to an API key. */
    private readonly billingOverride: (key: string) => 'subscription' | 'api' | undefined = () =>
      undefined
  ) {
    super()
  }

  async start(): Promise<void> {
    for (const r of await readNdjson<BridgeReading>(this.historyFile)) {
      if (r && typeof r.ts === 'number' && typeof r.source === 'string') this.add(r)
    }
    await this.scan()
    this.timer = setInterval(() => void this.scan(), 5000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  readings(): BridgeReading[] {
    return this.history
  }

  /** Billing guess for a session (by session id) from what the bridge saw. */
  billingOf(sessionId: string): BillingGuess {
    return inferBilling(this.bySession.get(sessionId) ?? [])
  }

  /** Latest context-window % per session id. */
  contextBySession(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [sid, list] of this.bySession) {
      const last = [...list].reverse().find((r) => r.contextPct !== undefined)
      if (last?.contextPct !== undefined) out.set(sid, last.contextPct)
    }
    return out
  }

  private add(r: BridgeReading): void {
    this.history.push(r)
    if (r.sessionId) {
      let list = this.bySession.get(r.sessionId)
      if (!list) this.bySession.set(r.sessionId, (list = []))
      list.push(r)
    }
  }

  private lastFor(r: BridgeReading): BridgeReading | undefined {
    if (r.sessionId) {
      const list = this.bySession.get(r.sessionId)
      return list?.[list.length - 1]
    }
    for (let i = this.history.length - 1; i >= 0; i--)
      if (this.history[i].source === r.source && !this.history[i].sessionId) return this.history[i]
    return undefined
  }

  /** Check every Claude home's live folder for new payloads. */
  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    const fresh: BridgeReading[] = []
    try {
      for (const src of this.sessions.sources) {
        if (src.status !== 'ok') continue
        const p = envPaths(src)
        if (!p) continue
        const live = join(p.bridgeDir, 'live')
        const latest = join(live, 'latest.json')
        let st
        try {
          st = await stat(latest)
        } catch {
          continue
        }
        const known = this.latestByFile.get(latest)
        const fullEvery = isUnc(live) ? 5 * 60_000 : 60_000
        const due = (this.lastFullScan.get(live) ?? 0) + fullEvery < Date.now()
        if (known === st.mtimeMs && !due) continue
        this.latestByFile.set(latest, st.mtimeMs)
        // latest.json is a copy of the newest session file; read session files
        // that changed (all of them on a periodic full scan).
        let names: string[] = []
        try {
          names = (await readdir(live)).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
        } catch {
          continue
        }
        if (due) this.lastFullScan.set(live, Date.now())
        for (const n of names) {
          const f = join(live, n)
          let fst
          try {
            fst = await stat(f)
          } catch {
            continue
          }
          if (this.latestByFile.get(f) === fst.mtimeMs && n !== 'latest.json') continue
          this.latestByFile.set(f, fst.mtimeMs)
          let text: string
          try {
            text = await readFile(f, 'utf8')
          } catch {
            continue
          }
          const r = parseBridgePayload(text, {
            ts: Math.round(fst.mtimeMs + clockOffset()),
            source: src.id
          })
          if (!r || (n === 'latest.json' && r.sessionId)) continue
          if (sameLimits(this.lastFor(r), r)) continue
          if (this.lastFor(r) && this.lastFor(r)!.ts >= r.ts) continue
          fresh.push(r)
        }
      }
    } finally {
      this.scanning = false
    }
    if (!fresh.length) return
    fresh.sort((a, b) => a.ts - b.ts)
    for (const r of fresh) {
      this.checkAlerts(r)
      this.add(r)
    }
    this.history.sort((a, b) => a.ts - b.ts)
    await appendNdjson(this.historyFile, fresh, this.dataDir).catch((err) =>
      console.warn('could not save limit readings', err)
    )
    this.emit('changed')
  }

  private checkAlerts(r: BridgeReading): void {
    const s = this.settings()
    if (!s.alertsEnabled) return
    const windows: ['five_hour' | 'seven_day', string][] = [
      ['five_hour', '5-hour window'],
      ['seven_day', 'Weekly limit']
    ]
    for (const [kind, label] of windows) {
      const w = kind === 'five_hour' ? r.fiveHour : r.sevenDay
      if (!w?.resetsAt || w.resetsAt <= now()) continue
      const key = `${kind}:${Math.round(w.resetsAt / 60_000)}`
      const done = this.bridgeStore.value.alerted[key] ?? []
      const hit = crossedThresholds(undefined, w.pct, s.alertThresholds).filter(
        (t) => !done.includes(t)
      )
      if (!hit.length) continue
      const top = Math.max(...hit)
      this.bridgeStore.update((d) => {
        d.alerted[key] = [...done, ...hit]
      })
      const reset = new Date(w.resetsAt).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        ...(kind === 'seven_day' ? { weekday: 'short' } : {})
      })
      this.notify(
        `${label}: ${Math.floor(w.pct)}% used`,
        `You've passed ${top}% of your ${kind === 'five_hour' ? '5-hour' : 'weekly'} limit. It resets at ${reset}.`
      )
    }
  }

  private isSubscription = (key: string): boolean => {
    const o = this.billingOverride(key)
    if (o) return o === 'subscription'
    const sid = key.split(':').pop() ?? key
    return this.billingOf(sid) !== 'api'
  }

  async state(): Promise<LimitsState> {
    const s = this.settings()
    const t = now()
    const records = this.usage.allRecords()
    const readings = this.history
    const five = gauge(readings, records, 'five_hour', t, s.weights, this.isSubscription)
    const week = gauge(readings, records, 'seven_day', t, s.weights, this.isSubscription)
    const lastReadingAt = readings.length ? readings[readings.length - 1].ts : undefined
    const lastLimitReading = [...readings].reverse().find((r) => r.fiveHour || r.sevenDay)

    const lastBySource = new Map<string, number>()
    for (const r of readings) lastBySource.set(r.source, r.ts)
    const envs = []
    for (const src of this.sessions.sources) {
      const e = await this.installer.describe(src, lastBySource.get(src.id))
      if (e) envs.push(e)
    }

    const recent = records.filter((r) => r.ts >= t - 2 * 86_400_000 && this.isSubscription(r.key))
    const blocks = fiveHourBlocks(recent, t, s.prices)
    const block = blocks.find((b) => b.active) ?? undefined

    const cap5 = impliedCapacity(readings, records, 'five_hour', s.weights, {
      isSubscription: this.isSubscription
    })
    const cap7 = impliedCapacity(readings, records, 'seven_day', s.weights, {
      isSubscription: this.isSubscription
    })

    const allBlocks = fiveHourBlocks(records, t, s.prices)
    const hits = this.usage.limitHits().map((h) => {
      const b = allBlocks.find((x) => h.ts >= x.start && h.ts < x.end + 60_000)
      return { ...h, windowTokens: b?.total ?? 0 }
    })

    return {
      plan: s.plan,
      now: t,
      hasBridgeData: !!lastLimitReading,
      fiveHour: five,
      sevenDay: week,
      lastReadingAt,
      stale: !lastLimitReading || t - lastLimitReading.ts > STALE_MS,
      envs,
      block,
      capacity5h: cap5,
      capacity7d: cap7,
      change5h: detectCapacityChange(cap5, t),
      change7d: detectCapacityChange(cap7, t, { recentDays: 21, beforeDays: 42, minSamples: 2 }),
      limitHits: hits.reverse(),
      alertsEnabled: s.alertsEnabled,
      alertThresholds: s.alertThresholds,
      weights: s.weights
    }
  }
}
