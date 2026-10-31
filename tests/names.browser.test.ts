// Browser tests (Vite + Playwright, like viewer-copy.browser.test.ts):
// - the name and description editors keep a draft through live updates;
// - keyboard picking in the (virtualized) session list.

import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { SessionSummary } from '../src/shared/types'

const root = resolve(import.meta.dirname, '..')
const virtualId = 'virtual:names-browser'

const base: SessionSummary = {
  key: 'browser:s0',
  sessionId: 's0',
  sourceId: 'browser',
  sourceLabel: 'Windows',
  env: 'windows',
  filePath: 'C:\\fixture\\s0.jsonl',
  originalPath: 'C:\\fixture\\s0.jsonl',
  availability: 'live',
  projectDir: 'fixture',
  projectName: 'Fixture',
  cwd: 'C:\\fixture',
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  toolCallCount: 0,
  malformedLines: 0,
  sizeBytes: 100,
  models: [],
  meta: { name: 'Mine', description: 'First description' },
  title: 'Mine',
  titleSource: 'name',
  source: 'terminal-windows',
  sourceReason: 'Browser fixture'
}
const many: SessionSummary[] = Array.from({ length: 80 }, (_, i) => ({
  ...base,
  key: `browser:s${i}`,
  sessionId: `s${i}`,
  meta: {},
  title: `Session ${i}`,
  titleSource: 'first-prompt',
  lastActivityAt: new Date(Date.UTC(2026, 9, 31, 12, 0) - i * 60_000).toISOString()
}))

const harness = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditableTitle, DescriptionEditor } from '/src/renderer/src/components/viewer/MetaEditors.tsx'
import { SessionList } from '/src/renderer/src/components/list/SessionList.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { Card, CardHeader } from '/src/renderer/src/components/usage/primitives.tsx'
import '/src/renderer/src/styles.css'
const screen = new URLSearchParams(location.search).get('screen') || 'editor'
window.saved = []
window.keys = []
window.addEventListener('keydown', (e) => window.keys.push({ key: e.key, prevented: e.defaultPrevented }))
window.csd = {}

function Editors() {
  const [session, setSession] = useState(${JSON.stringify(base)})
  window.setSession = (patch) => setSession((s) => ({ ...s, ...patch, meta: { ...s.meta, ...(patch.meta || {}) } }))
  return React.createElement('div', { style: { width: 600, padding: 20 } },
    React.createElement(EditableTitle, {
      key: session.key, session, focusNonce: 0,
      onSave: (name) => window.saved.push({ name })
    }),
    React.createElement(DescriptionEditor, {
      key: session.key + ':d', session, focusNonce: 0,
      onSave: (description) => window.saved.push({ description })
    }),
    React.createElement('button', { id: 'elsewhere' }, 'elsewhere')
  )
}

const items = ${JSON.stringify(many)}
useApp.setState({ sessions: items, loaded: true, scan: { phase: 'ready', done: 0, total: 0 }, selectedKey: items[0].key, anchorKey: items[0].key })
window.picked = () => { const s = useApp.getState(); return { selectedKey: s.selectedKey, anchorKey: s.anchorKey, checked: s.checked } }

createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null,
    screen === 'card'
      ? React.createElement('div', { style: { width: 360, padding: 20 } },
          React.createElement('button', { id: 'before' }, 'before'),
          React.createElement(Card, { className: 'p-5', label: 'Open API credits details', onClick: () => { window.opened = (window.opened || 0) + 1 } },
            React.createElement(CardHeader, { title: 'API credits', info: 'How it is counted' }),
            React.createElement('p', { id: 'card-text' }, '$38 left')))
      : screen === 'list'
      ? React.createElement('div', { style: { height: 600, width: 420, display: 'flex', flexDirection: 'column' } },
          React.createElement(SessionList, { items, total: items.length }))
      : React.createElement(Editors)
  )
)
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string
let unavailableReason = ''

