// Browser test (Vite + Playwright, like names.browser.test.ts): picking a
// model or effort with the keyboard in the launch dialog never launches.
// React passes key events up from a portal, so Enter on a picker's menu item
// used to reach the dialog's own Enter handler and start the session.

import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { SessionSummary } from '../src/shared/types'

const root = resolve(import.meta.dirname, '..')
const virtualId = 'virtual:resume-keys-browser'

const session: SessionSummary = {
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
  meta: {},
  title: 'Keyboard session',
  titleSource: 'first-prompt',
  source: 'terminal-windows',
  sourceReason: 'Browser fixture'
}

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ResumeDialog } from '/src/renderer/src/components/ResumeDialog.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import '/src/renderer/src/styles.css'

window.launched = []
window.metas = []
const preview = {
  commandLine: 'Start-Process wt.exe', claudeCommand: 'claude --resume s0', terminal: 'wt',
  fellBack: false, cwd: 'C:\\\\fixture', cwdExists: true, willRestore: false,
  restoreImpossible: false, originalPath: 'C:\\\\fixture\\\\s0.jsonl', billingLabel: 'Subscription',
  modelChoice: { modelFrom: 'none', effortFrom: 'none' }
}
window.csd = {
  previewLaunch: async () => preview,
  launch: async (o) => { window.launched.push(o); return { ok: true, restored: false, commandLine: 'x', simulated: true } },
  updateMeta: async (key, patch) => {
    window.metas.push(patch)
    const s = useApp.getState().sessions[0]
    const next = { ...s, meta: { ...s.meta, ...patch } }
    useApp.getState().patchSession(next)
    return next
  },
  updateSettings: async (p) => ({ ...useApp.getState().settings, ...p }),
  copyText: async () => {},
  pickCwd: async () => null
}
useApp.setState({ sessions: [${JSON.stringify(session)}], loaded: true, resume: { key: 'browser:s0', fork: false } })

createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null, React.createElement(ResumeDialog))
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
    // Its own dependency cache: the other browser tests run Vite servers at the same time.
    cacheDir: resolve(root, 'node_modules/.vite-resume-keys-browser'),
    logLevel: 'error',
    // Find and pre-bundle every dependency of the renderer when the server
    // starts. The test page is a virtual module Vite can't scan, so without this
    // a fresh cache (after npm install) discovers them while a page loads and
    // answers its requests with "504 Outdated Optimize Dep".
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
        name: 'resume-keys-browser-fixture',
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
    // No file watching or hot reload: a file changed in the repo while the tests
    // run (an edit, git, the formatter) would otherwise reload or restyle the
    // page in the middle of a test.
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a local port')
  origin = `http://127.0.0.1:${address.port}`
  // Warm up: Vite builds the modules on the first load, which is slow under a full test run.
  await (await open(60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 900 } })
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[resume-keys.browser]', err.message))
  await page.goto(origin)
  // The command preview has loaded once Resume can be pressed.
  await page.locator('pre', { hasText: 'Start-Process' }).waitFor()
  page.setDefaultTimeout(5_000)
  return page
}

const launched = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { launched: unknown[] }).launched.length)
/** Arrow down through the open menu until the focused item starts with `label`. */
async function arrowTo(page: Page, label: string): Promise<void> {
  const focused = () => page.evaluate<string>("document.activeElement?.textContent ?? ''")
  for (let i = 0; i < 30; i++) {
    const text = await focused()
    if (text.startsWith(label)) return
    await page.keyboard.press('ArrowDown')
    // The menu takes a moment to move focus (and ignores keys right after opening).
    for (let t = 0; t < 20 && (await focused()) === text; t++) await page.waitForTimeout(25)
  }
  throw new Error(`No menu item "${label}"`)
}
const metas = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { metas: unknown[] }).metas)

describe('launch dialog keyboard', () => {
  it('Enter on a Model or Effort menu item picks it, without launching', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      // Model: open with Enter, arrow to "Opus", pick with Enter.
      await page.getByRole('button', { name: /^Model:/ }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('menu').waitFor()
      await arrowTo(page, 'Opus')
      await page.keyboard.press('Enter')
      await expect.poll(() => metas(page)).toEqual([{ model: 'opus' }])
      await page.getByRole('menu').waitFor({ state: 'detached' })

      // Effort: arrow to "Medium", pick with Enter.
      await page.getByRole('button', { name: /^Effort:/ }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('menu').waitFor()
      await arrowTo(page, 'Medium')
      await page.keyboard.press('Enter')
      await expect.poll(() => metas(page)).toEqual([{ model: 'opus' }, { effort: 'medium' }])

      // Custom…: the last item, then Enter in its text field saves the model.
      await page.getByRole('button', { name: /^Model:/ }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('menu').waitFor()
      await arrowTo(page, 'Custom')
      await page.keyboard.press('Enter')
      const field = page.getByRole('textbox', { name: 'Custom model ID or alias' })
      await field.waitFor()
      await field.fill('claude-opus-4-5-20251101')
      await page.keyboard.press('Enter')
      await expect
        .poll(() => metas(page))
        .toEqual([{ model: 'opus' }, { effort: 'medium' }, { model: 'claude-opus-4-5-20251101' }])

      // Give a stray launch time to show up: none did.
      await page.waitForTimeout(300)
      expect(await launched(page)).toBe(0)

      // Enter (even Ctrl+Enter) on a picker's own button opens its menu, not a launch.
      await page.getByRole('button', { name: /^Effort:/ }).focus()
      await page.keyboard.press('Control+Enter')
      await page.getByRole('menu').waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'detached' })
      expect(await launched(page)).toBe(0)

      // Outside the pickers, Enter still launches.
      await page.locator('pre', { hasText: 'Start-Process' }).click()
      await page.keyboard.press('Enter')
      await expect.poll(() => launched(page)).toBe(1)
    } finally {
      await page.close()
    }
  }, 60_000)
})
