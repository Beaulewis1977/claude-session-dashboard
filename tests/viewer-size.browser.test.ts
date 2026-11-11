// Browser test: the viewer draws a session in full or only near the screen
// by how much it draws (not by its number of turns), and long tool inputs
// arrive cut, with "Show full", copies and find getting the full text.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ViteDevServer } from 'vite'
import type { ChatMessage, SessionSummary } from '../src/shared/types'
import {
  launchBrowser,
  startHarness,
  trackPage,
  unavailableReason,
  waitReady
} from './browser-harness'

const virtualId = 'virtual:viewer-size-browser'

const at = (i: number, s = 0) => new Date(Date.UTC(2026, 9, 1, 9, i, s)).toISOString()

// 30 turns of short questions and answers: a medium session, drawn in full.
const medium: ChatMessage[] = []
for (let i = 0; i < 15; i++) {
  medium.push({
    id: `u${i}`,
    role: 'user',
    kind: 'prompt',
    timestamp: at(i),
    blocks: [{ type: 'text', text: `Question ${i}` }]
  })
  medium.push({
    id: `a${i}`,
    role: 'assistant',
    kind: 'response',
    timestamp: at(i, 30),
    blocks: [
      { type: 'text', text: `Answer ${i}.` },
      {
        type: 'tool_use',
        id: `m${i}`,
        name: 'Bash',
        label: `Bash: ls ${i}`,
        input: { command: `ls ${i}` },
        result: { text: `out ${i}`, isError: false }
      }
    ]
  })
}

// 12 turns, each answer a long code block: few turns, a big DOM.
const code = `\`\`\`ts\n${Array.from({ length: 120 }, (_, i) => `const v${i} = f(${i}) + g('x')`).join('\n')}\n\`\`\``
const heavy: ChatMessage[] = []
for (let i = 0; i < 6; i++) {
  heavy.push({
    id: `u${i}`,
    role: 'user',
    kind: 'prompt',
    timestamp: at(i),
    blocks: [{ type: 'text', text: `Show me ${i}` }]
  })
  heavy.push({
    id: `a${i}`,
    role: 'assistant',
    kind: 'response',
    timestamp: at(i, 30),
    blocks: [{ type: 'text', text: code }]
  })
}

// A Write whose content is far past the input cut, its end holding "inputneedle".
const content = `${Array.from({ length: 900 }, (_, i) => `line ${i} of the file`).join('\n')}\n// inputneedle`
medium.push({
  id: 'w',
  role: 'assistant',
  kind: 'response',
  timestamp: at(40),
  blocks: [
    {
      type: 'tool_use',
      id: 'write1',
      name: 'Write',
      label: 'Write big.ts',
      input: { file_path: 'C:\\fixture\\big.ts', content },
      result: { text: 'File created', isError: false }
    },
    // A long command: "twoneedle" in the part sent and again past the cut, and a
    // quoted, escaped path past the cut.
    {
      type: 'tool_use',
      id: 'bash1',
      name: 'Bash',
      label: 'Bash: long command',
      input: {
        command: `echo twoneedle && ${'x'.repeat(7000)} && echo twoneedle "quoted" > C:\\tmp\\esc.txt`
      },
      result: { text: 'ok', isError: false }
    }
  ]
})

