import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coalesce } from '../src/main/core/coalesce'

describe('coalesce (change notices)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs at once, then at most once per interval, never losing the last call', () => {
    const fn = vi.fn()
    const c = coalesce(fn, () => 1000)
    c()
    expect(fn).toHaveBeenCalledTimes(1)
    // A burst inside the interval: one more run, at its end.
    for (let i = 0; i < 50; i++) c()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(999)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(2)
    // Quiet for longer than the interval: at once again.
    vi.advanceTimersByTime(5000)
    c()
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('asks for the interval each time (longer while busy) and can flush', () => {
    const fn = vi.fn()
    let busy = true
    const c = coalesce(fn, () => (busy ? 3000 : 1000))
    c()
    c()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(2)
    busy = false
    c()
    c.flush()
    expect(fn).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
