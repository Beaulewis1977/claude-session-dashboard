// The cached calendar lookup (one Intl call per 15-minute slot) gives exactly
// what Intl gives, also around DST changes and in zones with odd offsets.

import { describe, expect, it } from 'vitest'
import { localParts, localPartsExact } from '@shared/usage/time'

const ZONES = [
  'UTC',
  'America/Chicago',
  'America/New_York',
  'America/St_Johns', // -3:30 / -2:30
  'America/Santiago', // DST changes at midnight
  'America/Havana', // DST changes at midnight
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata', // +5:30
  'Asia/Kathmandu', // +5:45
  'Australia/Lord_Howe', // half-hour DST
  'Australia/Adelaide',
  'Pacific/Chatham', // +12:45 / +13:45
  'Pacific/Kiritimati' // +14
]

/** A small deterministic generator (the same instants every run). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('localParts (cached by 15-minute slot)', () => {
  it('matches Intl for random instants from 2020 to 2030', () => {
    const r = rng(42)
    const from = Date.UTC(2020, 0, 1)
    const span = Date.UTC(2030, 0, 1) - from
    for (const tz of ZONES)
      for (let i = 0; i < 3000; i++) {
        const ts = Math.floor(from + r() * span)
        expect(localParts(ts, tz), `${tz} ${ts}`).toEqual(localPartsExact(ts, tz))
      }
  })

  it('matches Intl minute by minute around every DST change of 2026', () => {
    for (const tz of ZONES) {
      // Find the changes by stepping hour by hour through the year.
      let prev: number | undefined
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) {
        const p = localPartsExact(t, tz)
        const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - t
        if (prev !== undefined && off !== prev)
          for (let x = t - 3 * 3_600_000; x <= t + 3 * 3_600_000; x += 60_000 + 7)
            expect(localParts(x, tz), `${tz} ${x}`).toEqual(localPartsExact(x, tz))
        prev = off
      }
    }
  })

  it('keeps Intl’s whole-second rounding and odd inputs', () => {
    for (const ts of [0, 999, 1000, 1_700_000_000_999, Date.UTC(2026, 2, 8, 8, 0, 0, 500)])
      for (const tz of ZONES) expect(localParts(ts, tz)).toEqual(localPartsExact(ts, tz))
  })
})
