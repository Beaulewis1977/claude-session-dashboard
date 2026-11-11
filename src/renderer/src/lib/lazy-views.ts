// Loads screens' code in the background once the app has started (when the
// renderer is idle), so a lazily loaded screen opens without waiting.

export function idleLoad(loaders: (() => Promise<unknown>)[], delayMs = 1500): void {
  if (typeof window === 'undefined') return
  window.setTimeout(() => {
    const next = (): void => {
      const load = loaders.shift()
      if (!load) return
      const go = (): void =>
        void load()
          .catch(() => undefined)
          .then(next)
      if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 3000 })
      else go()
    }
    next()
  }, delayMs)
}
