// Back / Forward history rules (src/renderer/src/lib/nav-history.ts): what is
// recorded, what collapses, the cap, and skipping entries whose session is gone.

import { describe, expect, it } from 'vitest'
import { EMPTY_FILTERS } from '../src/renderer/src/lib/filters'
import {
  changedFields,
  COLLAPSE_MS,
  NavHistory,
  type NavState
} from '../src/renderer/src/lib/nav-history'

const base: NavState = {
  view: 'sessions',
  filters: EMPTY_FILTERS,
  selectedKey: 'a',
  viewerTab: 'conversation',
  usageTab: 'trends',
  providerView: 'all',
  settingsSection: null
}
const st = (patch: Partial<NavState>): NavState => ({ ...base, ...patch })
const all = (): boolean => true

/** Moves far enough apart that none collapse. */
function walk(h: NavHistory, states: NavState[], gap = COLLAPSE_MS + 1): number {
  let t = 1000
  for (const s of states) {
    h.record(s, t)
    t += gap
  }
  return t
}

describe('recording moves', () => {
  it('starts with the first screen and adds an entry per move', () => {
    const h = new NavHistory()
    expect(h.record(base, 0)).toBe('push')
    expect(h.record(st({ view: 'usage' }), 1000)).toBe('push')
    expect(h.list().map((s) => s.view)).toEqual(['sessions', 'usage'])
  })

  it('ignores a move to the screen already shown', () => {
    const h = new NavHistory()
    h.record(base, 0)
    // A new but equal filters object (e.g. a date range) is the same screen.
    expect(h.record(st({ filters: { ...EMPTY_FILTERS } }), 1000)).toBe('none')
    expect(h.size).toBe(1)
  })

  it('collapses quick repeats of the same kind of move (J/K held down)', () => {
    const h = new NavHistory()
    h.record(base, 0)
    h.record(st({ selectedKey: 'b' }), 1000)
    expect(h.record(st({ selectedKey: 'c' }), 1100)).toBe('replace')
    expect(h.record(st({ selectedKey: 'd' }), 1200)).toBe('replace')
    expect(h.list().map((s) => s.selectedKey)).toEqual(['a', 'd'])
  })

  it('keeps moves apart when they are slow, or of different kinds', () => {
    const h = new NavHistory()
    h.record(base, 0)
    h.record(st({ selectedKey: 'b' }), 1000)
    h.record(st({ selectedKey: 'c' }), 1000 + COLLAPSE_MS + 1)
    // A tab change right after a selection is its own move.
    h.record(st({ selectedKey: 'c', viewerTab: 'changes' }), 1000 + COLLAPSE_MS + 50)
    expect(h.size).toBe(4)
  })

  it('collapses quick Usage tab and provider switch repeats too', () => {
    const h = new NavHistory()
    h.record(st({ view: 'usage' }), 0)
    h.record(st({ view: 'usage', usageTab: 'limits' }), 1000)
    h.record(st({ view: 'usage', usageTab: 'credits' }), 1200)
    h.record(st({ view: 'usage', usageTab: 'credits', providerView: 'codex' }), 3000)
    h.record(st({ view: 'usage', usageTab: 'credits', providerView: 'claude' }), 3100)
    expect(h.list().map((s) => [s.usageTab, s.providerView])).toEqual([
      ['trends', 'all'],
      ['credits', 'all'],
      ['credits', 'claude']
    ])
  })

  it('never collapses screen or filter changes, however quick', () => {
    const h = new NavHistory()
    h.record(base, 0)
    h.record(st({ view: 'usage' }), 10)
    h.record(st({ view: 'settings' }), 20)
    h.record(st({ filters: { ...EMPTY_FILTERS, tag: 'x' } }), 30)
    h.record(st({ filters: { ...EMPTY_FILTERS, tag: 'y' } }), 40)
    expect(h.size).toBe(5)
  })

  it('a quick A → B → A leaves no entry for the detour', () => {
    const h = new NavHistory()
    h.record(base, 0)
    h.record(st({ selectedKey: 'b' }), 1000)
    h.record(st({ selectedKey: 'c' }), 1100)
    h.record(st({ selectedKey: 'b' }), 1200)
    h.record(st({ selectedKey: 'a' }), 1300)
    expect(h.list().map((s) => s.selectedKey)).toEqual(['a'])
  })

  it('never replaces the first entry', () => {
    const h = new NavHistory()
    h.record(st({ selectedKey: 'a' }), 0)
    h.record(st({ selectedKey: 'b' }), 10)
    expect(h.list().map((s) => s.selectedKey)).toEqual(['a', 'b'])
  })

  it('caps history, dropping the oldest', () => {
    const h = new NavHistory(100)
    walk(
      h,
      Array.from({ length: 130 }, (_, i) => st({ selectedKey: `s${i}` }))
    )
    expect(h.size).toBe(100)
    expect(h.list()[0].selectedKey).toBe('s30')
    expect(h.position).toBe(99)
  })

  it('amend folds an automatic change into the current entry', () => {
    const h = new NavHistory()
    h.record(st({ selectedKey: null }), 0)
    h.amend(st({ selectedKey: 'first' }))
    expect(h.list()).toEqual([st({ selectedKey: 'first' })])
    // Before anything was recorded it starts history.
    const fresh = new NavHistory()
    fresh.amend(base)
    expect(fresh.size).toBe(1)
  })

  it('names the fields a move changed', () => {
    expect(changedFields(base, st({ view: 'usage', selectedKey: 'b' }))).toEqual([
      'view',
      'selectedKey'
    ])
  })
})

