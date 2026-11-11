// Keeps live limits and credits in the store, refreshed when the main
// process reports a change (throttled, so a busy session doesn't flood IPC).

import { useEffect } from 'react'
import { api } from './api'
import { useApp } from './store'

function throttled(fn: () => Promise<void>, ms: number): () => void {
  let timer: number | undefined
  let running = false
  let again = false
  const run = (): void => {
    if (running) {
      again = true
      return
    }
    running = true
    void fn().finally(() => {
      running = false
      if (again) {
        again = false
        schedule()
      }
    })
  }
  const schedule = (): void => {
    if (timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      run()
    }, ms)
  }
  return schedule
}

/** Starts once `enabled` (after the app clock is set from AppInfo). */
export function useLiveData(enabled = true): void {
  const set = useApp((s) => s.set)
  useEffect(() => {
    if (!enabled) return
    // Claude Code's and Codex's limits, loaded together (one change event for both).
    const loadLimits = async (): Promise<void> => {
      const [limits, codexLimits, fast] = await Promise.all([
        api.getLimits(),
        Promise.resolve()
          .then(() => api.getCodexLimits())
          .catch(() => null),
        // Which Codex models offer fast mode (cheap: the file is read again only when it changed).
        Promise.resolve()
          .then(() => api.getFastModels())
          .catch(() => ({ codex: null }))
      ])
      set({ limits, codexLimits, codexFastModels: fast.codex })
    }
    const loadCredits = async (): Promise<void> => set({ credits: await api.getCredits() })
    void loadLimits()
    void loadCredits()
    const l = throttled(loadLimits, 800)
    const c = throttled(loadCredits, 1200)
    const offs = [api.onLimitsChanged(l), api.onCreditsChanged(c), api.onUsageChanged(l)]
    // Countdowns and "stale" labels depend on the clock.
    const tick = window.setInterval(l, 60_000)
    return () => {
      offs.forEach((off) => off())
      window.clearInterval(tick)
    }
  }, [set, enabled])
}

/** "API · Personal credits", "Max 5x" or undefined (unknown). */
export function billingLabel(
  billing: { mode: string; accountId?: string } | undefined,
  accounts: { id: string; nickname: string }[],
  planLabel: string
): string | undefined {
  if (!billing || billing.mode === 'unknown') return undefined
  if (billing.mode === 'subscription') return planLabel
  const a = accounts.find((x) => x.id === billing.accountId)
  return a ? `API · ${a.nickname}` : 'API'
}
