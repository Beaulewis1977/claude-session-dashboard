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
  /** Different plan_types: separate sign-ins (default), or one account that changed plan. */
  accounts?: 'separate' | 'one'
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
  on(event: 'changed' | 'codex-progress', cb: () => void): unknown
}

/** A gauge for a window of any length (the 5-hour and 7-day ones use the shared gauge()). */
function windowGauge(
  r: CodexLimitReading,
  minutes: number,
  records: UsageRecord[],
  t: number,
  weights: CapacityWeights
): GaugeState | undefined {
  const w = r.windows.find((x) => canon(x.minutes) === minutes)
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
/** A window length with older Codex's 299 / 10079 counted as 300 / 10080. */
function canon(minutes: number): number {
  const k = windowKindOf(minutes)
  return k === 'five_hour' ? 300 : k === 'seven_day' ? 10_080 : minutes
}

/**
 * A reading as alerts know it: its session, time and numbers (not its id, which
 * an update of the parser can change, so a re-read never alerts again).
 */
function seenKey(r: CodexLimitReading): string {
  return [
    r.key,
    r.limitId,
    r.ts,
    r.windows.map((w) => `${w.pct}/${w.minutes}/${w.resetsAt ?? 0}`).join(';')
  ].join('|')
}

function latestByMinutes(
  readings: CodexLimitReading[],
  limitId: string
): Map<number, CodexLimitReading> {
  const out = new Map<number, CodexLimitReading>()
  for (const r of readings) {
    if (r.limitId !== limitId) continue
    for (const w of r.windows) {
      const m = canon(w.minutes)
      const cur = out.get(m)
      if (!cur || r.ts >= cur.ts) out.set(m, r)
    }
  }
  return out
}

/** Claude Code's pacing advice, in Codex's words. */
function codexAdvice(a: PaceAdvice | undefined): PaceAdvice | undefined {
  return a
    ? { ...a, text: a.text.replace('Open Claude Code', 'Send a message in Codex') }
    : undefined
}

export class CodexLimitsService extends EventEmitter<{ changed: [] }> {
  /** Readings already checked for alerts (a session scanned late still gets checked). */
  private seen = new Set<string>()
  /** Worked-out results for the same data, settings and minute (state() is asked for often). */
  private memo = new Map<string, unknown>()
  private memoKey = ''

  /** What the results depend on: the data, the settings and the clock (per 30 s). */
  private stamp(): string {
    const rs = this.usage.codexLimitReadings()
    const recs = this.usage.codexRecords()
    return [
      rs.length,
      rs[rs.length - 1]?.ts ?? 0,
      recs.length,
      recs[recs.length - 1]?.ts ?? 0,
      JSON.stringify(this.settings()),
      Math.floor(now() / 30_000)
    ].join('|')
  }

  private cached<T>(name: string, make: () => T): T {
    const key = this.stamp()
    if (key !== this.memoKey) {
      this.memo.clear()
      this.memoKey = key
    }
    if (!this.memo.has(name)) this.memo.set(name, make())
    return this.memo.get(name) as T
  }
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

  /**
   * Watch the usage data for new readings (alerts). Called once the saved
   * usage is loaded and before the logs are scanned: the readings saved then
   * were checked in an earlier run, and every one the scan finds after that
   * (also a crossing made while a long re-read runs) is checked.
   */
  start(): void {
    if (this.started) return
    this.started = true
    const rs = this.usage.codexLimitReadings()
    this.seen = new Set(rs.map(seenKey))
    this.usage.on('changed', () => this.onUsageChanged())
    // Also while a scan is still running (a long re-read takes minutes).
    this.usage.on('codex-progress', () => this.onUsageChanged())
  }

  readings(): CodexLimitReading[] {
    return this.usage.codexLimitReadings()
  }

  private onUsageChanged(): void {
    const rs = this.readings()
    const fresh = rs.filter((r) => !this.seen.has(seenKey(r)))
    if (!fresh.length) return
    for (const r of fresh) this.seen.add(seenKey(r))
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
          // The same limit of the same account (sign-ins never compare with each other).
          if (x.limitId !== r.limitId || (x.planType ?? '') !== (r.planType ?? '')) continue
          const pw = x.windows.find(
            (y) =>
              y.minutes === w.minutes && y.resetsAt && Math.abs(y.resetsAt - w.resetsAt!) < 120_000
          )
          if (pw) {
            prev = pw.pct
            break
          }
        }
        const base = `${r.limitId}:${r.planType ?? ''}:${w.minutes}:${Math.round(w.resetsAt / 60_000)}`
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
  /**
   * Which account's limits the gauges and limit health follow: the plan_type
   * of the newest main reading ("" when it reports none). Two ChatGPT
   * sign-ins on different plans can write into one Codex home; their
   * percentages are never mixed. auth.json is never read, so plan_type is the
   * only account marker (two accounts on the same plan look like one).
   */
  private account(): string {
    // One account: every plan_type is the same history.
    if (this.settings().accounts === 'one') return '*'
    // The newest reading that says its plan (one without it never resets the account).
    const rs = this.readings()
    for (let i = rs.length - 1; i >= 0; i--)
      if (rs[i].limitId === MAIN_LIMIT_ID && rs[i].planType) return rs[i].planType!
    return ''
  }

  /** The main limit's readings of the followed account. */
  private mainReadings(): CodexLimitReading[] {
    const acct = this.account()
    return this.readings().filter(
      (r) => r.limitId === MAIN_LIMIT_ID && (acct === '*' || (r.planType ?? '') === acct)
    )
  }

  /** Usage of the followed account (what moves its limits). */
  private accountRecords(): UsageRecord[] {
    const acct = this.account()
    const all = this.usage.codexRecords()
    if (acct === '*') return all
    // Logs that never report a plan: all of it.
    if (!acct) return all.filter((r) => !r.plan)
    return all.filter((r) => r.plan === acct)
  }

  /**
   * The plan the followed account is on now and since when: its newest plan,
   * since that plan was first seen in the latest run of it (one-account mode
   * can have several plans over time; a separate sign-in has one).
   */
  private currentPlan(): { code?: string; since: number } {
    const acct = this.account()
    const mine = this.mainReadings()
    const newest = [...mine].reverse().find((r) => r.planType)?.planType
    const code = acct === '*' ? newest : acct || undefined
    let since = 0
    if (code)
      for (let i = mine.length - 1; i >= 0; i--) {
        if (mine[i].planType && mine[i].planType !== code) break
        if (mine[i].planType === code) since = mine[i].ts
      }
    return { ...(code ? { code } : {}), since }
  }

  /**
   * The followed account's main readings under the plan it's on now: what
   * the gauges show. An earlier plan's windows (e.g. a 5-hour window the
   * current plan doesn't have) never show as current; limit health still
   * uses the whole history, each window at the multiplier of its plan.
   */
  private currentReadings(): CodexLimitReading[] {
    const { since } = this.currentPlan()
    const main = this.mainReadings()
    return since ? main.filter((r) => r.ts >= since) : main
  }

  /**
   * One account: when the plan in force now began, from every limit's
   * readings (a model limit, e.g. Spark, can report the new plan before the
   * main limit does): the first of the readings since the last one of
   * another plan.
   */
  private currentRunStart(): number {
    const { code } = this.currentPlan()
    if (!code) return 0
    const rs = this.readings()
    let since = 0
    for (let i = rs.length - 1; i >= 0; i--) {
      if (rs[i].planType && rs[i].planType !== code) break
      since = rs[i].ts
    }
    return since
  }

  /** Whether the plan in force now has a 5-hour window (it showed one lately). */
  private currentHasFiveHour(): boolean {
    const cur = this.currentReadings()
    const last = cur[cur.length - 1]
    return cur.some(
      (r) =>
        last.ts - r.ts < RECENT_LIMIT_MS &&
        r.windows.some((w) => windowKindOf(w.minutes) === 'five_hour')
    )
  }

  plan(): CodexPlanInfo {
    const s = this.settings()
    // Each plan once, by when it was first seen (accounts can alternate).
    const changes = detectPlanChanges(this.readings()).filter(
      (c, i, all) => all.findIndex((x) => x.code === c.code) === i
    )
    const mine = this.mainReadings()
    const { code, since } = this.currentPlan()
    const last = code ? { code, ts: since } : undefined
    const detected = last ? planOfCode(last.code) : undefined
    const newestAt = mine.length ? mine[mine.length - 1].ts : undefined
    const base = {
      setting: s.plan,
      changes,
      ...(last ? { detectedCode: last.code, detectedSince: last.ts } : {}),
      ...(newestAt !== undefined ? { detectedAt: newestAt } : {})
    }
    if (s.plan !== 'auto')
      return {
        ...base,
        plan: s.plan,
        label: CODEX_PLAN_LABEL[s.plan],
        mult: codexMult(s.plan, s.mults)
      }
    if (!last)
      return {
        ...base,
        plan: 'plus',
        label: 'Plus (no plan in the logs yet)',
        mult: codexMult('plus', s.mults)
      }
    return {
      ...base,
      ...(detected ? { plan: detected } : {}),
      label: codeLabel(last.code),
      mult: detected ? codexMult(detected, s.mults) : 1
    }
  }

  /** The followed account's plan (its readings all have one plan). */
  spans(): PlanSpan[] {
    const s = this.settings()
    const acct = this.account()
    // One account: its plan changes over time, each window at the multiplier of its plan.
    if (acct === '*') return codexPlanSpans(s.plan, detectPlanChanges(this.mainReadings()), s.mults)
    const first = this.mainReadings()[0]
    return codexPlanSpans(s.plan, acct && first ? [{ ts: first.ts, code: acct }] : [], s.mults)
  }

  private bridge() {
    return asBridgeReadings(this.mainReadings(), MAIN_LIMIT_ID)
  }

  health(kind: WindowKind): HealthReport {
    return this.cached(`health:${kind}`, () => this.healthNow(kind))
  }

  private healthNow(kind: WindowKind): HealthReport {
    const s = this.settings()
    return healthReport(bridgeWindowReadings(this.bridge(), kind), this.accountRecords(), {
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
    // Only the windows the plan in force now has (an earlier plan's 5-hour
    // baseline says nothing about a weekly-only plan).
    const kinds: WindowKind[] = this.currentHasFiveHour()
      ? ['five_hour', 'seven_day']
      : ['seven_day']
    for (const kind of kinds) {
      const h = this.health(kind)
      if (h.baseline) return { value: h.baseline.value * planAt(h.plans, now()).mult, kind }
    }
    return undefined
  }

  state(): CodexLimitsState {
    return this.cached('state', () => this.stateNow())
  }

  private stateNow(): CodexLimitsState {
    const s = this.settings()
    const t = now()
    const readings = this.readings()
    const records = this.accountRecords()
    // The gauges: the plan in force now only (see currentReadings).
    const main = this.currentReadings()
    const bridge = asBridgeReadings(main, MAIN_LIMIT_ID)
    const five = gauge(bridge, records, 'five_hour', t, s.weights)
    const week = gauge(bridge, records, 'seven_day', t, s.weights)
    const lastMain = main[main.length - 1]
    const fiveHourRecent = main.some(
      (r) =>
        t - r.ts < RECENT_LIMIT_MS && r.windows.some((w) => windowKindOf(w.minutes) === 'five_hour')
    )

    const otherWindows: CodexWindowGauge[] = []
    for (const [minutes, r] of latestByMinutes(main, MAIN_LIMIT_ID)) {
      if (windowKindOf(minutes)) continue
      const g = windowGauge(r, minutes, records, t, s.weights)
      if (g) otherWindows.push({ minutes, label: windowLabel(minutes), gauge: g })
    }

    const extraLimits: CodexLimitBucket[] = []
    const acct = this.account()
    // Model limits (e.g. Spark) per account too: a sign-in's percentages never
    // show under another's. One account: those from before the plan in force
    // now are the earlier plan's (never shown as current, never mixed in).
    const since = acct === '*' ? this.currentRunStart() : 0
    const groups = new Map<
      string,
      { id: string; plan?: string; earlier: boolean; rs: CodexLimitReading[] }
    >()
    for (const r of readings) {
      if (r.limitId === MAIN_LIMIT_ID) continue
      const plan = acct === '*' ? undefined : (r.planType ?? '')
      const earlier = r.ts < since
      const k = JSON.stringify([r.limitId, plan ?? null, earlier])
      let g = groups.get(k)
      if (!g)
        groups.set(
          k,
          (g = { id: r.limitId, ...(plan !== undefined ? { plan } : {}), earlier, rs: [] })
        )
      g.rs.push(r)
    }
    for (const { id, plan, earlier, rs } of groups.values()) {
      const latest = latestByMinutes(rs, id)
      const other = plan !== undefined && plan !== acct
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
        extraLimits.push({
          limitId: other ? `${id}@${plan || 'none'}` : earlier ? `${id}@earlier` : id,
          label: other
            ? `${label} · ${plan ? codeLabel(plan) : 'plan not reported'} · another sign-in or an earlier plan`
            : earlier
              ? `${label} · earlier plan`
              : label,
          windows,
          lastAt,
          // An earlier plan's is history: listed under "Other limits".
          recent: !earlier && t - lastAt < RECENT_LIMIT_MS
        })
    }
    // Another account's main limit (another plan_type in the same logs): its own gauges.
    const others = [
      ...new Set(readings.filter((r) => r.limitId === MAIN_LIMIT_ID).map((r) => r.planType ?? ''))
    ].filter((p) => acct !== '*' && p !== acct && p !== '')
    for (const p of others) {
      const rs = readings.filter((r) => r.limitId === MAIN_LIMIT_ID && (r.planType ?? '') === p)
      const windows: CodexWindowGauge[] = []
      for (const [minutes, r] of [...latestByMinutes(rs, MAIN_LIMIT_ID).entries()].sort(
        (a, b) => a[0] - b[0]
      )) {
        const g = windowGauge(r, minutes, [], t, s.weights)
        if (g) windows.push({ minutes, label: windowLabel(minutes), gauge: g })
      }
      const lastAt = rs[rs.length - 1].ts
      if (windows.length)
        extraLimits.push({
          limitId: `account:${p || 'none'}`,
          label: `${p ? codeLabel(p) : 'Plan not reported'} · another sign-in or an earlier plan`,
          windows,
          lastAt,
          recent: t - lastAt < RECENT_LIMIT_MS
        })
    }
    extraLimits.sort((a, b) => b.lastAt - a.lastAt)

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

    // Capacity changes with the plan: the plan in force now.
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
      readings: readings.length,
      models: [...new Set(records.map((r) => r.model))].sort()
    }
  }
}
