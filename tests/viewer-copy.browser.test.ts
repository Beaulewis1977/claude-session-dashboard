import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { ChatMessage, ContentBlock } from '../src/shared/types'

// This is a browser integration test inside the normal Vitest run. It renders
// production components and CSS; only the host app and session data are fixtures.
// Install Chromium with `npx playwright install chromium`, or use an installed
// Chrome/Edge. Machines without any of these explicitly skip the browser cases.
const root = resolve(import.meta.dirname, '..')
const virtualId = 'virtual:viewer-copy-browser'
const fixtures: Record<string, ChatMessage[]> = {}
const user = (id: string, text: string): ChatMessage => ({
  id,
  role: 'user',
  kind: 'prompt',
  blocks: [{ type: 'text', text }]
})
const assistant = (blocks: ContentBlock[]): ChatMessage => ({
  id: 'assistant-message',
  role: 'assistant',
  kind: 'response',
  blocks
})
fixtures.short = [user('user-message', 'Hi'), assistant([{ type: 'text', text: 'Hello' }])]
fixtures.copy = [
  user('user-message', 'Keep this selection'),
  assistant([{ type: 'text', text: '**Hello** from the viewer' }])
]
fixtures.tool = [
  user('user-message', 'Run'),
  assistant([
    {
      type: 'tool_use',
      id: 'tool-message',
      name: 'Bash',
      label: 'Bash: echo hello',
      input: { command: 'echo hello' },
      result: { text: 'hello', isError: false }
    }
  ])
]
fixtures.thinking = [
  user('user-message', 'Think'),
  assistant([{ type: 'thinking', text: 'Consider the result' }])
]
fixtures.image = [
  user('user-message', 'Look'),
  assistant([{ type: 'image', mediaType: 'image/png' }])
]
const groupPlainText: Record<string, string> = {
  tool: 'Bash: echo hello\n\necho hello\n\nhello',
  thinking: 'Consider the result',
  image: '[image]'
}

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { Transcript } from '/src/renderer/src/components/viewer/Transcript.tsx'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { writeClipboard } from '/src/renderer/src/lib/clipboard.ts'
import '/src/renderer/src/styles.css'
const fixtures = ${JSON.stringify(fixtures)}
const fixture = new URLSearchParams(location.search).get('fixture') || 'short'
window.csd = { copyText: writeClipboard }
window.branches = []
createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null,
    React.createElement(Transcript, {
      messages: fixtures[fixture], findQuery: '', className: 'px-3',
      onBranch: (id, mode) => window.branches.push({ id, mode })
    }),
    React.createElement(Toaster, { position: 'bottom-center' })
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
        name: 'viewer-copy-browser-fixture',
        resolveId: (id) => (id === virtualId ? `\0${virtualId}` : undefined),
        load: (id) => (id === `\0${virtualId}` ? harness : undefined),
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split('?')[0] !== '/') return next()
            const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/__x00__${virtualId}"></script></body></html>`
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
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function openFixture(
  fixture: string,
  width = 390,
  clipboard: 'native' | 'fallback' | 'failure' = 'native',
  touch = true
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({
    viewport: { width, height: 844 },
    hasTouch: touch,
    isMobile: touch,
    permissions: ['clipboard-read', 'clipboard-write']
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5_000)
  page.setDefaultNavigationTimeout(10_000)
  if (clipboard !== 'native') {
    await page.addInitScript(`
      window.savedClipboard = navigator.clipboard
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      window.copyEvents = []
      document.addEventListener('copy', () => {
        const active = document.activeElement
        window.copyEvents.push(active instanceof HTMLTextAreaElement
          ? active.value.slice(active.selectionStart, active.selectionEnd)
          : getSelection()?.toString())
      })
      ${clipboard === 'failure' ? 'document.execCommand = () => false' : ''}
    `)
  }
  await page.goto(`${origin}/?fixture=${fixture}`)
  await page.getByRole('button', { name: 'Copy message', exact: true }).first().waitFor()
  // Wait for the real Tailwind touch variant, rather than racing stylesheet load.
  expect(await page.evaluate("matchMedia('(hover: none)').matches")).toBe(touch)
  return { context, page }
}

async function capturePreview(page: Page, name: string): Promise<void> {
  if (process.env.CSD_VIEWER_SCREENSHOTS !== '1') return
  const directory = resolve(root, '.fixtures-data/pr6-review')
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: resolve(directory, `viewer-copy-${name}.png`), fullPage: true })
}

async function expectInViewport(page: Page): Promise<void> {
  const buttons = page.getByRole('button').filter({ visible: true })
  const width = page.viewportSize()!.width
  for (let index = 0; index < (await buttons.count()); index++) {
    const button = buttons.nth(index)
    const bounds = await button.boundingBox()
    const label = (await button.getAttribute('aria-label')) ?? undefined
    expect(bounds, label).not.toBeNull()
    expect(bounds!.x, label).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width, label).toBeLessThanOrEqual(width)
  }
}

