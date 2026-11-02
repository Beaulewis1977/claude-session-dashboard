import { useEffect, useRef } from 'react'
import { now } from '@shared/clock'

/**
 * Call `onExpire` when a warm cache runs out (`warmUntil`, epoch ms): the
 * resume estimate then goes up, so whoever shows it fetches it again.
 */
export function useWarmExpiry(warmUntil: number | undefined, onExpire: () => void): void {
  const cb = useRef(onExpire)
  useEffect(() => {
    cb.current = onExpire
  })
  useEffect(() => {
    if (!warmUntil) return
    const t = window.setTimeout(() => cb.current(), Math.max(0, warmUntil - now()) + 1000)
    return () => window.clearTimeout(t)
  }, [warmUntil])
}
