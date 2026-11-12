// Browser test (Vite + Playwright, like back-nav.browser.test.ts): the Settings
// page and its sidebar menu, rendered for real over a stand-in window.csd.
// - every setting in the registry is on the page exactly once (and no setting
//   row is outside one);
// - search filters in place (labels, descriptions, keywords), highlights, counts,
//   and Esc / clearing brings everything back; Ctrl+F and Ctrl+, focus it;
// - folding is remembered, and a search opens folded sections with matches;
// - scroll-spy follows sections and sub-headings;
// - links land on (and light up) the exact setting, old section ids included,
//   unfolding or clearing a search when needed;
// - Back / Forward put the section and the scroll back;
// - "Changed", reset with Undo, Reset section…, and no reset for the never-reset ones;
// - the amber dots, and the sessions sidebar coming back as it was.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Locator, Page } from 'playwright'
import type { ViteDevServer } from 'vite'
import {
  launchBrowser,
  startHarness,
  trackPage,
  unavailableReason,
  waitReady
} from './browser-harness'
import { SECTIONS, SETTINGS } from '../src/shared/settings-registry'

const virtualId = 'virtual:settings-page-browser'

const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { SettingsView } from '/src/renderer/src/components/SettingsView.tsx'
import { SidebarSlot } from '/src/renderer/src/components/SidebarSlot.tsx'
import { TooltipProvider } from '/src/renderer/src/components/ui/tooltip.tsx'
import { useApp } from '/src/renderer/src/lib/store.ts'
import { useSettingsUi } from '/src/renderer/src/lib/settings-ui.ts'
import { useHotkeys } from '/src/renderer/src/lib/hotkeys.ts'
import { settingsUi } from '/src/renderer/src/lib/settings-ui.ts'
import { useNavigation, navigate } from '/src/renderer/src/lib/navigation.ts'
import { APP_DEFAULTS } from '/src/shared/settings-registry.ts'
import '/src/renderer/src/styles.css'

const settings = structuredClone(APP_DEFAULTS)
// Shown only while quiet hours are on.
settings.liveAlerts.quiet.enabled = true
window.calls = []
window.mobile = {
  settings: { enabled: false, mode: 'tailscale', port: 47821, httpsPort: 8443, readOnly: false, confirmOnPc: false, autoStart: true },
  running: false,
  devices: []
}
window.backup = {
  available: true, schedule: 'daily', keep: 14, encrypted: false, locked: false, remembered: false,
  canRemember: true, running: false, snapshotCount: 0, damagedCount: 0, autoCleanSafety: false
}
const tally = { sessions: 0, bytes: 0, newBytes: 0, backupBytes: 0 }
const known = {
  remote: false,
  updateSettings: async (patch) => {
    window.calls.push(patch)
    return { ...useApp.getState().settings, ...patch }
  },
  getSettings: async () => useApp.getState().settings,
  updateGitSettings: async (p) => {
    const st = useApp.getState()
    st.set({ settings: { ...st.settings, gitLinks: { ...st.settings.gitLinks, ...p } } })
    return { git: [], gh: 'ask', linkedSessions: 0, repos: 0 }
  },
  startWithWindows: async () => ({ supported: true, on: false }),
  getArchiveStats: async () => ({ dir: 'C:\\\\data\\\\archive', files: 3, bytes: 1000 }),
  mobileStatus: async () => window.mobile,
  mobileUpdate: async (p) => {
    window.mobile = { ...window.mobile, settings: { ...window.mobile.settings, ...p } }
    return window.mobile
  },
  backupStatus: async () => window.backup,
  backupUpdate: async (p) => {
    window.backup = { ...window.backup, ...p }
    return window.backup
  },
  getUsageStatus: async () => ({ records: 10, files: 2, parsing: false }),
  getGitStatus: async () => ({ git: [], gh: 'ask', linkedSessions: 0, repos: 0 }),
  handoffStats: async () => ({ files: 0, bytes: 0, old: { files: 0, bytes: 0 } }),
  getCodexArchiveEstimate: async () => ({ all: tally, marked: tally, archived: 0, archivedBytes: 0 }),
  mobileActivity: async () => [],
  terminalHistory: async () => []
}
window.csd = new Proxy(known, {
  get: (t, k) =>
    k in t ? t[k] : typeof k === 'string' && k.startsWith('on') ? () => () => {} : async () => undefined
})

