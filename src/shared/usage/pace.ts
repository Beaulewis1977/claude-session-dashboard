// Pacing for the 5-hour and weekly windows, following claude-usage-pacer's
// method (MIT, see THIRD_PARTY_NOTICES) on the status line bridge's numbers:
// the target is `cap × elapsed ÷ window length`, and usage within `tolerance`
// points of it is on pace. The weekly window is the main limit.

import type { LimitWindow } from './bridge'
import { FIVE_HOURS, SEVEN_DAYS, type WindowKind } from './limits'

export type PaceStatus = 'behind' | 'on-pace' | 'ahead' | 'at-cap' | 'reset'

export interface PaceSettings {
  /** Target ceiling, percent. */
  cap: number
  /** ± band around the pace line that counts as on pace, in points. */
  tolerance: number
}

export const DEFAULT_PACE: PaceSettings = { cap: 90, tolerance: 5 }

export function sanitizePace(v: unknown): PaceSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const n = (x: unknown, d: number, lo: number, hi: number): number =>
    typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : d
  return {
    cap: n(o.cap, DEFAULT_PACE.cap, 10, 100),
    tolerance: n(o.tolerance, DEFAULT_PACE.tolerance, 0, 50)
  }
}

export interface PaceState {
  kind: WindowKind
  used: number
  cap: number
  /** Where usage "should" be now: cap × elapsed ÷ length. */
  target: number
  status: PaceStatus
  /** Share of the window that has passed, 0–1. */
  elapsed: number
  leftMs: number
  /** Points per hour you can still use and end at the cap. */
  roomPerHour: number
}

export function paceOf(
  w: LimitWindow | undefined,
  kind: WindowKind,
  now: number,
  s: PaceSettings = DEFAULT_PACE
): PaceState | undefined {
  if (!w?.resetsAt) return undefined
  const length = kind === 'five_hour' ? FIVE_HOURS : SEVEN_DAYS
  const leftMs = Math.max(0, w.resetsAt - now)
  if (leftMs === 0) {
    return {
      kind,
      used: w.pct,
      cap: s.cap,
      target: 0,
      status: 'reset',
      elapsed: 1,
      leftMs: 0,
      roomPerHour: 0
    }
  }
  const elapsed = Math.min(1, Math.max(0, (length - leftMs) / length))
  const target = s.cap * elapsed
  const status: PaceStatus =
    w.pct >= s.cap
      ? 'at-cap'
      : w.pct > target + s.tolerance
        ? 'ahead'
        : w.pct < target - s.tolerance
          ? 'behind'
          : 'on-pace'
  return {
    kind,
    used: w.pct,
    cap: s.cap,
    target,
    status,
    elapsed,
    leftMs,
    roomPerHour: Math.max(0, (s.cap - w.pct) / (leftMs / 3_600_000))
  }
}

export const PACE_LABEL: Record<PaceStatus, string> = {
  behind: 'Behind',
  'on-pace': 'On pace',
  ahead: 'Ahead',
  'at-cap': 'At cap',
  reset: 'Reset'
}

export interface PaceAdvice {
  tone: 'calm' | 'warn'
  text: string
}

/** One line of advice. The weekly window decides first: never let the 5-hour window push it over. */
export function paceAdvice(five?: PaceState, week?: PaceState): PaceAdvice | undefined {
  if (!five && !week) return undefined
  const wk = week?.status
  const fh = five?.status
  if (wk === 'at-cap')
    return {
      tone: 'warn',
      text: 'Weekly cap reached. Keep to essential work until the week resets.'
    }
  if (wk === 'ahead')
    return {
      tone: 'warn',
      text: 'Ahead of your weekly pace. Slow down, even if the 5-hour window has room.'
    }
  if (fh === 'at-cap')
    return { tone: 'warn', text: '5-hour cap reached. Pick up again after the window resets.' }
  if (fh === 'ahead')
    return { tone: 'warn', text: 'Ahead of your 5-hour pace. Pause or stagger a parallel task.' }
  if (wk === 'reset' || fh === 'reset')
    return { tone: 'calm', text: 'A window just reset. Open Claude Code to refresh the numbers.' }
  if (wk === 'behind' && (fh === 'behind' || fh === undefined))
    return { tone: 'calm', text: 'Behind pace: there is room to spare this week.' }
  return { tone: 'calm', text: 'On pace. Keep your current workload.' }
}
