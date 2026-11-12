// Browser test (Vite + Playwright): the phone's Settings tab. The same
// sections in the same order and the same search as the desktop page, with
// only the phone's safe subset of the PC's settings (plus this phone's own),
// and "Changed" / reset only where the phone may change the setting.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import type { ViteDevServer } from 'vite'
import {
  launchBrowser,
  startHarness,
  trackPage,
  unavailableReason,
  waitReady
} from './browser-harness'
import { PHONE_LOCAL_SETTINGS, phoneSettings, SECTIONS } from '../src/shared/settings-registry'

const virtualId = 'virtual:phone-settings-browser'

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { SettingsTab } from '/src/renderer/src/mobile/SettingsTab.tsx'
import { useMobile } from '/src/renderer/src/mobile/state.ts'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { APP_DEFAULTS } from '/src/shared/settings-registry.ts'
import '/src/renderer/src/styles.css'

window.calls = []
window.csd = new Proxy({
  remote: true,
  updateSettings: async (patch) => {
    window.calls.push(patch)
    if (window.fail) throw new Error('The PC is offline')
    window.pc = { ...window.pc, ...patch }
    return window.pc
  },
  getSettings: async () => window.pc
}, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && k.startsWith('on') ? () => () => {} : async () => undefined) })

const settings = structuredClone(APP_DEFAULTS)
window.pc = settings
useApp.setState({
  loaded: true,
  settings,
  info: { version: '9.9.9', platform: 'win32', fixtures: true, clockOffset: 0, dataDir: '', archiveDir: '' }
})
const me = (readOnly) => ({
  device: { id: 'p1', name: 'Pixel', createdAt: '2026-11-01T10:00:00Z', lastSeenAt: '2026-11-11T10:00:00Z', connected: true, push: false },
  readOnly, confirmOnPc: false, mode: 'tailscale', appVersion: '9.9.9', push: false
})
useMobile.setState({ me: me(false) })

const h = React.createElement
createRoot(document.getElementById('root')).render(h(React.Fragment, null, h(SettingsTab), h(Toaster)))

window.__p = {
  ids: () => [...new Set([...document.querySelectorAll('[data-setting-id]')].map((e) => e.getAttribute('data-setting-id')))],
  shown: () => [...new Set([...document.querySelectorAll('[data-setting-id]')].filter((e) => !e.closest('[hidden]')).map((e) => e.getAttribute('data-setting-id')))],
  sections: () => [...document.querySelectorAll('[data-phone-section]')].map((e) => e.getAttribute('data-phone-section')),
  shownSections: () => [...document.querySelectorAll('[data-phone-section]')].filter((e) => !e.hidden).map((e) => e.getAttribute('data-phone-section')),
  setSettings: (patch) => { const st = useApp.getState(); window.pc = { ...window.pc, ...patch }; st.set({ settings: window.pc }) },
  settings: () => useApp.getState().settings,
  readOnly: (on) => useMobile.setState({ me: me(on) })
}
`

let server: ViteDevServer | undefined
let browser: Browser | undefined
let origin: string

beforeAll(async () => {
  browser = await launchBrowser()
  if (!browser) return
  ;({ server, origin } = await startHarness({
    virtualId,
    harness,
    head: '<meta name="viewport" content="width=device-width, initial-scale=1">'
  }))
  await (await open(60_000)).close()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(
    await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true }),
    origin
  )
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[phone-settings.browser]', err.message))
  await page.goto(origin)
  await waitReady(page, page.locator('[data-phone-settings]'))
  await page.waitForFunction('typeof window.__p === "object"')
  page.setDefaultTimeout(5_000)
  return page
}

const p = <T>(page: Page, js: string) => page.evaluate<T>(`window.__p.${js}`)

describe('the phone’s Settings tab', () => {
  it('lists the phone’s safe settings and its own, in the desktop’s section order', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const ids = await p<string[]>(page, 'ids()')
      const want = [...phoneSettings(), ...PHONE_LOCAL_SETTINGS].map((d) => d.id)
      expect([...ids].sort()).toEqual([...want].sort())
      for (const never of ['launching.skip-permissions', 'phone.read-only', 'accounts.keys'])
        expect(ids).not.toContain(never)
      const order = SECTIONS.map((s) => s.id as string)
      const sections = await p<string[]>(page, 'sections()')
      expect(sections).toEqual([...sections].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    } finally {
      await page.close()
    }
  })

  it('searches the same way, and Esc clears the search', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const box = page.locator('[data-settings-search]')
      await box.fill('quiet')
      await expect
        .poll(() => p<string[]>(page, 'shown()'))
        .toEqual(['alerts.quiet', 'alerts.quiet-approvals'])
      expect(await p<string[]>(page, 'shownSections()')).toEqual(['alerts'])
      await expect.poll(() => page.locator('[data-settings-count]').textContent()).toBe('2 results')
      await box.fill('ssh')
      await expect.poll(() => p<string[]>(page, 'shown()')).toEqual(['phone-local.ssh-key'])
      await box.press('Escape')
      await expect
        .poll(() => p<number>(page, 'shown().length'))
        .toBe(phoneSettings().length + PHONE_LOCAL_SETTINGS.length)
    } finally {
      await page.close()
    }
  })

  it('shows "Changed" with a reset (and Undo) where the phone may change it', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const line = page.locator('[data-setting-id="launching.terminal"]')
      await expect.poll(() => line.locator('[data-changed-marker]').count()).toBe(0)
      await p(page, "setSettings({ terminal: 'cmd' })")
      await expect.poll(() => line.locator('[data-changed-marker]').count()).toBe(1)
      await page.locator('[data-reset-setting="launching.terminal"]').click()
      await expect
        .poll(() => p<{ terminal: string }>(page, 'settings()').then((s) => s.terminal))
        .toBe('wt')
      await page.getByRole('button', { name: 'Undo' }).click()
      await expect
        .poll(() => p<{ terminal: string }>(page, 'settings()').then((s) => s.terminal))
        .toBe('cmd')
      // In read-only mode the phone can't change it: the marker stays, no reset.
      await p(page, 'readOnly(true)')
      await expect.poll(() => line.locator('[data-changed-marker]').count()).toBe(1)
      await expect
        .poll(() => page.locator('[data-reset-setting="launching.terminal"]').count())
        .toBe(0)
    } finally {
      await page.close()
    }
  })

  it('a reset that the PC didn’t save says so, with no Undo', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await p(page, "setSettings({ terminal: 'cmd' })")
      await page.evaluate('window.fail = true')
      await page.locator('[data-reset-setting="launching.terminal"]').click()
      await expect.poll(() => page.getByText("Couldn't reset it").count()).toBe(1)
      expect(await page.getByRole('button', { name: 'Undo' }).count()).toBe(0)
      await expect
        .poll(() => p<{ terminal: string }>(page, 'settings()').then((s) => s.terminal))
        .toBe('cmd')
    } finally {
      await page.close()
    }
  })

  it('lists "Approvals during quiet hours" even while quiet hours are off (switch off)', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const sw = page.getByRole('switch', { name: 'Approvals during quiet hours' })
      expect(await sw.count()).toBe(1)
      expect(await sw.isDisabled()).toBe(true)
    } finally {
      await page.close()
    }
  })
})
