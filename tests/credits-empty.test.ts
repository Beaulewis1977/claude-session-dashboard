// The quiet "Track API credits" empty state shown in place of the API
// credits card when there's no key or no credit grant yet.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CreditsState } from '@shared/usage/credits'
import { CreditsEmptyState } from '@/components/usage/Hero'
import { creditsEmptyText } from '@/lib/billing'

vi.hoisted(() => {
  const g = globalThis as { window?: unknown }
  g.window ??= {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  }
})

const account = {
  id: 'acc1',
  nickname: 'Sample key',
  kind: 'standard' as const,
  masked: 'sk-ant-api03-…SAMP',
  createdAt: '2026-10-01T00:00:00.000Z',
  sample: true
}

const summary = {
  accountId: 'acc1',
  granted: 0,
  spent: 0,
  remaining: 0,
  uncovered: 0,
  lost: 0,
  spentThisWeek: 0,
  spentThisMonth: 0,
  burnPerDay: 0,
  daysLeft: undefined,
  grants: [],
  spark: Array.from({ length: 30 }, () => 0),
  bySource: { bridge: 0, estimate: 0 },
  sessions: 0
}

const state = (p: Partial<CreditsState>): CreditsState => ({
  encryptionAvailable: true,
  accounts: [],
  summaries: [],
  admin: [],
  apiSessions: [],
  ...p
})

describe('API credits empty state', () => {
  it('asks for a key and an amount when nothing is saved', () => {
    expect(creditsEmptyText(state({}))).toBe('Track API credits: add a key and the amount you have')
  })

  it('asks only for the amount when a key is saved without a credit grant', () => {
    expect(creditsEmptyText(state({ accounts: [account], summaries: [summary] }))).toBe(
      'Track API credits: add the amount you have'
    )
    // An Admin key alone doesn't track credits.
    expect(creditsEmptyText(state({ accounts: [{ ...account, kind: 'admin' }] }))).toContain(
      'add a key'
    )
  })

  it('steps aside once there is a grant or API spending (the real card shows)', () => {
    expect(
      creditsEmptyText(state({ accounts: [account], summaries: [{ ...summary, granted: 25 }] }))
    ).toBeNull()
    expect(
      creditsEmptyText(state({ accounts: [account], summaries: [{ ...summary, spent: 1.5 }] }))
    ).toBeNull()
    // Not loaded yet: nothing, rather than a flash of the empty state.
    expect(creditsEmptyText(null)).toBeNull()
    expect(renderToStaticMarkup(createElement(CreditsEmptyState, { credits: null }))).toBe('')
  })

  it('has one button to Settings → Accounts & API credits on the desktop', () => {
    const html = renderToStaticMarkup(
      createElement(CreditsEmptyState, { credits: state({}), onSetup: () => undefined })
    )
    expect(html).toContain('data-testid="credits-empty"')
    expect(html).toContain('Track API credits: add a key and the amount you have')
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)]
    expect(buttons).toHaveLength(1)
    expect(html).toContain('Accounts &amp; API credits')
  })

  it('has no button on a phone (keys are added on the PC)', () => {
    const html = renderToStaticMarkup(createElement(CreditsEmptyState, { credits: state({}) }))
    expect(html).not.toContain('<button')
    expect(html).toContain('in the app on your PC')
  })
})
