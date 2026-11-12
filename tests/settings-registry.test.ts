// The Settings page's map (shared/settings-registry.ts): every setting is in
// it once and in a real section, every AppSettings key is accounted for, search
// finds settings by their words and synonyms, "Changed" / reset / Undo touch
// only the setting's own keys and never the never-reset ones, old links still
// resolve, and the menu's amber dots follow their rules.

import { describe, expect, it } from 'vitest'
import {
  APP_DEFAULTS,
  canReset,
  getPath,
  isChanged,
  LEGACY_TARGETS,
  matchSetting,
  PHONE_LOCAL_SETTINGS,
  phoneSettings,
  resetPatch,
  resolveTarget,
  searchSettings,
  SECTIONS,
  SET_ELSEWHERE,
  settingDef,
  SETTINGS,
  STORE_DEFAULTS,
  targetLabel,
  undoPatch,
  type SettingDef
} from '../src/shared/settings-registry'
import { settingsAttention } from '../src/shared/settings-attention'
import { MOBILE_SAFE_SETTINGS } from '../src/shared/mobile'
import type { AppSettings, SourceInfo } from '../src/shared/types'
import type { HookEnv } from '../src/shared/live'
import type { LimitsState } from '../src/shared/usage/limits'
import type { BackupStatus } from '../src/shared/backup'
import type { MobileStatus } from '../src/shared/mobile'

/** Every key of AppSettings (a missing or extra one fails the type check). */
const ALL_KEYS: Record<keyof AppSettings, true> = {
  skipPermissionsDefault: true,
  terminal: true,
  theme: true,
  extraFolders: true,
  scanStoppedDistros: true,
  weekStart: true,
  prices: true,
  plan: true,
  alertsEnabled: true,
  alertThresholds: true,
  capacityWeights: true,
  defaultBilling: true,
  projectBilling: true,
  adminRefreshMinutes: true,
  branchConfirmed: true,
  planHistory: true,
  health: true,
  pace: true,
  elsewhere: true,
  askSkipPreview: true,
  askTimeoutSec: true,
  remoteControlDefault: true,
  defaultModel: true,
  defaultEffort: true,
  projectModels: true,
  defaultFast: true,
  liveAlerts: true,
  summaries: true,
  contextWarning: true,
  providers: true,
  providerView: true,
  codexArchive: true,
  showSubagents: true,
  codexDefaultModel: true,
  codexDefaultEffort: true,
  codexProjectModels: true,
  codexDefaultFast: true,
  codexOpenInDefault: true,
  codexProjectOpenIn: true,
  codexPlan: true,
  codexAccounts: true,
  codexPlanMults: true,
  codexHealth: true,
  codexElsewhere: true,
  codexPrices: true,
  meterProvider: true,
  usageSplit: true,
  gitLinks: true,
  askSessions: true,
  coworkSource: true
}

const appKeys = SETTINGS.filter((d) => (d.store ?? 'app') === 'app').flatMap((d) => d.keys ?? [])

/** A path is claimed when a setting shows it, or a part of it, or one that contains it. */
function claimed(path: string): boolean {
  const covers = (k: string): boolean =>
    k === path || path.startsWith(`${k}.`) || k.startsWith(`${path}.`)
  return appKeys.some(covers) || Object.keys(SET_ELSEWHERE).some(covers)
}

/** Objects whose fields are claimed one by one (a setting per field). */
const NESTED = [
  'liveAlerts',
  'liveAlerts.quiet',
  'summaries',
  'contextWarning',
  'health',
  'pace',
  'askSessions',
  'gitLinks',
  'codexHealth'
]

