// Shared hooks for the gauges: the app clock, reduced motion and count-up.

import { useEffect, useRef, useState } from 'react'
import { now } from '@shared/clock'

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(motionQuery.matches)
  useEffect(() => {
    const on = (): void => setReduced(motionQuery.matches)
    motionQuery.addEventListener('change', on)
    return () => motionQuery.removeEventListener('change', on)
  }, [])
  return reduced
}

/** Animate a number toward `value` (under 400 ms; instant with reduced motion). */
export function useCountUp(value: number, ms = 360): number {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    if (reduced) {
      from.current = value
      return
    }
    const start = performance.now()
    const a = from.current
    let raf = 0
    const step = (t: number): void => {
      const k = Math.min(1, (t - start) / ms)
      const eased = 1 - (1 - k) ** 3
      setShown(a + (value - a) * eased)
      if (k < 1) raf = requestAnimationFrame(step)
      else from.current = value
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms, reduced])
  return reduced ? value : shown
}

/** Re-render on a timer so countdowns stay current. */
export function useNow(ms = 30_000): number {
  const [t, setT] = useState(now())
  useEffect(() => {
    const id = window.setInterval(() => setT(now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return t
}

export type Level = 'calm' | 'warn' | 'crit'

/** Calm under 75%, amber 75–90%, red from 90%. Red is used nowhere else. */
export function levelOf(pct: number): Level {
  return pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'calm'
}

export const LEVEL_COLOR: Record<Level, string> = {
  calm: 'var(--gauge-calm)',
  warn: 'var(--gauge-warn)',
  crit: 'var(--gauge-crit)'
}