describe('Back and Forward', () => {
  it('goes back and forward through the entries', () => {
    const h = new NavHistory()
    walk(h, [base, st({ view: 'usage' }), st({ view: 'settings' })])
    expect(h.go(-1, all)?.state.view).toBe('usage')
    expect(h.go(-1, all)?.state.view).toBe('sessions')
    expect(h.go(-1, all)).toBeNull()
    expect(h.go(1, all)?.state.view).toBe('usage')
    expect(h.go(1, all)?.state.view).toBe('settings')
    expect(h.go(1, all)).toBeNull()
  })

  it('a new move after going back drops the entries ahead', () => {
    const h = new NavHistory()
    walk(h, [base, st({ view: 'usage' }), st({ view: 'settings' })])
    h.go(-1, all)
    h.go(-1, all)
    h.record(st({ view: 'running' }), 99_999)
    expect(h.list().map((s) => s.view)).toEqual(['sessions', 'running'])
    expect(h.peek(1, all)).toBeNull()
  })

  it('a move right after arriving is its own entry (no collapse into it)', () => {
    const h = new NavHistory()
    const t = walk(h, [base, st({ selectedKey: 'b' }), st({ selectedKey: 'c' })])
    h.go(-1, all)
    h.go(1, all)
    expect(h.record(st({ selectedKey: 'd' }), t)).toBe('push')
    expect(h.list().map((s) => s.selectedKey)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('skips entries whose session no longer exists', () => {
    const h = new NavHistory()
    walk(h, [base, st({ selectedKey: 'b' }), st({ selectedKey: 'c' })])
    const exists = (s: NavState): boolean => s.selectedKey !== 'b'
    expect(h.go(-1, exists)?.state.selectedKey).toBe('a')
    expect(h.go(1, exists)?.state.selectedKey).toBe('c')
  })

  it('has nowhere to go when every other entry is gone', () => {
    const h = new NavHistory()
    walk(h, [st({ selectedKey: 'x' }), st({ selectedKey: 'y' }), base])
    const exists = (s: NavState): boolean => s.selectedKey === 'a'
    expect(h.peek(-1, exists)).toBeNull()
    expect(h.go(-1, exists)).toBeNull()
    expect(h.position).toBe(2)
  })

  it('skips an entry that looks just like the screen shown now', () => {
    const h = new NavHistory()
    walk(h, [base, st({ view: 'usage' }), st({ view: 'settings' })])
    // Something changed the screen back to Usage without a record yet.
    expect(h.peek(-1, all, st({ view: 'usage' }))?.state.view).toBe('sessions')
  })

  it('keeps each entry’s scroll position', () => {
    const h = new NavHistory()
    h.record(base, 0)
    h.setScroll('main', 1200)
    h.setScroll('list', 300)
    h.record(st({ selectedKey: 'b' }), 1000)
    h.setScroll('main', 50)
    expect(h.go(-1, all)?.scroll).toEqual({ main: 1200, list: 300 })
    expect(h.go(1, all)?.scroll).toEqual({ main: 50 })
  })
})