async function launchBrowser(): Promise<Browser | undefined> {
  const errors: string[] = []
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
    } catch (error) {
      errors.push(`${channel ?? 'bundled Chromium'}: ${String(error).split('\n')[0]}`)
    }
  }
  unavailableReason = `Browser integration tests need Playwright Chromium or Chrome/Edge. ${errors.join('; ')}`
  return undefined
}

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  server = await createServer({
    configFile: false,
    root,
    // Its own dependency cache: viewer-copy.browser.test.ts runs a Vite server at the same time.
    cacheDir: resolve(root, 'node_modules/.vite-names-browser'),
    logLevel: 'error',
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer/src'),
        '@shared': resolve(root, 'src/shared')
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'names-browser-fixture',
        resolveId: (id) => (id === virtualId ? `\0${virtualId}` : undefined),
        load: (id) => (id === `\0${virtualId}` ? harness : undefined),
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split('?')[0] !== '/') return next()
            const html = `<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/@id/__x00__${virtualId}"></script></body></html>`
            void vite.transformIndexHtml(req.url, html).then((transformed) => {
              res.setHeader('Content-Type', 'text/html')
              res.end(transformed)
            })
          })
        }
      }
    ],
    server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a local port')
  origin = `http://127.0.0.1:${address.port}`
  // Warm up: Vite builds the modules on the first load, which is slow under a full test run.
  for (const screen of ['editor', 'list'] as const) await (await open(screen, 60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(screen: 'editor' | 'list' | 'card', loadTimeout = 15_000): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 900, height: 700 } })
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[names.browser]', err.message))
  await page.goto(`${origin}/?screen=${screen}`)
  await page
    .locator(
      screen === 'list'
        ? '#session-list [role="option"]'
        : screen === 'card'
          ? '#card-text'
          : 'textarea'
    )
    .first()
    .waitFor()
  page.setDefaultTimeout(5_000)
  return page
}

const title = (page: Page) => page.getByRole('textbox', { name: 'Session name' })
const description = (page: Page) => page.getByRole('textbox', { name: 'Session description' })
const saved = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { saved: unknown[] }).saved)
const setSession = (page: Page, patch: Partial<SessionSummary>) =>
  page.evaluate(
    (p) => (globalThis as unknown as { setSession: (x: unknown) => void }).setSession(p),
    patch as unknown as Record<string, unknown>
  )
const renameInClaude = {
  title: 'From Claude',
  titleSource: 'claude-name',
  claudeName: 'From Claude'
} as const

