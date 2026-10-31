// Running now alerts: which changes alert, quiet hours, mutes, cooldowns, and
// what desktop and push alerts say.

import { describe, expect, it } from 'vitest'
import type { LiveSession } from '@shared/live'
import {
  alertVerdict,
  ALERT_COOLDOWN_MS,
  DEFAULT_LIVE_ALERTS,
  desktopText,
  detectAlerts,
  inQuietHours,
  sanitizeLiveAlerts,
  type Alert,
  type AlertContext
} from '@shared/live-alerts'
import { PUSH_TEXT } from '@shared/mobile'

const NOW = 2_000_000_000_000

function s(
  key: string,
  state: LiveSession['state'],
  extra: Partial<LiveSession> = {}
): LiveSession {
  return {
    key,
    sessionId: key,
    sourceId: 'windows',
    env: 'windows',
    state,
    since: NOW,
    lastSeenAt: NOW,
    basis: 'status',
    ...extra
  }
}

const map = (...xs: LiveSession[]) => new Map(xs.map((x) => [x.key, x]))

describe('detectAlerts', () => {
  it('the first poll is a baseline', () => {
    expect(detectAlerts(undefined, [s('a', 'approval')])).toEqual([])
  })

  it('alerts on approval, finished, failed and exits', () => {
    const prev = map(
      s('a', 'working'),
      s('b', 'working'),
      s('c', 'idle'),
      s('d', 'working'),
      s('e', 'idle')
    )
    const next = [
      s('a', 'approval'),
      s('b', 'idle'),
      s('c', 'exited'),
      s('d', 'idle', { failed: true }),
      s('e', 'idle'),
      // New, and already waiting for approval.
      s('f', 'approval'),
      // New and working: nothing to say yet.
      s('g', 'working')
    ]
    expect(detectAlerts(prev, next).map((a) => `${a.key}:${a.kind}`)).toEqual([
      'a:approval',
      'b:finished',
      'c:exited',
      'd:failed',
      'f:approval'
    ])
  })

  it('does not repeat an approval that is still waiting, and knows Claude Code’s reminder', () => {
    expect(detectAlerts(map(s('a', 'approval')), [s('a', 'approval')])).toEqual([])
    expect(detectAlerts(map(s('a', 'idle')), [s('a', 'idle')], new Set(['a']))[0].kind).toBe(
      'waiting'
    )
  })
})

