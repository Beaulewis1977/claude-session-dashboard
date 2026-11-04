// Codex usage & limits settings (Phase C), with their defaults. They're
// optional in the settings file (absent in every file written before them)
// and never shared with Claude Code's plan, baseline or price table.

import type { AppSettings, MeterProvider, UsageSplit } from '../types'
import {
  sanitizeCodexMults,
  sanitizeCodexPlan,
  type CodexPlan,
  type CodexPlanSetting
} from './codex'
import {
  DEFAULT_HEALTH,
  sanitizeElsewhere,
  sanitizeHealth,
  type ElsewhereRange,
  type HealthSettings
} from './health'
import { DEFAULT_CODEX_PRICES, sanitizePrices, type ModelPrice } from './pricing'

export interface CodexUsageSettings {
  codexPlan: CodexPlanSetting
  codexPlanMults: Partial<Record<CodexPlan, number>>
  codexHealth: HealthSettings
  codexElsewhere: ElsewhereRange[]
  codexPrices: ModelPrice[]
  meterProvider: MeterProvider
  usageSplit: UsageSplit
}

export function isMeterProvider(v: unknown): v is MeterProvider {
  return v === 'claude' || v === 'codex' || v === 'both'
}

export function isUsageSplit(v: unknown): v is UsageSplit {
  return v === 'stacked' || v === 'split'
}

/**
 * Snapshot rows for models a saved table doesn't have yet are added (a newer
 * snapshot's models); rows already there, edited or not, are kept as they are.
 */
export function withSnapshotModels(saved: ModelPrice[], snapshot: ModelPrice[]): ModelPrice[] {
  const have = new Set(saved.map((p) => p.model.toLowerCase()))
  return [
    ...saved,
    ...snapshot.filter((p) => !have.has(p.model.toLowerCase())).map((p) => ({ ...p }))
  ]
}

export function codexUsageSettings(s: Partial<AppSettings>): CodexUsageSettings {
  const prices = sanitizePrices(s.codexPrices)
  return {
    codexPlan: sanitizeCodexPlan(s.codexPlan) ?? 'auto',
    codexPlanMults: sanitizeCodexMults(s.codexPlanMults) ?? {},
    codexHealth: s.codexHealth ? sanitizeHealth(s.codexHealth) : { ...DEFAULT_HEALTH },
    codexElsewhere: sanitizeElsewhere(s.codexElsewhere),
    codexPrices: prices
      ? withSnapshotModels(prices, DEFAULT_CODEX_PRICES)
      : DEFAULT_CODEX_PRICES.map((p) => ({ ...p })),
    meterProvider: isMeterProvider(s.meterProvider) ? s.meterProvider : 'claude',
    usageSplit: isUsageSplit(s.usageSplit) ? s.usageSplit : 'stacked'
  }
}

/** A settings patch's Codex usage keys, cleaned (only the keys it has). */
export function codexSettingsPatch(
  p: Partial<AppSettings>,
  cur: Partial<AppSettings>
): Partial<AppSettings> {
  const out: Partial<AppSettings> = {}
  if ('codexPlan' in p) {
    const v = sanitizeCodexPlan(p.codexPlan)
    if (v) out.codexPlan = v
  }
  if ('codexPlanMults' in p)
    out.codexPlanMults = {
      ...(sanitizeCodexMults(cur.codexPlanMults) ?? {}),
      ...(sanitizeCodexMults(p.codexPlanMults) ?? {})
    }
  if ('codexHealth' in p)
    out.codexHealth = sanitizeHealth({
      ...(cur.codexHealth ?? DEFAULT_HEALTH),
      ...((p.codexHealth ?? {}) as object)
    })
  if ('codexElsewhere' in p) out.codexElsewhere = sanitizeElsewhere(p.codexElsewhere)
  if ('codexPrices' in p) {
    const v = sanitizePrices(p.codexPrices)
    if (v) out.codexPrices = v
  }
  if (isMeterProvider(p.meterProvider)) out.meterProvider = p.meterProvider
  if (isUsageSplit(p.usageSplit)) out.usageSplit = p.usageSplit
  return out
}
