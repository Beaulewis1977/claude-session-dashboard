// What resuming a session would cost: its context size priced at the launch's
// model, as a share of the 5-hour window (estimate). Reuses the limit-health
// baseline and, without one, the live window's own rate with the limit
// gauge's subscription filter (API-billed use doesn't move the limit).

import { now } from '@shared/clock'
import {
  estimateResume,
  NO_BASELINE,
  pctPerWeightedToken,
  type ResumeEstimate
} from '@shared/context'
import { projectDefault } from '@shared/project-key'
import { summaryMarkdown } from '@shared/summary'
import type { AppSettings, SessionSummary } from '@shared/types'
import type { ModelPrice } from '@shared/usage/pricing'
import type { CodexLimitsService } from './codex-limits'
import type { LimitsService } from './limits'
import type { UsageService } from './usage'

/**
 * Codex logs no cache writes (uncached input is billed as input) and say
 * nothing about how long a prompt cache stays warm, so a Codex resume is
 * priced cold: the whole context at the input price.
 */
export const CODEX_CACHE_NOTE =
  "Codex's logs don't say how long its prompt cache stays warm, so this assumes a cold start: the whole context at the input price."

/** Codex's price table for a resume estimate: every write at the input price. */
function coldPrices(table: ModelPrice[]): ModelPrice[] {
  return table.map((p) => ({
    ...p,
    cacheWrite5m: p.input,
    cacheWrite1h: p.input,
    ...(p.longContext
      ? {
          longContext: {
            ...p.longContext,
            cacheWrite5m: p.longContext.input,
            cacheWrite1h: p.longContext.input
          }
        }
      : {})
  }))
}

/**
 * The launch bills the same account the session's prompt cache belongs to.
 * Caches aren't shared across organizations, so another account (or a
 * session whose billing isn't known) starts cold. The app tags a session's
 * billing when it opens the terminal, before any new reply: a tag newer than
 * the last reply says nothing about who made the cache.
 */
export function sameCacheScope(s: SessionSummary, billingAccountId: string | undefined): boolean {
  const b = s.billing
  if (!b) return false
  const lastReply = s.context?.lastReplyAt ? Date.parse(s.context.lastReplyAt) : undefined
  const taggedAt = s.meta.billing?.at ? Date.parse(s.meta.billing.at) : undefined
  if (
    b.source === 'launch' &&
    (taggedAt === undefined || lastReply === undefined || !(taggedAt <= lastReply))
  )
    return false
  if (billingAccountId) return b.mode === 'api' && b.accountId === billingAccountId
  return b.mode === 'subscription'
}

/**
 * A newer status line context reading changes badges, sorting and the
 * viewer: tell the session list (its change event reaches the renderer and
 * paired phones) whenever the newest reading's time moves.
 */
export function publishContextReadings(
  limits: Pick<LimitsService, 'lastContextAt'> & {
    on(event: 'changed', cb: () => void): unknown
  },
  sessions: { touch(): void }
): void {
  let seen = limits.lastContextAt()
  limits.on('changed', () => {
    const at = limits.lastContextAt()
    if (at === seen) return
    seen = at
    sessions.touch()
  })
}

export class ContextCost {
  constructor(
    private readonly deps: {
      limits: Pick<LimitsService, 'dollarsPerPct' | 'state' | 'isSubscription'>
      usage: Pick<UsageService, 'allRecords'>
      settings: () => AppSettings
      /** Codex sessions: its own baseline and price table. */
      codex?: { limits: Pick<CodexLimitsService, 'dollarsPerPct'>; prices: () => ModelPrice[] }
    }
  ) {}

  /** A Codex session: always on the ChatGPT plan, cold (see CODEX_CACHE_NOTE). */
  private codexEstimate(
    s: SessionSummary,
    modelChoice: string | undefined
  ): ResumeEstimate | undefined {
    if (!s.context || !this.deps.codex) return undefined
    const st = this.deps.settings()
    const basis = this.deps.codex.limits.dollarsPerPct()
    const est = estimateResume({
      ctx: { ...s.context, lastReplyAt: undefined, cache1hShare: undefined },
      modelChoice,
      billing: 'subscription',
      sameScope: true,
      prices: coldPrices(this.deps.codex.prices()),
      weights: st.capacityWeights,
      dollarsPerPct: basis?.value,
      // Continue fresh: Codex's own setup (its first request) plus the handoff.
      handoffChars: s.meta.aiSummary ? summaryMarkdown(s.meta.aiSummary).length : undefined,
      now: now()
    })
    return {
      ...est,
      ...(est.windowFrom === 'status-line' ? { windowFrom: 'codex-log' as const } : {}),
      ...(basis?.kind === 'seven_day' ? { pctWindow: 'seven_day' as const } : {}),
      ...(est.unknown === NO_BASELINE
        ? {
            unknown: 'Not enough Codex limit history yet to turn tokens into a share of your limit.'
          }
        : {}),
      cacheNote: CODEX_CACHE_NOTE
    }
  }

  /**
   * The estimate for a launch of `s`. `billingAccountId` undefined: the
   * subscription. `modelChoice`: the launch's `--model` (undefined: Claude
   * Code's default).
   */
  async estimate(
    s: SessionSummary,
    launch: { billingAccountId?: string; modelChoice?: string }
  ): Promise<ResumeEstimate | undefined> {
    if (!s.context) return undefined
    if (s.provider === 'codex')
      return this.codexEstimate(
        s,
        launch.modelChoice && launch.modelChoice !== 'default' ? launch.modelChoice : undefined
      )
    const st = this.deps.settings()
    const sub = !launch.billingAccountId
    const dollarsPerPct = sub ? this.deps.limits.dollarsPerPct() : undefined
    let pctPerWeighted: number | undefined
    if (sub && !dollarsPerPct) {
      const g = (await this.deps.limits.state()).fiveHour
      pctPerWeighted = pctPerWeightedToken({
        reading:
          g && !g.expired ? { pct: g.pct, at: g.updatedAt, windowStart: g.windowStart } : undefined,
        records: this.deps.usage.allRecords(),
        weights: st.capacityWeights,
        isSubscription: this.deps.limits.isSubscription
      })
    }
    const summary = s.meta.aiSummary
    return estimateResume({
      ctx: s.context,
      modelChoice: launch.modelChoice,
      billing: sub ? 'subscription' : 'api',
      sameScope: sameCacheScope(s, launch.billingAccountId),
      prices: st.prices,
      weights: st.capacityWeights,
      dollarsPerPct,
      pctPerWeighted,
      handoffChars: summary ? summaryMarkdown(summary).length : undefined,
      now: now()
    })
  }

  /** With the session's default billing (its project's, else Settings'): the desktop's stats. */
  defaultBilling(s: SessionSummary): string | undefined {
    const st = this.deps.settings()
    const b = projectDefault(st.projectBilling, s) ?? st.defaultBilling
    return b && b !== 'subscription' ? b : undefined
  }
}
