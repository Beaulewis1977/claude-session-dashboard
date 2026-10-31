// Live limits: reads what the status line bridge saved in each Claude home's
// `.claude-session-dashboard/live/` folder, keeps every reading forever in
// `limits-history.ndjson`, and turns them into gauges, projections, alerts
// and the implied-capacity history.

import { EventEmitter } from 'node:events'
import { lstat, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { clockOffset, now } from '@shared/clock'
import { fiveHourBlocks } from '@shared/usage/aggregate'
import {
  hasLimits,
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
  type Plan,
  weeklyBuckets
} from '@shared/usage/limits'
import type { ModelPrice } from '@shared/usage/pricing'
import {
  bridgeWindowReadings,
  compareHealth,
  healthReport,
  splitWindow,
  scoreWindows,
  type CompareRange,
  type ElsewhereRange,
  type HealthCompare,
  type HealthReport,
  type HealthSettings,
  type PlanChange,
  type WindowReading
} from '@shared/usage/health'
import { paceAdvice, paceOf, type PaceSettings } from '@shared/usage/pace'
import type { WindowKind } from '@shared/usage/limits'
import type { JsonStore } from '../core/json-store'
import { appendNdjson, readNdjson } from '../core/ndjson'
import { assertExactBridgeLive, assertRealBridgeWrite } from '../core/safe-paths'
import { envPaths, type BridgeFile, type BridgeInstaller } from './bridge'
import type { SessionService } from './sessions'
import type { UsageService } from './usage'

export interface LimitsSettings {
  plan: Plan
  alertsEnabled: boolean
  alertThresholds: number[]
  weights: CapacityWeights
  prices: ModelPrice[]
  health: HealthSettings
  planHistory: PlanChange[]
  pace: PaceSettings
  elsewhere: ElsewhereRange[]
}

const STALE_MS = 60 * 60_000
const isUnc = (p: string): boolean => /^[\\/]{2}/.test(p)

/** A temp file the bridge script left in live/: `.tmp.<pid>.<name>.json`. */
const ORPHAN_RE = /^\.tmp\.\d+\.(.+\.json)$/
/** Younger temp files may still be in use by a running bridge script. */
const ORPHAN_MIN_AGE_MS = 2 * 60_000
/** A reading's identity in the history: source, session and time. */
const keyOf = (r: BridgeReading): string => `${r.source}|${r.sessionId ?? ''}|${r.ts}`

export interface SalvageResult {
  /** Readings added to the limit history. */
  imported: number
  /** Readings with limits already in the history, unchanged repeats, or latest.json copies. */
  repeats: number
  /** Temp files deleted (imported, repeats, empty or without limits). */
  deleted: number
  /** Temp files left in place because they couldn't be read or parsed. */
  failed: number
  /** Time range of the imported readings, epoch ms. */
  from?: number
  to?: number
}

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
      undefined,
    /** Source label of a session (Terminal, VS Code, …), for the window split. */
    private readonly sourceOf: (key: string) => string = () => 'This computer'
  ) {
    super()
  }

  async start(): Promise<void> {
    const loaded = (await readNdjson<BridgeReading>(this.historyFile)).filter(
      (r) => r && typeof r.ts === 'number' && typeof r.source === 'string'
    )
    // Salvaged readings are appended after newer ones, so the file isn't in order.
    for (const r of loaded.sort((a, b) => a.ts - b.ts)) {
      this.add(r)
      this.saved.add(keyOf(r))
    }
    const salvaged = await this.salvageOrphans().catch((err) => {
      console.warn('could not salvage bridge temp files', err)
      return undefined
    })
    if (salvaged && (salvaged.imported || salvaged.deleted || salvaged.failed))
      console.info('bridge temp files salvaged', salvaged)
    await this.scan()
    this.timer = setInterval(() => void this.scan(), 5000)
  }

  /**
   * The Windows bridge script used to fail to replace a session's saved
   * payload, so every update after the first stayed behind as
   * `.tmp.<pid>.<name>.json` in live/, with the real limit data in it. Import
   * the readings with limits into the history (dedupe by session + time, and
   * unchanged repeats), then delete the temp files that were imported, were
   * repeats, or had no limits. Files that can't be read or parsed are left
   * alone. Only the app's own temp files in a real bridge folder are ever
   * deleted: links and junctions are followed and checked first.
   *
   * Single flight: the startup salvage and a manual rescan share one run, so
   * the same file is never imported twice.
   */
  salvageOrphans(): Promise<SalvageResult> {
    this.salvaging ??= this.salvageNow().finally(() => {
      this.salvaging = undefined
    })
    return this.salvaging
  }

  private salvaging: Promise<SalvageResult> | undefined
  /** Readings known to be in the history file (see keyOf). */
  private saved = new Set<string>()
  /** Readings in memory whose append failed; saved again on the next scan. */
  private unsaved: BridgeReading[] = []

  /** Append to the history file; only then are the readings known to be saved. */
  private async persist(rows: BridgeReading[]): Promise<void> {
    await appendNdjson(this.historyFile, rows, this.dataDir)
    for (const r of rows) this.saved.add(keyOf(r))
  }

  private async salvageNow(): Promise<SalvageResult> {
    const res: SalvageResult = { imported: 0, repeats: 0, deleted: 0, failed: 0 }
    /** `needs`: the reading that must be saved on disk before the file may go. */
    type Handled = { live: string; file: string; mtimeMs: number; needs?: BridgeReading }
    const done: Handled[] = []
    const found: (Handled & { r: BridgeReading })[] = []
    const homes = new Map<string, string>()
    for (const src of this.sessions.sources) {
      if (src.status !== 'ok') continue
      const p = envPaths(src)
      if (!p) continue
      const live = join(p.bridgeDir, 'live')
      let names: string[]
      try {
        // With links followed, exactly this home's live folder (outside .claude).
        await assertExactBridgeLive(live, p.home)
        names = await readdir(live)
      } catch {
        continue
      }
      homes.set(live, p.home)
      for (const n of names) {
        if (!ORPHAN_RE.test(n)) continue
        const file = join(live, n)
        let text: string
        let mtimeMs: number
        try {
          const st = await lstat(file)
          if (!st.isFile()) continue
          mtimeMs = st.mtimeMs
          if (Date.now() - mtimeMs < ORPHAN_MIN_AGE_MS) continue
          text = await readFile(file, 'utf8')
        } catch {
          res.failed++
          continue
        }
        const h = { live, file, mtimeMs }
        if (!text.trim()) {
          done.push(h)
          continue
        }
        const r = parseBridgePayload(text, {
          ts: Math.round(mtimeMs + clockOffset()),
          source: src.id
        })
        if (!r) res.failed++
        else if (!hasLimits(r)) done.push(h)
        // latest.json temps too: the session's own save may have failed while
        // this copy survived. A copy of a session temp is an unchanged repeat.
        else found.push({ ...h, r })
      }
    }
    const seen = new Map(this.history.map((r) => [keyOf(r), r]))
    const batchPrev = new Map<string, BridgeReading>()
    const fresh: BridgeReading[] = []
    for (const f of found.sort((a, b) => a.r.ts - b.r.ts)) {
      const { r } = f
      const sid = `${r.source}|${r.sessionId ?? ''}`
      // The reading just before this one, from the history or this batch.
      const fromHistory = this.readingBefore(r)
      const fromBatch = batchPrev.get(sid)
      const prev =
        fromBatch && (!fromHistory || fromBatch.ts >= fromHistory.ts) ? fromBatch : fromHistory
      const match = seen.get(keyOf(r)) ?? (sameLimits(prev, r) ? prev : undefined)
      // A repeat stands for the reading it repeats (the one that gets saved).
      batchPrev.set(sid, match ?? r)
      if (match) {
        res.repeats++
        // Deleted only once that reading is on disk, not just in memory.
        done.push({ ...f, needs: match })
        continue
      }
      seen.set(keyOf(r), r)
      fresh.push(r)
      done.push({ ...f, needs: r })
    }
    if (fresh.length) {
      // Saved first: a temp file is only deleted once its reading is in the history.
      await this.persist(fresh)
      for (const r of fresh) this.add(r)
      this.history.sort((a, b) => a.ts - b.ts)
      for (const list of this.bySession.values()) list.sort((a, b) => a.ts - b.ts)
      res.imported = fresh.length
      res.from = fresh[0].ts
      res.to = fresh[fresh.length - 1].ts
    }
    const checked = new Map<string, boolean>()
    for (const { live, file, mtimeMs, needs } of done) {
      try {
        // Its reading (or the one it repeats) must be saved on disk.
        if (needs && !this.saved.has(keyOf(needs))) continue
        // Check the folder again right before deleting (it could have been
        // swapped for a link meanwhile), and skip a file that changed since it was read.
        if (!checked.has(live)) {
          checked.set(
            live,
            await assertExactBridgeLive(live, homes.get(live)!).then(
              () => true,
              () => false
            )
          )
        }
        if (!checked.get(live) || !ORPHAN_RE.test(basename(file))) continue
        await assertRealBridgeWrite(file)
        const st = await lstat(file)
        if (!st.isFile() || st.mtimeMs !== mtimeMs) continue
        await unlink(file)
        res.deleted++
      } catch {
        // Gone already, or not ours to delete.
      }
    }
    if (fresh.length) this.emit('changed')
    return res
  }

  /** The newest reading of the same session (or source) that is older than `r`. */
  private readingBefore(r: BridgeReading): BridgeReading | undefined {
    const list = r.sessionId
      ? (this.bySession.get(r.sessionId) ?? [])
      : this.history.filter((x) => !x.sessionId)
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i].ts < r.ts && list[i].source === r.source) return list[i]
    return undefined
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

  /** When the bridge folders were last checked. */
  lastScanAt: number | undefined

  /** Check every Claude home's live folder for new payloads (`full`: re-read every file). */
  async scan(full = false): Promise<void> {
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
        const due = full || (this.lastFullScan.get(live) ?? 0) + fullEvery < Date.now()
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
      this.lastScanAt = Date.now()
    }
    if (!fresh.length && !this.unsaved.length) return
    fresh.sort((a, b) => a.ts - b.ts)
    for (const r of fresh) {
      this.checkAlerts(r)
      this.add(r)
    }
    this.history.sort((a, b) => a.ts - b.ts)
    // Readings whose save failed earlier go along, so none stays memory-only.
    const toSave = [...this.unsaved, ...fresh]
    this.unsaved = []
    await this.persist(toSave).catch((err) => {
      this.unsaved = [...toSave, ...this.unsaved]
      console.warn('could not save limit readings; will retry', err)
    })
    if (fresh.length) this.emit('changed')
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

  /** Bridge readings plus /usage readings from old transcripts, for one window kind. */
  windowReadings(kind: WindowKind): WindowReading[] {
    const out = bridgeWindowReadings(this.history, kind)
    for (const r of this.usage.usageCommandReadings())
      if (r.kind === kind && r.resetsAt)
        out.push({ ts: r.ts, pct: r.pct, resetsAt: r.resetsAt, from: 'usage-command' })
    return out
  }

  health(kind: WindowKind): HealthReport {
    const s = this.settings()
    return healthReport(this.windowReadings(kind), this.usage.allRecords(), {
      kind,
      prices: s.prices,
      now: now(),
      settings: s.health,
      planHistory: s.planHistory,
      currentPlan: s.plan,
      elsewhere: s.elsewhere,
      isSubscription: this.isSubscription
    })
  }

  compare(kind: WindowKind, a: CompareRange, b: CompareRange): HealthCompare {
    return compareHealth(this.health(kind).windows, kind, a, b)
  }

  async state(): Promise<LimitsState> {
    const s = this.settings()
    const t = now()
    const records = this.usage.allRecords()
    const readings = this.history
    const five = gauge(readings, records, 'five_hour', t, s.weights, this.isSubscription)
    const week = gauge(readings, records, 'seven_day', t, s.weights, this.isSubscription)
    const lastReadingAt = readings.length ? readings[readings.length - 1].ts : undefined
    const lastLimitReading = [...readings].reverse().find(hasLimits)

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

    const health5h = this.health('five_hour')
    const health7d = this.health('seven_day')
    const pace5h =
      five && !five.expired
        ? paceOf({ pct: five.pct, resetsAt: five.resetsAt }, 'five_hour', t, s.pace)
        : undefined
    const pace7d =
      week && !week.expired
        ? paceOf({ pct: week.pct, resetsAt: week.resetsAt }, 'seven_day', t, s.pace)
        : undefined
    const split = (kind: WindowKind, g: typeof five, h: HealthReport) => {
      if (!g?.resetsAt || g.expired) return undefined
      const reads = this.windowReadings(kind).filter(
        (r) => Math.abs(r.resetsAt - g.resetsAt!) < 3_600_000
      )
      const scored = scoreWindows(reads, records, {
        kind,
        prices: s.prices,
        now: t,
        settings: { ...s.health, minPct: 0 },
        planHistory: s.planHistory,
        currentPlan: s.plan,
        elsewhere: s.elsewhere,
        isSubscription: this.isSubscription,
        // The long-run baseline, not one from this window alone.
        baseline: h.baseline ?? null
      })
      const w = scored.windows[scored.windows.length - 1]
      if (!w) return undefined
      return splitWindow(
        w,
        records,
        s.prices,
        this.sourceOf,
        this.isSubscription,
        s.health.familyPricing
      )
    }

    return {
      plan: s.plan,
      now: t,
      health5h,
      health7d,
      pace5h,
      pace7d,
      advice: paceAdvice(pace5h, pace7d),
      split5h: split('five_hour', five, health5h),
      split7d: split('seven_day', week, health7d),
      backfilled: this.usage.usageCommandReadings().length,
      hasBridgeData: !!lastLimitReading,
      fiveHour: five,
      sevenDay: week,
      lastReadingAt,
      lastLimitAt: lastLimitReading?.ts,
      weeklyBuckets: weeklyBuckets(readings, t),
      lastScanAt: this.lastScanAt === undefined ? undefined : this.lastScanAt + clockOffset(),
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
