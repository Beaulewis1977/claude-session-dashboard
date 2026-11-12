// The Settings menu's amber dots: what needs attention in each section, and
// the exact setting a click on the dot goes to. Pure rules; the renderer
// (lib/settings-attention.ts) gathers their inputs while Settings is open.

import type { SectionId } from './settings-registry'
import type { SourceInfo } from './types'
import type { HookEnv } from './live'
import type { LimitsState } from './usage/limits'
import type { BackupStatus } from './backup'
import type { MobileStatus } from './mobile'
import type { Account } from './usage/credits'

export interface Attention {
  message: string
  /** The setting (or heading) to go to. */
  target: string
}

export interface AttentionInput {
  now: number
  sources?: SourceInfo[]
  hooks?: HookEnv[]
  limits?: LimitsState | null
  backup?: BackupStatus | null
  mobile?: MobileStatus | null
  accounts?: Account[]
}

const DAY = 24 * 60 * 60 * 1000
const INTERVAL: Record<string, number> = { daily: DAY, weekly: 7 * DAY }

export function settingsAttention(i: AttentionInput): Partial<Record<SectionId, Attention[]>> {
  const out: Partial<Record<SectionId, Attention[]>> = {}
  const add = (section: SectionId, a: Attention): void => {
    ;(out[section] ??= []).push(a)
  }

  for (const s of i.sources ?? [])
    if (s.status === 'unreadable')
      add('sources', {
        message: `Can’t read ${s.label}${s.user ? ` (${s.user})` : ''}${s.statusMessage ? `: ${s.statusMessage}` : ''}`,
        target: 'sources.folders'
      })

  for (const h of i.hooks ?? []) {
    if (h.installed && (h.changedSinceInstall || h.hookModified))
      add('alerts', {
        message: `The app’s hooks in ${h.label} were changed by something else since they were added.`,
        target: 'alerts.hooks'
      })
    if (h.provider === 'codex' && h.installed && h.hooksFeatureOff)
      add('alerts', {
        message: `Hooks are turned off in Codex’s config.toml (${h.label}), so approval alerts are guesses.`,
        target: 'alerts.hooks'
      })
    else if (h.provider === 'codex' && h.installed && h.trust && h.trust !== 'trusted')
      add('alerts', {
        message:
          h.trust === 'disabled'
            ? `The approval hook is turned off in Codex (${h.label}). Turn it on in Codex’s /hooks.`
            : `Codex doesn’t trust the approval hook yet (${h.label}). Trust it in Codex’s /hooks.`,
        target: 'alerts.hooks'
      })
  }

  const envs = i.limits?.envs ?? []
  if (envs.some((e) => e.installed) && i.limits?.stale)
    add('usage', {
      message: 'Live limits are stale: no recent status line reading.',
      target: 'usage.status-line'
    })
  for (const e of envs)
    if (e.installed && e.changedSinceInstall)
      add('usage', {
        message: `The status line in ${e.label} was changed after the bridge was enabled.`,
        target: 'usage.status-line'
      })

  const b = i.backup
  if (b?.setDir) {
    if (b.paused)
      add('archive', {
        message: 'Backups are paused until you choose.',
        target: 'archive.backup-folder'
      })
    else if (b.last && !b.last.ok)
      add('archive', {
        message: `The last backup failed${b.last.error ? `: ${b.last.error}` : '.'}`,
        target: 'archive.backup-folder'
      })
    else {
      const every = INTERVAL[b.schedule]
      const last = b.lastSuccessAt ? Date.parse(b.lastSuccessAt) : NaN
      if (every && Number.isFinite(last) && i.now - last > 2 * every)
        add('archive', {
          message: `No backup since ${new Date(last).toLocaleDateString()}: backups are overdue.`,
          target: 'archive.backup-folder'
        })
      else if (every && !Number.isFinite(last))
        add('archive', { message: 'No backup has finished yet.', target: 'archive.backup-folder' })
    }
  }

  const m = i.mobile
  if (m?.settings.enabled) {
    if (m.error)
      add('phone', { message: `Phone access: ${m.error}`, target: 'phone.access-switch' })
    if (m.devices.length === 0)
      add('phone', {
        message: 'Phone access is on, but no phone is paired yet.',
        target: 'phone.devices'
      })
  }

  for (const a of i.accounts ?? [])
    if (a.needsKey)
      add('accounts', {
        message: `“${a.nickname}” needs its key again (Reconnect).`,
        target: 'accounts.keys'
      })

  return out
}
