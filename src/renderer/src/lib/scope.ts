// The All / Claude / Codex switch and the subagent toggle, as the desktop
// keeps them (in the app's settings, so they're remembered between launches).

import { useMemo } from 'react'
import {
  effectiveView,
  enabledProviders,
  sanitizeProviderToggles,
  type ProviderId,
  type ProviderToggles,
  type ProviderView
} from '@shared/provider'
import type { AppSettings, SessionSummary } from '@shared/types'
import { api } from './api'
import type { Scope } from './filters'
import { useApp } from './store'

export function toggles(settings: Pick<AppSettings, 'providers'>): ProviderToggles {
  return sanitizeProviderToggles(settings.providers)
}

export function scopeOf(
  settings: Pick<AppSettings, 'providers' | 'providerView' | 'showSubagents'>
): Scope {
  return {
    view: effectiveView(settings.providerView ?? 'all', toggles(settings)),
    subagents: settings.showSubagents === true
  }
}

/** The desktop's scope (from Settings). */
export function useScope(): Scope {
  const providers = useApp((s) => s.settings.providers)
  const providerView = useApp((s) => s.settings.providerView)
  const showSubagents = useApp((s) => s.settings.showSubagents)
  return useMemo(
    () => scopeOf({ providers, providerView, showSubagents }),
    [providers, providerView, showSubagents]
  )
}

/** Providers that are on (the switch shows only when more than one is). */
export function useEnabledProviders(): ProviderId[] {
  const providers = useApp((s) => s.settings.providers)
  return useMemo(() => enabledProviders(sanitizeProviderToggles(providers)), [providers])
}

/** Remember the switch (desktop: in Settings). */
export function saveView(view: ProviderView): void {
  const { settings, set } = useApp.getState()
  set({ settings: { ...settings, providerView: view } })
  void api.updateSettings({ providerView: view })
}

export function saveShowSubagents(on: boolean): void {
  const { settings, set } = useApp.getState()
  set({ settings: { ...settings, showSubagents: on } })
  void api.updateSettings({ showSubagents: on })
}

/** Some Codex sessions are subagent threads (the toggle shows only then). */
export function hasSubagents(sessions: Pick<SessionSummary, 'subagent'>[]): boolean {
  return sessions.some((s) => !!s.subagent)
}
