// Browser test (Vite + Playwright, like resume-keys.browser.test.ts): the
// Summarize dialog sends the text it showed (even once hidden), never sends
// while a requested preview is loading or failed, and Cancel while it is
// preparing really cancels.

import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { SessionSummary } from '../src/shared/types'

const root = resolve(import.meta.dirname, '..')
const virtualId = 'virtual:summarize-dialog-browser'

const session = (i: number): SessionSummary => ({
  key: `browser:s${i}`,
  sessionId: `s${i}`,
  sourceId: 'browser',
  sourceLabel: 'Windows',
  env: 'windows',
  filePath: `C:\\fixture\\s${i}.jsonl`,
  originalPath: `C:\\fixture\\s${i}.jsonl`,
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
  title: `Session ${i}`,
  titleSource: 'first-prompt',
  source: 'terminal-windows',
  sourceReason: 'Browser fixture'
})
const sessions = [session(0), session(1), session(2)]

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SummarizeDialog } from '/src/renderer/src/components/summary/SummarizeDialog.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { DEFAULT_SETTINGS } from '/src/shared/types.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import '/src/renderer/src/styles.css'

const params = new URLSearchParams(location.search)
// Preview answers, in order: "ok", "fail" or "hold" (resolves on window.releasePreview()).
const plan = (params.get('preview') ?? 'ok').split(',')
window.calls = []
window.cancels = []
let previews = 0
const estimate = { sessions: 3, chars: 9000, tokens: 12000, costUsd: 0.1, skipped: 0 }
window.csd = {
  summaryEstimate: async () => estimate,
  summaryPreview: (key) => {
    const what = plan[Math.min(previews, plan.length - 1)]
    const id = 'p' + (++previews) + '00000000000000'.slice(0, 14)
    const p = { id, key, prompt: '[claude-session-dashboard:summary] text ' + id, bytes: 10, chars: 10, kept: 2, total: 2, estimate }
    if (what === 'fail') return Promise.reject(new Error('the file is busy'))
    if (what === 'hold') return new Promise((r) => (window.releasePreview = () => r(p)))
    return Promise.resolve(p)
  },
  summarize: (keys, origin, previewId, prepId) => {
    window.calls.push({ keys, origin, previewId, prepId })
    if (params.get('prep') !== 'hold') return Promise.resolve(keys.length)
    // Reading the sessions: report progress, finish only when released.
    const q = useApp.getState().summaryQueue
    useApp.setState({ summaryQueue: { ...q, preparing: [{ id: prepId, done: 1, total: keys.length }] } })
    return new Promise((r) => (window.releasePrep = () => r(0)))
  },
  summaryCancelPrep: async (id) => { window.cancels.push(id) },
  updateSettings: async (p) => ({ ...useApp.getState().settings, ...p })
}
useApp.setState({
  sessions: ${JSON.stringify(sessions)},
  loaded: true,
  settings: { ...DEFAULT_SETTINGS, summaries: { ...DEFAULT_SETTINGS.summaries, noticeAccepted: true } },
  summarize: { keys: ${JSON.stringify(sessions.map((s) => s.key))}, origin: 'bulk' }
})
window.dialogOpen = () => useApp.getState().summarize !== null

createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null, React.createElement(SummarizeDialog))
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
    cacheDir: resolve(root, 'node_modules/.vite-summarize-dialog-browser'),
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
        name: 'summarize-dialog-browser-fixture',
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
  await (await open('', 60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(query: string, loadTimeout = 15_000): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 900 } })
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[summarize-dialog.browser]', err.message))
  await page.goto(`${origin}/${query}`)
  // The estimate has loaded.
  await page.getByText('About 12K tokens').waitFor()
  page.setDefaultTimeout(5_000)
  return page
}

type Win = { calls: { previewId?: string; prepId?: string }[]; cancels: string[] }
const calls = (page: Page) => page.evaluate(() => (globalThis as unknown as Win).calls)
const send = (page: Page) => page.getByRole('button', { name: /^Summarize 3$/ })

describe('Summarize dialog', { timeout: 30_000 }, () => {
  it('sends the previewed text even after it was hidden', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('')
    try {
      await page.getByRole('button', { name: /Show exactly what is sent/ }).click()
      await page.locator('pre', { hasText: 'text p1' }).waitFor()
      await page.getByRole('button', { name: 'Hide what is sent' }).click()
      await page.locator('pre').waitFor({ state: 'detached' })
      await send(page).click()
      await expect.poll(() => calls(page)).toHaveLength(1)
      const [c] = await calls(page)
      expect(c.previewId).toMatch(/^p1/)
      expect(c.prepId).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      await page.close()
    }
  })

  it('waits for a requested preview, and needs a retry after it failed', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('?preview=fail,hold')
    try {
      await page.getByRole('button', { name: /Show exactly what is sent/ }).click()
      await page.getByText("Couldn't prepare what is sent").waitFor()
      // Hiding the failed text doesn't make it sendable.
      await page.getByRole('button', { name: 'Hide what is sent' }).click()
      expect(await send(page).isDisabled()).toBe(true)
      await page.getByRole('button', { name: /Show exactly what is sent/ }).click()
      await page.getByRole('button', { name: 'Try again' }).click()
      // Loading: still no sending.
      await page.getByText('Preparing what is sent…').waitFor()
      expect(await send(page).isDisabled()).toBe(true)
      await page.evaluate(() =>
        (globalThis as unknown as { releasePreview(): void }).releasePreview()
      )
      await page.locator('pre', { hasText: 'text p2' }).waitFor()
      await expect.poll(() => send(page).isDisabled()).toBe(false)
      await send(page).click()
      await expect.poll(() => calls(page)).toHaveLength(1)
      expect((await calls(page))[0].previewId).toMatch(/^p2/)
    } finally {
      await page.close()
    }
  })

  it('shows preparation progress, and Cancel cancels that request', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('?prep=hold')
    try {
      await send(page).click()
      await page.getByText('Preparing… (1/3)').waitFor()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      const { calls: c, cancels } = await page.evaluate(() => {
        const w = globalThis as unknown as Win
        return { calls: w.calls, cancels: w.cancels }
      })
      expect(cancels).toEqual([c[0].prepId])
      expect(
        await page.evaluate(() => (globalThis as unknown as { dialogOpen(): boolean }).dialogOpen())
      ).toBe(false)
    } finally {
      await page.close()
    }
  })
})
