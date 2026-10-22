import type { CsdApi } from '@shared/api'

declare global {
  interface Window {
    csd: CsdApi
  }
}

export const api: CsdApi = window.csd