describe('viewer copy in a real phone-size browser', { timeout: 20_000 }, () => {
  for (const [width, touch] of [
    [320, true],
    [390, true],
    [320, false],
    [390, false]
  ] as const) {
    it(`keeps one-word user and assistant actions within ${width}px (${touch ? 'touch' : 'mouse'})`, async ({
      skip
    }) => {
      if (!browser) skip(unavailableReason)
      const { context, page } = await openFixture('short', width, 'native', touch)
      try {
        expect(await page.getByRole('button', { name: 'Copy message', exact: true }).count()).toBe(
          2
        )
        await expectInViewport(page)
        if (touch) {
          for (const [index, label] of ['You', 'Claude'].entries()) {
            const heading = await page.getByText(label, { exact: true }).boundingBox()
            const copy = await page
              .getByRole('button', { name: 'Copy message', exact: true })
              .nth(index)
              .boundingBox()
            expect(copy!.y, `${label} toolbar overlaps its heading`).toBeGreaterThanOrEqual(
              heading!.y + heading!.height
            )
          }
        }
        await capturePreview(page, `short-${width}-${touch ? 'touch' : 'mouse'}`)
        for (const menu of await page
          .getByRole('button', { name: 'More message actions', exact: true })
          .all()) {
          await menu.click()
          expect(await page.getByRole('menuitem', { name: 'Copy as plain text' }).isVisible()).toBe(
            true
          )
          expect(
            await page.getByRole('menuitem', { name: 'Branch from here', exact: true }).isVisible()
          ).toBe(true)
          await page.keyboard.press('Escape')
        }
      } finally {
        await context.close()
      }
    })
  }

  for (const fixture of ['tool', 'thinking', 'image']) {
    it(`offers touch copy and branch actions for assistant ${fixture} groups`, async ({ skip }) => {
      if (!browser) skip(unavailableReason)
      const { context, page } = await openFixture(fixture)
      try {
        const menus = page.getByRole('button', { name: 'More message actions', exact: true })
        expect(await menus.count()).toBe(2)
        await expectInViewport(page)
        await capturePreview(page, fixture)
        await menus.nth(1).click()
        expect(await page.getByRole('menuitem', { name: 'Copy as plain text' }).isVisible()).toBe(
          true
        )
        expect(await page.getByRole('menuitem', { name: 'Copy as Markdown' }).isVisible()).toBe(
          true
        )
        await page.getByRole('menuitem', { name: 'Copy as plain text' }).click()
        await page.getByText('Copied ✓', { exact: true }).waitFor()
        const copied = await page.evaluate<string>('navigator.clipboard.readText()')
        expect(copied.replace(/\r\n/g, '\n')).toBe(groupPlainText[fixture])
        await menus.nth(1).click()
        await page.getByRole('menuitem', { name: 'Branch from here', exact: true }).click()
        expect(await page.evaluate('window.branches')).toEqual([
          { id: 'assistant-message', mode: 'include' }
        ])
      } finally {
        await context.close()
      }
    })
  }

  it('copies from the real Radix dropdown when navigator.clipboard is unavailable', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const { context, page } = await openFixture('copy', 390, 'fallback')
    try {
      const trigger = page.getByRole('button', { name: 'More message actions', exact: true }).nth(1)
      await trigger.click()
      await page.getByRole('menuitem', { name: 'Copy as plain text' }).click()
      await page.getByText('Copied ✓', { exact: true }).waitFor()
      expect(await page.evaluate('window.savedClipboard.readText()')).toBe('Hello from the viewer')
      expect(await page.evaluate('window.copyEvents')).toEqual(['Hello from the viewer'])
      await page.getByRole('menu').waitFor({ state: 'hidden' })
      expect(await page.getByRole('menu').count()).toBe(0)
      await expect
        .poll(() => trigger.evaluate((element) => element === element.ownerDocument.activeElement))
        .toBe(true)
      // Repeat through the same menu to cover focus-scope cleanup after copying.
      await trigger.click()
      await page.getByRole('menuitem', { name: 'Copy as Markdown' }).click()
      await page.getByRole('menu').waitFor({ state: 'hidden' })
      await page.waitForFunction('window.copyEvents.length === 2')
      expect(await page.evaluate('window.savedClipboard.readText()')).toBe(
        '**Hello** from the viewer'
      )
    } finally {
      await context.close()
    }
  })

  it('restores selected transcript text and button focus after a fallback copy', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const { context, page } = await openFixture('copy', 390, 'fallback')
    try {
      const copy = page.getByRole('button', { name: 'Copy message', exact: true }).nth(1)
      await copy.focus()
      await page.evaluate(`(() => {
        const element = [...document.querySelectorAll('p')].find(element => element.textContent === 'Keep this selection')
        const range = document.createRange()
        range.selectNodeContents(element)
        getSelection().removeAllRanges()
        getSelection().addRange(range)
      })()`)
      expect(await page.evaluate('getSelection().toString()')).toBe('Keep this selection')
      // Keyboard activation preserves a user's existing transcript selection.
      await page.keyboard.press('Enter')
      await page.getByText('Copied ✓', { exact: true }).waitFor()
      expect(await page.evaluate('getSelection().toString()')).toBe('Keep this selection')
      expect(
        await copy.evaluate((element) => element === element.ownerDocument.activeElement)
      ).toBe(true)
      expect(await page.evaluate('document.querySelectorAll("textarea").length')).toBe(0)
    } finally {
      await context.close()
    }
  })

  it('preserves backward transcript selection endpoints after a fallback copy', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const { context, page } = await openFixture('copy', 390, 'fallback')
    try {
      const copy = page.getByRole('button', { name: 'Copy message', exact: true }).nth(1)
      await copy.focus()
      const before = await page
        .getByText('Hello from the viewer', { exact: true })
        .evaluateHandle((element) => {
          const anchorNode = element.lastChild
          const focusNode = element.querySelector('strong')?.firstChild
          const selection = element.ownerDocument.getSelection()
          if (!anchorNode || !focusNode || !selection) {
            throw new Error('Expected transcript text nodes and a browser selection')
          }
          selection.setBaseAndExtent(anchorNode, 5, focusNode, 1)
          return {
            anchorNode,
            anchorOffset: selection.anchorOffset,
            focusNode,
            focusOffset: selection.focusOffset
          }
        })
      expect(await page.evaluate('getSelection().toString()')).toBe('ello from')
      await page.keyboard.press('Enter')
      await page.getByText('Copied ✓', { exact: true }).waitFor()
      expect(await page.evaluate('window.savedClipboard.readText()')).toBe(
        '**Hello** from the viewer'
      )
      expect(await page.evaluate('getSelection().toString()')).toBe('ello from')
      expect(
        await before.evaluate((saved) => {
          const selection = saved.anchorNode.ownerDocument?.getSelection()
          if (!selection) throw new Error('Expected the saved transcript selection document')
          return {
            anchorNode: selection.anchorNode === saved.anchorNode,
            anchorOffset: selection.anchorOffset === saved.anchorOffset,
            focusNode: selection.focusNode === saved.focusNode,
            focusOffset: selection.focusOffset === saved.focusOffset
          }
        })
      ).toEqual({ anchorNode: true, anchorOffset: true, focusNode: true, focusOffset: true })
      expect(
        await copy.evaluate((element) => element === element.ownerDocument.activeElement)
      ).toBe(true)
      await before.dispose()
    } finally {
      await context.close()
    }
  })

  for (const tag of ['input', 'textarea']) {
    it(`restores a focused ${tag} selection and scroll after fallback copy`, async ({ skip }) => {
      if (!browser) skip(unavailableReason)
      const { context, page } = await openFixture('copy', 390, 'fallback')
      try {
        const before = await page.evaluate(`(() => {
          const editor = document.createElement('${tag}')
          editor.id = 'focused-editor'
          editor.value = '0123456789'.repeat(50)
          editor.setAttribute('wrap', 'off')
          editor.style.cssText = 'position:fixed;top:0;left:0;width:80px;height:24px;white-space:pre;overflow:auto'
          document.body.appendChild(editor)
          editor.focus()
          editor.setSelectionRange(2, 8, 'backward')
          editor.scrollLeft = 70
          editor.addEventListener('keydown', event => {
            if (event.key === 'F8') void window.csd.copyText('editor copy')
          })
          return { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, scrollLeft: editor.scrollLeft }
        })()`)
        await page.keyboard.press('F8')
        await page.waitForFunction('window.copyEvents.length === 1')
        const after = await page.evaluate(`(() => {
          const editor = document.getElementById('focused-editor')
          return { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, scrollLeft: editor.scrollLeft }
        })()`)
        expect(after).toEqual(before)
        expect(await page.evaluate('document.activeElement.id')).toBe('focused-editor')
        expect(await page.evaluate('window.savedClipboard.readText()')).toBe('editor copy')
        expect(
          await page.evaluate('document.querySelectorAll("textarea:not(#focused-editor)").length')
        ).toBe(0)
      } finally {
        await context.close()
      }
    })
  }

  it('shows a failure toast instead of a success state when the browser refuses copy', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const { context, page } = await openFixture('copy', 390, 'failure')
    try {
      await page.getByRole('button', { name: 'Copy message', exact: true }).nth(1).click()
      await page.getByText("Couldn't copy, select the text manually", { exact: true }).waitFor()
      expect(await page.getByText('Copied ✓', { exact: true }).count()).toBe(0)
      expect(
        await page.getByRole('button', { name: 'Copy message', exact: true }).nth(1).innerText()
      ).toBe('Copy')
      expect(await page.evaluate('document.querySelectorAll("textarea").length')).toBe(0)
    } finally {
      await context.close()
    }
  })
})