const session = (i) => ({
  key: 'windows:s' + i, sessionId: 's' + i, sourceId: 'windows', sourceLabel: 'Windows', env: 'windows',
  filePath: '', originalPath: '', availability: 'live', projectDir: 'p' + i, projectName: 'project-' + i,
  cwd: 'C:\\\\work\\\\project-' + i, messageCount: 1, userMessageCount: 1, assistantMessageCount: 0,
  toolCallCount: 0, malformedLines: 0, sizeBytes: 1, models: [], meta: { tags: ['tag-' + i] },
  title: 'Session ' + i, titleSource: 'name', source: 'terminal-windows', sourceReason: '',
  provider: 'claude'
})
useApp.setState({
  loaded: true,
  view: 'sessions',
  settings,
  info: { version: '9.9.9', platform: 'win32', fixtures: true, clockOffset: 0, dataDir: 'C:\\\\data', archiveDir: 'C:\\\\data\\\\archive' },
  sources: [{ id: 'windows', kind: 'auto', env: 'windows', provider: 'claude', label: 'Windows', projectsDir: 'C:\\\\Users\\\\alex\\\\.claude\\\\projects', status: 'ok', sessionCount: 3 }],
  credits: {
    accounts: [{ id: 'a1', nickname: 'Work', kind: 'admin', masked: 'sk-ant-admin…', createdAt: '2026-10-01T00:00:00Z', sample: true }],
    summaries: [], admin: [], apiSessions: [], encryptionAvailable: true
  },
  sessions: Array.from({ length: 40 }, (_, i) => session(i))
})

const h = React.createElement
function Host() {
  useNavigation()
  const view = useApp((s) => s.view)
  // The app's own Ctrl+, (App.tsx): opens Settings; while open, goes to its search.
  useHotkeys([{ combo: 'mod+,', allowInInput: true, handler: () =>
    useApp.getState().view === 'settings' ? settingsUi.focusSearch() : useApp.getState().set({ view: 'settings' }) }])
  return h(TooltipProvider, null,
    h('div', { style: { display: 'flex', height: '100vh' } },
      h(SidebarSlot),
      view === 'settings'
        ? h('div', { style: { flex: 1, minWidth: 0 } }, h(SettingsView))
        : h('div', { 'data-nav-scroll': 'main', style: { flex: 1, overflow: 'auto' } },
            h('div', { style: { height: '2000px' } }, 'sessions'))),
    h(Toaster))
}
createRoot(document.getElementById('root')).render(h(Host))

const shownIds = () =>
  [...document.querySelectorAll('[data-setting-id]')]
    .filter((e) => !e.closest('[hidden]'))
    .map((e) => e.getAttribute('data-setting-id'))
window.__t = {
  ids: () => [...document.querySelectorAll('#settings-scroll [data-setting-id]')].map((e) => e.getAttribute('data-setting-id')),
  shown: () => shownIds().filter((id) => document.querySelector('#settings-scroll [data-setting-id="' + id + '"]')),
  sections: () => [...document.querySelectorAll('[data-settings-section]')].filter((e) => !e.hidden).map((e) => e.getAttribute('data-settings-section')),
  menu: () => [...document.querySelectorAll('[data-settings-sidebar] [data-menu-item]')].map((e) => e.getAttribute('data-menu-item')),
  current: () => document.querySelector('[data-settings-sidebar] [aria-current="location"]')?.getAttribute('data-menu-item') ?? null,
  orphanRows: () => [...document.querySelectorAll('[data-settings-row]')].filter((r) => !r.closest('[data-setting-id]')).length,
  highlights: () => CSS.highlights?.get('settings-search')?.size ?? 0,
  set: (patch) => useApp.getState().set(patch),
  setSettings: (patch) => { const st = useApp.getState(); st.set({ settings: { ...st.settings, ...patch } }) },
  settings: () => useApp.getState().settings,
  app: () => { const s = useApp.getState(); return { view: s.view, settingsSection: s.settingsSection } },
  ui: () => { const s = useSettingsUi.getState(); return { query: s.query, active: s.active, collapsed: s.collapsed } },
  scrollTop: () => document.getElementById('settings-scroll')?.scrollTop ?? -1,
  // Where an element is in the scroll pane (its top, from the pane's top).
  offset: (sel) => {
    const c = document.getElementById('settings-scroll')
    const el = document.querySelector(sel)
    return el ? el.getBoundingClientRect().top - c.getBoundingClientRect().top : null
  },
  scrollToEl: (sel, under) => {
    const c = document.getElementById('settings-scroll')
    const el = document.querySelector(sel)
    c.scrollTop += el.getBoundingClientRect().top - c.getBoundingClientRect().top - under
  },
  navigate: (dir) => navigate(dir),
  storage: (k) => localStorage.getItem(k)
}
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

