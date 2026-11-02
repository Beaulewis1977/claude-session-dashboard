// Display text for summaries and their estimates.

import { formatDateTime, formatTokens } from '@shared/format'
import type { AiSummary, SummaryEstimate } from '@shared/summary'
import { modelLabel } from '@shared/usage/pricing'

/** "About 42k tokens · roughly 3% of your 5-hour window". */
export function estimateText(e: SummaryEstimate): string {
  const pct =
    e.pct5h === undefined
      ? ''
      : ` · roughly ${e.pct5h < 1 ? '<1' : Math.round(e.pct5h)}% of your 5-hour window`
  return `About ${formatTokens(e.tokens)} tokens${pct}`
}

/** Where a summary came from: "Oct 22, 2026 2:47 PM · Sonnet 5.5 · edited". */
export function summaryByline(s: AiSummary): string {
  const sample = s.model?.endsWith(' (sample)') === true
  const model = s.model ? modelLabel(s.model.replace(/ \(sample\)$/, '')) : undefined
  return [
    formatDateTime(s.generatedAt),
    model && `${model}${sample ? ' (sample)' : ''}`,
    s.editedAt ? 'edited' : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}
