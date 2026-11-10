// Browser test (Vite + Playwright, like back-nav.browser.test.ts): Ask
// review fixes that only show in the real UI.
// - The Ask screen keeps a running answer's Cancel when I open a history item,
//   and when I leave the screen and come back (the run's state isn't the screen's).
// - A citation into a long assistant turn lands on the cited message itself:
//   its own bubble, or its own part of a long tool group, never a later
//   message of its passage; it opens the cited tool call once, and I can
//   close it again.

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

const virtualId = 'virtual:ask-view-browser'

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { AskView } from '/src/renderer/src/components/ask/AskView.tsx'
import { Transcript } from '/src/renderer/src/components/viewer/Transcript.tsx'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { useAsk } from '/src/renderer/src/lib/ask-sessions.ts'
import { useCitedMessages, useFocusMessage } from '/src/renderer/src/lib/focus-message.ts'
import { DEFAULT_ASK_SESSIONS } from '/src/shared/ask-sessions/types.ts'
import '/src/renderer/src/styles.css'

const calls = { send: 0, cancel: [] }
let finish = null
const old = {
  id: 'old', at: Date.now() - 60000, question: 'How many sessions last week?', mode: 'local', ok: true,
  local: { headline: '**3 sessions** last week.', interpretation: 'Sessions, last week', steps: ['Read the list.'] }
}
const status = { enabled: true, phase: 'ready', sessions: 2, passages: 10, chars: 100, bytes: 100, done: 0, total: 0, skipped: 0 }
const preview = {
  id: 'p1', question: 'Where did I fix the redirect loop?', searchText: 'fix redirect loop', scope: {},
  scopeText: 'all my sessions', today: '2026-11-10 (Tue)', matched: 1, cut: 0, model: 'sonnet', effort: 'default',
  index: { sessions: 2, passages: 10, skipped: 0 },
  snippets: [{ sid: 'S1', key: 'w:a', title: 'Safari login', project: 'acme-web', agent: 'Claude Code',
    where: 'Windows', kind: 'turn', messageId: 'm1', text: 'Fixed the cookie path.' }]
}
window.csd = {
  askSessionsHistory: async () => [old],
  askSessionsStatus: async () => status,
  askSessionsPending: async () => [],
  onAskSessionsChanged: () => () => {},
  onAskSessionsStatus: () => () => {},
  onAskSessionsPhoneRequest: () => () => {},
  askSessions: async () => ({ mode: 'content', preview }),
  askSessionsEstimate: async () => ({ tokens: 1200, costUsd: 0.01, priceModel: 'claude-sonnet-5-5' }),
  askSessionsSend: (id) => { calls.send++; return new Promise((resolve) => { finish = () => resolve({
    id, at: Date.now(), question: preview.question, mode: 'content', ok: false, error: 'Cancelled.', where: 'Windows'
  }) }) },
  askSessionsCancel: async (id) => { calls.cancel.push(id); finish && finish() },
  askSessionsDelete: async () => true,
  updateSettings: async (patch) => ({ ...useApp.getState().settings, ...patch })
}
useApp.setState({
  loaded: true,
  view: 'ask',
  settings: { ...useApp.getState().settings, askSessions: { ...DEFAULT_ASK_SESSIONS, enabled: true, noticeAccepted: true } }
})
useAsk.setState({ items: [old], status, pending: [], loaded: true })

// A long session: a prompt, many text replies, then one long tool group of
// 40 tool-only messages (the last one is cited), then another prompt and reply.
const tool = (id, label) => ({ type: 'tool_use', id, name: 'Bash', label, input: { command: label },
  result: { text: 'Output of ' + label, isError: false } })
const msgs = [{ id: 'u1', role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: 'Fix the loop' }], timestamp: '2026-11-03T10:00:00Z' }]
for (let i = 0; i < 20; i++)
  msgs.push({ id: 'a' + i, role: 'assistant', kind: 'response', timestamp: '2026-11-03T10:01:00Z',
    blocks: [{ type: 'text', text: 'Step ' + i + ' of the work, with enough words to take up some room on the screen.' }] })
for (let i = 0; i < 40; i++)
  msgs.push({ id: 't' + i, role: 'assistant', kind: 'response', timestamp: '2026-11-03T10:10:00Z',
    blocks: [tool('tu' + i, 'npm run step-' + i)] })
msgs.push({ id: 'u2', role: 'user', kind: 'prompt', blocks: [{ type: 'text', text: 'Now ship it' }], timestamp: '2026-11-03T11:00:00Z' })
msgs.push({ id: 'afinal', role: 'assistant', kind: 'response', timestamp: '2026-11-03T11:01:00Z',
  blocks: [{ type: 'text', text: 'Shipped.' }] })