describe('name editor and live updates', { timeout: 30_000 }, () => {
  it('a live rename while typing keeps the draft, then saves it on blur', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('editor')
    try {
      await title(page).click()
      await title(page).fill('My draft')
      await setSession(page, renameInClaude)
      await expect.poll(() => page.getByTestId('renamed-meanwhile').count()).toBe(1)
      expect(await title(page).inputValue()).toBe('My draft')
      await title(page).press('Enter')
      expect(await saved(page)).toEqual([{ name: 'My draft' }])
    } finally {
      await page.close()
    }
  })

  it('a live rename while focused (no typing) shows after blur, saving nothing', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('editor')
    try {
      await title(page).click()
      await setSession(page, renameInClaude)
      expect(await title(page).inputValue()).toBe('Mine')
      await page.locator('#elsewhere').focus()
      // My name no longer wins: the box is empty and shows the Claude Code name.
      await expect.poll(() => title(page).inputValue()).toBe('')
      expect(await title(page).getAttribute('placeholder')).toBe('From Claude')
      expect(await saved(page)).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('"Use it" drops the draft for the name from Claude Code', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('editor')
    try {
      await title(page).click()
      await title(page).fill('Half typed')
      await setSession(page, renameInClaude)
      await page.getByRole('button', { name: 'Use it' }).click()
      await expect.poll(() => title(page).inputValue()).toBe('')
      expect(await saved(page)).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('updates the text live when not editing, and keeps a description draft', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('editor')
    try {
      await setSession(page, {
        title: 'Renamed on the phone',
        meta: { name: 'Renamed on the phone' }
      })
      await expect.poll(() => title(page).inputValue()).toBe('Renamed on the phone')
      await description(page).click()
      await description(page).fill('My notes')
      await setSession(page, { meta: { description: 'Changed on the phone' } })
      expect(await description(page).inputValue()).toBe('My notes')
      await page.locator('#elsewhere').focus()
      expect(await saved(page)).toEqual([{ description: 'My notes' }])
    } finally {
      await page.close()
    }
  })
})

describe('keyboard picking in the session list', { timeout: 30_000 }, () => {
  type PickedState = { selectedKey: string; anchorKey: string; checked: string[] }
  const picked = (page: Page) =>
    page.evaluate(() => (globalThis as unknown as { picked: () => PickedState }).picked())

  it('Space, Ctrl+↑/↓, Shift+↑/↓, Ctrl+A and Esc, with ARIA states', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('list')
    try {
      const list = page.locator('#session-list')
      expect(await list.getAttribute('aria-multiselectable')).toBe('true')
      await list.focus()

      await page.keyboard.press('Space')
      expect((await picked(page)).checked).toEqual(['browser:s0'])
      await page.keyboard.press('Control+ArrowDown')
      await page.keyboard.press('Control+ArrowDown')
      await page.keyboard.press('Space')
      expect(await picked(page)).toMatchObject({
        selectedKey: 'browser:s2',
        checked: ['browser:s0', 'browser:s2']
      })
      expect(await page.locator('#row-browser\\:s2').getAttribute('aria-selected')).toBe('true')
      expect(await page.locator('#row-browser\\:s1').getAttribute('aria-selected')).toBe('false')
      // The bulk bar is there for two or more.
      await page.getByRole('toolbar', { name: 'Selected sessions' }).waitFor()

      await page.keyboard.press('Shift+ArrowDown')
      expect((await picked(page)).checked).toEqual(['browser:s2', 'browser:s3'])

      await page.keyboard.press('Escape')
      expect((await picked(page)).checked).toEqual([])

      await page.keyboard.press('Control+a')
      expect((await picked(page)).checked).toHaveLength(80)
      await page.keyboard.press('Escape')
    } finally {
      await page.close()
    }
  })

  it('Shift+↓ past the visible rows keeps the focused row rendered and in view', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('list')
    try {
      await page.locator('#session-list').focus()
      for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowDown')
      const p = await picked(page)
      expect(p.selectedKey).toBe('browser:s30')
      expect(p.checked).toHaveLength(31)
      const active = await page.locator('#session-list').getAttribute('aria-activedescendant')
      expect(active).toBe('row-browser:s30')
      await expect.poll(() => page.locator('#row-browser\\:s30').isVisible()).toBe(true)
      expect(await page.locator('#row-browser\\:s30').getAttribute('aria-selected')).toBe('true')
    } finally {
      await page.close()
    }
  })

  it('leaves plain ↑/↓ to the app (one session, as before)', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('list')
    try {
      await page.locator('#session-list').focus()
      await page.keyboard.press('ArrowDown')
      const keys = await page.evaluate(
        () => (globalThis as unknown as { keys: { key: string; prevented: boolean }[] }).keys
      )
      expect(keys.at(-1)).toEqual({ key: 'ArrowDown', prevented: false })
      expect((await picked(page)).checked).toEqual([])
    } finally {
      await page.close()
    }
  })
})

describe('clickable usage card', { timeout: 30_000 }, () => {
  const opened = (page: Page) =>
    page.evaluate(() => (globalThis as unknown as { opened?: number }).opened ?? 0)

  it('has a native action button and a separate info button, each reached by Tab', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('card')
    try {
      expect(await page.locator('[role="button"]:not(button)').count()).toBe(0)
      expect(await page.locator('button button').count()).toBe(0)
      await page.locator('#before').focus()
      await page.keyboard.press('Tab')
      expect(await page.evaluate("document.activeElement?.getAttribute('aria-label')")).toBe(
        'Open API credits details'
      )
      // Enter runs the action once (it bubbles to the card's click handler, not twice).
      await page.keyboard.press('Enter')
      expect(await opened(page)).toBe(1)
      await page.keyboard.press('Tab')
      expect(await page.evaluate("document.activeElement?.getAttribute('aria-label')")).toBe(
        'More information'
      )
      // The info button doesn't open the card.
      await page.getByRole('button', { name: 'More information' }).click()
      expect(await opened(page)).toBe(1)
      // A click anywhere else on the card does.
      await page.locator('#card-text').click()
      expect(await opened(page)).toBe(2)
    } finally {
      await page.close()
    }
  })
})