describe('the settings map', () => {
  it('has each setting once, in a real section and sub-heading', () => {
    const ids = SETTINGS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    const local = PHONE_LOCAL_SETTINGS.map((d) => d.id)
    for (const id of local) expect(ids).not.toContain(id)
    for (const d of SETTINGS) {
      const section = SECTIONS.find((s) => s.id === d.section)
      expect(section, d.id).toBeDefined()
      if (d.sub)
        expect(
          section!.subsections?.map((u) => u.id),
          d.id
        ).toContain(d.sub)
      expect(d.label.trim(), d.id).not.toBe('')
    }
  })

  it('lists the sections in the agreed order', () => {
    expect(SECTIONS.map((s) => s.title)).toEqual([
      'General',
      'Providers & sources',
      'Launching',
      'Usage & limits',
      'Alerts',
      'Summaries & Ask',
      'Git',
      'Phone & remote',
      'Accounts & credits',
      'Archive & backup',
      'Advanced'
    ])
    const subs = (id: string) => SECTIONS.find((s) => s.id === id)!.subsections!.map((u) => u.title)
    expect(subs('usage')).toEqual([
      'Plan',
      'Live limits',
      'Limit health',
      'Pacing',
      'Prices',
      'Codex',
      'Tray & meter'
    ])
    expect(subs('launching')).toEqual(['Claude Code', 'Codex', 'Large sessions'])
    expect(subs('phone')).toEqual(['Phone access', 'Paired phones', 'Terminal access'])
    expect(subs('ai')).toEqual(['Summaries', 'Ask Claude', 'Ask across sessions'])
  })

  it('accounts for every AppSettings key: on the page once, or set elsewhere', () => {
    for (const key of Object.keys(ALL_KEYS)) expect(claimed(key), key).toBe(true)
    for (const path of NESTED) {
      const value = getPath(APP_DEFAULTS, path) as Record<string, unknown>
      expect(value && typeof value === 'object', path).toBe(true)
      for (const field of Object.keys(value)) {
        if (`${path}.${field}` === 'liveAlerts.quiet') continue
        expect(claimed(`${path}.${field}`), `${path}.${field}`).toBe(true)
      }
    }
    // No key is shown by two settings (it would be "on the page" twice).
    const seen = new Map<string, string>()
    for (const d of SETTINGS)
      for (const k of d.keys ?? []) {
        const id = `${d.store ?? 'app'}:${k}`
        expect(seen.get(id), `${k}: ${d.id} and ${seen.get(id)}`).toBeUndefined()
        seen.set(id, d.id)
      }
  })

  it('never offers a reset for secrets, keys, paired devices, backup passwords or system changes', () => {
    for (const id of [
      'accounts.keys',
      'phone.devices',
      'archive.backup-password',
      'archive.backup-folder',
      'phone.access',
      'phone.terminal',
      'alerts.hooks',
      'usage.status-line',
      'general.startup',
      'phone.read-only',
      'phone.confirm',
      'sources.folders'
    ]) {
      const d = settingDef(id)!
      expect(d.never, id).toBeTruthy()
      expect(canReset(d), id).toBe(false)
    }
    // Their keys never go into a reset patch, even in a section reset.
    const all = SETTINGS.filter((d) => d.section === 'sources')
    const patch = resetPatch(all, { ...APP_DEFAULTS, extraFolders: ['D:\\more'] } as never)
    expect(patch).not.toHaveProperty('extraFolders')
  })

  it('gives the phone only settings it may change', () => {
    const safe = new Set<string>(MOBILE_SAFE_SETTINGS)
    const phone = phoneSettings()
    expect(phone.length).toBeGreaterThan(10)
    for (const d of phone)
      for (const k of d.keys ?? []) expect(safe.has(k.split('.')[0]), `${d.id}: ${k}`).toBe(true)
    const ids = phone.map((d) => d.id)
    expect(ids).toContain('alerts.quiet')
    expect(ids).toContain('launching.terminal')
    expect(ids).not.toContain('launching.skip-permissions')
    expect(ids).not.toContain('phone.read-only')
  })
})

describe('settings search', () => {
  const ids = (q: string, defs?: SettingDef[]) => searchSettings(q, defs).map((d) => d.id)

  it('finds settings by label, description and section, every word, any case', () => {
    expect(ids('quiet hours')).toEqual(['alerts.quiet', 'alerts.quiet-approvals'])
    expect(ids('QUIET')).toEqual(ids('quiet'))
    expect(ids('Theme')).toContain('general.theme')
    expect(ids('pacing cap')).toEqual(['usage.pace-cap'])
    // A word must start a word: "ark" doesn't find "dark".
    expect(ids('ark')).not.toContain('general.theme')
    expect(ids('')).toHaveLength(SETTINGS.length)
    expect(ids('zzzz-nothing')).toEqual([])
  })

  it('finds settings by keywords and synonyms, and says so', () => {
    expect(ids('hook')).toEqual(['alerts.hooks'])
    expect(ids('ssh')).toContain('phone.terminal')
    expect(ids('ssh', PHONE_LOCAL_SETTINGS)).toEqual(['phone-local.ssh-key'])
    expect(ids('fast')).toEqual(
      expect.arrayContaining(['launching.model', 'launching.codex-model'])
    )
    expect(ids('dnd')).toContain('alerts.quiet')
    expect(ids('notifications')).toEqual(
      expect.arrayContaining(['alerts.desktop', 'alerts.limits'])
    )
    expect(ids('bypass')).toContain('launching.skip-permissions')
    const m = matchSetting(settingDef('alerts.hooks')!, 'hook')
    expect(m).toEqual({ match: true, viaKeyword: [] })
    const q = matchSetting(settingDef('alerts.quiet')!, 'dnd')
    expect(q).toEqual({ match: true, viaKeyword: ['dnd'] })
  })

  it('matches accents and curly quotes the same as plain text', () => {
    expect(ids('“finished” only')).toContain('alerts.min-work')
    expect(ids('thème')).toContain('general.theme')
  })
})

