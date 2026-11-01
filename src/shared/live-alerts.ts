// Alerts for "Running now": which state changes deserve a notification, and
// whether one may be shown now (quiet hours, muted sessions, a cooldown).
// Pure, so the rules can be tested.

import type { PushKind } from './mobile'
import type { LiveSession } from './live'

export type AlertKind = Exclude<PushKind, 'test'>

export interface QuietHours {
  enabled: boolean
  /** Local time "HH:MM". May wrap past midnight (22:00 → 07:00). */
  from: string
  to: string
  /** Approvals still alert during quiet hours (a session is blocked until I answer). */
  allowApprovals: boolean
}

export interface LiveAlertSettings {
  /** Alert when a session needs approval (a permission prompt or a question). */
  approval: boolean
  /** When a session finishes its turn (worked, now waiting for my next message). */
  finished: boolean
  /** When a turn ends with an error. */
  failed: boolean
  /** Claude Code's own "still waiting for your input" reminder (after a minute idle). */
  waiting: boolean
  /** When a session's process ends. */
  exited: boolean
  /** Desktop notifications (Windows toasts). */
  desktop: boolean
  /** Push alerts to phones that turned them on (Settings on each phone). */
  phone: boolean
  /** "Finished" only after it worked at least this long (seconds), so quick replies don't ping. */
  minWorkSec: number
  quiet: QuietHours
}

export const DEFAULT_LIVE_ALERTS: LiveAlertSettings = {
  approval: true,
  finished: true,
  failed: true,
  waiting: false,
  exited: false,
  desktop: true,
  phone: true,
  minWorkSec: 20,
  quiet: { enabled: false, from: '22:00', to: '07:00', allowApprovals: false }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function sanitizeLiveAlerts(v: unknown, base = DEFAULT_LIVE_ALERTS): LiveAlertSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const b = (k: keyof LiveAlertSettings): boolean =>
    typeof o[k] === 'boolean' ? (o[k] as boolean) : (base[k] as boolean)
  const q = (o.quiet && typeof o.quiet === 'object' ? o.quiet : {}) as Record<string, unknown>
  const min = Number(o.minWorkSec)
  return {
    approval: b('approval'),
    finished: b('finished'),
    failed: b('failed'),
    waiting: b('waiting'),
    exited: b('exited'),
    desktop: b('desktop'),
    phone: b('phone'),
    minWorkSec:
      Number.isFinite(min) && min >= 0 ? Math.min(3600, Math.round(min)) : base.minWorkSec,
    quiet: {
      enabled: typeof q.enabled === 'boolean' ? q.enabled : base.quiet.enabled,
      from: typeof q.from === 'string' && HHMM.test(q.from) ? q.from : base.quiet.from,
      to: typeof q.to === 'string' && HHMM.test(q.to) ? q.to : base.quiet.to,
      allowApprovals:
        typeof q.allowApprovals === 'boolean' ? q.allowApprovals : base.quiet.allowApprovals
    }
  }
}

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Is local time `at` inside the quiet hours? (Equal from/to = never.) */
export function inQuietHours(q: QuietHours, at: Date): boolean {
  if (!q.enabled) return false
  const from = minutes(q.from)
  const to = minutes(q.to)
  if (from === to) return false
  const m = at.getHours() * 60 + at.getMinutes()
  return from < to ? m >= from && m < to : m >= from || m < to
}

export interface Alert {
  key: string
  kind: AlertKind
  /** When the change happened, epoch ms. */
  at: number
  session: LiveSession
}

/**
 * The alerts between two polls. A session seen for the first time only
 * alerts for an approval (it may have started waiting while the app was
 * closed: that's still worth knowing); the very first poll is a baseline.
 * `idlePrompts` lists sessions that just got Claude Code's own
 * "waiting for your input" reminder.
 */
export function detectAlerts(
  prev: ReadonlyMap<string, LiveSession> | undefined,
  next: readonly LiveSession[],
  idlePrompts: ReadonlySet<string> = new Set()
): Alert[] {
  if (!prev) return []
  const out: Alert[] = []
  for (const s of next) {
    const p = prev.get(s.key)
    const add = (kind: AlertKind): void => {
      out.push({ key: s.key, kind, at: s.since, session: s })
    }
    if (s.state === 'approval') {
      if (p?.state !== 'approval') add('approval')
      continue
    }
    if (!p) continue
    if (s.state === 'idle' && p.state === 'working') {
      add(s.failed ? 'failed' : 'finished')
      continue
    }
    if (s.state === 'exited' && p.state !== 'exited') {
      add(s.failed ? 'failed' : 'exited')
      continue
    }
    if (s.state === 'idle' && idlePrompts.has(s.key)) add('waiting')
  }
  return out
}

export interface AlertContext {
  now: number
  /** Muted sessions (per-session mute, a metadata flag). */
  muted: (key: string) => boolean
  /** When this session last started working (for minWorkSec). */
  workedSince?: (key: string) => number | undefined
  /** When an alert of this kind was last shown for this session. */
  lastShown?: (key: string, kind: AlertKind) => number | undefined
  /** Local time, for quiet hours (tests pass a fixed one). */
  localTime?: (now: number) => Date
}

export const ALERT_COOLDOWN_MS = 60_000

export type AlertVerdict =
  | { show: true; desktop: boolean; phone: boolean }
  | { show: false; why: 'off' | 'muted' | 'quiet' | 'short' | 'repeat' | 'no-channel' }

/** May this alert be shown now, and where? */
export function alertVerdict(a: Alert, s: LiveAlertSettings, ctx: AlertContext): AlertVerdict {
  if (!s[a.kind]) return { show: false, why: 'off' }
  if (ctx.muted(a.key)) return { show: false, why: 'muted' }
  if (a.kind === 'finished' && s.minWorkSec > 0) {
    const from = ctx.workedSince?.(a.key)
    if (from !== undefined && a.at - from < s.minWorkSec * 1000)
      return { show: false, why: 'short' }
  }
  const last = ctx.lastShown?.(a.key, a.kind)
  if (last !== undefined && ctx.now - last < ALERT_COOLDOWN_MS)
    return { show: false, why: 'repeat' }
  const local = (ctx.localTime ?? ((n: number) => new Date(n)))(ctx.now)
  if (inQuietHours(s.quiet, local) && !(a.kind === 'approval' && s.quiet.allowApprovals))
    return { show: false, why: 'quiet' }
  if (!s.desktop && !s.phone) return { show: false, why: 'no-channel' }
  return { show: true, desktop: s.desktop, phone: s.phone }
}

/** A desktop notification's text. On the PC itself it may name the session. */
export function desktopText(a: Alert, title: string): { title: string; body: string } {
  const d = a.session.detail
  switch (a.kind) {
    case 'approval':
      return { title: 'Needs your approval', body: d ? `${title}: ${d}` : title }
    case 'finished':
      return { title: 'Finished', body: `${title} is waiting for your next message` }
    case 'failed':
      return { title: 'Stopped with an error', body: d ? `${title}: ${d}` : title }
    case 'waiting':
      return { title: 'Waiting for you', body: title }
    case 'exited':
      return { title: 'Session ended', body: title }
  }
}
