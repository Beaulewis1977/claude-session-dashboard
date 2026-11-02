// Browser test (Vite + Playwright, like resume-keys.browser.test.ts): the
// large-session warning in the Resume dialog. It shows the size, the estimate
// with the warm-cache note and the Continue fresh comparison, offers Continue
// fresh / Fork / "Don't warn", and never blocks: Resume anyway is one click.

import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { SessionSummary } from '../src/shared/types'

const root = resolve(import.meta.dirname, '..')
const virtualId = 'virtual:context-warning-browser'

const session: SessionSummary = {
  key: 'browser:s0',
  sessionId: 's0',
  sourceId: 'browser',
  sourceLabel: 'Windows',
  env: 'windows',
  filePath: 'C:/fixture/s0.jsonl',
  originalPath: 'C:/fixture/s0.jsonl',
  availability: 'live',
  projectDir: 'fixture',
  projectName: 'Fixture',
  cwd: 'C:/fixture',
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  toolCallCount: 0,
  malformedLines: 0,
  sizeBytes: 100,
  models: [],
  meta: {
    aiSummary: {
      done: ['Refactored checkout'],
      files: [],
      decisions: [],
      todos: [],
      pickUp: 'Test it.',
      generatedAt: '2026-10-01T12:00:00.000Z',
      messageCount: 2
    }
  },
  context: { tokens: 180_000, from: 'usage', compactions: 1, preCompactTokens: 205_000 },
  title: 'Big session',
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

const small = location.search.includes('small')
// ?expire: the cache runs out 1.5 s after the first preview; later previews are cold.
const expire = location.search.includes('expire')
window.previews = 0
window.launched = []
window.metas = []
const est = (tokens) => ({
  tokens, from: 'usage', windowSize: 200000, windowPct: tokens / 2000, band: tokens >= 150000 ? 'XL' : 'M',
  compactions: 1, preCompactTokens: 205000, model: 'claude-opus-4-5', billing: 'subscription', cache: '1h',
  warmUntil: Date.now() + (expire ? 1500 : 20 * 60000),
  resume: { tokens, costUsd: 0.09, pct5h: 0.18 },
  cold: { tokens, costUsd: 1.8, pct5h: 3.6 },
  perMessage: { tokens, costUsd: 0.09, pct5h: 0.18 },
  fresh: { tokens: 21000, costUsd: 0.21, pct5h: 0.42 },
  basis: 'baseline'
})
const preview = {
  commandLine: 'Start-Process wt.exe', claudeCommand: 'claude --resume s0', terminal: 'wt',
  fellBack: false, cwd: 'C:/fixture', cwdExists: true, willRestore: false,
  restoreImpossible: false, originalPath: 'C:/fixture/s0.jsonl', billingLabel: 'Subscription',
  modelChoice: { modelFrom: 'none', effortFrom: 'none' },
  context: est(small ? 60000 : 180000)
}
window.csd = {
  previewLaunch: async (o) => {
    window.previews++
    if (o.continueFresh) return { ...preview, context: undefined }
    const now = useApp.getState().sessions[0].context?.tokens
    if (now !== undefined && now !== preview.context.tokens) return { ...preview, context: est(now) }
    if (expire && window.previews > 1) {
      const { warmUntil, cold, ...rest } = preview.context
      return { ...preview, context: { ...rest, resume: cold } }
    }
    return preview
  },
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
const start = ${JSON.stringify(session)}
if (small) start.context = { ...start.context, tokens: 60000 }
useApp.setState({ sessions: [start], loaded: true, resume: { key: 'browser:s0', fork: false } })
window.store = useApp

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
    cacheDir: resolve(root, 'node_modules/.vite-context-warning-browser'),
    logLevel: 'error',
    // Pre-bundle the renderer's dependencies (the test page is a virtual module Vite can't scan).
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
        name: 'context-warning-browser-fixture',
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
    // No file watching or hot reload while the tests run.
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

async function open(loadTimeout = 15_000, query = ''): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1000, height: 900 } })
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[context-warning.browser]', err.message))
  await page.goto(origin + query)
  await page.locator('pre', { hasText: 'Start-Process' }).waitFor()
  page.setDefaultTimeout(5_000)
  return page
}

const launched = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { launched: unknown[] }).launched.length)
const metas = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { metas: unknown[] }).metas)
const resumeState = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as { store: { getState: () => { resume: unknown } } }).store.getState()
        .resume
  )
const warning = (page: Page) => page.getByRole('alert').filter({ hasText: 'Large session' })

const previews = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { previews: number }).previews)
const lastLaunch = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as { launched: Record<string, unknown>[] }).launched.at(-1) ?? null
  )

