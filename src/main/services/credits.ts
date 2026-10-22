// Credits tracker: grants vs. spending of API-billed sessions, plus the Admin
// API cost report as the authoritative figure when an Admin key exists.

import { now } from '@shared/clock'
import {
  spendFromReadings,
  spendFromRecords,
  summarizeCredits,
  type AdminSummary,
  type ApiSessionSpend,
  type CreditsState,
  type SpendEvent
} from '@shared/usage/credits'
import type { BridgeReading } from '@shared/usage/bridge'
import { estimateCost, type ModelPrice } from '@shared/usage/pricing'
import {
  bucketRange,
  dayKey,
  monthKey,
  startOfDayKey,
  weekKey,
  localTimeZone
} from '@shared/usage/time'
import type { WeekStart } from '@shared/usage/types'
import type { AccountsService } from './accounts'
import type { SessionService } from './sessions'
import type { UsageService } from './usage'

export interface CreditsDeps {
  accounts: AccountsService
  sessions: SessionService
  usage: UsageService
  readings: () => BridgeReading[]
  settings: () => { prices: ModelPrice[]; weekStart: WeekStart; defaultBilling: string }
}

export function creditsState(d: CreditsDeps): CreditsState {
  const t = now()
  const tz = localTimeZone()
  const s = d.settings()
  const accounts = d.accounts.list()
  const standard = accounts.filter((a) => a.kind === 'standard')
  const fallbackAccount =
    standard.find((a) => a.id === s.defaultBilling)?.id ?? standard[0]?.id ?? undefined

  const apiSessions = d.sessions.list().filter((x) => x.billing?.mode === 'api')
  const accountOf = new Map<string, string | undefined>()
  for (const x of apiSessions) accountOf.set(x.key, x.billing?.accountId ?? fallbackAccount)
  const keyBySessionId = new Map(apiSessions.map((x) => [x.sessionId, x.key]))

  const bridge = spendFromReadings(d.readings(), (r) => keyBySessionId.get(r.sessionId ?? ''))
  const withBridge = new Set(bridge.map((e) => e.sessionKey))
  const estimate = spendFromRecords(
    d.usage.allRecords(),
    new Set(apiSessions.map((x) => x.key).filter((k) => !withBridge.has(k))),
    s.prices
  )
  const events: SpendEvent[] = [...bridge, ...estimate]

  const weekStart = startOfDayKey(weekKey(t, tz, s.weekStart), tz)
  const monthStart = bucketRange(monthKey(t, tz), 'month', tz).start
  const grants = d.accounts.grants()
  const summaries = standard.map((a) =>
    summarizeCredits(
      a.id,
      grants,
      events.filter((e) => accountOf.get(e.sessionKey) === a.id),
      t,
      { weekStart, monthStart }
    )
  )

  const spendByKey = new Map<string, { usd: number; source: 'bridge' | 'estimate' }>()
  for (const e of events) {
    const cur = spendByKey.get(e.sessionKey) ?? { usd: 0, source: e.source }
    cur.usd += e.usd
    spendByKey.set(e.sessionKey, cur)
  }
  const sessionsOut: ApiSessionSpend[] = apiSessions
    .map((x) => ({
      key: x.key,
      title: x.title,
      accountId: accountOf.get(x.key),
      usd: spendByKey.get(x.key)?.usd ?? 0,
      source: spendByKey.get(x.key)?.source ?? 'estimate',
      lastActivityAt: x.lastActivityAt
    }))
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))

  const admin: AdminSummary[] = accounts
    .filter((a) => a.kind === 'admin')
    .map((a) => {
      const r = d.accounts.adminReport(a.id)
      const today = dayKey(t, 'UTC')
      const dayOf = (iso: string): string => iso.slice(0, 10)
      const weekFrom = new Date(weekStart).toISOString().slice(0, 10)
      const monthFrom = new Date(monthStart).toISOString().slice(0, 10)
      const byModel = new Map<string, { usd: number; tokens: number }>()
      const daily = new Map<string, { usd: number; tokens: number }>()
      let todayUsd = 0
      let weekUsd = 0
      let monthUsd = 0
      let monthTokens = 0
      for (const c of r?.costs ?? []) {
        const day = dayOf(c.date)
        if (day === today) todayUsd += c.usd
        if (day >= weekFrom) weekUsd += c.usd
        if (day >= monthFrom) {
          monthUsd += c.usd
          const m = byModel.get(c.model ?? 'other') ?? { usd: 0, tokens: 0 }
          m.usd += c.usd
          byModel.set(c.model ?? 'other', m)
        }
        const dd = daily.get(day) ?? { usd: 0, tokens: 0 }
        dd.usd += c.usd
        daily.set(day, dd)
      }
      for (const u of r?.usage ?? []) {
        const day = dayOf(u.date)
        const tokens = u.input + u.output + u.cacheWrite + u.cacheRead
        const dd = daily.get(day) ?? { usd: 0, tokens: 0 }
        dd.tokens += tokens
        daily.set(day, dd)
        if (day >= monthFrom) {
          monthTokens += tokens
          const m = byModel.get(u.model) ?? { usd: 0, tokens: 0 }
          m.tokens += tokens
          byModel.set(u.model, m)
        }
      }
      // Without a cost report, fall back to the price table for the usage report.
      if (r && !r.costs.length && r.usage.length) {
        for (const u of r.usage) {
          const usd = estimateCost({ ...u, model: u.model }, s.prices)
          if (dayOf(u.date) >= monthFrom) monthUsd += usd
        }
      }
      return {
        accountId: a.id,
        nickname: a.nickname,
        fetchedAt: r?.fetchedAt,
        error: r?.error,
        sample: r?.sample,
        todayUsd,
        weekUsd,
        monthUsd,
        monthTokens,
        byModel: [...byModel.entries()]
          .map(([model, v]) => ({ model, ...v }))
          .sort((x, y) => y.usd - x.usd),
        daily: [...daily.entries()]
          .map(([date, v]) => ({ date, ...v }))
          .sort((x, y) => x.date.localeCompare(y.date))
      }
    })

  return {
    encryptionAvailable: d.accounts.encryptionAvailable(),
    accounts,
    summaries,
    admin,
    apiSessions: sessionsOut
  }
}