const session = (n: number): SessionSummary => ({
  key: 'browser:size',
  sessionId: 'size',
  sourceId: 'browser',
  sourceLabel: 'Windows',
  env: 'windows',
  filePath: 'C:\\fixture\\size.jsonl',
  originalPath: 'C:\\fixture\\size.jsonl',
  availability: 'live',
  projectDir: 'fixture',
  projectName: 'Fixture',
  cwd: 'C:\\fixture',
  messageCount: n,
  userMessageCount: n / 2,
  assistantMessageCount: n / 2,
  toolCallCount: 0,
  malformedLines: 0,
  sizeBytes: 100,
  models: [],
  meta: {},
  title: 'Size session',
  titleSource: 'name',
  source: 'terminal-windows',
  sourceReason: 'Browser fixture'
})

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SessionViewer } from '/src/renderer/src/components/viewer/SessionViewer.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { cutForViewer, matchesInCut, toolInputOf, toolResultOf } from '/src/shared/transcript-cut.ts'
import '/src/renderer/src/styles.css'
const sets = { medium: ${JSON.stringify(medium)}, heavy: ${JSON.stringify(heavy)} }
// #lazy: the medium session sent as a very long one would be (placeholders).
const lazy = location.hash === '#lazy'
const messages = sets[location.hash.slice(1)] ?? sets.medium
const sent = cutForViewer(messages, lazy ? 1000 : undefined)
const session = { ...${JSON.stringify(session(0))}, messageCount: messages.length }
window.calls = []
window.csd = {
  copyText: async (text) => { window.copied = text; return true },
  getSession: async (key, opts) => {
    window.calls.push(['getSession', !!(opts && opts.cut)])
    return { summary: session, messages: opts && opts.cut ? sent.messages : messages }
  },
  getToolResult: async (key, id) => toolResultOf(messages, id) ?? null,
  getToolInput: async (key, id) => {
    window.calls.push(['getToolInput', id])
    return toolInputOf(messages, id) ?? null
  },
  findInCut: async (key, q) => {
    window.calls.push(['findInCut', q])
    return matchesInCut(messages, q, sent.limits)
  },
  getSessionUsage: async () => null,
  getContextEstimate: async () => null,
  onLimitsChanged: () => () => {},
  onUsageChanged: () => () => {}
}
useApp.setState({ sessions: [session] })
createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null,
    React.createElement('div', { style: { height: '100vh' } },
      React.createElement(SessionViewer, { session, allTags: [] })))
)
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  ;({ server, origin } = await startHarness({ virtualId, harness }))
  await (await open('medium', 60_000)).close()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(set: 'medium' | 'heavy' | 'lazy', loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(await browser!.newPage({ viewport: { width: 1100, height: 800 } }), origin)
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[viewer-size.browser]', err.message))
  await page.goto(`${origin}/#${set}`)
  await waitReady(page, page.locator('[data-msg-ids]').first())
  page.setDefaultTimeout(5_000)
  return page
}

const virtualized = (page: Page) => page.locator('[data-index]').count()

describe('drawing a session in full or near the screen', { timeout: 30_000 }, () => {
  it('draws a medium session (30 turns, a small DOM) in full, so a selection can span it', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('medium')
    try {
      expect(await virtualized(page)).toBe(0)
      expect(await page.locator('[data-msg-ids]').count()).toBe(30)
      // A selection from the first turn to the last holds both.
      const text = await page.evaluate<string>(`(() => {
        const r = document.createRange()
        r.setStartBefore(document.querySelector('[data-msg-ids="u0"]'))
        r.setEndAfter(document.querySelector('[data-msg-ids~="a14"]'))
        const s = getSelection(); s.removeAllRanges(); s.addRange(r)
        return s.toString()
      })()`)
      expect(text).toContain('Question 0')
      expect(text).toContain('Answer 14.')
    } finally {
      await page.close()
    }
  })

  it('draws a short session with a big DOM (12 turns of long code) near the screen only', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('heavy')
    try {
      await expect.poll(() => virtualized(page)).toBeGreaterThan(0)
      expect(await page.locator('[data-msg-ids]').count()).toBeLessThan(12)
    } finally {
      await page.close()
    }
  })
})

