// Moving to and saving settings from anywhere: links into the Settings page,
// and saving or resetting settings (with what Undo needs).

import {
  canReset,
  isChanged,
  resetPatch,
  settingDef,
  undoPatch,
  type SettingDef
} from '@shared/settings-registry'
import type { AppSettings } from '@shared/types'
import type { GitLinkSettings } from '@shared/git/types'
import { api } from './api'
import { useApp } from './store'

/** Height of a section's sticky header (sub-headings stick right under it). */
export const SECTION_HEADER_PX = 48
export const SUB_HEADER_PX = 30

/** Go to a setting, sub-heading or section (opens Settings; recorded in Back / Forward). */
export function openSettingsTarget(target: string): void {
  useApp.getState().set({ view: 'settings', settingsSection: target })
}

// ─── Saving and resetting ────────────────────────────────────────────────

/**
 * Save a settings patch: shown at once, then what the app saved. Git links go
 * through their own call (it starts or stops reading repos).
 */
export async function applySettingsPatch(patch: Partial<AppSettings>): Promise<void> {
  const st = useApp.getState()
  const before = st.settings
  st.set({ settings: { ...before, ...patch } })
  const { gitLinks, ...rest } = patch
  try {
    if (Object.keys(rest).length) st.set({ settings: await api.updateSettings(rest) })
    if (gitLinks) {
      await api.updateGitSettings(gitLinks as Partial<GitLinkSettings>)
      st.set({ settings: await api.getSettings() })
    }
  } catch (err) {
    // Not saved: show what the app has, and let the caller say it failed.
    st.set({ settings: await api.getSettings().catch(() => before) })
    throw err
  }
}

/** Reset these (app) settings to their defaults; resolves to their Undo. */
export async function resetAppSettings(defs: SettingDef[]): Promise<() => Promise<void>> {
  const before = useApp.getState().settings as unknown as Record<string, unknown>
  await applySettingsPatch(resetPatch(defs, before) as Partial<AppSettings>)
  return async () => {
    const now = useApp.getState().settings as unknown as Record<string, unknown>
    await applySettingsPatch(undoPatch(defs, before, now) as Partial<AppSettings>)
  }
}

/**
 * "Changed" and reset for a setting kept outside AppSettings (phone,
 * backup): its values now, and how to save a patch of them.
 */
export function storeSetting(
  id: string,
  values: Record<string, unknown> | null | undefined,
  apply: (patch: Record<string, unknown>) => Promise<unknown>
): { changed: boolean; onReset?: () => Promise<() => Promise<void>> } {
  const def = settingDef(id)
  if (!def || !values) return { changed: false }
  const changed = isChanged(def, values)
  if (!canReset(def)) return { changed }
  return {
    changed,
    onReset: async () => {
      const before = { ...values }
      await apply(resetPatch([def], values))
      return async () => {
        await apply(undoPatch([def], before, values))
      }
    }
  }
}
