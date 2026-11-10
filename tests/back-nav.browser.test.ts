// Browser test (Vite + Playwright, like running-keys.browser.test.ts): Back /
// Forward on the desktop. The real title bar and the real useNavigation()
// (store subscription, hotkeys, mouse side buttons, app commands, scroll
// restore) over a small stand-in for the session list and the main pane.

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

const virtualId = 'virtual:back-nav-browser'

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { TitleBar } from '/src/renderer/src/components/TitleBar.tsx'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { useNavigation, navDebug } from '/src/renderer/src/lib/navigation.ts'
import '/src/renderer/src/styles.css'

let navCb = null
window.csd = {
  onNavigate: (cb) => { navCb = cb; return () => { navCb = null } },
  updateSettings: async (patch) => ({ ...useApp.getState().settings, ...patch })
}
const session = (id, title) => ({
  key: 'windows:' + id, sessionId: id, sourceId: 'windows', sourceLabel: 'Windows', env: 'windows',
  filePath: '', originalPath: '', availability: 'live', projectDir: 'p', projectName: 'p',
  messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, toolCallCount: 0,
  malformedLines: 0, sizeBytes: 1, models: [], meta: {}, title, titleSource: 'name',
  source: 'terminal-windows', sourceReason: ''
})
useApp.setState({
  loaded: true,
  view: 'sessions',
  selectedKey: 'windows:a',
  sessions: [session('a', 'Checkout flow'), session('b', 'Orders API'), session('c', 'Billing page')]
})
const h = React.createElement
function Host() {
  useNavigation()
  const view = useApp((s) => s.view)
  const key = useApp((s) => s.selectedKey)
  return h(TooltipProvider, null,
    h(TitleBar),
    h('input', { 'aria-label': 'Search', defaultValue: 'abc' }),
    h('textarea', { 'aria-label': 'Description', defaultValue: 'text' }),
    h('div', { 'aria-label': 'Editable', contentEditable: true, suppressContentEditableWarning: true }, 'edit me'),
    h('div', { id: 'status' }, view + '|' + key),
    // A tall main pane per screen (remounted on each, like the real views).
    h('div', { key: view + key, 'data-nav-scroll': 'main', style: { height: '200px', overflow: 'auto' } },
      h('div', { style: { height: '3000px' } }, view))
  )
}
createRoot(document.getElementById('root')).render(h(Host))
window.__nav = {
  state: () => { const s = useApp.getState(); return s.view + '|' + s.selectedKey },
  set: (patch) => useApp.getState().set(patch),
  select: (key) => useApp.getState().select(key),
  drop: (key) => useApp.setState({ sessions: useApp.getState().sessions.filter((s) => s.key !== key) }),
  appCommand: (dir) => navCb && navCb(dir),
  debug: () => navDebug()
}
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  ;({ server, origin } = await startHarness({ virtualId, harness }))
  await (await open(60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(await browser!.newPage({ viewport: { width: 1100, height: 700 } }), origin)
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[back-nav.browser]', err.message))
  await page.goto(origin)
  await waitReady(page, page.getByRole('button', { name: 'Back' }))
  await page.waitForFunction('typeof window.__nav === "object"')
  page.setDefaultTimeout(5_000)
  return page
}

const state = (page: Page) => page.evaluate<string>('window.__nav.state()')
/** A move, then a pause longer than the quick-repeat window so it's its own entry. */
async function move(page: Page, js: string): Promise<void> {
  await page.evaluate(js)
  await page.waitForTimeout(600)
}
/** History: a → b → c (three entries). */
async function abc(page: Page): Promise<void> {
  await page.waitForTimeout(50)
  await move(page, "window.__nav.select('windows:b')")
  await move(page, "window.__nav.select('windows:c')")
  await expect.poll(() => state(page)).toBe('sessions|windows:c')
}
/** A mouse side button click (3 = Back, 4 = Forward), as the page sees it. */
const mouse = (page: Page, button: number) =>
  page.evaluate(
    `for (const type of ['mousedown', 'mouseup'])
      document.body.dispatchEvent(new MouseEvent(type, { button: ${button}, bubbles: true, cancelable: true }))`
  )

describe('Back / Forward on the desktop', () => {
  it('Alt+← / Alt+→ and Backspace move through history', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await abc(page)
      await page.locator('body').click({ position: { x: 900, y: 650 } })
      await page.keyboard.press('Alt+ArrowLeft')
      await expect.poll(() => state(page)).toBe('sessions|windows:b')
      await page.keyboard.press('Backspace')
      await expect.poll(() => state(page)).toBe('sessions|windows:a')
      await page.keyboard.press('Alt+ArrowRight')
      await expect.poll(() => state(page)).toBe('sessions|windows:b')
      await page.keyboard.press('Alt+ArrowRight')
      await expect.poll(() => state(page)).toBe('sessions|windows:c')
      // Going back and forth added no entries.
      const d = await page.evaluate<{ states: unknown[] }>('window.__nav.debug()')
      expect(d.states).toHaveLength(3)
    } finally {
      await page.close()
    }
  })

  it('never triggers inside a text field', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await abc(page)
      for (const name of ['Search', 'Description', 'Editable']) {
        const field =
          name === 'Editable' ? page.getByLabel('Editable') : page.getByRole('textbox', { name })
        await field.click()
        await page.keyboard.press('End')
        await page.keyboard.press('Backspace')
        await page.keyboard.press('Alt+ArrowLeft')
        await page.keyboard.press('Alt+ArrowRight')
        expect(await state(page)).toBe('sessions|windows:c')
      }
      // Backspace still deleted in the field.
      expect(await page.getByRole('textbox', { name: 'Search' }).inputValue()).toBe('ab')
    } finally {
      await page.close()
    }
  })

  it("the mouse's side buttons go back and forward", async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await abc(page)
      await mouse(page, 3)
      await expect.poll(() => state(page)).toBe('sessions|windows:b')
      await page.waitForTimeout(450)
      await mouse(page, 4)
      await expect.poll(() => state(page)).toBe('sessions|windows:c')
    } finally {
      await page.close()
    }
  })

  it("Windows' app command goes back, and one click sent both ways moves once", async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await abc(page)
      await page.evaluate("window.__nav.appCommand('back')")
      await expect.poll(() => state(page)).toBe('sessions|windows:b')
      await page.waitForTimeout(450)
      // The same click as a DOM button and an app command: one step.
      await mouse(page, 3)
      await page.evaluate("window.__nav.appCommand('back')")
      await expect.poll(() => state(page)).toBe('sessions|windows:a')
      await page.waitForTimeout(100)
      expect(await state(page)).toBe('sessions|windows:a')
      expect((await page.evaluate<{ position: number }>('window.__nav.debug()')).position).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('title bar buttons: disabled with nowhere to go, tooltips say where they lead', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const back = page.getByRole('button', { name: 'Back' })
      const fwd = page.getByRole('button', { name: 'Forward' })
      expect(await back.isDisabled()).toBe(true)
      expect(await fwd.isDisabled()).toBe(true)
      await move(page, "window.__nav.set({ view: 'usage', usageTab: 'credits' })")
      await expect.poll(() => back.isDisabled()).toBe(false)
      expect(await back.getAttribute('data-nav-target')).toBe('All sessions › Checkout flow')
      await back.click()
      await expect.poll(() => state(page)).toBe('sessions|windows:a')
      await expect.poll(() => fwd.getAttribute('data-nav-target')).toBe('Usage & limits › Credits')
      await fwd.hover()
      await expect
        .poll(() => page.getByRole('tooltip').first().textContent())
        .toContain('Forward to Usage & limits › Credits')
      await fwd.click()
      await expect.poll(() => state(page)).toBe('usage|windows:a')
      expect(await fwd.isDisabled()).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('skips a session that no longer exists', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await abc(page)
      await page.evaluate("window.__nav.drop('windows:b')")
      await page.keyboard.press('Alt+ArrowLeft')
      await expect.poll(() => state(page)).toBe('sessions|windows:a')
      await page.keyboard.press('Alt+ArrowRight')
      await expect.poll(() => state(page)).toBe('sessions|windows:c')
    } finally {
      await page.close()
    }
  })

  it('restores the scroll position of the screen it goes back to', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await move(page, "window.__nav.set({ view: 'settings' })")
      await page.evaluate("document.querySelector('[data-nav-scroll=main]').scrollTop = 1234")
      await page.waitForTimeout(100)
      await move(page, "window.__nav.set({ view: 'running' })")
      const top = () =>
        page.evaluate<number>("document.querySelector('[data-nav-scroll=main]').scrollTop")
      expect(await top()).toBe(0)
      await page.keyboard.press('Alt+ArrowLeft')
      await expect.poll(() => state(page)).toBe('settings|windows:a')
      await expect.poll(top).toBe(1234)
      await page.keyboard.press('Alt+ArrowRight')
      await expect.poll(() => state(page)).toBe('running|windows:a')
      await expect.poll(top).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('quick repeats are one entry; Back waits while a dialog is open', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await page.waitForTimeout(50)
      await page.evaluate(
        "window.__nav.select('windows:b'); setTimeout(() => window.__nav.select('windows:c'), 80)"
      )
      await page.waitForTimeout(400)
      const d = await page.evaluate<{ states: { selectedKey: string }[] }>('window.__nav.debug()')
      expect(d.states.map((s) => s.selectedKey)).toEqual(['windows:a', 'windows:c'])
      await page.evaluate('window.__nav.set({ paletteOpen: true })')
      await page.keyboard.press('Alt+ArrowLeft')
      await page.waitForTimeout(100)
      expect(await state(page)).toBe('sessions|windows:c')
      await page.evaluate('window.__nav.set({ paletteOpen: false })')
      await page.keyboard.press('Alt+ArrowLeft')
      await expect.poll(() => state(page)).toBe('sessions|windows:a')
    } finally {
      await page.close()
    }
  })
})
