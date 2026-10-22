// API keys, credit grants and how fast they're being spent.
//
// There is no API for a remaining credit balance, so grants are entered by
// hand. Spending comes from the status line bridge (`cost.total_cost_usd` of
// API-billed sessions) or, when that's missing, from the price table × the
// tokens in the session logs.

import type { BridgeReading } from './bridge'
import { estimateCost, type ModelPrice } from './pricing'
import type { UsageRecord } from './types'

export type AccountKind = 'standard' | 'admin'

/** An API key as the renderer sees it: never the key itself. */
export interface Account {
  id: string
  nickname: string
  kind: AccountKind
  /** e.g. "sk-ant-api03-…Q7xA". */
  masked: string
  createdAt: string
  /** Sample account in fixtures mode (no real key stored). */
  sample?: boolean
}

export interface CreditGrant {
  id: string
  accountId: string
  amountUsd: number
  /** ISO date. */
  receivedAt: string
  expiresAt?: string
  note?: string
}

export type BillingMode = 'subscription' | 'api'

/** How a session is billed, as tagged at launch or inferred from the bridge. */
export interface SessionBilling {
  mode: BillingMode | 'unknown'
  accountId?: string
  /** Where the answer came from. */
  source: 'launch' | 'manual' | 'bridge' | 'none'
}

export interface SpendEvent {
  ts: number
  usd: number
  sessionKey: string
  source: 'bridge' | 'estimate'
}

export interface GrantStatus extends CreditGrant {
  spent: number
  remaining: number
  expired: boolean
  /** Unspent amount lost to expiry. */
  lost: number
  expiresSoon: boolean
}

export interface CreditsSummary {
  accountId: string
  granted: number
  spent: number
  remaining: number
  /** Spending not covered by any grant (billed to your card, or a missing grant). */
  uncovered: number
  lost: number
  spentThisWeek: number
  spentThisMonth: number
  /** Average USD per day over the last 14 days. */
  burnPerDay: number
  /** Days until the remaining credits run out at this pace. */
  daysLeft?: number
  grants: GrantStatus[]
  /** Daily spend for the last 30 days, oldest first. */
  spark: number[]
  bySource: { bridge: number; estimate: number }
  sessions: number
}

const DAY = 86_400_000
const KEY_RE = /^sk-ant-(api|admin)\d*-[A-Za-z0-9_-]{8,}$/

export function keyKind(key: string): AccountKind | undefined {
  const m = KEY_RE.exec(key.trim())
  if (!m) return undefined
  return m[1] === 'admin' ? 'admin' : 'standard'
}

/** "sk-ant-api03-abc…xyz" → "sk-ant-api03-…wxyz". Shows only the prefix and the last 4. */
export function maskKey(key: string): string {
  const k = key.trim()
  const m = /^(sk-ant-[a-z]+\d*-)/.exec(k)
  const prefix = m ? m[1] : k.slice(0, 7)
  return `${prefix}…${k.slice(-4)}`
}

/**
 * Turn bridge readings (cumulative session cost) into spend increments. A
 * cost that goes down means Claude Code started counting again (e.g. /clear).
 */
export function spendFromReadings(
  readings: BridgeReading[],
  keyOf: (r: BridgeReading) => string | undefined
): SpendEvent[] {
  const bySession = new Map<string, BridgeReading[]>()
  for (const r of readings) {
    if (r.costUsd === undefined || !r.sessionId) continue
    const k = keyOf(r)
    if (!k) continue
    let list = bySession.get(k)
    if (!list) bySession.set(k, (list = []))
    list.push(r)
  }
  const out: SpendEvent[] = []
  for (const [sessionKey, list] of bySession) {
    list.sort((a, b) => a.ts - b.ts)
    let last = 0
    for (const r of list) {
      const c = r.costUsd!
      const delta = c >= last ? c - last : c
      last = c
      if (delta > 0) out.push({ ts: r.ts, usd: delta, sessionKey, source: 'bridge' })
    }
  }
  return out
}