describe('changed from default, reset and undo', () => {
  const app = (patch: Partial<AppSettings>): Record<string, unknown> =>
    ({ ...structuredClone(APP_DEFAULTS), ...patch }) as unknown as Record<string, unknown>

  it('marks only the settings whose own keys differ from their defaults', () => {
    const s = app({
      terminal: 'cmd',
      liveAlerts: {
        ...APP_DEFAULTS.liveAlerts,
        quiet: { ...APP_DEFAULTS.liveAlerts.quiet, from: '23:00' }
      }
    })
    const changed = SETTINGS.filter((d) => (d.store ?? 'app') === 'app' && isChanged(d, s)).map(
      (d) => d.id
    )
    expect(changed.sort()).toEqual(['alerts.quiet', 'launching.terminal'])
    // Absent optional keys are their defaults (settings files from before them).
    const old = app({})
    delete old.codexArchive
    delete old.providers
    expect(isChanged(settingDef('archive.codex')!, old)).toBe(false)
    expect(isChanged(settingDef('sources.providers')!, old)).toBe(false)
  })

  it('resets one nested field and leaves the object’s other fields alone; Undo puts it back', () => {
    const before = app({
      liveAlerts: {
        ...APP_DEFAULTS.liveAlerts,
        finished: false,
        quiet: { ...APP_DEFAULTS.liveAlerts.quiet, enabled: true, from: '23:00' }
      }
    })
    const quiet = settingDef('alerts.quiet')!
    const patch = resetPatch([quiet], before) as Partial<AppSettings>
    expect(Object.keys(patch)).toEqual(['liveAlerts'])
    expect(patch.liveAlerts!.quiet).toEqual({ ...APP_DEFAULTS.liveAlerts.quiet })
    expect(patch.liveAlerts!.finished).toBe(false)
    const after = { ...before, ...patch }
    const undo = undoPatch([quiet], before, after) as Partial<AppSettings>
    expect(undo.liveAlerts!.quiet).toEqual({
      enabled: true,
      from: '23:00',
      to: '07:00',
      allowApprovals: false
    })
    expect(undo.liveAlerts!.finished).toBe(false)
  })

  it('a section reset covers every resettable setting in it, and nothing else', () => {
    const before = app({ terminal: 'cmd', skipPermissionsDefault: false, theme: 'dark' })
    const launching = SETTINGS.filter((d) => d.section === 'launching')
    const patch = resetPatch(launching, before) as Partial<AppSettings>
    expect(patch.terminal).toBe('wt')
    expect(patch.skipPermissionsDefault).toBe(true)
    expect(patch).not.toHaveProperty('theme')
  })

  it('settings kept by the phone server and backups have their own defaults', () => {
    const port = settingDef('advanced.ports')!
    const mobile = { ...STORE_DEFAULTS.mobile, port: 50000 }
    expect(isChanged(port, mobile)).toBe(true)
    expect(resetPatch([port], mobile)).toEqual({ port: 47821, httpsPort: 8443 })
    const keep = settingDef('archive.backup-keep')!
    expect(isChanged(keep, { schedule: 'daily', keep: 14, autoCleanSafety: false })).toBe(false)
    expect(resetPatch([keep], { schedule: 'weekly', keep: 5 })).toEqual({ keep: 14 })
    // Read-only mode shows "Changed" but is never reset (a security choice).
    const ro = settingDef('phone.read-only')!
    expect(isChanged(ro, { ...STORE_DEFAULTS.mobile, readOnly: true })).toBe(true)
    expect(resetPatch([ro], { ...STORE_DEFAULTS.mobile, readOnly: true })).toEqual({})
  })
})

describe('links into Settings', () => {
  it('resolve sections, sub-headings, settings and the old section ids', () => {
    expect(resolveTarget('alerts')).toEqual({ kind: 'section', id: 'alerts', section: 'alerts' })
    expect(resolveTarget('usage.pacing')).toEqual({
      kind: 'sub',
      id: 'usage.pacing',
      section: 'usage'
    })
    expect(resolveTarget('alerts.quiet')).toEqual({
      kind: 'setting',
      id: 'alerts.quiet',
      section: 'alerts'
    })
    for (const old of Object.keys(LEGACY_TARGETS)) expect(resolveTarget(old), old).not.toBeNull()
    expect(resolveTarget('codex-usage')).toMatchObject({ kind: 'sub', id: 'usage.codex' })
    expect(resolveTarget('backup')).toMatchObject({ kind: 'setting', id: 'archive.backup-folder' })
    expect(resolveTarget('nope')).toBeNull()
    expect(targetLabel('alerts.quiet')).toBe('Alerts › Quiet hours')
    expect(targetLabel('usage.pacing')).toBe('Usage & limits › Pacing')
  })
})

