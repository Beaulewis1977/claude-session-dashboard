// Browser test (Vite + Playwright, like context-warning.browser.test.ts): the
// Usage view follows the All / Claude / Codex switch. Claude: as before (no
// Codex, no provider in the query). Codex: its own gauges by window length,
// the detected plan with its raw code, its separate limits, the "new model
// detected" notice, no Credits tab. All: each provider's gauges side by side
// (never one combined %), and the chart stacked or split by provider.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ViteDevServer } from 'vite'
import {
  launchBrowser,
  startHarness,
  trackPage,
  unavailableReason,
  waitReady
} from './browser-harness'

const virtualId = 'virtual:usage-providers-browser'

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { UsageView } from '/src/renderer/src/components/usage/UsageView.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { DEFAULT_SETTINGS } from '/src/shared/types.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import '/src/renderer/src/styles.css'

const view = new URLSearchParams(location.search).get('view') ?? 'all'
const now = Date.now()
const H = 3600000
const gauge = (kind, pct, resetIn) => ({
  kind, pct, lastPct: pct, resetsAt: now + resetIn, windowStart: now + resetIn - (kind === 'five_hour' ? 5 * H : 168 * H),
  updatedAt: now - 60000, expired: false, tokens: 123456, weighted: 1000, source: 'windows'
})
const limits = {
  plan: 'max5', now, hasBridgeData: true, stale: false, envs: [],
  fiveHour: gauge('five_hour', 41, 2 * H), sevenDay: gauge('seven_day', 57, 50 * H),
  capacity5h: [], capacity7d: [], limitHits: [], alertsEnabled: true, alertThresholds: [75, 90],
  weights: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
}
const codexLimits = {
  provider: 'codex', now,
  plan: { setting: 'auto', plan: 'pro100', label: 'Pro $100 (prolite)', mult: 5, detectedCode: 'prolite', detectedSince: now - 48 * H, changes: [] },
  hasData: true, sevenDay: gauge('seven_day', 23, 100 * H), fiveHourRecent: false,
  otherWindows: [],
  extraLimits: [{ limitId: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark', lastAt: now - H, recent: true,
    windows: [{ minutes: 10080, label: 'Weekly', gauge: gauge('seven_day', 3, 100 * H) }] }],
  stale: false, capacity5h: [], capacity7d: [], limitHits: [], alertsEnabled: true, alertThresholds: [75, 90],
  readings: 3, models: ['gpt-6.1-sol', 'gpt-5.3-codex-spark']
}
const totals = (n) => ({ input: n, output: n, cacheWrite: 0, cacheRead: n, total: 3 * n, cost: 1, responses: 2 })
window.queries = []
window.updates = []
const report = (q) => {
  window.queries.push(q)
  const codex = q.provider === 'codex'
  const models = codex ? ['gpt-6.1-sol', 'gpt-5.3-codex-spark'] : q.provider === 'all' ? ['claude-opus-5-5', 'gpt-6.1-sol', 'gpt-5.3-codex-spark'] : ['claude-opus-5-5']
  const start = now - 86400000
  const point = { bucket: 'd', start, ...totals(1000), byModel: {}, ...(q.provider === 'all' ? { byProvider: { claude: 3000, codex: 6000 } } : {}) }
  const card = (id, label) => ({ id, label, from: start, to: now, total: 3000, cost: 1, spark: [1, 2] })
  return {
    generatedAt: now, timeZone: 'UTC', weekStart: 'monday', loading: false, models,
    totals: totals(1000), series: [point], breakdown: [], byModel: [], topSessions: [],
    cards: [card('today', 'Today'), card('week', 'This week'), card('month', 'This month'), card('all', 'All time')],
    blocks: [], raw: [], extraFields: []
  }
}
const methods = {
  getUsageReport: async (q) => report(q),
  updateSettings: async (p) => { window.updates.push(p); return { ...useApp.getState().settings, ...p } }
}
window.csd = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'remote') return false
    if (k in methods) return methods[k]
    if (typeof k === 'string' && k.startsWith('on')) return () => () => undefined
    return async () => null
  }
})
useApp.setState({
  settings: { ...DEFAULT_SETTINGS, providers: { claude: true, codex: true }, providerView: view },
  limits, codexLimits, credits: null, loaded: true
})
window.store = useApp

createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null, React.createElement(UsageView))
)
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  ;({ server, origin } = await startHarness({ virtualId, harness }))
  await (await open('all', 60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(view: string, loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(
    await browser!.newPage({ viewport: { width: 1400, height: 1000 } }),
    origin
  )
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[usage-providers.browser]', err.message))
  await page.goto(`${origin}/?view=${view}`)
  await waitReady(page, page.getByRole('heading', { name: 'Usage & limits' }))
  page.setDefaultTimeout(5_000)
  return page
}

const queries = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { queries: { provider?: string }[] }).queries)

describe('the Usage view and the provider switch', () => {
  it('Claude: as before, with no Codex and no provider in the query', async ({ skip }) => {
    if (!browser) return skip(unavailableReason)
    const page = await open('claude')
    try {
      await page.getByText('This week · all models').first().waitFor()
      expect(await page.getByText('Codex · Weekly').count()).toBe(0)
      await expect.poll(async () => (await queries(page)).length).toBeGreaterThan(0)
      expect((await queries(page)).every((q) => q.provider === undefined)).toBe(true)
      expect(await page.getByRole('tab', { name: 'Credits' }).count()).toBe(1)
    } finally {
      await page.close()
    }
  })

  it('Codex: its own gauges by window length, the detected plan, separate limits and new models', async ({
    skip
  }) => {
    if (!browser) return skip(unavailableReason)
    const page = await open('codex')
    try {
      await page.getByText('Codex · Weekly').waitFor()
      await page.getByText('23%').first().waitFor()
      // No 5-hour card: Codex hasn't reported one (Pro has none).
      expect(await page.getByText('Codex · 5-hour window').count()).toBe(0)
      await page.getByText(/No 5-hour window/).waitFor()
      await page
        .getByRole('button', { name: /Pro \$100 \(prolite\)/ })
        .first()
        .waitFor()
      await page.getByText('GPT-5.3-Codex-Spark').first().waitFor()
      await page.getByText(/New Codex model detected/).waitFor()
      expect(await page.getByText('This week · all models').count()).toBe(0)
      expect(await page.getByRole('tab', { name: 'Credits' }).count()).toBe(0)
      expect((await queries(page)).every((q) => q.provider === 'codex')).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('All: both providers side by side, the chart stacked or split by provider', async ({
    skip
  }) => {
    if (!browser) return skip(unavailableReason)
    const page = await open('all')
    try {
      await page.getByRole('region', { name: 'Claude Code limits' }).waitFor()
      await page.getByRole('region', { name: 'Codex limits' }).waitFor()
      // Each gauge stays its provider's own: Claude's 57% and Codex's 23%, never combined.
      await page.getByRole('region', { name: 'Claude Code limits' }).getByText('57%').waitFor()
      await page.getByRole('region', { name: 'Codex limits' }).getByText('23%').first().waitFor()
      expect((await queries(page)).some((q) => q.provider === 'all')).toBe(true)
      await page.getByRole('radio', { name: 'Split' }).click()
      await expect
        .poll(async () => {
          const q = await queries(page)
          return q.some((x) => x.provider === 'codex') && q.some((x) => x.provider === undefined)
        })
        .toBe(true)
      await page.getByText('Codex · tokens over time').waitFor()
      await page.getByText('Claude Code · tokens over time').waitFor()
      const updates = await page.evaluate(
        () => (globalThis as unknown as { updates: unknown[] }).updates
      )
      expect(updates).toContainEqual({ usageSplit: 'split' })
    } finally {
      await page.close()
    }
  })
})
