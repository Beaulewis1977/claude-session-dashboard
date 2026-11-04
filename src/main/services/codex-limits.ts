// Codex plan limits: gauges, pace, alerts, implied capacity and limit health,
// all from the `rate_limits` Codex writes into its rollouts (read by the
// usage service, see providers/codex/usage.ts), so the full history is there
// with no setup. Its plan, multipliers, baseline, normal dates and "used
// elsewhere" ranges are its own: never mixed with Claude Code's.

import { EventEmitter } from 'node:events'
import { now } from '@shared/clock'
import {
  asBridgeReadings,
  codexMult,
  codexPlanSpans,
  CODEX_PLAN_LABEL,
  codeLabel,
  detectPlanChanges,
  FIVE_HOUR_MINUTES,
  limitLabel,
  MAIN_LIMIT_ID,
  planOfCode,
  RECENT_LIMIT_MS,
  windowKindOf,
  windowLabel,
  type CodexLimitBucket,
  type CodexLimitReading,
  type CodexLimitsState,
  type CodexPlan,
  type CodexPlanInfo,
  type CodexPlanSetting,
  type CodexWindowGauge
} from '@shared/usage/codex'
import {
  crossedThresholds,
  detectCapacityChange,
  gauge,
  impliedCapacity,
  weightedTokens,
  type CapacityWeights,
  type GaugeState,
  type WindowKind
} from '@shared/usage/limits'
import {
  bridgeWindowReadings,
  compareHealth,
  healthReport,
  planAt,
  scoreWindows,
  splitWindow,
  type CompareRange,
  type ElsewhereRange,
  type HealthCompare,
  type HealthReport,
  type HealthSettings,
  type PlanSpan
} from '@shared/usage/health'
import { paceAdvice, paceOf, type PaceAdvice, type PaceSettings } from '@shared/usage/pace'
import type { ModelPrice } from '@shared/usage/pricing'
import type { UsageRecord } from '@shared/usage/types'
import type { UsageService } from './usage'

export interface CodexLimitsSettings {
  plan: CodexPlanSetting
  mults: Partial<Record<CodexPlan, number>>
  health: HealthSettings
  elsewhere: ElsewhereRange[]
  prices: ModelPrice[]
  pace: PaceSettings
  weights: CapacityWeights
  alertsEnabled: boolean
  alertThresholds: number[]
}

/** The newest reading this old or older counts as stale (as for Claude Code). */
const STALE_MS = 60 * 60_000
/** Alerts only for readings this recent (not for history read at startup). */
const ALERT_RECENT_MS = 30 * 60_000

type Pick2 = Pick<UsageService, 'codexRecords' | 'codexLimitReadings'> & {
  on(event: 'changed', cb: () => void): unknown
}

/** A gauge for a window of any length (the 5-hour and 7-day ones use the shared gauge()). */
function windowGauge(
  r: CodexLimitReading,
  minutes: number,
  records: UsageRecord[],
  t: number,
  weights: CapacityWeights
): GaugeState | undefined {
  const w = r.windows.find((x) => x.minutes === minutes)
  if (!w) return undefined
  const windowStart = w.resetsAt ? w.resetsAt - minutes * 60_000 : undefined
  const expired = !!w.resetsAt && t >= w.resetsAt
  let tokens = 0
  let weighted = 0
  if (windowStart !== undefined && !expired)
    for (const x of records) {
      if (x.ts < windowStart || x.ts > t) continue
      tokens += x.input + x.output + x.cacheWrite + x.cacheRead
      weighted += weightedTokens(x, weights)
    }
  return {
    kind: windowKindOf(minutes) ?? (minutes >= 1440 ? 'seven_day' : 'five_hour'),
    pct: expired ? 0 : w.pct,
    lastPct: w.pct,
    ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
    ...(windowStart !== undefined ? { windowStart } : {}),
    updatedAt: r.ts,
    expired,
    tokens,
    weighted,
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    source: r.source
  }
}

