// One color per token type and per model, used by every chart, chip and legend.

import type { TokenType } from '@shared/usage/types'
import { modelLabel } from '@shared/usage/pricing'

export const TOKEN_META: Record<TokenType, { label: string; color: string; short: string }> = {
  cacheRead: { label: 'Cache read', short: 'Cache read', color: 'var(--tok-cache-read)' },
  cacheWrite: { label: 'Cache write', short: 'Cache write', color: 'var(--tok-cache-write)' },
  input: { label: 'Input', short: 'Input', color: 'var(--tok-input)' },
  output: { label: 'Output', short: 'Output', color: 'var(--tok-output)' }
}

/** Bottom to top in stacked charts: the big, cheap cache reads at the base. */
export const TOKEN_ORDER: TokenType[] = ['cacheRead', 'cacheWrite', 'input', 'output']

function family(model: string): string {
  const m = /^claude-(?:\d-\d-)?([a-z]+)/i.exec(model)
  return m ? m[1].toLowerCase() : 'other'
}

const FAMILY_VAR: Record<string, string> = {
  opus: '--model-opus',
  sonnet: '--model-sonnet',
  haiku: '--model-haiku',
  fable: '--model-fable',
  mythos: '--model-fable'
}

function versionRank(model: string): number {
  const nums = (model.match(/\d+/g) ?? []).filter((n) => n.length < 4).map(Number)
  return nums.reduce((a, n, i) => a + n / 10 ** i, 0)
}

/**
 * Color for a model: its family's hue, newest version at full strength and
 * older versions mixed toward the surface (the legend always names them).
 */
export function modelColor(model: string, allModels: string[]): string {
  const fam = family(model)
  const v = FAMILY_VAR[fam]
  if (!v) return 'var(--model-other)'
  const siblings = [...new Set(allModels.filter((m) => family(m) === fam))].sort(
    (a, b) => versionRank(b) - versionRank(a)
  )
  const i = Math.max(0, siblings.indexOf(model))
  if (i === 0) return `var(${v})`
  const pct = Math.max(35, 100 - i * 22)
  return `color-mix(in oklab, var(${v}) ${pct}%, var(--card))`
}

export { modelLabel }
