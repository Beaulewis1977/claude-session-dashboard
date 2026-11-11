// Browser test: a long session in the viewer draws only the turns near the
// screen, gets long tool outputs cut (and asks for the rest when needed), and
// find still finds, counts and goes to every match, also far off screen and
// past a cut.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ViteDevServer } from 'vite'
import type { ChatMessage, SessionSummary } from '../src/shared/types'
import {
  launchBrowser,
  startHarness,
  trackPage,
  unavailableReason,
  waitReady
} from './browser-harness'

const virtualId = 'virtual:viewer-virtual-browser'

const TURNS = 300
// The hidden part of a long output holds "needle" (past the 8,000-character cut).
const longOutput = `${'x'.repeat(15_000)} needle ${'y'.repeat(5_000)}`
const messages: ChatMessage[] = []
for (let i = 0; i < TURNS; i++) {
  messages.push({
    id: `u${i}`,
    role: 'user',
    kind: 'prompt',
    timestamp: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(),
    blocks: [
      { type: 'text', text: i === 10 || i === 290 ? `Question ${i} about zebra` : `Question ${i}` }
    ]
  })
  messages.push({
    id: `a${i}`,
    role: 'assistant',
    kind: 'response',
    timestamp: new Date(Date.UTC(2026, 9, 1, 9, i, 30)).toISOString(),
    blocks: [
      { type: 'text', text: `Answer ${i}, a paragraph with a few words so it wraps a little.` },
      {
        type: 'tool_use',
        id: `tool${i}`,
        name: 'Bash',
        label: `Bash: run ${i}`,
        input: { command: `run ${i}` },
        result: { text: i === 200 ? longOutput : `output ${i}`, isError: false }
      }
    ]
  })
}

const session: SessionSummary = {
  key: 'browser:long',
  sessionId: 'long',
  sourceId: 'browser',
  sourceLabel: 'Windows',
  env: 'windows',
  filePath: 'C:\\fixture\\long.jsonl',
  originalPath: 'C:\\fixture\\long.jsonl',
  availability: 'live',
  projectDir: 'fixture',
  projectName: 'Fixture',
  cwd: 'C:\\fixture',
  messageCount: messages.length,
  userMessageCount: TURNS,
  assistantMessageCount: TURNS,
  toolCallCount: TURNS,
  malformedLines: 0,
  sizeBytes: 100,
  models: [],
  meta: {},
  title: 'Long session',
  titleSource: 'name',
  source: 'terminal-windows',
  sourceReason: 'Browser fixture'
}

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SessionViewer } from '/src/renderer/src/components/viewer/SessionViewer.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { cutTranscript, matchesInCut, toolResultOf } from '/src/shared/transcript-cut.ts'
import '/src/renderer/src/styles.css'
const messages = ${JSON.stringify(messages)}
const session = ${JSON.stringify(session)}
window.calls = []
window.csd = {
  copyText: async () => true,
  getSession: async (key, opts) => {
    window.calls.push(['getSession', !!(opts && opts.cut)])
    return { summary: session, messages: opts && opts.cut ? cutTranscript(messages) : messages }
  },
  getToolResult: async (key, id) => {
    window.calls.push(['getToolResult', id])
    return toolResultOf(messages, id) ?? null
  },
  findInCut: async (key, q) => {
    window.calls.push(['findInCut', q])
    return matchesInCut(messages, q)
  },
  getSessionUsage: async () => null,
  getContextEstimate: async () => null,
  onLimitsChanged: () => () => {},
  onUsageChanged: () => () => {}
}
useApp.setState({ sessions: [session] })
createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null,
    React.createElement('div', { style: { height: '100vh' } },
      React.createElement(SessionViewer, { session, allTags: [] })))
)
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  ;({ server, origin } = await startHarness({ virtualId, harness }))
  await (await open(60_000)).close()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(await browser!.newPage({ viewport: { width: 1100, height: 800 } }), origin)
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[viewer-virtual.browser]', err.message))
  await page.goto(origin)
  await waitReady(page, page.locator('[data-msg-ids]').first())
  page.setDefaultTimeout(5_000)
  return page
}

