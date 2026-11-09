// Shared setup for the browser tests (*.browser.test.ts): one Vite config for
// every file, so they all use one pre-bundled dependency cache, built once per
// run by browser-global-setup.ts before any test file starts; Chromium (or
// Chrome / Edge); and page loads that say why when a page isn't ready in time.
//
// Before this, each file had its own config and cache: after `npm install`
// each pre-bundled the same dependencies again while its first page waited
// (about 5 s each, far more under load), and two test runs at once could
// rewrite the same cache under each other's pages.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { createServer, type InlineConfig, type Plugin, type ViteDevServer } from 'vite'

export const ROOT = resolve(import.meta.dirname, '..')
/** The browser tests' own dependency cache (the dev server's is node_modules/.vite). */
export const CACHE_DIR = resolve(ROOT, 'node_modules/.vite-browser-tests')
/** Every file's fixture plugin has this name: plugin names are part of Vite's cache key. */
const PLUGIN_NAME = 'csd-browser-harness'

/**
 * The one Vite config. Only the fixture plugin's hooks differ between files;
 * nothing that goes into the dependency cache's key does.
 */
export function harnessConfig(fixture: Omit<Plugin, 'name'> = {}): InlineConfig {
  return {
    configFile: false,
    root: ROOT,
    cacheDir: CACHE_DIR,
    logLevel: 'error',
    // Find and pre-bundle every dependency of the renderer up front. The test
    // pages are virtual modules Vite can't scan, so without this a fresh cache
    // discovers them while a page loads and answers with "504 Outdated Optimize Dep".
    optimizeDeps: { entries: ['src/renderer/src/**/*.tsx'] },
    resolve: {
      alias: {
        '@': resolve(ROOT, 'src/renderer/src'),
        '@shared': resolve(ROOT, 'src/shared')
      }
    },
    plugins: [react(), tailwindcss(), { name: PLUGIN_NAME, ...fixture }],
    // No file watching or hot reload: a file changed in the repo while the tests
    // run (an edit, git, the formatter) would otherwise reload or restyle the
    // page in the middle of a test.
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false }
  }
}

/**
 * A Vite server whose page `/` runs `harness` (a module's source text, served
 * as the virtual module `virtualId`).
 */
export async function startHarness(opts: {
  virtualId: string
  harness: string
  /** Extra `<head>` markup, e.g. a viewport meta tag. */
  head?: string
}): Promise<{ server: ViteDevServer; origin: string }> {
  const { virtualId, harness, head = '' } = opts
  const server = await createServer(
    harnessConfig({
      resolveId: (id) => (id === virtualId ? `\0${virtualId}` : undefined),
      load: (id) => (id === `\0${virtualId}` ? harness : undefined),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0] !== '/') return next()
          const html = `<!doctype html><html><head>${head}</head><body><div id="root"></div><script type="module" src="/@id/__x00__${virtualId}"></script></body></html>`
          void vite.transformIndexHtml(req.url, html).then((transformed) => {
            res.setHeader('Content-Type', 'text/html')
            res.end(transformed)
          })
        })
      }
    })
  )
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a local port')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

/** Why no browser could be started (the tests are then skipped), when none could. */
export let unavailableReason = ''

export async function launchBrowser(): Promise<Browser | undefined> {
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

// ------------------------------------------------------------ diagnostics

interface Tracker {
  started: number
  pending: Map<string, number>
  failed: string[]
  log: string[]
}
const trackers = new WeakMap<Page, Tracker>()

/** Keep track of a page's requests and console, for waitReady's error message. */
export function trackPage(page: Page, origin: string): Page {
  const t: Tracker = { started: Date.now(), pending: new Map(), failed: [], log: [] }
  const short = (url: string) => url.replace(origin, '').slice(0, 120)
  page.on('request', (r) => t.pending.set(short(r.url()), Date.now()))
  page.on('requestfinished', (r) => {
    t.pending.delete(short(r.url()))
    void r
      .response()
      .then((res) => {
        if (res && res.status() >= 400) t.failed.push(`${res.status()} ${short(r.url())}`)
      })
      .catch(() => undefined)
  })
  page.on('requestfailed', (r) => {
    t.pending.delete(short(r.url()))
    t.failed.push(`${r.failure()?.errorText ?? 'failed'} ${short(r.url())}`)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      t.log.push(`${m.type()}: ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => t.log.push(`pageerror: ${e.message.slice(0, 300)}`))
  trackers.set(page, t)
  return page
}

/**
 * Wait for the element that shows the page is ready. If it doesn't appear in
 * time, the error says what the page was doing: its DOM, the requests still
 * open or failed, and console errors.
 */
export async function waitReady(page: Page, locator: Locator, timeout?: number): Promise<void> {
  try {
    await locator.first().waitFor(timeout === undefined ? {} : { timeout })
  } catch (err) {
    throw new Error(`${(err as Error).message.split('\n')[0]}\n${await describePage(page)}`, {
      cause: err
    })
  }
}

async function describePage(page: Page): Promise<string> {
  const t = trackers.get(page)
  const state = await Promise.race([
    page
      // A string: this file is type-checked without the DOM library.
      .evaluate<unknown>(
        `({
          readyState: document.readyState,
          url: location.pathname + location.search,
          rootChars: document.getElementById('root')?.innerHTML.length ?? -1,
          body: document.body?.innerText.slice(0, 200) ?? ''
        })`
      )
      .catch((e: unknown) => `evaluate failed: ${String(e).split('\n')[0]}`),
    new Promise<string>((r) => setTimeout(() => r('evaluate timed out'), 2000))
  ])
  const now = Date.now()
  const lines = [
    `page state: ${JSON.stringify(state)}`,
    ...(t
      ? [
          `after ${now - t.started} ms; open requests: ${JSON.stringify([...t.pending].map(([u, at]) => `${u} (${now - at} ms)`))}`,
          `failed requests: ${JSON.stringify(t.failed.slice(-10))}`,
          `console: ${JSON.stringify(t.log.slice(-10))}`
        ]
      : [])
  ]
  return lines.join('\n')
}

// ------------------------------------------------------------ one pre-bundle per run

const LOCK = `${CACHE_DIR}.lock`
const LOCK_STALE_MS = 10 * 60_000

/**
 * Hold a lock shared by every test run on this PC (a folder made atomically),
 * so two runs at once never write the cache at the same time. A lock left by
 * a run that died is taken over after ten minutes.
 */
export async function withCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 2 * LOCK_STALE_MS
  for (;;) {
    try {
      await mkdir(LOCK)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const at = await stat(LOCK).then(
        (s) => s.mtimeMs,
        () => 0
      )
      if (at && Date.now() - at > LOCK_STALE_MS) {
        await rm(LOCK, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${LOCK}`, { cause: err })
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  try {
    await writeFile(resolve(LOCK, 'owner'), String(process.pid))
    return await fn()
  } finally {
    // Only our own lock (a stale-lock takeover by another run can't be undone here).
    const owner = await readFile(resolve(LOCK, 'owner'), 'utf8').catch(() => '')
    if (owner === String(process.pid)) await rm(LOCK, { recursive: true, force: true })
  }
}
