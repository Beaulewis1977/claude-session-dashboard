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

/**
 * The launch bills the same account the session's prompt cache belongs to.
 * Caches aren't shared across organizations, so another account (or a
 * session whose billing isn't known) starts cold.
 */
export function sameCacheScope(s: SessionSummary, billingAccountId: string | undefined): boolean {
  const b = s.billing
  if (!b) return false
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
      limits: Pick<
        LimitsService,
        'dollarsPerPct' | 'state' | 'isSubscription' | 'latestModel' | 'windowSizes'
      >
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
      sameScope: sameCacheScope(s, launch.billingAccountId),
      prices: st.prices,
      weights: st.capacityWeights,
      dollarsPerPct,
      pctPerWeighted,
      handoffChars: summary ? summaryMarkdown(summary).length : undefined,
      defaultModel: this.deps.limits.latestModel(),
      windowSizes: this.deps.limits.windowSizes(),
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
