// Browser test (Vite + Playwright, like resume-keys.browser.test.ts): the
// Running now rows in the session list work from the keyboard. A row is a
// real button (Enter and Space open the session), and its actions are
// buttons beside it, not nested inside it.

import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = resolve(import.meta.dirname, '..')
const virtualId = 'virtual:running-keys-browser'

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { RunningSection } from '/src/renderer/src/components/live/RunningNow.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import '/src/renderer/src/styles.css'

window.csd = { copyText: async () => {}, focusTerminal: async () => ({ ok: true, how: 'tab' }) }
const now = Date.now()
const session = (id, title) => ({
  key: 'windows:' + id, sessionId: id, sourceId: 'windows', sourceLabel: 'Windows', env: 'windows',
  filePath: '', originalPath: '', availability: 'live', projectDir: 'p', projectName: 'p',
  messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, toolCallCount: 0,
  malformedLines: 0, sizeBytes: 1, models: [], meta: {}, title, titleSource: 'name',
  source: 'terminal-windows', sourceReason: ''
})
const live = (id, state) => ({
  key: 'windows:' + id, sessionId: id, sourceId: 'windows', env: 'windows', state,
  since: now - 60000, lastSeenAt: now, basis: 'status', pid: 4242
})
useApp.setState({
  loaded: true,
  view: 'running',
  sessions: [session('a', 'Checkout flow'), session('b', 'Orders API')],
  live: { at: now, hooks: [], sessions: [live('a', 'approval'), live('b', 'working')] }
})
createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null, React.createElement(RunningSection))
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
    cacheDir: resolve(root, 'node_modules/.vite-running-keys-browser'),
    logLevel: 'error',
    optimizeDeps: { entries: ['src/renderer/src/**/*.tsx'] },
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
        name: 'running-keys-browser-fixture',
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
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a local port')
  origin = `http://127.0.0.1:${address.port}`
  await (await open(60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 420, height: 600 } })
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[running-keys.browser]', err.message))
  await page.goto(origin)
  await page.getByRole('button', { name: /Checkout flow/ }).waitFor()
  page.setDefaultTimeout(5_000)
  return page
}

/** "<selectedKey>|<view>" from the page's store (exposed by the test as window.__sel). */
const selected = (page: Page) =>
  page.evaluate<string | null>('window.__sel ? window.__sel() : null')

describe('Running now rows, by keyboard', () => {
  it('a row is a real button: Space and Enter open the session', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await page.addScriptTag({
        type: 'module',
        content:
          "import { useApp } from '/src/renderer/src/lib/store.ts'; window.__sel = () => useApp.getState().selectedKey + '|' + useApp.getState().view"
      })
      await expect.poll(() => page.evaluate<string>('typeof window.__sel')).toBe('function')
      const row = page.getByRole('button', { name: /Checkout flow/ })
      expect(await row.evaluate((el) => el.tagName)).toBe('BUTTON')
      await row.focus()
      await page.keyboard.press('Space')
      await expect.poll(() => selected(page)).toBe('windows:a|sessions')
      await page.getByRole('button', { name: /Orders API/ }).focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => selected(page)).toBe('windows:b|sessions')
    } finally {
      await page.close()
    }
  })

  it('its actions are separate buttons, reachable with Tab', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const row = page.getByRole('button', { name: /Checkout flow/ })
      await row.focus()
      await page.keyboard.press('Tab')
      const focused = await page.evaluate<string | null>(
        "document.activeElement?.getAttribute('aria-label') ?? null"
      )
      expect(focused).toBe('Focus terminal')
      // Not nested in the row's button (a button inside a button breaks screen readers).
      const nested = await page.evaluate<number>(
        "document.querySelectorAll('button button, [role=button] button').length"
      )
      expect(nested).toBe(0)
      const group = page.getByRole('group', { name: 'Actions for Checkout flow' })
      await expect.poll(() => group.isVisible()).toBe(true)
    } finally {
      await page.close()
    }
  })
})