/** The newest reading of a limit per window length. */
function latestByMinutes(readings: CodexLimitReading[], limitId: string): Map<number, CodexLimitReading> {
  const out = new Map<number, CodexLimitReading>()
  for (const r of readings) {
    if (r.limitId !== limitId) continue
    for (const w of r.windows) {
      const cur = out.get(w.minutes)
      if (!cur || r.ts >= cur.ts) out.set(w.minutes, r)
    }
  }
  return out
}

/** Claude Code's pacing advice, in Codex's words. */
function codexAdvice(a: PaceAdvice | undefined): PaceAdvice | undefined {
  return a ? { ...a, text: a.text.replace('Open Claude Code', 'Send a message in Codex') } : undefined
}

export class CodexLimitsService extends EventEmitter<{ changed: [] }> {
  private lastSeen = 0
  private alerted = new Set<string>()
  private started = false

  constructor(
    private readonly usage: Pick2,
    private readonly settings: () => CodexLimitsSettings,
    private readonly notify: (title: string, body: string) => void,
    /** Source label of a session (CLI, VS Code, …), for the window split. */
    private readonly sourceOf: (key: string) => string = () => 'Codex'
  ) {
    super()
  }

  /** Watch the usage data for new readings (alerts) from now on. */
  start(): void {
    if (this.started) return
    this.started = true
    const rs = this.usage.codexLimitReadings()
    this.lastSeen = rs.length ? rs[rs.length - 1].ts : 0
    this.usage.on('changed', () => this.onUsageChanged())
  }

  readings(): CodexLimitReading[] {
    return this.usage.codexLimitReadings()
  }

  private onUsageChanged(): void {
    const rs = this.readings()
    const newest = rs.length ? rs[rs.length - 1].ts : 0
    if (newest <= this.lastSeen) return
    const fresh = rs.filter((r) => r.ts > this.lastSeen)
    this.lastSeen = newest
    this.checkAlerts(fresh, rs)
    this.emit('changed')
  }

