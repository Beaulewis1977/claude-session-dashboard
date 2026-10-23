// Settings → Phone: the companion's status, kept fresh while it's on screen.

import { useCallback, useEffect, useState } from 'react'
import type { MobileStatus } from '@shared/mobile'
import { api } from './api'

export function useMobileStatus(pollMs = 0): {
  status: MobileStatus | null
  refresh: () => Promise<MobileStatus>
  setStatus: (s: MobileStatus) => void
} {
  const [status, setStatus] = useState<MobileStatus | null>(null)
  const refresh = useCallback(async () => {
    const s = await api.mobileStatus()
    setStatus(s)
    return s
  }, [])
  useEffect(() => {
    const load = (): void => void api.mobileStatus().then(setStatus)
    load()
    const off = api.onMobileChanged(load)
    const t = pollMs ? window.setInterval(load, pollMs) : undefined
    return () => {
      off()
      if (t) window.clearInterval(t)
    }
  }, [pollMs])
  return { status, refresh, setStatus }
}

/** "https://login.tailscale.com/…" inside an error message, if any. */
export function tailscaleLinkIn(text: string | undefined): string | undefined {
  return text?.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0]
}
