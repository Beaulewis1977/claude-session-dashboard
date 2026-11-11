import { describe, expect, it } from 'vitest'
import {
  costParts,
  DEFAULT_CODEX_PRICES,
  DEFAULT_PRICES,
  estimateCost
} from '@shared/usage/pricing'

describe('estimateCost', () => {
  it('is exactly the sum of costParts (same order, same bits), for every kind of record', () => {
    const table = [...DEFAULT_PRICES, ...DEFAULT_CODEX_PRICES]
    const models = [
      ...table.map((p) => p.model),
      ...table.slice(0, 8).map((p) => `${p.model}-fast`),
      'claude-sonnet-4-5-20250929',
      'unknown-model',
      'unknown-model-fast'
    ]
    let seed = 11
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let i = 0; i < 5000; i++) {
      const r = {
        model: models[rnd(models.length)],
        input: rnd(3) ? rnd(400_000) : rnd(10),
        output: rnd(50_000),
        cacheWrite: rnd(300_000),
        cacheRead: rnd(2_000_000),
        ...(rnd(2) ? { cw1h: rnd(400_000) } : {})
      }
      const p = costParts(r, table)
      expect(
        Object.is(estimateCost(r, table), p.input + p.output + p.cacheRead + p.cacheWrite)
      ).toBe(true)
    }
  })
})