describe('large-session warning', () => {
  it('shows the size, the warm cache and the comparison; Resume anyway is one click', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const card = warning(page)
      await card.waitFor()
      const text = (await card.innerText()).replace(/\s+/g, ' ')
      expect(text).toContain('Large session: about 180K tokens')
      expect(text).toContain('90% of the 200K context window')
      expect(text).toContain('Resume ≈ 0.2% · Continue fresh ≈ 0.4%')
      expect(text).toContain('Cache may still be warm, cheaper if you resume now')
      expect(text).toContain('instead of ≈ 3.6%')
      expect(text).toContain('Compacted once (205K before the last)')
      await card.getByRole('button', { name: /Fork · same size/ }).waitFor()

      // "Don't warn for this session" is saved right away; the warning stays while open.
      await card.getByRole('checkbox').click()
      await expect.poll(() => metas(page)).toEqual([{ noContextWarning: true }])
      await card.waitFor()

      await page.getByRole('button', { name: /Resume anyway/ }).click()
      await expect.poll(() => launched(page)).toBe(1)
    } finally {
      await page.close()
    }
  }, 60_000)

  it('Continue fresh and Fork switch the dialog', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await warning(page)
        .getByRole('button', { name: /Continue fresh/ })
        .click()
      await expect.poll(() => resumeState(page)).toMatchObject({ continueFresh: true })
      expect(await launched(page)).toBe(0)
    } finally {
      await page.close()
    }
    const page2 = await open()
    try {
      await warning(page2).getByRole('button', { name: /Fork/ }).click()
      await expect.poll(() => resumeState(page2)).toMatchObject({ fork: true })
      // Fork doesn't warn; it shows the size.
      await page2.getByText(/Context ≈ 180K tokens/).waitFor()
      expect(await warning(page2).count()).toBe(0)
      expect(await launched(page2)).toBe(0)
    } finally {
      await page2.close()
    }
  }, 60_000)

  it('switching to Fork keeps the choices made in the dialog', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const skipBox = page.getByRole('checkbox', { name: /Skip permission prompts/ })
      // On by default (Settings); turn it off, and pick PowerShell.
      await skipBox.click()
      await page.getByRole('radio', { name: 'PowerShell' }).click()
      await warning(page).getByRole('button', { name: /Fork/ }).click()
      await expect
        .poll(() => resumeState(page))
        .toMatchObject({
          fork: true,
          carry: { skip: false, terminal: 'powershell' }
        })
      await expect
        .poll(() => page.getByRole('checkbox', { name: /Skip permission prompts/ }).isChecked())
        .toBe(false)
      await page.getByRole('button', { name: /^Fork/ }).last().click()
      await expect
        .poll(() => lastLaunch(page))
        .toMatchObject({ fork: true, skipPermissions: false, terminal: 'powershell' })
    } finally {
      await page.close()
    }
  }, 60_000)

  it('a warm cache that runs out while the dialog is open: the estimate is fetched again', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open(15_000, '/?expire=1')
    try {
      await warning(page)
        .getByText(/Cache may still be warm/)
        .waitFor()
      const before = await previews(page)
      await expect.poll(() => previews(page), { timeout: 6_000 }).toBeGreaterThan(before)
      await warning(page)
        .getByText(/Cache may still be warm/)
        .waitFor({ state: 'detached' })
      expect((await warning(page).innerText()).replace(/\s+/g, ' ')).toContain('Resume ≈ 3.6%')
    } finally {
      await page.close()
    }
  }, 60_000)

  it('an open dialog follows the session when its context changes', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    const setTokens = (tokens: number, size: number) =>
      page.evaluate(
        ([tokens, size]) => {
          const store = (
            globalThis as unknown as {
              store: {
                getState: () => {
                  sessions: Record<string, unknown>[]
                  patchSession: (s: unknown) => void
                }
              }
            }
          ).store
          const s = store.getState().sessions[0]
          store.getState().patchSession({
            ...s,
            sizeBytes: size,
            context: { ...(s.context as object), tokens, at: new Date().toISOString() }
          })
        },
        [tokens, size]
      )
    try {
      await warning(page).waitFor()
      // Compacted down to 1k: the warning goes away.
      await setTokens(1_000, 200)
      await page.getByText(/Context ≈ 1K tokens/).waitFor()
      expect(await warning(page).count()).toBe(0)
      // Grown past the threshold again: it comes back.
      await setTokens(170_000, 300)
      await warning(page)
        .getByText(/about 170K tokens/)
        .waitFor()
      expect(await page.getByRole('button', { name: /Resume anyway/ }).count()).toBe(1)
    } finally {
      await page.close()
    }
  }, 60_000)

  it('below the threshold: no warning, just the size line', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open(15_000, '/?small=1')
    try {
      await page.getByText(/Context ≈ 60K tokens/).waitFor()
      expect(await warning(page).count()).toBe(0)
      expect(await page.getByRole('button', { name: /Resume anyway/ }).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 60_000)
})
