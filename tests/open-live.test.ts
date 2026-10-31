// A tapped push alert keeps its destination until the session can be shown:
// before the app has loaded, while the PC can't be reached, and while the
// session list doesn't know the session yet.

import { describe, expect, it } from 'vitest'
import { nextOpenStep, PENDING_MAX_MS } from '../src/renderer/src/mobile/open-live-rules'

const ctx = (over: Partial<Parameters<typeof nextOpenStep>[1]> = {}) => ({
  loaded: true,
  known: () => true,
  inFlight: false,
  now: 1000,
  ...over
})

describe('opening a tapped alert', () => {
  it('resolves the reference first, once at a time, even before the app has loaded', () => {
    expect(nextOpenStep({ ref: 'r', since: 0 }, ctx({ loaded: false }))).toBe('resolve')
    expect(nextOpenStep({ ref: 'r', since: 0 }, ctx({ inFlight: true }))).toBe('wait')
  })

  it('waits for the app and the session list, then opens', () => {
    expect(nextOpenStep({ key: 'k', since: 0 }, ctx({ loaded: false }))).toBe('wait')
    expect(nextOpenStep({ key: 'k', since: 0 }, ctx({ known: () => false }))).toBe('wait')
    expect(nextOpenStep({ key: 'k', since: 0 }, ctx())).toBe('open')
  })

  it('gives up after a while, and on nothing to open', () => {
    expect(
      nextOpenStep({ key: 'k', since: 0 }, ctx({ known: () => false, now: PENDING_MAX_MS + 1 }))
    ).toBe('drop')
    expect(nextOpenStep({ since: 0 }, ctx())).toBe('drop')
  })
})