const drawnTurns = (page: Page) => page.locator('[data-msg-ids]').count()
const scroller = '[data-nav-scroll="main"]'

describe('a long session in the viewer', { timeout: 30_000 }, () => {
  it('draws only the turns near the screen, and more as it scrolls', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      // 600 turns (300 prompts and 300 answers): a screenful is drawn.
      expect(await drawnTurns(page)).toBeLessThan(40)
      expect(await page.locator('[data-msg-ids="u0"]').count()).toBe(1)
      expect(await page.locator('[data-msg-ids="u299"]').count()).toBe(0)
      // It asked for the transcript with long outputs cut.
      expect(await page.evaluate<unknown[]>('window.calls')).toContainEqual(['getSession', true])
      // Scrolling to the end draws the last turns (and lets the first ones go).
      for (let i = 0; i < 30; i++) {
        await page.evaluate(
          `(() => { const el = document.querySelector('${scroller}'); el.scrollTop = el.scrollHeight })()`
        )
        await page.waitForTimeout(50)
        if (await page.locator('[data-msg-ids="a299"]').count()) break
      }
      await expect.poll(() => page.locator('[data-msg-ids="a299"]').count()).toBe(1)
      expect(await page.locator('[data-msg-ids="u0"]').count()).toBe(0)
      expect(await drawnTurns(page)).toBeLessThan(40)
    } finally {
      await page.close()
    }
  })

  it('finds matches far off screen and goes to them', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await page.keyboard.press('Control+f')
      await page.getByRole('textbox', { name: 'Find in session' }).fill('zebra')
      // Both matching turns are drawn (turn 290 is far below the screen), and counted.
      await expect.poll(() => page.locator('[data-msg-ids="u290"]').count()).toBe(1)
      await expect.poll(() => page.locator('.sr-only[aria-live]').innerText()).toBe('2 matches')
      expect(await drawnTurns(page)).toBeLessThan(60)
      // Next goes to the far one: it's on screen.
      await page.getByRole('button', { name: 'Next match' }).click()
      await expect
        .poll(() =>
          page.evaluate<boolean>(
            `(() => { const r = document.querySelector('[data-msg-ids="u290"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })()`
          )
        )
        .toBe(true)
    } finally {
      await page.close()
    }
  })

  it('finds a match past a cut and shows that output in full', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await page.keyboard.press('Control+f')
      await page.getByRole('textbox', { name: 'Find in session' }).fill('needle')
      // The main process says which cut outputs hold it; that tool opens with its full text.
      await expect.poll(() => page.locator('.sr-only[aria-live]').innerText()).toBe('1 matches')
      const calls = await page.evaluate<unknown[]>('window.calls')
      expect(calls).toContainEqual(['findInCut', 'needle'])
      expect(calls).toContainEqual(['getToolResult', 'tool200'])
      await expect
        .poll(() => page.locator('[data-msg-id="a200"] pre').last().innerText())
        .toContain('needle')
    } finally {
      await page.close()
    }
  })

  it('Show all on a cut output asks for it in full and says its real size', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const turn = page.locator('[data-msg-ids="a200"]')
      for (let i = 0; i < 60 && !(await turn.count()); i++) {
        await page.evaluate(`document.querySelector('${scroller}').scrollTop += 2500`)
        await page.waitForTimeout(50)
      }
      await turn.scrollIntoViewIfNeeded()
      await turn.getByRole('button', { name: /run 200/ }).click()
      const showAll = turn.getByRole('button', { name: /Show all/ })
      expect(await showAll.innerText()).toContain(`${longOutput.length.toLocaleString()} chars`)
      await showAll.click()
      await expect.poll(() => turn.locator('pre').last().innerText()).toContain('needle')
    } finally {
      await page.close()
    }
  })
})
