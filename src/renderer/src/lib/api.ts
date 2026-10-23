import type { CsdApi } from '@shared/api'

declare global {
  interface Window {
    csd: CsdApi
  }
}

/**
 * The bridge to the main process: IPC in the desktop window (set by the
 * preload script), HTTPS + WebSocket in the phone app (set by mobile/install).
 * Looked up on each use, not at import: the phone sets window.csd after the
 * shared code has been loaded.
 */
export const api: CsdApi = new Proxy({} as CsdApi, {
  get: (_target, key) => window.csd[key as keyof CsdApi]
})
