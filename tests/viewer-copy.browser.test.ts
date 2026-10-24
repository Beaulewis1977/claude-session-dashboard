import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { ChatMessage, ContentBlock, SessionSummary } from '../src/shared/types'

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
// Every message type on one phone screen: one-word messages, a long reply, and a
// tool call whose output is far taller than the screen.
const longReply = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1} of a long answer, with enough words to wrap on a phone.`
).join('\n\n')
const longOutput = Array.from({ length: 200 }, (_, i) => `output line ${i + 1}`).join('\n')
fixtures.phone = [
  user('user-one-word', 'Hi'),
  {
    id: 'assistant-one-word',
    role: 'assistant',
    kind: 'response',
    blocks: [{ type: 'text', text: 'Yes' }]
  },
  user('user-long-ask', 'Explain it'),
  {
    id: 'assistant-long',
    role: 'assistant',
    kind: 'response',
    blocks: [{ type: 'text', text: longReply }]
  },
  user('user-run', 'Run it'),
  {
    id: 'assistant-tool',
    role: 'assistant',
    kind: 'response',
    blocks: [
      {
        type: 'tool_use',
        id: 'tool-long',
        name: 'Bash',
        label: 'Bash: seq 200',
        input: { command: 'seq 200' },
        result: { text: longOutput, isError: false }
      }
    ]
  }
]
fixtures.find = [
  user('user-find', 'Please copy this sentence.'),
  assistant([
    { type: 'text', text: 'A real copy match.\n\n```js\nconst copy_value = true\n```' },
    {
      type: 'tool_use',
      id: 'tool-find',
      name: 'Bash',
      label: 'Bash: printf payload',
      input: { command: "printf 'copy input payload'" },
      result: { text: 'copy output payload', isError: false }
    },
    {
      type: 'tool_result',
      toolUseId: 'orphan-find',
      result: { text: 'copy orphan output', isError: false }
    }
  ])
]
const session: SessionSummary = {
  key: 'browser:session',
  sessionId: 'session',
  sourceId: 'browser',
  sourceLabel: 'Windows',
  env: 'windows',
  filePath: 'C:\\fixture\\session.jsonl',
  originalPath: 'C:\\fixture\\session.jsonl',
  availability: 'live',
  projectDir: 'fixture',
  projectName: 'Fixture',
  cwd: 'C:\\fixture',
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  toolCallCount: 1,
  malformedLines: 0,
  sizeBytes: 100,
  models: [],
  meta: {},
  title: 'Browser fixture',
  titleSource: 'name',
  source: 'terminal-windows',
  sourceReason: 'Browser fixture'
}
const groupPlainText: Record<string, string> = {
  tool: 'Bash: echo hello\n\necho hello\n\nhello',
  thinking: 'Consider the result',
  image: '[image]'
}

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster, toast } from 'sonner'
import { Transcript } from '/src/renderer/src/components/viewer/Transcript.tsx'
import { SessionViewer } from '/src/renderer/src/components/viewer/SessionViewer.tsx'
import { SessionScreen } from '/src/renderer/src/mobile/SessionScreen.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { writeClipboard } from '/src/renderer/src/lib/clipboard.ts'
import '/src/renderer/src/styles.css'
const fixtures = ${JSON.stringify(fixtures)}
const fixture = new URLSearchParams(location.search).get('fixture') || 'short'
const screen = new URLSearchParams(location.search).get('screen') || 'transcript'
const session = ${JSON.stringify(session)}
window.csd = {
  copyText: writeClipboard,
  getSession: async () => ({ summary: session, messages: fixtures[fixture] }),
  getSessionUsage: async () => null,
  onUsageChanged: () => () => {}
}
useApp.setState({ sessions: [session] })
window.branches = []
window.dismissToasts = () => toast.dismiss()
// A scroll container like the app's, so sticky action rows behave as on a phone.
createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null,
    screen === 'mobile'
      ? React.createElement(SessionScreen, { session })
      : screen === 'desktop'
        ? React.createElement('div', { style: { height: '100vh' } },
            React.createElement(SessionViewer, { session, allTags: [] }))
        : React.createElement('div', { id: 'scroller', style: { height: '100vh', overflowY: 'auto' } },
            React.createElement(Transcript, {
              messages: fixtures[fixture], findQuery: '', className: 'px-3',
              onBranch: (id, mode) => window.branches.push({ id, mode })
            })
          ),
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
  touch = true,
  screen: 'transcript' | 'mobile' | 'desktop' = 'transcript'
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
  await page.goto(`${origin}/?fixture=${fixture}&screen=${screen}`)
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

// ---------------------------------------------------------------------------
// Touch: every message and every expanded tool output has a Copy button that is
// visible, at least 40px, inside the screen and not covered, wherever you are.

type Box = { x: number; y: number; width: number; height: number }

/** The button is shown (not faded), 40px or larger, fully on screen and the topmost thing at its centre. */
async function expectTappable(page: Page, button: Locator, what: string): Promise<Box> {
  const { width, height } = page.viewportSize()!
  const box = (await button.boundingBox())!
  expect(box, what).not.toBeNull()
  expect(box.width, `${what}: width`).toBeGreaterThanOrEqual(40)
  expect(box.height, `${what}: height`).toBeGreaterThanOrEqual(40)
  expect(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(0)
  expect(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(width)
  expect(box.y + box.height, `${what}: bottom edge`).toBeLessThanOrEqual(height)
  // Let enter animations (expanding a tool call fades in) finish first.
  // (Page-side code goes through `el`, as this file is type-checked without DOM types.)
  await button.evaluate((el) =>
    Promise.all(
      el.ownerDocument
        .getAnimations()
        .map((a: { finished: Promise<unknown> }) => a.finished.catch(() => undefined))
    )
  )
  const state = await button.evaluate((el) => {
    const view = el.ownerDocument.defaultView!
    let opacity = 1
    for (let n = el; n; n = n.parentElement) opacity *= Number(view.getComputedStyle(n).opacity)
    const r = el.getBoundingClientRect()
    const top = el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    const name = top
      ? `${top.tagName.toLowerCase()}.${[...top.classList].slice(0, 4).join('.')} "${(top.textContent ?? '').slice(0, 30)}"`
      : 'nothing'
    return { opacity, onTop: !!top && el.contains(top), top: name }
  })
  expect(state.opacity, `${what}: opacity`).toBeGreaterThanOrEqual(0.9)
  expect(state.onTop, `${what}: covered by ${state.top}`).toBe(true)
  return box
}

/** Scrolls the transcript so the element's vertical middle sits at the screen's middle. */
async function scrollToMiddleOf(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    const scroller = el.ownerDocument.getElementById('scroller')!
    const r = el.getBoundingClientRect()
    scroller.scrollTop += r.top + r.height / 2 - scroller.clientHeight / 2
  })
}

async function copyAndRead(page: Page, button: Locator): Promise<string> {
  await page.evaluate('navigator.clipboard.writeText("")')
  await button.tap()
  await page.getByText('Copied ✓', { exact: true }).first().waitFor()
  const text = await page.evaluate<string>('navigator.clipboard.readText()')
  // Clear the toast so it can't cover the next button being checked.
  await page.evaluate('window.dismissToasts()')
  await page.locator('[data-sonner-toast]').first().waitFor({ state: 'detached' })
  return text.replace(/\r\n/g, '\n')
}

describe('session Find with production screens', { timeout: 30_000 }, () => {
  for (const screen of ['mobile', 'desktop'] as const) {
    for (const touch of [true, false]) {
      it(`${screen}: finds content rather than visible or hidden copy controls (${touch ? 'touch' : 'mouse'})`, async ({
        skip
      }) => {
        if (!browser) skip(unavailableReason)
        const { context, page } = await openFixture(
          'find',
          screen === 'mobile' ? 390 : 1024,
          'native',
          touch,
          screen
        )
        try {
          expect(await page.evaluate("'highlights' in CSS")).toBe(true)
          await page.getByRole('button', { name: 'Find in session', exact: true }).click()
          await page.getByRole('textbox', { name: 'Find in session', exact: true }).fill('copy')
          await expect.poll(() => page.getByText(/^\d+ of \d+$/).textContent()).toBe('1 of 6')

          // Both layouts exist in the real tool group. Find must skip the
          // hidden row as well as the active controls and code-block buttons.
          const controls = await page
            .locator('[data-message-actions]')
            .evaluateAll((elements) =>
              elements.map((el) => el.ownerDocument.defaultView!.getComputedStyle(el).display)
            )
          expect(controls).toContain('none')
          expect(controls.filter((display) => display !== 'none').length).toBeGreaterThan(0)
          expect(await page.locator('button[aria-label="Copy input"]').count()).toBe(1)
          expect(await page.locator('button[aria-label="Copy output"]').count()).toBe(2)
          expect(await page.locator('.code-block button[aria-label="Copy"]').count()).toBe(2)

          const matches = await page.evaluate<
            { text: string; content: string | null; inControl: boolean }[]
          >(`Array.from(CSS.highlights.get('find') || [], range => ({
            text: range.toString(),
            content: range.startContainer.parentElement.closest('p, pre')?.textContent.trim() ?? null,
            inControl: !!range.startContainer.parentElement.closest('button, [data-message-actions]')
          }))`)
          expect(matches).toEqual(
            [
              'Please copy this sentence.',
              'A real copy match.',
              'const copy_value = true',
              "printf 'copy input payload'",
              'copy output payload',
              'copy orphan output'
            ].map((content) => ({ text: 'copy', content, inControl: false }))
          )
          expect(await page.evaluate("CSS.highlights.get('find-current').size")).toBe(1)

          await page.getByRole('button', { name: 'Close find', exact: true }).click()
          await expect
            .poll(() =>
              page.evaluate("CSS.highlights.has('find') || CSS.highlights.has('find-current')")
            )
            .toBe(false)
        } finally {
          await context.close()
        }
      })
    }

    for (const query of ['', 'output line 100']) {
      it(`${screen}: keeps Copy output tappable midway through long output with Find ${query ? 'searching' : 'open and empty'}`, async ({
        skip
      }) => {
        if (!browser) skip(unavailableReason)
        const { context, page } = await openFixture(
          'phone',
          screen === 'mobile' ? 390 : 1024,
          'native',
          true,
          screen
        )
        try {
          await page.getByRole('button', { name: /Bash/ }).first().tap()
          await page.getByRole('button', { name: /^Show all/ }).tap()
          await page.getByRole('button', { name: 'Find in session', exact: true }).click()
          const findInput = page.getByRole('textbox', { name: 'Find in session', exact: true })
          if (query) {
            await findInput.fill(query)
            await expect.poll(() => page.getByText(/^\d+ of \d+$/).textContent()).toBe('1 of 1')
          }
          const output = page.locator('pre', { hasText: 'output line 200' })
          expect((await output.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height)
          await output.evaluate((el) => {
            let scroller = el.parentElement!
            const view = el.ownerDocument.defaultView!
            while (view.getComputedStyle(scroller).overflowY !== 'auto') {
              if (!scroller.parentElement)
                throw new Error('No production transcript scroll container')
              scroller = scroller.parentElement
            }
            const box = scroller.getBoundingClientRect()
            const result = el.getBoundingClientRect()
            scroller.scrollTop += result.top + result.height / 2 - box.top - box.height / 2
          })
          const copy = page.getByRole('button', { name: 'Copy output', exact: true })
          await expectTappable(page, copy, `${screen} Copy output with Find open`)
          const findBounds = (await findInput.locator('xpath=../..').boundingBox())!
          const copyBounds = (await copy.boundingBox())!
          expect(copyBounds.y, 'Copy output clears the Find bar').toBeGreaterThanOrEqual(
            findBounds.y + findBounds.height
          )

          // Closing Find must release the reserved top space immediately,
          // including when its query has always been empty.
          await page.getByRole('button', { name: 'Close find', exact: true }).click()
          await expectTappable(page, copy, `${screen} Copy output after closing Find`)
          const closedBounds = (await copy.boundingBox())!
          expect(copyBounds.y - closedBounds.y).toBeGreaterThanOrEqual(48)
        } finally {
          await context.close()
        }
      })
    }
  }
})

describe('touch copy buttons are visible and tappable', { timeout: 30_000 }, () => {
  for (const width of [320, 390]) {
    it(`one-word, long and tool messages at ${width}px`, async ({ skip }) => {
      if (!browser) skip(unavailableReason)
      const { context, page } = await openFixture('phone', width)
      try {
        const copies = page.getByRole('button', { name: 'Copy message', exact: true })
        // You · Claude · You · Claude (long) · You · Claude (tool group).
        expect(await copies.count()).toBe(6)
        const bubbles = ['.bg-user-bubble', '.bg-assistant-bubble']

        // One-word messages: the row fits inside the bubble and the screen.
        for (const [index, selector, text] of [
          [0, bubbles[0], 'Hi'],
          [1, bubbles[1], 'Yes']
        ] as const) {
          const bubble = page.locator(selector).first()
          await bubble.scrollIntoViewIfNeeded()
          const box = await expectTappable(page, copies.nth(index), `one-word "${text}" Copy`)
          const outer = (await bubble.boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(outer.x)
          expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width)
          await expectTappable(
            page,
            bubble.getByRole('button', { name: 'More message actions', exact: true }),
            `one-word "${text}" ⋯`
          )
          expect(await copyAndRead(page, copies.nth(index))).toBe(text)
        }

        // A long reply, read from the middle: its Copy is pinned on screen.
        const long = page.locator(bubbles[1]).nth(1)
        expect((await long.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height)
        await scrollToMiddleOf(long)
        await expectTappable(page, copies.nth(3), 'long reply Copy (middle)')
        await capturePreview(page, `phone-long-middle-${width}`)
        expect(await copyAndRead(page, copies.nth(3))).toBe(longReply)
        // ...and at its very end.
        await long.evaluate((el) => el.scrollIntoView({ block: 'end' }))
        await expectTappable(page, copies.nth(3), 'long reply Copy (end)')

        // An expanded tool call with output taller than the screen.
        await page.getByRole('button', { name: /Bash/ }).first().tap()
        await page.getByRole('button', { name: /^Show all/ }).tap()
        const output = page.locator('pre', { hasText: 'output line 200' })
        expect((await output.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height)
        await scrollToMiddleOf(output)
        const copyOutput = page.getByRole('button', { name: 'Copy output', exact: true })
        await expectTappable(page, copyOutput, 'Copy output (middle of output)')
        await expectTappable(
          page,
          page.getByRole('button', { name: 'Copy input', exact: true }),
          'Copy input (middle of output)'
        )
        await expectTappable(page, copies.nth(5), 'tool group Copy (middle of output)')
        await capturePreview(page, `phone-tool-middle-${width}`)
        expect(await copyAndRead(page, copyOutput)).toBe(longOutput)
      } finally {
        await context.close()
      }
    })
  }

  it('stays hover-based with a mouse', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const { context, page } = await openFixture('phone', 1024, 'native', false)
    try {
      const copy = page.getByRole('button', { name: 'Copy message', exact: true }).first()
      const pill = copy.locator('xpath=..')
      expect(
        await pill.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).opacity)
      ).toBe('0')
      expect(
        await pill.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).position)
      ).toBe('absolute')
      await page.locator('.bg-user-bubble').first().hover()
      await expect
        .poll(() =>
          pill.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).opacity)
        )
        .toBe('1')
      expect((await copy.boundingBox())!.height).toBeLessThan(40)
    } finally {
      await context.close()
    }
  })
})
