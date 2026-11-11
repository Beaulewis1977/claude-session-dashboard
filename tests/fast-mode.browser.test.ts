// Browser test (Vite + Playwright, like context-warning.browser.test.ts): the
// Fast picker in the Resume dialog. Shown next to Model and Effort for a model
// with fast mode, hidden for one without; picking On saves it on the session,
// the Resume button says "Fast", and the note says what it costs (Claude:
// usage credits; Codex: a warning above the pause line).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ViteDevServer } from 'vite'
import type { SessionSummary } from '../src/shared/types'
import {
  launchBrowser,
  startHarness,
  trackPage,
  unavailableReason,
  waitReady
} from './browser-harness'

const virtualId = 'virtual:fast-mode-browser'

const base: SessionSummary = {
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
  models: ['claude-opus-5-5'],
  meta: {},
  title: 'Fast session',
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

const q = new URLSearchParams(location.search)
const codex = q.has('codex')
window.metas = []
window.csd = {
  previewLaunch: async () => {
    const s = useApp.getState().sessions[0]
    const fast = s.meta.fast === 'on'
    return {
      commandLine: 'Start-Process wt.exe', claudeCommand: 'claude --resume s0', terminal: 'wt',
      fellBack: false, cwd: 'C:/fixture', cwdExists: true, willRestore: false,
      restoreImpossible: false, originalPath: 'C:/fixture/s0.jsonl', billingLabel: 'Subscription',
      modelChoice: { modelFrom: 'none', effortFrom: 'none', ...(fast ? { fast: true, fastFrom: 'session' } : {}) }
    }
  },
  launch: async () => ({ ok: true, restored: false, commandLine: 'x', simulated: true }),
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
const start = ${JSON.stringify(base)}
if (q.get('model')) start.meta = { ...start.meta, model: q.get('model') }
// ?last=<model>: the session's last reply was on that model (after Opus 5.5 earlier).
if (q.get('last')) {
  start.models = ['claude-opus-5-5', q.get('last')]
  start.lastModel = q.get('last')
}
// ?launch=new|continue: New session or Continue fresh instead of Resume.
const kind = q.get('launch')
const resume = { key: 'browser:s0', fork: false }
if (kind === 'new') resume.newSession = true
if (kind === 'continue') resume.continueFresh = true
if (codex) {
  start.provider = 'codex'
  start.models = ['gpt-6-sol']
}
useApp.setState({
  sessions: [start],
  loaded: true,
  resume,
  codexFastModels: codex ? { browser: ['gpt-6-sol'] } : null,
  codexLimits: codex ? { fiveHour: { pct: Number(q.get('pct') ?? 10), expired: false } } : null
})
window.store = useApp

createRoot(document.getElementById('root')).render(
  React.createElement(TooltipProvider, null, React.createElement(ResumeDialog))
)
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

async function open(loadTimeout = 15_000, query = ''): Promise<Page> {
  const page = trackPage(await browser!.newPage({ viewport: { width: 1000, height: 900 } }), origin)
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[fast-mode.browser]', err.message))
  await page.goto(origin + query)
  await waitReady(page, page.locator('pre', { hasText: 'Start-Process' }))
  page.setDefaultTimeout(5_000)
  return page
}

const metas = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { metas: unknown[] }).metas)
const fastButton = (page: Page) => page.getByRole('button', { name: /^Fast: / })

describe('Fast picker', () => {
  it('Opus 5.5: shown, On saves it, the button and the note follow', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const btn = fastButton(page)
      await expect.poll(() => btn.innerText()).toContain('Default (Off')
      await btn.click()
      await page.getByRole('menuitemradio', { name: 'On' }).click()
      await expect.poll(() => metas(page)).toEqual([{ fast: 'on' }])
      await expect
        .poll(() => page.getByRole('button', { name: /^Resume/ }).innerText())
        .toContain('Fast')
      await page.getByText('Fast mode is billed to usage credits (not your plan limits)').waitFor()
    } finally {
      await page.close()
    }
  }, 60_000)

  it('Sonnet: hidden', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open(15_000, '?model=sonnet')
    try {
      await page.getByRole('button', { name: /^Effort: / }).waitFor()
      expect(await fastButton(page).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 60_000)

  it("goes by the launch: Resume continues on the last reply's model, a new session on the default", async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    // Last reply on Sonnet 4.5 (no fast mode): Resume hides Fast.
    let page = await open(15_000, '?last=claude-sonnet-4-5-20250929')
    try {
      await page.getByRole('button', { name: /^Effort: / }).waitFor()
      expect(await fastButton(page).count()).toBe(0)
    } finally {
      await page.close()
    }
    // Last reply back on Opus 5.5 (models lists Sonnet last): shown.
    page = await open(15_000, '?last=claude-opus-5-5')
    try {
      await fastButton(page).waitFor()
    } finally {
      await page.close()
    }
    // New session and Continue fresh start on Claude Code's default: shown, with the note.
    for (const launch of ['new', 'continue']) {
      page = await open(15_000, `?last=claude-sonnet-4-5-20250929&launch=${launch}`)
      try {
        await fastButton(page).waitFor()
      } finally {
        await page.close()
      }
    }
  }, 60_000)

  it("Codex: shown for a model in Codex's list, hidden for one that isn't; warns above the pause line", async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    let page = await open(15_000, '?codex&pct=92')
    try {
      await fastButton(page).click()
      await page.getByRole('menuitemradio', { name: 'On' }).click()
      const alert = page.getByRole('alert').filter({ hasText: "Codex's 5-hour window is at 92%" })
      await alert.waitFor()
      expect(await alert.innerText()).toContain('2.5×')
    } finally {
      await page.close()
    }
    page = await open(15_000, '?codex&model=gpt-5.3-codex-spark')
    try {
      await page.getByRole('button', { name: /^Effort: / }).waitFor()
      expect(await fastButton(page).count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 60_000)
})
