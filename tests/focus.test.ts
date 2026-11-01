// Focus terminal: which window and tab to bring forward. Exact names only,
// and ambiguity is reported rather than guessed.

import { describe, expect, it } from 'vitest'
import {
  normalizeTitle,
  parseTermList,
  pickFocusTarget,
  type TermWindow
} from '../src/main/core/focus'

const WT = 'CASCADIA_HOSTING_WINDOW_CLASS'
const wt = (hwnd: number, tabs: string[]): TermWindow => ({
  hwnd,
  cls: WT,
  title: tabs[0] ?? '',
  tabs
})
const con = (hwnd: number, title: string): TermWindow => ({
  hwnd,
  cls: 'ConsoleWindowClass',
  title,
  tabs: []
})

describe('pickFocusTarget', () => {
  it('ignores Claude Code’s status glyph, spacing and case', () => {
    expect(normalizeTitle('◑ Dashboard  Live alerts ')).toBe('dashboard live alerts')
    expect(normalizeTitle('✳ CBC P4 — SKU & Location')).toBe('cbc p4 — sku & location')
  })

  it('a name inside a longer title never matches ("foo" is not "foobar")', () => {
    const list = { windows: [wt(1, ['✳ foobar', '✳ other'])] }
    expect(pickFocusTarget(list, ['foo'])).toEqual({ error: 'not-found' })
    const both = { windows: [wt(1, ['✳ foobar', '◑ foo'])] }
    expect(pickFocusTarget(both, ['foo'])).toEqual({ hwnd: 1, tab: 1, tabName: '◑ foo' })
  })

  it('two tabs with the name is ambiguous: nothing is guessed', () => {
    const list = { windows: [wt(1, ['✳ api work']), wt(2, ['◑ api work'])] }
    expect(pickFocusTarget(list, ['api work'])).toEqual({ error: 'ambiguous' })
    // A better name first settles it.
    const named = { windows: [wt(1, ['✳ api work']), wt(2, ['◑ api work', '✳ Checkout'])] }
    expect(pickFocusTarget(named, ['Checkout', 'api work'])).toEqual({
      hwnd: 2,
      tab: 1,
      tabName: '✳ Checkout'
    })
  })

  it('its own window is certain; a tab only when exactly one there has the name', () => {
    const list = { ancestor: 2, windows: [wt(1, ['✳ api']), wt(2, ['✳ api', '✳ api', '✳ web'])] }
    expect(pickFocusTarget(list, ['web'])).toEqual({ hwnd: 2, tab: 2, tabName: '✳ web' })
    // Ambiguous inside its own window: the window only (it's still the right one).
    expect(pickFocusTarget(list, ['api'])).toEqual({ hwnd: 2 })
    expect(pickFocusTarget(list, ['nothing'])).toEqual({ hwnd: 2 })
    // A classic console window is the session's own.
    expect(pickFocusTarget({ ancestor: 9, windows: [con(9, 'cmd')] }, ['x'])).toEqual({ hwnd: 9 })
  })

  it('finds a classic console by its exact title, and skips short names', () => {
    const list = { windows: [con(5, '✳ orders api'), con(6, 'orders api retries')] }
    expect(pickFocusTarget(list, ['orders api'])).toEqual({ hwnd: 5 })
    expect(pickFocusTarget(list, ['ab'])).toEqual({ error: 'not-found' })
  })

  it('reads PowerShell’s JSON, where one-item lists come as the item', () => {
    expect(
      parseTermList('{"ancestor":0,"windows":{"hwnd":7,"cls":"X","title":"t","tabs":"only tab"}}')
    ).toEqual({
      ancestor: undefined,
      windows: [{ hwnd: 7, cls: 'X', title: 't', tabs: ['only tab'] }]
    })
    expect(parseTermList('{"ancestor":12,"windows":[]}')).toEqual({ ancestor: 12, windows: [] })
  })
})