/** Price-table estimate for sessions the bridge never reported a cost for. */
export function spendFromRecords(
  records: UsageRecord[],
  sessionKeys: Set<string>,
  prices: ModelPrice[]
): SpendEvent[] {
  return records
    .filter((r) => sessionKeys.has(r.key))
    .map((r) => ({
      ts: r.ts,
      usd: estimateCost(r, prices),
      sessionKey: r.key,
      source: 'estimate' as const
    }))
}

const t = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const v = Date.parse(iso)
  return Number.isFinite(v) ? v : undefined
}

/**
 * Apply spending to grants in time order. Each dollar comes from the active
 * grant (received, not yet expired) that expires first; grants without an
 * expiry are used last. Spending with no active grant is "uncovered".
 */
export function summarizeCredits(
  accountId: string,
  grants: CreditGrant[],
  events: SpendEvent[],
  now: number,
  opts: { weekStart: number; monthStart: number; soonDays?: number } = {
    weekStart: now - 7 * DAY,
    monthStart: now - 30 * DAY
  }
): CreditsSummary {
  const gs = grants
    .filter((g) => g.accountId === accountId)
    .map((g) => ({
      g,
      left: Math.max(0, g.amountUsd),
      from: t(g.receivedAt) ?? 0,
      until: t(g.expiresAt) ?? Infinity
    }))
  const evs = [...events].sort((a, b) => a.ts - b.ts)
  let uncovered = 0
  for (const e of evs) {
    let need = e.usd
    const active = gs
      .filter((x) => x.left > 0 && x.from <= e.ts && e.ts < x.until)
      .sort((a, b) => a.until - b.until || a.from - b.from)
    for (const x of active) {
      if (need <= 0) break
      const take = Math.min(x.left, need)
      x.left -= take
      need -= take
    }
    uncovered += need
  }
  const soon = (opts.soonDays ?? 14) * DAY
  const statuses: GrantStatus[] = gs.map((x) => {
    const expired = now >= x.until
    return {
      ...x.g,
      spent: x.g.amountUsd - x.left,
      remaining: expired ? 0 : x.left,
      expired,
      lost: expired ? x.left : 0,
      expiresSoon: !expired && x.left > 0.005 && x.until - now <= soon
    }
  })
  const sum = (from: number): number =>
    evs.filter((e) => e.ts >= from && e.ts <= now).reduce((a, e) => a + e.usd, 0)
  const spent = evs.filter((e) => e.ts <= now).reduce((a, e) => a + e.usd, 0)
  const burnPerDay = sum(now - 14 * DAY) / 14
  const remaining = statuses.reduce((a, g) => a + g.remaining, 0)
  const spark = new Array<number>(30).fill(0)
  for (const e of evs) {
    const i = 29 - Math.floor((now - e.ts) / DAY)
    if (i >= 0 && i < 30) spark[i] += e.usd
  }
  return {
    accountId,
    granted: statuses.reduce((a, g) => a + g.amountUsd, 0),
    spent,
    remaining,
    uncovered,
    lost: statuses.reduce((a, g) => a + g.lost, 0),
    spentThisWeek: sum(opts.weekStart),
    spentThisMonth: sum(opts.monthStart),
    burnPerDay,
    daysLeft: burnPerDay > 0 ? remaining / burnPerDay : undefined,
    grants: statuses.sort((a, b) => (t(b.receivedAt) ?? 0) - (t(a.receivedAt) ?? 0)),
    spark,
    bySource: {
      bridge: evs.filter((e) => e.source === 'bridge').reduce((a, e) => a + e.usd, 0),
      estimate: evs.filter((e) => e.source === 'estimate').reduce((a, e) => a + e.usd, 0)
    },
    sessions: new Set(evs.map((e) => e.sessionKey)).size
  }
}

