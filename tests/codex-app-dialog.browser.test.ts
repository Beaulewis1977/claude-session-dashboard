// Browser test (Vite + Playwright, like resume-keys.browser.test.ts): Continue
// fresh in the Codex app with a subfolder consent. When the launch is refused
// because the enclosing project changed after the user approved it, the open
// dialog checks again, drops the stale consent and asks about the new project,
// instead of failing the same way until it's closed and reopened.

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

const virtualId = 'virtual:codex-app-dialog-browser'

const session: SessionSummary = {
  key: 'codex-windows:019a1111-0000-7000-8000-000000000001',
  sessionId: '019a1111-0000-7000-8000-000000000001',
  sourceId: 'codex-windows',
  sourceLabel: 'Windows',
  provider: 'codex',
  env: 'windows',
  filePath: 'C:\\fixture\\rollout.jsonl',
  originalPath: 'C:\\fixture\\rollout.jsonl',
  availability: 'live',
  projectDir: 'fixture',
  projectName: 'lib',
  cwd: 'C:\\work\\lib',
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  toolCallCount: 0,
  malformedLines: 0,
  sizeBytes: 100,
  models: [],
  meta: {},
  title: 'Codex subfolder session',
  titleSource: 'first-prompt',
  source: 'codex-cli',
  sourceReason: 'Browser fixture'
}

// The PC side, faked: before the failed launch the folder is inside project A;
// afterwards inside project B. A consent opens only the project it names.
const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ResumeDialog } from '/src/renderer/src/components/ResumeDialog.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import '/src/renderer/src/styles.css'

window.launched = []
window.previews = []
let enclosing = { id: 'p-a', name: 'Alpha', root: 'C:\\\\work' }
const base = {
  commandLine: 'Start-Process wt.exe', claudeCommand: 'codex', terminal: 'wt',
  fellBack: false, cwd: 'C:\\\\work\\\\lib', cwdExists: true, willRestore: false,
  restoreImpossible: false, originalPath: 'C:\\\\fixture\\\\rollout.jsonl', billingLabel: 'Subscription',
  modelChoice: { modelFrom: 'none', effortFrom: 'none' },
  continueFresh: {
    newSessionId: '6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d', handoffPath: 'C:\\\\data\\\\h.md',
    sessionPath: 'C:\\\\data\\\\h.md', mode: 'read', handoff: '# Handoff', newSince: 0, name: 'x'
  }
}
function app(accepted) {
  const inside = { ...enclosing }
  if (!accepted) return { available: false, inside, reason: 'This folder is inside the Codex project ' + inside.name + '.' }
  if (accepted.id === inside.id && accepted.root === inside.root)
    return { available: true, project: inside, inside }
  return { available: false, consentChanged: true, inside, reason: 'The Codex project for this folder changed since you chose it.' }
}
window.csd = {
  previewLaunch: async (o) => {
    window.previews.push(o.codexAppProject ?? null)
    return { ...base, codexApp: app(o.codexAppProject) }
  },
  launch: async (o) => {
    window.launched.push(o.codexAppProject ?? null)
    if (window.launched.length === 1) {
      // The app's projects changed between the preview and the launch.
      enclosing = { id: 'p-b', name: 'Bravo', root: 'C:\\\\work\\\\' }
      return { ok: false, restored: false, commandLine: '', error: 'The Codex project for this folder changed since you chose it.' }
    }
    return { ok: true, restored: false, commandLine: 'codex://threads/new', openedIn: 'codex-app' }
  },
  updateMeta: async () => undefined,
  updateSettings: async (p) => ({ ...useApp.getState().settings, ...p }),
  copyText: async () => {},
  pickCwd: async () => null
}
useApp.setState({
  sessions: [${JSON.stringify(session)}],
  loaded: true,
  settings: { ...useApp.getState().settings, codexOpenInDefault: 'codex-app' },
  resume: { key: ${JSON.stringify(session.key)}, fork: false, continueFresh: true }
})

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
  // Warm up: Vite builds the modules on the first load, which is slow under a full test run.
  await (await open(60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(await browser!.newPage({ viewport: { width: 1000, height: 900 } }), origin)
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[codex-app-dialog.browser]', err.message))
  await page.goto(origin)
  await waitReady(page, page.getByRole('button', { name: 'Use Alpha' }))
  page.setDefaultTimeout(5_000)
  return page
}

const launched = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { launched: unknown[] }).launched)

describe('Continue fresh in the Codex app: a consent that went stale', () => {
  it('after a refused launch, the open dialog asks about the new project', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await page.getByRole('button', { name: 'Use Alpha' }).click()
      const go = page.getByRole('button', { name: /Open in Codex app/ })
      await expect.poll(() => go.isEnabled()).toBe(true)
      await go.click()
      // Refused: the project changed. The dialog checks again and asks about Bravo,
      // with Alpha's consent dropped (it isn't sent again).
      await page.getByRole('button', { name: 'Use Bravo' }).waitFor()
      expect(await go.isEnabled()).toBe(false)
      await page.getByRole('button', { name: 'Use Bravo' }).click()
      await expect.poll(() => go.isEnabled()).toBe(true)
      await go.click()
      await expect
        .poll(() => launched(page))
        .toEqual([
          { id: 'p-a', root: 'C:\\work' },
          { id: 'p-b', root: 'C:\\work\\' }
        ])
    } finally {
      await page.close()
    }
  }, 60_000)
})
