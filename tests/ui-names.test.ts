// Renderer pieces: the multi-selection for bulk actions, and the API credits
// card's markup (React warned about a <button> inside a <button>).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CreditsState } from '@shared/usage/credits'
import {
  extend,
  moveFocus,
  pickedVisible,
  rangeClick,
  selectAll,
  toggleClick,
  toggleFocused,
  type Picked
} from '@/lib/multi-select'
import { CreditsHeroCard } from '@/components/usage/Hero'
import { TooltipProvider } from '@/components/ui/tooltip'

// The usage hooks read the reduced-motion setting when they load (hoisted
// above the imports by Vitest).
vi.hoisted(() => {
  const g = globalThis as { window?: unknown }
  g.window ??= {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  }
})

describe('multi-selection', () => {
  const keys = ['a', 'b', 'c', 'd', 'e']
  const plain = (key: string | null): Picked => ({ selectedKey: key, anchorKey: key, checked: [] })

  it('Ctrl+click adds the selected session and the clicked one, and removes again', () => {
    let p = toggleClick(keys, plain('b'), 'd')
    expect(p).toEqual({ selectedKey: 'd', anchorKey: 'd', checked: ['b', 'd'] })
    p = toggleClick(keys, p, 'e')
    expect(p.checked).toEqual(['b', 'd', 'e'])
    p = toggleClick(keys, p, 'd')
    expect(p.checked).toEqual(['b', 'e'])
  })

  it('Shift+click picks the range from the anchor to the clicked session', () => {
    expect(rangeClick(keys, plain('d'), 'b')).toEqual({
      selectedKey: 'b',
      anchorKey: 'd',
      checked: ['b', 'c', 'd']
    })
    // No anchor in the list: just the clicked one.
    expect(rangeClick(keys, plain('zz'), 'b')).toEqual(plain('b'))
  })

  it('Space picks and unpicks the focused session', () => {
    let p = toggleFocused(keys, plain('b'))
    expect(p.checked).toEqual(['b'])
    p = moveFocus(keys, p, 1)
    p = moveFocus(keys, p, 1)
    expect(p).toMatchObject({ selectedKey: 'd', checked: ['b'] })
    p = toggleFocused(keys, p)
    expect(p.checked).toEqual(['b', 'd'])
    p = toggleFocused(keys, p)
    expect(p.checked).toEqual(['b'])
  })

  it('Ctrl+↑/↓ keeps the current selection as a pick while the focus moves', () => {
    expect(moveFocus(keys, plain('c'), -1)).toEqual({
      selectedKey: 'b',
      anchorKey: 'c',
      checked: ['c']
    })
    // It stops at the ends.
    expect(moveFocus(keys, plain('e'), 1).selectedKey).toBe('e')
  })

  it('Shift+↑/↓ extends the range from the anchor, and shrinks it going back', () => {
    let p = extend(keys, plain('b'), 1)
    expect(p).toEqual({ selectedKey: 'c', anchorKey: 'b', checked: ['b', 'c'] })
    p = extend(keys, p, 1)
    expect(p.checked).toEqual(['b', 'c', 'd'])
    p = extend(keys, p, -1)
    p = extend(keys, p, -1)
    p = extend(keys, p, -1)
    expect(p).toEqual({ selectedKey: 'a', anchorKey: 'b', checked: ['a', 'b'] })
  })

  it('Ctrl+A picks every visible session', () => {
    expect(selectAll(keys, plain('c'))).toEqual({
      selectedKey: 'c',
      anchorKey: 'a',
      checked: keys
    })
    expect(selectAll([], plain(null))).toEqual(plain(null))
  })

  it('only counts picked sessions that are still in the list', () => {
    expect(pickedVisible(keys, ['e', 'gone', 'a'])).toEqual(['a', 'e'])
    expect(pickedVisible(keys, [])).toEqual([])
  })
})

describe('API credits card', () => {
  const credits: CreditsState = {
    encryptionAvailable: true,
    accounts: [
      {
        id: 'acc1',
        nickname: 'Sample key',
        kind: 'standard',
        masked: 'sk-ant-api03-…SAMP',
        createdAt: '2026-10-01T00:00:00.000Z',
        sample: true
      }
    ],
    summaries: [
      {
        accountId: 'acc1',
        granted: 50,
        spent: 12,
        remaining: 38,
        uncovered: 0,
        lost: 0,
        spentThisWeek: 3,
        spentThisMonth: 12,
        burnPerDay: 0.8,
        daysLeft: 47,
        grants: [],
        spark: Array.from({ length: 30 }, (_, i) => (i % 5) * 0.3),
        bySource: { bridge: 10, estimate: 2 },
        sessions: 4
      }
    ],
    admin: [],
    apiSessions: []
  }

  function render(): string {
    return renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(CreditsHeroCard, { credits, onOpen: () => undefined })
      )
    )
  }

  /** Deepest nesting of `<button>` elements in the markup. */
  function buttonDepth(html: string): number {
    let depth = 0
    let max = 0
    for (const m of html.matchAll(/<(\/?)button\b/g)) {
      depth += m[1] ? -1 : 1
      max = Math.max(max, depth)
    }
    return max
  }

  it('renders without a <button> inside a <button>', () => {
    const html = render()
    expect(html).toContain('API credits')
    expect(html.startsWith('<button')).toBe(false)
    expect(buttonDepth(html)).toBe(1)
  })

  it('is a plain container with two separate native buttons: the action and the info tip', () => {
    const html = render()
    // The card itself: no button role, not focusable.
    const card = /^<div[^>]*>/.exec(html)![0]
    expect(card).not.toMatch(/role=|tabindex=/)
    expect(html).not.toContain('role="button"')
    // Both are real buttons, reachable on their own by keyboard and screen readers.
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toContain('aria-label="Open API credits details"')
    expect(buttons[0]).toContain('type="button"')
    expect(buttons[1]).toContain('aria-label="More information"')
    expect(buttons.some((b) => /tabindex="-1"/.test(b))).toBe(false)
  })
})