  /** Desktop alerts when a window passes a threshold (75 / 90% by default). */
  private checkAlerts(fresh: CodexLimitReading[], all: CodexLimitReading[]): void {
    const s = this.settings()
    if (!s.alertsEnabled) return
    const t = now()
    for (const r of fresh) {
      if (t - r.ts > ALERT_RECENT_MS) continue
      for (const w of r.windows) {
        if (!w.resetsAt || w.resetsAt <= t) continue
        // The same window's reading just before this one.
        let prev: number | undefined
        for (let i = all.indexOf(r) - 1; i >= 0; i--) {
          const x = all[i]
          if (x.limitId !== r.limitId) continue
          const pw = x.windows.find(
            (y) => y.minutes === w.minutes && y.resetsAt && Math.abs(y.resetsAt - w.resetsAt!) < 120_000
          )
          if (pw) {
            prev = pw.pct
            break
          }
        }
        const base = `${r.limitId}:${w.minutes}:${Math.round(w.resetsAt / 60_000)}`
        const hit = crossedThresholds(prev, w.pct, s.alertThresholds).filter(
          (th) => !this.alerted.has(`${base}:${th}`)
        )
        if (!hit.length) continue
        for (const th of hit) this.alerted.add(`${base}:${th}`)
        const top = Math.max(...hit)
        const label = windowLabel(w.minutes)
        const name = r.limitId === MAIN_LIMIT_ID ? 'Codex' : `Codex · ${limitLabel(r)}`
        const reset = new Date(w.resetsAt).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
          ...(w.minutes >= 1440 ? { weekday: 'short' } : {})
        })
        this.notify(
          `${name} ${label.toLowerCase()}: ${Math.floor(w.pct)}% used`,
          `You've passed ${top}% of your Codex ${label.toLowerCase()} limit. It resets at ${reset}.`
        )
      }
    }
  }

  /** The plan: chosen in Settings, or detected from `plan_type` in the logs. */
  plan(): CodexPlanInfo {
    const s = this.settings()
    const changes = detectPlanChanges(this.readings())
    const last = changes[changes.length - 1]
    const detected = last ? planOfCode(last.code) : undefined
    let newestAt: number | undefined
    const rs = this.readings()
    for (let i = rs.length - 1; i >= 0; i--)
      if (rs[i].planType) {
        newestAt = rs[i].ts
        break
      }
    const base = {
      setting: s.plan,
      changes,
      ...(last ? { detectedCode: last.code, detectedSince: last.ts } : {}),
      ...(newestAt !== undefined ? { detectedAt: newestAt } : {})
    }
    if (s.plan !== 'auto')
      return { ...base, plan: s.plan, label: CODEX_PLAN_LABEL[s.plan], mult: codexMult(s.plan, s.mults) }
    if (!last) return { ...base, plan: 'plus', label: 'Plus (no plan in the logs yet)', mult: codexMult('plus', s.mults) }
    return {
      ...base,
      ...(detected ? { plan: detected } : {}),
      label: codeLabel(last.code),
      mult: detected ? codexMult(detected, s.mults) : 1
    }
  }

  spans(): PlanSpan[] {
    const s = this.settings()
    return codexPlanSpans(s.plan, detectPlanChanges(this.readings()), s.mults)
  }

  private bridge() {
    return asBridgeReadings(this.readings(), MAIN_LIMIT_ID)
  }

  health(kind: WindowKind): HealthReport {
    const s = this.settings()
    return healthReport(bridgeWindowReadings(this.bridge(), kind), this.usage.codexRecords(), {
      kind,
      prices: s.prices,
      now: now(),
      settings: s.health,
      planHistory: [],
      currentPlan: 'pro',
      elsewhere: s.elsewhere,
      spans: this.spans(),
      product: 'Codex'
    })
  }

  compare(kind: WindowKind, a: CompareRange, b: CompareRange): HealthCompare {
    return compareHealth(this.health(kind).windows, kind, a, b)
  }

  /**
   * $ per 1% at the plan in force now, from Codex's own baseline: the 5-hour
   * window's if there is one, else the weekly one (plans without a 5-hour window).
   */
  dollarsPerPct(): { value: number; kind: WindowKind } | undefined {
    for (const kind of ['five_hour', 'seven_day'] as WindowKind[]) {
      const h = this.health(kind)
      if (h.baseline) return { value: h.baseline.value * planAt(h.plans, now()).mult, kind }
    }
    return undefined
  }

  state(): CodexLimitsState {
    const s = this.settings()
    const t = now()
    const readings = this.readings()
    const records = this.usage.codexRecords()
    const bridge = this.bridge()
    const five = gauge(bridge, records, 'five_hour', t, s.weights)
    const week = gauge(bridge, records, 'seven_day', t, s.weights)
    const main = readings.filter((r) => r.limitId === MAIN_LIMIT_ID)
    const lastMain = main[main.length - 1]
    const fiveHourRecent = main.some(
      (r) => t - r.ts < RECENT_LIMIT_MS && r.windows.some((w) => w.minutes === FIVE_HOUR_MINUTES)
    )

    const otherWindows: CodexWindowGauge[] = []
    for (const [minutes, r] of latestByMinutes(readings, MAIN_LIMIT_ID)) {
      if (windowKindOf(minutes)) continue
      const g = windowGauge(r, minutes, records, t, s.weights)
      if (g) otherWindows.push({ minutes, label: windowLabel(minutes), gauge: g })
    }

    const extraLimits: CodexLimitBucket[] = []
    const ids = [...new Set(readings.map((r) => r.limitId))].filter((id) => id !== MAIN_LIMIT_ID)
    for (const id of ids) {
      const latest = latestByMinutes(readings, id)
      // The limit's own model, when its name says which (e.g. "GPT-5.3-Codex-Spark").
      const windows: CodexWindowGauge[] = []
      let lastAt = 0
      let label = id
      for (const [minutes, r] of [...latest.entries()].sort((a, b) => a[0] - b[0])) {
        const g = windowGauge(r, minutes, [], t, s.weights)
        if (g) windows.push({ minutes, label: windowLabel(minutes), gauge: g })
        if (r.ts > lastAt) {
          lastAt = r.ts
          label = limitLabel(r)
        }
      }
      if (windows.length)
        extraLimits.push({ limitId: id, label, windows, lastAt, recent: t - lastAt < RECENT_LIMIT_MS })
    }
    extraLimits.sort((a, b) => b.lastAt - a.lastAt)

    const health5h = this.health('five_hour')
    const health7d = this.health('seven_day')
    const pace5h =
      five && !five.expired ? paceOf({ pct: five.pct, resetsAt: five.resetsAt }, 'five_hour', t, s.pace) : undefined
    const pace7d =
      week && !week.expired ? paceOf({ pct: week.pct, resetsAt: week.resetsAt }, 'seven_day', t, s.pace) : undefined
    const spans = this.spans()
    const split = (kind: WindowKind, g: GaugeState | undefined, h: HealthReport) => {
      if (!g?.resetsAt || g.expired) return undefined
      const reads = bridgeWindowReadings(bridge, kind).filter(
        (r) => Math.abs(r.resetsAt - g.resetsAt!) < 3_600_000
      )
      const scored = scoreWindows(reads, records, {
        kind,
        prices: s.prices,
        now: t,
        settings: { ...s.health, minPct: 0 },
        planHistory: [],
        currentPlan: 'pro',
        elsewhere: s.elsewhere,
        spans,
        product: 'Codex',
        baseline: h.baseline ?? null
      })
      const w = scored.windows[scored.windows.length - 1]
      return w ? splitWindow(w, records, s.prices, this.sourceOf, () => true, false) : undefined
    }

    const cap5 = impliedCapacity(bridge, records, 'five_hour', s.weights)
    const cap7 = impliedCapacity(bridge, records, 'seven_day', s.weights)
    const hits = readings
      .filter((r) => r.reached)
      .map((r) => {
        let windowTokens = 0
        for (const x of records)
          if (x.ts <= r.ts && x.ts >= r.ts - 5 * 3_600_000)
            windowTokens += x.input + x.output + x.cacheWrite + x.cacheRead
        return {
          id: r.id,
          ts: r.ts,
          key: r.key,
          text: `Codex reported the limit was reached (${r.reached}${r.limitId !== MAIN_LIMIT_ID ? `, ${limitLabel(r)}` : ''})`,
          kind: 'other' as const,
          windowTokens
        }
      })
      .reverse()

    return {
      provider: 'codex',
      now: t,
      plan: this.plan(),
      hasData: readings.length > 0,
      ...(five ? { fiveHour: five } : {}),
      ...(week ? { sevenDay: week } : {}),
      fiveHourRecent,
      otherWindows,
      extraLimits,
      ...(lastMain ? { lastLimitAt: lastMain.ts } : {}),
      stale: !lastMain || t - lastMain.ts > STALE_MS,
      ...(lastMain?.credits ? { credits: { ...lastMain.credits, at: lastMain.ts } } : {}),
      health5h,
      health7d,
      ...(pace5h ? { pace5h } : {}),
      ...(pace7d ? { pace7d } : {}),
      ...(pace5h || pace7d ? { advice: codexAdvice(paceAdvice(pace5h, pace7d)) } : {}),
      ...(() => {
        const a = split('five_hour', five, health5h)
        const b = split('seven_day', week, health7d)
        return { ...(a ? { split5h: a } : {}), ...(b ? { split7d: b } : {}) }
      })(),
      capacity5h: cap5,
      capacity7d: cap7,
      ...(() => {
        const a = detectCapacityChange(cap5, t)
        const b = detectCapacityChange(cap7, t, { recentDays: 21, beforeDays: 42, minSamples: 2 })
        return { ...(a ? { change5h: a } : {}), ...(b ? { change7d: b } : {}) }
      })(),
      limitHits: hits,
      alertsEnabled: s.alertsEnabled,
      alertThresholds: [...s.alertThresholds],
      readings: readings.length
    }
  }
}
