// What resuming a session would cost: its context size priced at the launch's
// model, as a share of the 5-hour window (estimate). Reuses the limit-health
// baseline and, without one, the live window's own rate with the limit
// gauge's subscription filter (API-billed use doesn't move the limit).

import { now } from '@shared/clock'
import { estimateResume, pctPerWeightedToken, type ResumeEstimate } from '@shared/context'
import { projectDefault } from '@shared/project-key'
import { summaryMarkdown } from '@shared/summary'
import type { AppSettings, SessionSummary } from '@shared/types'
import type { LimitsService } from './limits'
import type { UsageService } from './usage'

export class ContextCost {
  constructor(
    private readonly deps: {
      limits: Pick<LimitsService, 'dollarsPerPct' | 'state' | 'isSubscription'>
      usage: Pick<UsageService, 'allRecords'>
      settings: () => AppSettings
    }
  ) {}

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
      prices: st.prices,
      weights: st.capacityWeights,
      dollarsPerPct,
      pctPerWeighted,
      handoffChars: summary ? summaryMarkdown(summary).length : undefined,
      now: now()
    })
  }

  /** With the session's default billing (its project's, else Settings'): the session stats. */
  defaultBilling(s: SessionSummary): string | undefined {
    const st = this.deps.settings()
    const b = projectDefault(st.projectBilling, s) ?? st.defaultBilling
    return b && b !== 'subscription' ? b : undefined
  }
}
