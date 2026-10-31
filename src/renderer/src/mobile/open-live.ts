// A tapped push alert opens its session. The tap can come before the app has
// loaded (a cold start) or while the PC can't be reached, so the reference
// (and, once the PC has resolved it, the session key) is kept until the
// session can be shown; a failed lookup is tried again when the connection
// comes back.

import { useEffect, useRef, useState } from 'react'
import { useApp } from '@/lib/store'
import { phone } from '@/lib/web-api'
import { nextOpenStep, type PendingLive } from './open-live-rules'

export function useOpenLive(paired: boolean): void {
  const [pending, setPending] = useState<PendingLive | null>(null)
  const loaded = useApp((s) => s.loaded)
  const sessions = useApp((s) => s.sessions)
  const [conn, setConn] = useState(phone.connection)
  const inFlight = useRef(false)
  useEffect(() => phone.onConnection(setConn), [])

  useEffect(() => {
    if (!paired) return
    return phone.onOpenLive((ref) => {
      // Running now right away; the session itself once it's known.
      useApp.getState().set({ view: 'running', selectedKey: null })
      setPending(ref ? { ref, since: Date.now() } : null)
    })
  }, [paired])

  useEffect(() => {
    if (!pending) return
    const step = nextOpenStep(pending, {
      loaded,
      known: (key) => sessions.some((s) => s.key === key),
      inFlight: inFlight.current,
      now: Date.now()
    })
    if (step === 'open') {
      useApp.getState().set({ view: 'running', selectedKey: pending.key! })
      setPending(null)
    } else if (step === 'drop') setPending(null)
    else if (step === 'resolve') {
      const ref = pending.ref!
      inFlight.current = true
      phone
        .resolveLiveRef(ref)
        // Expired or already used: Running now stays open.
        .then((key) =>
          setPending((p) => (p?.ref === ref ? (key ? { key, since: p.since } : null) : p))
        )
        // Offline: kept, and tried again when the connection is back.
        .catch(() => undefined)
        .finally(() => {
          inFlight.current = false
        })
    }
  }, [pending, loaded, sessions, conn])
}
