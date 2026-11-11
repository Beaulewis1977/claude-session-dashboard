import { describe, expect, it } from 'vitest'
import { mergeByTime } from '@shared/usage/merge'

describe('merging two time-sorted lists', () => {
  const sorted = (xs: { ts: number }[]) => [...xs].sort((a, b) => a.ts - b.ts)

  it('gives exactly what a stable sort of both gives (ties: the first list first, each in its order)', () => {
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let round = 0; round < 300; round++) {
      const a = sorted(Array.from({ length: rnd(40) }, (_, i) => ({ ts: rnd(20), id: `a${i}` })))
      const b = sorted(Array.from({ length: rnd(40) }, (_, i) => ({ ts: rnd(20), id: `b${i}` })))
      expect(mergeByTime(a, b)).toEqual([...a, ...b].sort((x, y) => x.ts - y.ts))
    }
  })

  it('sorts as before when a list is out of order', () => {
    const a = [{ ts: 3 }, { ts: 1 }]
    const b = [{ ts: 2 }]
    expect(mergeByTime(a, b)).toEqual([{ ts: 1 }, { ts: 2 }, { ts: 3 }])
    expect(mergeByTime([], [])).toEqual([])
  })
})