describe('alertVerdict', () => {
  const base: AlertContext = {
    now: NOW,
    muted: () => false,
    localTime: () => new Date(2026, 9, 31, 14, 0)
  }
  const a = (kind: Alert['kind'], at = NOW): Alert => ({
    key: 'k',
    kind,
    at,
    session: s('k', 'idle')
  })

  it('respects the event switches and per-session mutes', () => {
    expect(alertVerdict(a('approval'), DEFAULT_LIVE_ALERTS, base)).toEqual({
      show: true,
      desktop: true,
      phone: true
    })
    expect(alertVerdict(a('exited'), DEFAULT_LIVE_ALERTS, base)).toEqual({
      show: false,
      why: 'off'
    })
    expect(alertVerdict(a('waiting'), DEFAULT_LIVE_ALERTS, base)).toEqual({
      show: false,
      why: 'off'
    })
    expect(
      alertVerdict(a('approval'), DEFAULT_LIVE_ALERTS, { ...base, muted: () => true })
    ).toEqual({ show: false, why: 'muted' })
    const deskOnly = { ...DEFAULT_LIVE_ALERTS, phone: false }
    expect(alertVerdict(a('approval'), deskOnly, base)).toEqual({
      show: true,
      desktop: true,
      phone: false
    })
    expect(alertVerdict(a('approval'), { ...deskOnly, desktop: false }, base)).toEqual({
      show: false,
      why: 'no-channel'
    })
  })

  it('skips quick turns and repeats', () => {
    const quick = { ...base, workedSince: () => NOW - 5000 }
    expect(alertVerdict(a('finished'), DEFAULT_LIVE_ALERTS, quick)).toEqual({
      show: false,
      why: 'short'
    })
    const long = { ...base, workedSince: () => NOW - 60_000 }
    expect(alertVerdict(a('finished'), DEFAULT_LIVE_ALERTS, long).show).toBe(true)
    expect(alertVerdict(a('finished'), { ...DEFAULT_LIVE_ALERTS, minWorkSec: 0 }, quick).show).toBe(
      true
    )
    const repeat = { ...base, lastShown: () => NOW - ALERT_COOLDOWN_MS / 2 }
    expect(alertVerdict(a('approval'), DEFAULT_LIVE_ALERTS, repeat)).toEqual({
      show: false,
      why: 'repeat'
    })
  })

  it('stays quiet in quiet hours (past midnight too), approvals optionally excepted', () => {
    const quiet = {
      ...DEFAULT_LIVE_ALERTS,
      quiet: { enabled: true, from: '22:00', to: '07:00', allowApprovals: false }
    }
    const at = (h: number, m = 0) => ({ ...base, localTime: () => new Date(2026, 9, 31, h, m) })
    expect(alertVerdict(a('finished'), quiet, at(23))).toEqual({ show: false, why: 'quiet' })
    expect(alertVerdict(a('finished'), quiet, at(3))).toEqual({ show: false, why: 'quiet' })
    expect(alertVerdict(a('finished'), quiet, at(7)).show).toBe(true)
    expect(alertVerdict(a('finished'), quiet, at(21, 59)).show).toBe(true)
    expect(alertVerdict(a('approval'), quiet, at(23)).show).toBe(false)
    const allow = { ...quiet, quiet: { ...quiet.quiet, allowApprovals: true } }
    expect(alertVerdict(a('approval'), allow, at(23)).show).toBe(true)
    expect(alertVerdict(a('finished'), allow, at(23)).show).toBe(false)
  })

  it('quiet hours within a day, and empty ones', () => {
    const q = { enabled: true, from: '12:30', to: '13:30', allowApprovals: false }
    expect(inQuietHours(q, new Date(2026, 0, 1, 12, 45))).toBe(true)
    expect(inQuietHours(q, new Date(2026, 0, 1, 13, 30))).toBe(false)
    expect(inQuietHours({ ...q, to: '12:30' }, new Date(2026, 0, 1, 12, 30))).toBe(false)
    expect(inQuietHours({ ...q, enabled: false }, new Date(2026, 0, 1, 12, 45))).toBe(false)
  })
})

describe('alert settings and text', () => {
  it('sanitizes what a phone or an old file sends', () => {
    expect(sanitizeLiveAlerts(undefined)).toEqual(DEFAULT_LIVE_ALERTS)
    const s1 = sanitizeLiveAlerts({
      approval: false,
      minWorkSec: -3,
      quiet: { enabled: true, from: '25:00', to: '06:30' },
      junk: 1
    })
    expect(s1.approval).toBe(false)
    expect(s1.minWorkSec).toBe(DEFAULT_LIVE_ALERTS.minWorkSec)
    expect(s1.quiet).toEqual({ enabled: true, from: '22:00', to: '06:30', allowApprovals: false })
    expect('junk' in s1).toBe(false)
    expect(sanitizeLiveAlerts({ minWorkSec: 99999 }).minWorkSec).toBe(3600)
  })

  it('desktop alerts may name the session; push text never does', () => {
    const al: Alert = {
      key: 'k',
      kind: 'approval',
      at: NOW,
      session: s('k', 'approval', { detail: 'Wants to use Bash' })
    }
    expect(desktopText(al, 'Checkout flow')).toEqual({
      title: 'Needs your approval',
      body: 'Checkout flow: Wants to use Bash'
    })
    expect(desktopText({ ...al, kind: 'finished' }, 'Checkout flow').title).toBe('Finished')
    for (const text of Object.values(PUSH_TEXT)) {
      expect(text).not.toMatch(/Checkout|Bash|\\|\//)
    }
  })
})