const h = React.createElement
function Viewer() {
  useFocusMessage('w:a', true, 'conversation')
  const cited = useCitedMessages('w:a')
  return h('div', { style: { height: '600px', overflow: 'auto' }, id: 'scroller' },
    h(Transcript, { messages: msgs, findQuery: '', cited }))
}
function Screens() {
  const view = useApp((s) => s.view)
  // Another screen in place of Ask: AskView unmounts, as in the app.
  return view === 'ask' ? h(AskView) : h('div', null, 'Settings screen')
}
function Host() {
  const viewer = location.hash === '#viewer'
  return h(TooltipProvider, null, viewer ? h(Viewer) : h('div', { style: { height: '700px' } }, h(Screens)))
}
createRoot(document.getElementById('root')).render(h(Host))
window.__ask = {
  calls: () => calls,
  go: (view) => useApp.getState().set({ view }),
  focus: (ids) => useApp.getState().set({ focusMessage: { key: 'w:a', ids, nonce: Date.now() } })
}
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  ;({ server, origin } = await startHarness({ virtualId, harness }))
  await (await open('', 60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(hash: string, loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(await browser!.newPage({ viewport: { width: 1100, height: 700 } }), origin)
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[ask-view.browser]', err.message))
  await page.goto(`${origin}/${hash}`)
  await waitReady(
    page,
    hash === '#viewer' ? page.getByText('Fix the loop') : page.getByLabel('Your question')
  )
  await page.waitForFunction('typeof window.__ask === "object"')
  page.setDefaultTimeout(5_000)
  return page
}

/** Ask a content question and Send it: the stand-in never answers until Cancel. */
async function sendOne(page: Page): Promise<void> {
  await page.getByLabel('Your question').fill('Where did I fix the redirect loop?')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => page.evaluate('window.__ask.calls().send')).toBe(1)
  // The preview's own Cancel while it's on screen.
  await page.getByRole('button', { name: 'Cancel' }).waitFor()
}

const runningBar = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Sending to Claude…' })

/** The open/closed toggle of the cited message's tool call (not its menu button). */
const toggleOf = (page: Page, id: string) =>
  page.locator(`[data-msg-id="${id}"] button[aria-expanded]:not([aria-haspopup])`)

describe('Ask review fixes in the real UI', () => {
  it('opening a history item while an answer runs keeps Cancel', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('')
    try {
      await sendOne(page)
      // Open the history item: the preview goes, Cancel stays.
      await page.getByText('How many sessions last week?').first().click()
      await page.getByText('3 sessions').waitFor()
      const bar = runningBar(page)
      await bar.waitFor()
      await bar.getByRole('button', { name: 'Cancel' }).click()
      await expect.poll(() => page.evaluate('window.__ask.calls().cancel')).toEqual(['p1'])
      await bar.waitFor({ state: 'detached' })
    } finally {
      await page.close()
    }
  })

  it('leaving Ask while an answer runs, and coming back, keeps Cancel', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('')
    try {
      await sendOne(page)
      await page.evaluate('window.__ask.go("settings")')
      await page.getByText('Settings screen').waitFor()
      await page.evaluate('window.__ask.go("ask")')
      const bar = runningBar(page)
      await bar.waitFor()
      // A new question can't start while one is being answered.
      await expect(
        page.getByRole('button', { name: 'Ask', exact: true }).isDisabled()
      ).resolves.toBe(true)
      await bar.getByRole('button', { name: 'Cancel' }).click()
      await expect.poll(() => page.evaluate('window.__ask.calls().cancel')).toEqual(['p1'])
      await bar.waitFor({ state: 'detached' })
    } finally {
      await page.close()
    }
  })

  it('a citation lands on its own message in a long tool group, opens it once, and lets me close it', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('#viewer')
    try {
      // Far below the first screen (off-screen turns skip layout, so attributes, not visibility).
      const toggle = toggleOf(page, 't39')
      await toggle.waitFor({ state: 'attached' })
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
      await page.evaluate('window.__ask.focus(["t39"])')
      // That message's own part of the 40-message tool group flashes.
      const flashed = page.locator('.cite-flash')
      await flashed.waitFor()
      expect(await flashed.getAttribute('data-msg-id')).toBe('t39')
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
      await page.getByText('Output of npm run step-39').waitFor()
      // On screen, though the group starts screens above it.
      const box = await flashed.boundingBox()
      expect(box && box.y >= 0 && box.y + box.height <= 700).toBe(true)
      const first = await page.locator('[data-msg-id="t0"]').boundingBox()
      expect(first && first.y < 0).toBe(true)
      // Opened once: I can close it again.
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
      // A new citation of it opens it again.
      await page.evaluate('window.__ask.focus(["t39"])')
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    } finally {
      await page.close()
    }
  })

  it("the cited message wins over its passage's other messages", async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('#viewer')
    try {
      // The user's prompt is cited; the reply after it (with its own anchor) is only context.
      await page.evaluate('window.__ask.focus(["u2", "afinal"])')
      const flashed = page.locator('.cite-flash')
      await flashed.waitFor()
      expect(await flashed.getAttribute('data-msg-ids')).toBe('u2')
      await expect(flashed.textContent()).resolves.toContain('Now ship it')
    } finally {
      await page.close()
    }
  })
})
