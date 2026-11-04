// Codex's limits in small places: the tray icon, the status bar and the mini meter.

import { freshnessOf, lastKnown, type GaugeState } from '@shared/usage/limits'
import type { CodexLimitsState } from '@shared/usage/codex'

/** A plain-text line for tooltips: "Codex weekly: 23%" (or why there's no current %). */
export function codexGaugeLine(label: string, g: GaugeState | undefined, t: number): string {
  if (!g) return `${label}: no data`
  if (freshnessOf(g, t) === 'stale') return `${label}: no recent reading (${lastKnown(g, t)})`
  return `${label}: ${Math.round(g.pct)}%`
}

/** The gauge that stands for Codex in small places (tray, status bar): 5-hour if current, else weekly. */
export function codexMainGauge(
  codex: CodexLimitsState | null,
  t: number
): { g: GaugeState; label: string } | undefined {
  if (!codex) return undefined
  const five = codex.fiveHour
  if (five && codex.fiveHourRecent && freshnessOf(five, t) !== 'stale')
    return { g: five, label: '5h' }
  if (codex.sevenDay) return { g: codex.sevenDay, label: 'Wk' }
  return five ? { g: five, label: '5h' } : undefined
}