describe('a long tool input', { timeout: 30_000 }, () => {
  const writeCall = (page: Page) => page.locator('[data-msg-ids~="w"]')

  it('arrives cut, says its real size and shows in full on Show full', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('medium')
    try {
      const turn = writeCall(page)
      await turn.scrollIntoViewIfNeeded()
      await turn.getByRole('button', { name: /big\.ts/ }).click()
      const code = turn.locator('pre').first()
      expect(await code.innerText()).not.toContain('inputneedle')
      const showFull = turn.getByRole('button', { name: /Show full/ })
      expect(await showFull.innerText()).toContain(`${content.length.toLocaleString()} chars`)
      expect(await showFull.innerText()).toContain('901 lines')
      await showFull.click()
      await expect.poll(() => turn.locator('pre').first().innerText()).toContain('inputneedle')
      expect(await page.evaluate<unknown[]>('window.calls')).toContainEqual([
        'getToolInput',
        'write1'
      ])
      await turn.getByRole('button', { name: 'Show less' }).click()
      await expect.poll(() => turn.locator('pre').first().innerText()).not.toContain('inputneedle')
    } finally {
      await page.close()
    }
  })

  it('Copy input and the message Copy copy the full input', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('medium')
    try {
      const turn = writeCall(page)
      await turn.scrollIntoViewIfNeeded()
      await turn.getByRole('button', { name: /big\.ts/ }).click()
      await turn.getByRole('button', { name: 'Copy input' }).click()
      await expect.poll(() => page.evaluate<string>('window.copied || ""')).toBe(content)
      await page.evaluate('window.copied = ""')
      await turn
        .locator('[data-message-actions]')
        .last()
        .getByRole('button', { name: 'Copy message' })
        .click()
      await expect.poll(() => page.evaluate<string>('window.copied || ""')).toContain('inputneedle')
    } finally {
      await page.close()
    }
  })

  it('find past the cut opens the input in full and counts the match', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('medium')
    try {
      await page.keyboard.press('Control+f')
      await page.getByRole('textbox', { name: 'Find in session' }).fill('inputneedle')
      await expect.poll(() => page.locator('.sr-only[aria-live]').innerText()).toBe('1 matches')
      expect(await page.evaluate<unknown[]>('window.calls')).toContainEqual([
        'findInCut',
        'inputneedle'
      ])
      await expect
        .poll(() => writeCall(page).locator('pre').first().innerText())
        .toContain('inputneedle')
    } finally {
      await page.close()
    }
  })

  it('find counts a later match past the cut when the part sent has one too', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('medium')
    try {
      await page.keyboard.press('Control+f')
      await page.getByRole('textbox', { name: 'Find in session' }).fill('twoneedle')
      await expect.poll(() => page.locator('.sr-only[aria-live]').innerText()).toBe('2 matches')
      expect(await page.evaluate<unknown[]>('window.calls')).toContainEqual([
        'getToolInput',
        'bash1'
      ])
    } finally {
      await page.close()
    }
  })

  it('find matches quoted and escaped text past the cut as it is shown', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('medium')
    try {
      await page.keyboard.press('Control+f')
      const box = page.getByRole('textbox', { name: 'Find in session' })
      await box.fill('"quoted"')
      await expect.poll(() => page.locator('.sr-only[aria-live]').innerText()).toBe('1 matches')
      await box.fill('C:\\tmp\\esc')
      await expect.poll(() => page.locator('.sr-only[aria-live]').innerText()).toBe('1 matches')
    } finally {
      await page.close()
    }
  })

  it('in a very long transcript, is loaded when opened and shown as usual', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('lazy')
    try {
      const turn = writeCall(page)
      await turn.scrollIntoViewIfNeeded()
      await turn.getByRole('button', { name: /big.ts/ }).click()
      // Its first 60 lines, as in any transcript, with Show full for the rest.
      await expect
        .poll(() => turn.locator('pre').first().innerText())
        .toContain('line 59 of the file')
      expect(await turn.locator('pre').first().innerText()).not.toContain('line 60 of the file')
      expect(await page.evaluate<unknown[]>('window.calls')).toContainEqual([
        'getToolInput',
        'write1'
      ])
      await turn.getByRole('button', { name: /Show full/ }).click()
      await expect.poll(() => turn.locator('pre').first().innerText()).toContain('inputneedle')
    } finally {
      await page.close()
    }
  })

  it('in a very long transcript, find past a placeholder opens it and counts the match', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open('lazy')
    try {
      await page.keyboard.press('Control+f')
      await page.getByRole('textbox', { name: 'Find in session' }).fill('line 500 of')
      await expect.poll(() => page.locator('.sr-only[aria-live]').innerText()).toBe('1 matches')
      await expect
        .poll(() => writeCall(page).locator('pre').first().innerText())
        .toContain('line 500 of the file')
    } finally {
      await page.close()
    }
  })
})