describe('status dots', () => {
  const NOW = Date.parse('2026-11-11T12:00:00Z')
  const source = (status: SourceInfo['status']): SourceInfo =>
    ({ id: 's', label: 'WSL: Ubuntu', status, statusMessage: 'Permission denied' }) as SourceInfo
  const hook = (h: Partial<HookEnv>): HookEnv =>
    ({ sourceId: 'c', label: 'Windows', installed: true, ...h }) as HookEnv
  const backup = (b: Partial<BackupStatus>): BackupStatus =>
    ({
      setDir: 'E:\\b',
      schedule: 'daily',
      lastSuccessAt: '2026-11-11T02:00:00Z',
      ...b
    }) as BackupStatus
  const mobile = (m: Partial<MobileStatus>, enabled = true): MobileStatus =>
    ({ settings: { enabled }, devices: [{ id: 'p' }], ...m }) as MobileStatus

  it('is quiet when nothing needs attention', () => {
    expect(
      settingsAttention({
        now: NOW,
        sources: [source('ok'), source('not-running'), source('missing')],
        hooks: [
          hook({ provider: 'codex', trust: 'trusted' }),
          hook({ installed: false, provider: 'codex' })
        ],
        limits: { envs: [{ installed: true }], stale: false } as LimitsState,
        backup: backup({}),
        mobile: mobile({}),
        accounts: [{ id: 'a', nickname: 'Work' } as never]
      })
    ).toEqual({})
    // Phone access off: no phone paired is fine.
    expect(settingsAttention({ now: NOW, mobile: mobile({ devices: [] }, false) })).toEqual({})
    // No backup folder: nothing to be overdue.
    expect(
      settingsAttention({
        now: NOW,
        backup: backup({ setDir: undefined, lastSuccessAt: undefined })
      })
    ).toEqual({})
  })

  it('flags each section with the setting to go to', () => {
    const a = settingsAttention({
      now: NOW,
      sources: [source('unreadable')],
      hooks: [hook({ provider: 'codex', trust: 'untrusted' })],
      limits: { envs: [{ installed: true }], stale: true } as LimitsState,
      backup: backup({ lastSuccessAt: '2026-11-08T02:00:00Z' }),
      mobile: mobile({ devices: [] }),
      accounts: [{ id: 'a', nickname: 'Work', needsKey: true } as never]
    })
    expect(a.sources?.[0]).toMatchObject({ target: 'sources.folders' })
    expect(a.sources?.[0].message).toContain('Permission denied')
    expect(a.alerts?.[0]).toMatchObject({ target: 'alerts.hooks' })
    expect(a.alerts?.[0].message).toMatch(/trust/i)
    expect(a.usage?.[0]).toMatchObject({ target: 'usage.status-line' })
    expect(a.archive?.[0]).toMatchObject({ target: 'archive.backup-folder' })
    expect(a.archive?.[0].message).toMatch(/overdue/)
    expect(a.phone?.[0]).toMatchObject({ target: 'phone.devices' })
    expect(a.accounts?.[0]).toMatchObject({ target: 'accounts.keys' })
    for (const list of Object.values(a))
      for (const x of list) expect(resolveTarget(x.target)).not.toBeNull()
  })

  it('flags failed and paused backups, and a phone server error', () => {
    expect(
      settingsAttention({
        now: NOW,
        backup: backup({ last: { ok: false, error: 'Disk full' } as never })
      }).archive?.[0].message
    ).toContain('Disk full')
    expect(
      settingsAttention({ now: NOW, backup: backup({ paused: { reason: 'replaced' } }) })
        .archive?.[0].message
    ).toMatch(/paused/)
    expect(
      settingsAttention({ now: NOW, mobile: mobile({ error: 'serve failed' }) }).phone?.[0]
    ).toMatchObject({ target: 'phone.access' })
    // Weekly backups aren't overdue after three days.
    expect(
      settingsAttention({
        now: NOW,
        backup: backup({ schedule: 'weekly', lastSuccessAt: '2026-11-08T02:00:00Z' })
      })
    ).toEqual({})
  })
})
