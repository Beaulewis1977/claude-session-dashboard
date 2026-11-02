// The phone's All / Claude / Codex switch and subagent toggle: remembered on
// each phone (localStorage), since a phone can't change the PC's view.

import { useMemo } from 'react'
import { create } from 'zustand'
import {
  effectiveView,
  enabledProviders,
  isProviderView,
  sanitizeProviderToggles,
  type ProviderId,
  type ProviderView
} from '@shared/provider'
import type { Scope } from '@/lib/filters'
import { useApp } from '@/lib/store'

const VIEW_KEY = 'csd.mobile.providerView'
const SUB_KEY = 'csd.mobile.showSubagents'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    // a per-phone convenience only
  }
}

interface PhoneScope {
  view: ProviderView
  subagents: boolean
  setView: (v: ProviderView) => void
  setSubagents: (on: boolean) => void
}

export const usePhoneScope = create<PhoneScope>((set) => {
  const v = read(VIEW_KEY)
  return {
    view: isProviderView(v) ? v : 'all',
    subagents: read(SUB_KEY) === '1',
    setView: (view) => {
      write(VIEW_KEY, view)
      set({ view })
    },
    setSubagents: (on) => {
      write(SUB_KEY, on ? '1' : '0')
      set({ subagents: on })
    }
  }
})

/** Providers that are on (from the PC's Settings → Providers). */
export function usePhoneProviders(): ProviderId[] {
  const providers = useApp((s) => s.settings.providers)
  return useMemo(() => enabledProviders(sanitizeProviderToggles(providers)), [providers])
}

export function useMobileScope(): Scope {
  const view = usePhoneScope((s) => s.view)
  const subagents = usePhoneScope((s) => s.subagents)
  const providers = useApp((s) => s.settings.providers)
  return useMemo(
    () => ({ view: effectiveView(view, sanitizeProviderToggles(providers)), subagents }),
    [view, subagents, providers]
  )
}
