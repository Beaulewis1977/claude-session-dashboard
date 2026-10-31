// Renderer pieces: the multi-selection for bulk actions, and the API credits
// card's markup (React warned about a <button> inside a <button>).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CreditsState } from '@shared/usage/credits'
import { pick, pickedVisible } from '@/lib/multi-select'
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

  it('Ctrl+click adds the selected session and the clicked one, and removes again', () => {
    let p = pick(keys, { selectedKey: 'b', checked: [] }, 'd', 'toggle')
    expect(p).toEqual({ selectedKey: 'd', checked: ['b', 'd'] })
    p = pick(keys, p, 'e', 'toggle')
    expect(p.checked).toEqual(['b', 'd', 'e'])
    p = pick(keys, p, 'd', 'toggle')
    expect(p).toEqual({ selectedKey: 'e', checked: ['b', 'e'] })
    // Down to one: a plain selection again.
    p = pick(keys, p, 'b', 'toggle')
    expect(p).toEqual({ selectedKey: 'e', checked: [] })
  })

  it('Shift+click picks the range from the selected session, in list order', () => {
    expect(pick(keys, { selectedKey: 'd', checked: [] }, 'b', 'range')).toEqual({
      selectedKey: 'd',
      checked: ['b', 'c', 'd']
    })
    // Nothing selected (or not in the list): just the clicked one.
    expect(pick(keys, { selectedKey: 'zz', checked: [] }, 'b', 'range')).toEqual({
      selectedKey: 'b',
      checked: []
    })
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
    // The info tip is a button; the clickable card itself is not a <button>.
    expect(html).toContain('aria-label="More information"')
    expect(html.startsWith('<button')).toBe(false)
    expect(buttonDepth(html)).toBe(1)
  })

  it('keeps the card usable from the keyboard', () => {
    const html = render()
    expect(html).toMatch(/^<div[^>]*role="button"[^>]*tabindex="0"/)
  })
})
