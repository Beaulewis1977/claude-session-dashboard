// What a launch in fast mode should say first (the launch dialog on the
// desktop, the launch sheet on the phone):
// - Claude Code on the subscription: fast mode is billed to usage credits,
//   never to the plan's limits, and needs usage credits turned on.
// - Codex: it uses the plan's limits at 2.5×, so above the limits guard's
//   pause line (Settings → Summaries) it warns.
// - Opened in the agent's own app: the flag isn't passed there.

import type { CodexLimitsState } from './usage/codex'
import type { ProviderId } from './provider'

export const CLAUDE_FAST_CREDITS =
  'Fast mode is billed to usage credits (not your plan limits) and only works if usage credits are turned on in your Claude account.'

export const CLAUDE_FAST_API =
  'Fast mode on an API key is billed at its higher per-token price (Opus 5.5: $8 / $40 per million input / output tokens).'

export interface FastNote {
  tone: 'info' | 'warn'
  text: string
}

/** The notes for a launch in fast mode (none when it isn't one). */
export function fastNotes(i: {
  fast: boolean | undefined
  agent: ProviderId
  /** On an API key (Claude Code only). */
  api?: boolean
  /** Opens in the agent's own desktop app (no flags are passed there). */
  inApp?: 'claude-app' | 'codex-app'
  codexLimits?: Pick<CodexLimitsState, 'fiveHour'> | null
  /** Settings → Summaries: the 5-hour % the limits guard pauses above. */
  pauseAbovePct: number
}): FastNote[] {
  if (!i.fast) return []
  if (i.inApp === 'claude-app')
    return [
      { tone: 'info', text: "Fast mode isn't passed to the Claude desktop app: use /fast there." }
    ]
  if (i.inApp === 'codex-app')
    return [{ tone: 'info', text: "Fast mode isn't passed to the Codex app: turn on Fast there." }]
  if (i.agent === 'codex') {
    const g = i.codexLimits?.fiveHour
    const pct = g && !g.expired ? Math.round(g.pct) : undefined
    return pct !== undefined && pct > i.pauseAbovePct
      ? [
          {
            tone: 'warn',
            text: `Codex's 5-hour window is at ${pct}%, above your ${i.pauseAbovePct}% pause line. Fast mode uses limits at 2.5× the standard rate.`
          }
        ]
      : [{ tone: 'info', text: 'Fast mode uses your Codex limits at 2.5× the standard rate.' }]
  }
  return [{ tone: 'info', text: i.api ? CLAUDE_FAST_API : CLAUDE_FAST_CREDITS }]
}

/** The short note next to the Fast picker. */
export const FAST_NOTE = 'Faster replies, uses limits faster / costs more'

/** What fast mode does and costs, per agent (the picker's ⓘ). */
export function fastDetails(agent: ProviderId): string[] {
  if (agent === 'codex')
    return [
      "Codex's Fast service tier: the same model, about 1.5–2× faster, on the models whose entry in Codex's own model list offers it.",
      'Signed in with ChatGPT, it uses your included limits at 2.5× the standard rate (purchased credits at 2×). With an API key, API prices apply.',
      'Passed as -c service_tier=fast. Off passes nothing, so the service_tier in your config.toml applies.',
      'Not passed when the session opens in the Codex app: use Fast there.'
    ]
  return [
    'The same model up to 2.5× faster, at a higher price per token. Only on Fable 5.2, Opus 5.5 and Opus 5.',
    'With your Claude subscription it is billed to usage credits (not your plan limits), and only works if usage credits are turned on in your Claude account.',
    'On an API key, per million input / output tokens: $16 / $80 (Fable 5.2), $8 / $40 (Opus 5.5), $10 / $50 (Opus 5).',
    'Passed as --settings with the app\'s own file that holds only {"fastMode": true}: your other Claude Code settings stay as they are. Off passes nothing, so your own /fast setting applies.',
    'Not passed when the session opens in the Claude desktop app: use /fast there.'
  ]
}