async function open(loadTimeout = 15_000): Promise<Page> {
  const page = trackPage(
    await browser!.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }),
    origin
  )
  page.setDefaultTimeout(loadTimeout)
  page.on('pageerror', (err) => console.error('[settings-page.browser]', err.message))
  await page.goto(origin)
  await page.waitForFunction('typeof window.__t === "object"')
  await page.evaluate("window.__t.set({ view: 'settings' })")
  await waitReady(page, page.locator('[data-setting-id="advanced.about"]'))
  // Everything that loads after the page (phone status, startup, backups) is in.
  // (A plain wait: expect.poll only works inside a test, and this runs in beforeAll too.)
  await page.waitForFunction(`window.__t.ids().length === ${SETTINGS.length}`)
  page.setDefaultTimeout(5_000)
  return page
}

const t = <T>(page: Page, js: string) => page.evaluate<T>(`window.__t.${js}`)
/** The element has the focus. */
const focused = (l: Locator) => l.evaluate((e) => e === e.ownerDocument.activeElement)
const search = (page: Page) => page.locator('[data-settings-sidebar] [data-settings-search]')

describe('the Settings page', () => {
  it('shows every setting exactly once, each in its own section, none outside an item', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const ids = await t<string[]>(page, 'ids()')
      expect([...ids].sort()).toEqual(SETTINGS.map((d) => d.id).sort())
      expect(await t<number>(page, 'orphanRows()')).toBe(0)
      for (const d of SETTINGS) {
        const inSection = await page
          .locator(`[data-settings-section="${d.section}"] [data-setting-id="${d.id}"]`)
          .count()
        expect(inSection, d.id).toBe(1)
      }
      expect(await t<string[]>(page, 'sections()')).toEqual(SECTIONS.map((s) => s.id))
      // The menu lists every section and the sub-headings of the big ones.
      const menu = await t<string[]>(page, 'menu()')
      for (const s of SECTIONS) {
        expect(menu).toContain(s.id)
        for (const u of s.subsections ?? []) expect(menu).toContain(u.id)
      }
      // Landmarks for screen readers.
      await expect.poll(() => page.getByRole('main', { name: 'Settings' }).count()).toBe(1)
      await expect
        .poll(() => page.getByRole('navigation', { name: 'Settings sections' }).count())
        .toBe(1)
    } finally {
      await page.close()
    }
  })

  it('search filters in place, highlights and counts; Esc brings everything back', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await search(page).fill('quiet')
      await expect
        .poll(() => t<string[]>(page, 'shown()'))
        .toEqual(['alerts.quiet', 'alerts.quiet-approvals'])
      expect(await t<string[]>(page, 'sections()')).toEqual(['alerts'])
      expect(await t<string[]>(page, 'menu()')).toEqual(['alerts'])
      await expect
        .poll(() => page.locator('[data-settings-sidebar] [data-settings-count]').textContent())
        .toBe('2 results')
      await expect.poll(() => t<number>(page, 'highlights()')).toBeGreaterThanOrEqual(2)
      // A heading over settings that are all hidden hides too ("Alert me when").
      await expect.poll(() => page.getByText('Alert me when').isVisible()).toBe(false)

      // Keywords and synonyms; found only that way, a setting says what matched.
      await search(page).fill('dnd')
      await expect.poll(() => t<string[]>(page, 'shown()')).toContain('alerts.quiet')
      await expect
        .poll(() => page.locator('[data-setting-id="alerts.quiet"]').textContent())
        .toContain('Matches “dnd”')
      await search(page).fill('ssh')
      await expect.poll(() => t<string[]>(page, 'shown()')).toContain('phone.terminal')
      await search(page).fill('fast')
      await expect.poll(() => t<string[]>(page, 'shown()')).toContain('launching.model')
      await search(page).fill('hook')
      await expect.poll(() => t<string[]>(page, 'shown()')).toEqual(['alerts.hooks'])

      await search(page).fill('zzzz')
      await expect.poll(() => page.getByText('No settings match “zzzz”').isVisible()).toBe(true)
      await expect
        .poll(() => page.locator('[data-settings-sidebar] [data-settings-count]').textContent())
        .toBe('No results')

      await search(page).press('Escape')
      await expect.poll(() => t<string[]>(page, 'shown()')).toHaveLength(SETTINGS.length)
      expect(await t<number>(page, 'highlights()')).toBe(0)
      // A second Esc leaves the field (a third would leave Settings, as before).
      await search(page).press('Escape')
      expect(
        await page.evaluate('document.activeElement?.hasAttribute("data-settings-search")')
      ).toBe(false)

      // Ctrl+F in Settings goes to the search; so does Ctrl+, while Settings is open.
      await page.locator('body').click({ position: { x: 900, y: 10 } })
      await page.keyboard.press('Control+f')
      await expect.poll(() => focused(search(page))).toBe(true)
      await page.locator('body').click({ position: { x: 900, y: 10 } })
      await page.keyboard.press('Control+,')
      await expect.poll(() => focused(search(page))).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('remembers folded sections; a search opens the ones with matches while it’s on', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const body = page.locator('#settings-general-body')
      await page.locator('[data-collapse="general"]').click()
      await expect.poll(() => body.isVisible()).toBe(false)
      await expect
        .poll(() => page.locator('[data-collapse="general"]').getAttribute('aria-expanded'))
        .toBe('false')
      expect(
        JSON.parse((await t<string>(page, "storage('csd.settings.collapsed')")) ?? '{}')
      ).toEqual({
        general: true
      })
      await search(page).fill('theme')
      await expect.poll(() => body.isVisible()).toBe(true)
      await expect
        .poll(() => page.locator('[data-setting-id="general.theme"]').isVisible())
        .toBe(true)
      await search(page).fill('')
      await expect.poll(() => body.isVisible()).toBe(false)
      // Still on the page while folded (counted, searchable), just not shown.
      expect(await t<string[]>(page, 'ids()')).toContain('general.theme')
      await page.locator('[data-collapse="general"]').click()
      await expect.poll(() => body.isVisible()).toBe(true)
      expect(
        JSON.parse((await t<string>(page, "storage('csd.settings.collapsed')")) ?? '{}')
      ).toEqual({})
    } finally {
      await page.close()
    }
  })

  it('scroll-spy follows the section and the sub-heading in view', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      expect(await t<string | null>(page, 'current()')).toBe('general')
      await t(page, `scrollToEl('[data-settings-section="alerts"]', -10)`)
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('alerts')
      await t(page, `scrollToEl('[data-settings-sub-group="usage.pacing"]', 60)`)
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('usage.pacing')
      // The section header stays pinned while its settings scroll under it.
      const header = await t<number>(page, `offset('[data-settings-section="usage"] header')`)
      expect(Math.abs(header)).toBeLessThan(2)
      // The ↑ Top button shows once scrolled down, and goes back up.
      await page.locator('[data-top-button]').click()
      await expect.poll(() => t<number>(page, 'scrollTop()')).toBe(0)
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('general')
      // End / Home when no field is focused.
      await page.keyboard.press('End')
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('advanced')
      await page.keyboard.press('Home')
      await expect.poll(() => t<number>(page, 'scrollTop()')).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('links land on the exact setting and light it up (old ids too)', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await t(page, "set({ settingsSection: 'alerts.quiet' })")
      const quiet = page.locator('[data-setting-id="alerts.quiet"]')
      await expect.poll(() => quiet.getAttribute('data-highlighted')).toBe('true')
      const top = await t<number>(page, `offset('[data-setting-id="alerts.quiet"]')`)
      expect(top).toBeGreaterThan(40)
      expect(top).toBeLessThan(200)
      expect(
        (await t<{ settingsSection: string | null }>(page, 'app()')).settingsSection
      ).toBeNull()
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('alerts')
      // The light goes out by itself.
      await expect.poll(() => quiet.getAttribute('data-highlighted'), { timeout: 4000 }).toBeNull()

      // An old section id (Usage's "Codex usage & limits" link).
      await t(page, "set({ settingsSection: 'codex-usage' })")
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('usage.codex')
      const sub = await t<number>(page, `offset('[data-settings-sub-group="usage.codex"]')`)
      expect(Math.abs(sub - 48)).toBeLessThan(4)

      // Into a folded section: it unfolds.
      await page.locator('[data-collapse="git"]').click()
      await t(page, "set({ settingsSection: 'git.gh' })")
      await expect.poll(() => page.locator('[data-setting-id="git.gh"]').isVisible()).toBe(true)
      await expect
        .poll(() => page.locator('[data-setting-id="git.gh"]').getAttribute('data-highlighted'))
        .toBe('true')

      // While a search hides it: the search is cleared.
      await search(page).fill('quiet')
      await t(page, "set({ settingsSection: 'sources.cowork' })")
      await expect
        .poll(() => page.locator('[data-setting-id="sources.cowork"]').isVisible())
        .toBe(true)
      expect((await t<{ query: string }>(page, 'ui()')).query).toBe('')

      // "See also" links between related settings.
      await page.locator('[data-see-also="phone"]').click()
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('phone')
    } finally {
      await page.close()
    }
  })

  it('Back / Forward put the section and the scroll position back', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const go = async (id: string): Promise<number> => {
        await page.locator(`[data-settings-sidebar] [data-menu-item="${id}"]`).click()
        await expect.poll(() => t<string | null>(page, 'current()')).toBe(id)
        await page.waitForTimeout(600)
        return t<number>(page, 'scrollTop()')
      }
      await go('launching')
      const alerts = await go('alerts')
      const git = await go('git')
      expect(git).toBeGreaterThan(alerts)
      await t(page, 'navigate(-1)')
      await expect.poll(() => t<number>(page, 'scrollTop()')).toBe(alerts)
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('alerts')
      await page.waitForTimeout(600)
      await t(page, 'navigate(1)')
      await expect.poll(() => t<number>(page, 'scrollTop()')).toBe(git)
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('git')
    } finally {
      await page.close()
    }
  })

  it('shows "Changed", resets one setting with Undo, and resets a section after a confirm', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const terminal = page.locator('[data-setting-id="launching.terminal"]')
      await expect.poll(() => terminal.locator('[data-changed-marker]').count()).toBe(0)
      await t(page, "setSettings({ terminal: 'cmd' })")
      await expect.poll(() => terminal.locator('[data-changed-marker]').isVisible()).toBe(true)
      await expect
        .poll(() => page.locator('[data-changed-count="launching"]').textContent())
        .toBe('1 changed')
      await page.locator('[data-reset-setting="launching.terminal"]').click()
      await expect
        .poll(() => t<{ terminal: string }>(page, 'settings()').then((s) => s.terminal))
        .toBe('wt')
      await expect.poll(() => terminal.locator('[data-changed-marker]').count()).toBe(0)
      await page.getByRole('button', { name: 'Undo' }).click()
      await expect
        .poll(() => t<{ terminal: string }>(page, 'settings()').then((s) => s.terminal))
        .toBe('cmd')

      // A nested setting: only its own fields go back.
      const s = await t<{ liveAlerts: Record<string, unknown> }>(page, 'settings()')
      await t(
        page,
        `setSettings({ liveAlerts: ${JSON.stringify({ ...s.liveAlerts, finished: false, minWorkSec: 90 })} })`
      )
      await page.locator('[data-reset-setting="alerts.min-work"]').click()
      await expect
        .poll(() =>
          t<{ liveAlerts: { minWorkSec: number } }>(page, 'settings()').then(
            (x) => x.liveAlerts.minWorkSec
          )
        )
        .toBe(20)
      expect(
        (await t<{ liveAlerts: { finished: boolean } }>(page, 'settings()')).liveAlerts.finished
      ).toBe(false)

      // Reset section…: a confirm that lists what goes back, then Undo for all of it.
      await t(page, 'setSettings({ skipPermissionsDefault: false })')
      await expect
        .poll(() => page.locator('[data-changed-count="launching"]').textContent())
        .toBe('2 changed')
      await page.locator('[data-reset-section="launching"]').click()
      const dialog = page.getByRole('dialog')
      await expect.poll(() => dialog.textContent()).toContain('Reset Launching to defaults?')
      await expect
        .poll(() => dialog.getByRole('list', { name: 'Settings to reset' }).textContent())
        .toContain('Terminal')
      await dialog.getByRole('button', { name: 'Reset 2 settings' }).click()
      await expect
        .poll(() => t<{ terminal: string; skipPermissionsDefault: boolean }>(page, 'settings()'))
        .toMatchObject({ terminal: 'wt', skipPermissionsDefault: true })
      await expect.poll(() => page.locator('[data-changed-count="launching"]').count()).toBe(0)
      await page.getByRole('button', { name: 'Undo' }).first().click()
      await expect
        .poll(() => t<{ terminal: string; skipPermissionsDefault: boolean }>(page, 'settings()'))
        .toMatchObject({ terminal: 'cmd', skipPermissionsDefault: false })
    } finally {
      await page.close()
    }
  })

  it('has Codex’s own bypass default right after Claude Code’s, changed on its own', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      // Adjacent: the last setting of Launching → Claude Code, the first of → Codex.
      const order = await page.evaluate<string[]>(
        `[...document.querySelectorAll('[data-settings-section="launching"] [data-setting-id]')].map((e) => e.getAttribute('data-setting-id'))`
      )
      const i = order.indexOf('launching.skip-permissions')
      expect(order[i + 1]).toBe('launching.codex-bypass')
      expect(
        await page
          .locator(
            '[data-settings-sub-group="launching.codex"] [data-setting-id="launching.codex-bypass"]'
          )
          .count()
      ).toBe(1)
      await page
        .getByRole('switch', { name: 'Codex: bypass approvals and sandbox by default' })
        .click()
      await expect
        .poll(() =>
          t<{ codexBypassDefault: boolean; skipPermissionsDefault: boolean }>(page, 'settings()')
        )
        .toMatchObject({ codexBypassDefault: false, skipPermissionsDefault: true })
      await page.locator('[data-reset-setting="launching.codex-bypass"]').click()
      await expect
        .poll(() =>
          t<{ codexBypassDefault: boolean }>(page, 'settings()').then((x) => x.codexBypassDefault)
        )
        .toBe(true)
    } finally {
      await page.close()
    }
  })

  it('never offers a reset for security choices, folders, keys or devices', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await page.evaluate(
        `window.mobile = { ...window.mobile, settings: { ...window.mobile.settings, readOnly: true, autoStart: false } }`
      )
      await t(page, "setSettings({ extraFolders: ['D:\\\\more'] })")
      // The phone section reloads its status on the next open.
      await t(page, "set({ view: 'sessions' })")
      await t(page, "set({ view: 'settings' })")
      const ro = page.locator('[data-setting-id="phone.read-only"]')
      await expect.poll(() => ro.locator('[data-changed-marker]').isVisible()).toBe(true)
      await expect
        .poll(() => page.locator('[data-reset-setting="phone.read-only"]').count())
        .toBe(0)
      await expect
        .poll(() => page.locator('[data-reset-setting="phone.auto-start"]').count())
        .toBe(1)
      await expect
        .poll(() => page.locator('[data-reset-setting="sources.folders"]').count())
        .toBe(0)
      for (const id of [
        'accounts.keys',
        'phone.devices',
        'archive.backup-password',
        'archive.backup-folder'
      ])
        await expect.poll(() => page.locator(`[data-reset-setting="${id}"]`).count()).toBe(0)
      // Reset section… lists read-only mode under "Not reset" and leaves it on.
      await page.locator('[data-reset-section="phone"]').click()
      const dialog = page.getByRole('dialog')
      await expect.poll(() => dialog.textContent()).toContain('Not reset')
      await expect.poll(() => dialog.textContent()).toContain('Read-only mode')
      await dialog.getByRole('button', { name: 'Reset 1 setting' }).click()
      await expect
        .poll(() =>
          page.evaluate<{ readOnly: boolean; autoStart: boolean }>('window.mobile.settings')
        )
        .toMatchObject({ readOnly: true, autoStart: true })
    } finally {
      await page.close()
    }
  })

  it('shows an amber dot where something needs attention; clicking it goes there', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await expect.poll(() => page.locator('[data-attention]').count()).toBe(0)
      await t(
        page,
        "set({ sources: [{ id: 'wsl', kind: 'auto', env: 'wsl', provider: 'claude', label: 'WSL: Ubuntu', projectsDir: 'ubuntu', status: 'unreadable', statusMessage: 'Access denied' }] })"
      )
      const dot = page.locator('[data-attention="sources"]')
      await expect.poll(() => dot.isVisible()).toBe(true)
      await expect
        .poll(() => dot.getAttribute('aria-label'))
        .toMatch(/Can’t read WSL: Ubuntu: Access denied/)
      await dot.click()
      await expect
        .poll(() =>
          page.locator('[data-setting-id="sources.folders"]').getAttribute('data-highlighted')
        )
        .toBe('true')
    } finally {
      await page.close()
    }
  })

  it('slides the sidebar to the Settings menu and back, keeping the sessions sidebar as it was', async ({
    skip
  }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      await page.locator('[data-back-to-sessions]').click()
      await expect
        .poll(() => t<{ view: string }>(page, 'app()').then((a) => a.view))
        .toBe('sessions')
      const sessions = page.locator('[data-sessions-sidebar]')
      await expect.poll(() => sessions.getAttribute('inert')).toBeNull()
      await expect
        .poll(() => page.locator('[data-settings-sidebar]').getAttribute('inert'))
        .toBe('')
      // Scroll the sessions sidebar and mark its DOM node.
      await page.evaluate(`(() => {
        const el = document.querySelector('[data-sessions-sidebar] .overflow-y-auto')
        el.scrollTop = 120
        el.dataset.mark = 'kept'
      })()`)
      await t(page, "set({ view: 'settings' })")
      await expect.poll(() => sessions.getAttribute('inert')).toBe('')
      await expect
        .poll(() => page.locator('[data-settings-sidebar]').getAttribute('inert'))
        .toBeNull()
      await page.locator('[data-back-to-sessions]').click()
      await expect.poll(() => sessions.getAttribute('inert')).toBeNull()
      const kept = await page.evaluate<{ mark?: string; top: number }>(`(() => {
        const el = document.querySelector('[data-sessions-sidebar] .overflow-y-auto')
        return { mark: el.dataset.mark, top: el.scrollTop }
      })()`)
      expect(kept).toEqual({ mark: 'kept', top: 120 })
    } finally {
      await page.close()
    }
  })

  it('moves through the menu with the arrow keys (one tab stop)', async ({ skip }) => {
    if (!browser) skip(unavailableReason)
    const page = await open()
    try {
      const stops = await page.evaluate<number>(
        `[...document.querySelectorAll('[data-settings-sidebar] [data-menu-item]')].filter((b) => b.tabIndex === 0).length`
      )
      expect(stops).toBe(1)
      await page.locator('[data-settings-sidebar] [data-menu-item="general"]').focus()
      await page.keyboard.press('ArrowDown')
      await expect
        .poll(() => focused(page.locator('[data-settings-sidebar] [data-menu-item="sources"]')))
        .toBe(true)
      await page.keyboard.press('End')
      await expect
        .poll(() => focused(page.locator('[data-settings-sidebar] [data-menu-item="advanced"]')))
        .toBe(true)
      await page.keyboard.press('Enter')
      await expect.poll(() => t<string | null>(page, 'current()')).toBe('advanced')
    } finally {
      await page.close()
    }
  })
})