export function sanitizeGrant(v: unknown): Omit<CreditGrant, 'id'> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const amount = typeof o.amountUsd === 'number' && Number.isFinite(o.amountUsd) ? o.amountUsd : NaN
  const received = typeof o.receivedAt === 'string' ? t(o.receivedAt) : undefined
  const expires = typeof o.expiresAt === 'string' && o.expiresAt ? t(o.expiresAt) : undefined
  if (!(amount > 0 && amount < 1e7) || received === undefined || typeof o.accountId !== 'string')
    return undefined
  if (typeof o.expiresAt === 'string' && o.expiresAt && expires === undefined) return undefined
  return {
    accountId: o.accountId,
    amountUsd: Math.round(amount * 100) / 100,
    receivedAt: new Date(received).toISOString(),
    expiresAt: expires !== undefined ? new Date(expires).toISOString() : undefined,
    note: typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 120) : undefined
  }
}

// ---------------------------------------------------- Admin API reports

export interface AdminDay {
  /** Bucket start, ISO. */
  date: string
  model: string
  apiKeyId?: string | null
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface AdminCostDay {
  date: string
  model?: string
  description?: string
  usd: number
}

export interface AdminReport {
  accountId: string
  fetchedAt: number
  from: string
  to: string
  usage: AdminDay[]
  costs: AdminCostDay[]
  error?: string
  sample?: boolean
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() && Number.isFinite(Number(v))
      ? Number(v)
      : 0
}

function bucketsOf(json: unknown): { starting_at?: unknown; results?: unknown }[] {
  const d = (json as Record<string, unknown> | undefined)?.data
  return Array.isArray(d) ? (d as { starting_at?: unknown; results?: unknown }[]) : []
}

/** Parse `/v1/organizations/usage_report/messages` pages. */
export function parseUsageReport(pages: unknown[]): AdminDay[] {
  const out: AdminDay[] = []
  for (const page of pages) {
    for (const b of bucketsOf(page)) {
      const date = typeof b.starting_at === 'string' ? b.starting_at : undefined
      if (!date || !Array.isArray(b.results)) continue
      for (const r of b.results as Record<string, unknown>[]) {
        const cc = (r.cache_creation ?? {}) as Record<string, unknown>
        out.push({
          date,
          model: typeof r.model === 'string' ? r.model : 'unknown',
          apiKeyId: typeof r.api_key_id === 'string' ? r.api_key_id : null,
          input: num(r.uncached_input_tokens),
          output: num(r.output_tokens),
          cacheWrite: num(cc.ephemeral_5m_input_tokens) + num(cc.ephemeral_1h_input_tokens),
          cacheRead: num(r.cache_read_input_tokens)
        })
      }
    }
  }
  return out
}

/** Parse `/v1/organizations/cost_report` pages. Amounts are decimal strings in cents. */
export function parseCostReport(pages: unknown[]): AdminCostDay[] {
  const out: AdminCostDay[] = []
  for (const page of pages) {
    for (const b of bucketsOf(page)) {
      const date = typeof b.starting_at === 'string' ? b.starting_at : undefined
      if (!date || !Array.isArray(b.results)) continue
      for (const r of b.results as Record<string, unknown>[]) {
        if (typeof r.currency === 'string' && r.currency !== 'USD') continue
        out.push({
          date,
          model: typeof r.model === 'string' ? r.model : undefined,
          description: typeof r.description === 'string' ? r.description : undefined,
          usd: num(r.amount) / 100
        })
      }
    }
  }
  return out
}

// ---------------------------------------------------------- UI state

export interface AdminSummary {
  accountId: string
  nickname: string
  fetchedAt?: number
  error?: string
  sample?: boolean
  todayUsd: number
  weekUsd: number
  monthUsd: number
  monthTokens: number
  byModel: { model: string; usd: number; tokens: number }[]
  daily: { date: string; usd: number; tokens: number }[]
}

export interface ApiSessionSpend {
  key: string
  title: string
  accountId?: string
  usd: number
  source: 'bridge' | 'estimate'
  lastActivityAt?: string
}

export interface CreditsState {
  encryptionAvailable: boolean
  accounts: Account[]
  summaries: CreditsSummary[]
  admin: AdminSummary[]
  apiSessions: ApiSessionSpend[]
}
