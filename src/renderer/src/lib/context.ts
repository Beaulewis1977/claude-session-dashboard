// Wording for context sizes and resume estimates (desktop and phone).

import type { CostEstimate, ResumeEstimate, SessionContext } from '@shared/context'
import { formatInt, formatTokens, formatUsd } from '@shared/format'
import { modelLabel } from '@shared/model-choice'

/** "12%", "4.5%", "< 0.1%". */
export function pctText(p: number): string {
  if (p < 0.1) return '< 0.1%'
  if (p < 10) return `${p.toFixed(1).replace(/\.0$/, '')}%`
  return `${Math.round(p)}%`
}

/** "≈ 12%" (subscription), "≈ $1.20" (API), else "≈ 182K tokens". */
export function costShort(c: CostEstimate, billing: ResumeEstimate['billing']): string {
  if (c.unpriced) return `≈ ${formatTokens(c.tokens)} tokens`
  if (billing === 'api' && c.costUsd > 0) return `≈ ${formatUsd(c.costUsd)}`
  if (billing === 'subscription' && c.pct5h !== undefined) return `≈ ${pctText(c.pct5h)}`
  return `≈ ${formatTokens(c.tokens)} tokens`
}

/** What resuming would use, as a sentence ending without a full stop. */
export function resumeSentence(e: ResumeEstimate): string {
  const c = e.resume
  if (e.billing === 'api')
    return c.costUsd > 0
      ? `Resuming costs about ${formatUsd(c.costUsd)} in API credits (it doesn't use your 5-hour window)`
      : `Resuming reloads about ${formatTokens(e.tokens)} tokens on API credits`
  if (c.pct5h !== undefined)
    return `Resuming may use about ${pctText(c.pct5h)} of your ${e.pctWindow === 'seven_day' ? 'weekly limit' : '5-hour window'}`
  return `Resuming reloads about ${formatTokens(e.tokens)} tokens`
}

export function compactionNote(
  c: Pick<SessionContext, 'compactions' | 'preCompactTokens'>
): string | undefined {
  if (!c.compactions) return undefined
  const times = c.compactions === 1 ? 'once' : `${c.compactions}×`
  return `Compacted ${times}${c.preCompactTokens ? ` (${formatTokens(c.preCompactTokens)} before the last)` : ''}`
}

/** "1M · Opus 5.5": the window and the model it belongs to. */
export function windowLabel(e: Pick<ResumeEstimate, 'windowSize' | 'windowModel'>): string {
  return `${formatTokens(e.windowSize)}${e.windowModel ? ` · ${modelLabel(e.windowModel)}` : ''}`
}

const WINDOW_FROM: Record<ResumeEstimate['windowFrom'], string> = {
  variant: 'the [1m] variant chosen for the launch',
  'status-line': "Claude Code's status line for this session",
  model: "the model's own window in Claude Code's model configuration",
  size: 'the context is already past 200k, so it runs on a 1M window',
  'codex-log': "Codex's own session log (its model_context_window)"
}

/** Where the window size comes from (hover text). */
export function windowSource(
  e: Pick<ResumeEstimate, 'windowSize' | 'windowModel' | 'windowFrom'>
): string {
  return `${formatInt(e.windowSize)}-token context window${e.windowModel ? ` of ${modelLabel(e.windowModel)}` : ''}, from ${WINDOW_FROM[e.windowFrom] ?? 'the model'}.`
}

/** Hover text of the size badge. */
export function contextTitle(c: SessionContext): string {
  const parts = [`≈ ${formatInt(c.tokens)} tokens in context`]
  if (c.from === 'compaction') parts.push('estimated after the last compaction')
  else if (c.from === 'status-line') parts.push('from the status line')
  const note = compactionNote(c)
  if (note) parts.push(note.toLowerCase())
  return parts.join(' · ')
}

const CACHE: Record<ResumeEstimate['cache'], string> = {
  '1h': '1-hour cache',
  '5m': '5-minute cache',
  mixed: 'partly 1-hour, partly 5-minute cache'
}

const SOURCE: Record<ResumeEstimate['from'], string> = {
  usage: "the last reply's usage in the session file",
  compaction: 'the compaction summary (no reply since the last compaction)',
  'status-line': "Claude Code's status line"
}

/** Codex: its own log, not a status line. */
const CODEX_SOURCE: Record<ResumeEstimate['from'], string> = {
  usage: "the last response's token count in Codex's log",
  compaction: 'the compaction summary (no response since the last compaction)',
  'status-line': "Codex's log"
}

/** The ⓘ text: how the estimate is worked out. */
export function estimateExplainer(e: ResumeEstimate): string {
  const codex = e.windowFrom === 'codex-log' || !!e.cacheNote
  const lines = [
    `Estimate. The context size (${formatInt(e.tokens)} tokens) comes from ${(codex ? CODEX_SOURCE : SOURCE)[e.from]}. The window: ${windowSource(e)}`,
    codex
      ? `Resuming sends the whole conversation again. Priced as ${e.model} at OpenAI's API list prices (Codex's price table). ${e.cacheNote ?? ''}`.trim()
      : `Resuming sends the whole conversation again. Priced as ${e.model} at API list prices: the first message writes it to the prompt cache (${CACHE[e.cache]}), and each later message reads it from the cache.`
  ]
  if (e.otherScope)
    lines.push(
      "This launch bills another account than the session did (or the session's billing isn't known), so it can't reuse the session's cache, and the write is priced at the 1-hour cache rate."
    )
  if (e.warmUntil)
    lines.push(
      "The last reply was recent enough that its cache may still be (partly) alive, so the first message may read it from the cache instead (if Claude Code's prompt is unchanged). The estimate goes up when it runs out."
    )
  if (e.billing === 'api') lines.push("On API credits, this doesn't use your 5-hour window.")
  else if (e.basis === 'baseline')
    lines.push(
      codex
        ? `The share of your ${e.pctWindow === 'seven_day' ? 'weekly limit' : '5-hour window'} comes from your Codex limit-health baseline ($ per 1%).`
        : 'The share of the 5-hour window comes from your limit-health baseline ($ per 1%).'
    )
  else if (e.basis === 'window')
    lines.push(
      "There's no limit-health baseline yet, so the share comes from this window's own use so far (subscription use only)."
    )
  if (e.unknown) lines.push(e.unknown)
  if (e.fresh)
    lines.push(
      `Continue fresh starts a new session with only Claude Code's setup and the summary handoff: about ${formatTokens(e.fresh.tokens)} tokens${e.freshModel ? `, priced as ${e.freshModel}` : " (in tokens: with no model chosen, the new session uses Claude Code's default model, which the app can't see; pick a model to compare in %)"}.`
    )
  return lines.join(' ')
}
