// Which sessions run on the Claude subscription and which on API credits.
//
// Sessions launched from the app are tagged at launch (Fork and New session
// tag the new session when it appears). Other sessions are inferred from the
// status line bridge: `rate_limits` → subscription, a cost without them → API.

import { now } from '@shared/clock'
import type { SessionBilling } from '@shared/usage/credits'
import type { SessionMeta, SessionSummary } from '@shared/types'
import type { SessionService } from './sessions'

interface PendingTag {
  sourceId: string
  cwd: string
  at: number
  billing: NonNullable<SessionMeta['billing']>
  known: Set<string>
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

export class BillingService {
  private pending: PendingTag[] = []
  private inferredApi = new Set<string>()

  constructor(
    private readonly sessions: SessionService,
    private readonly bridgeGuess: (sessionId: string) => 'subscription' | 'api' | 'unknown',
    private readonly accountExists: (id: string) => boolean
  ) {
    sessions.billingResolver = (sid, meta) => this.resolve(sid, meta)
    sessions.on('changed', () => this.matchPending())
  }

  resolve(sessionId: string, meta: SessionMeta): SessionBilling {
    const b = meta.billing
    if (b) {
      return {
        mode: b.mode,
        accountId:
          b.mode === 'api' && b.accountId && this.accountExists(b.accountId)
            ? b.accountId
            : undefined,
        source: b.source
      }
    }
    const g = this.bridgeGuess(sessionId)
    if (g !== 'unknown') return { mode: g, source: 'bridge' }
    return { mode: 'unknown', source: 'none' }
  }

  /** Session keys billed to API credits (optionally a specific account). */
  apiSessions(list: SessionSummary[]): SessionSummary[] {
    return list.filter((s) => s.billing?.mode === 'api')
  }

  /** Remember a launch so the new session (Fork / New session) gets tagged when it appears. */
  expect(sourceId: string, cwd: string, billing: NonNullable<SessionMeta['billing']>): void {
    const known = new Set(this.sessions.list().map((s) => s.key))
    this.pending.push({ sourceId, cwd: norm(cwd), at: now(), billing, known })
  }

  private matchPending(): void {
    if (!this.pending.length) return
    const t = now()
    this.pending = this.pending.filter((p) => t - p.at < 30 * 60_000)
    for (const s of this.sessions.list()) {
      const i = this.pending.findIndex(
        (p) =>
          !p.known.has(s.key) &&
          s.sourceId === p.sourceId &&
          s.cwd !== undefined &&
          norm(s.cwd) === p.cwd &&
          !!s.startedAt &&
          Date.parse(s.startedAt) >= p.at - 60_000
      )
      if (i < 0) continue
      const [p] = this.pending.splice(i, 1)
      if (!s.meta.billing) this.sessions.tagBilling(s.sessionId, p.billing)
    }
  }

  /** Re-emit sessions when the bridge changes what we infer. */
  refreshInferred(): void {
    const next = new Set(
      this.sessions
        .list()
        .filter((s) => s.billing?.source === 'bridge' && s.billing.mode === 'api')
        .map((s) => s.key)
    )
    const changed =
      next.size !== this.inferredApi.size || [...next].some((k) => !this.inferredApi.has(k))
    this.inferredApi = next
    if (changed) this.sessions.touch()
  }
}
