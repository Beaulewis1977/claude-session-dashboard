// The summary queue as the renderer sees it (see main/services/summaries.ts).

import type { SummaryEstimate } from './summary'

export interface SummaryJob {
  id: string
  key: string
  title: string
  /** Summarize (one session), Summarize selected, or auto-summarize. */
  origin: 'manual' | 'bulk' | 'auto'
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
  startedAt?: number
  finishedAt?: number
  estimate?: SummaryEstimate
}

export interface SummaryQueueState {
  jobs: SummaryJob[]
  /** Key of the session being summarized now. */
  running?: string
  /** The queue stopped because the live 5-hour limit is above the threshold. */
  paused?: { pct: number; limit: number }
  /** Resume was clicked: going on above the threshold until the queue is empty. */
  override: boolean
  /** Fixtures mode: sample summaries, nothing is run. */
  simulated: boolean
}

export interface SummaryPreview {
  key: string
  /** The exact text sent on stdin. */
  prompt: string
  bytes: number
  chars: number
  /** Messages sent, of those with something to send. */
  kept: number
  total: number
  estimate: SummaryEstimate
  /** The live 5-hour %, when there's a current reading. */
  fiveHourPct?: number
}

export type SummaryBatchEstimate = SummaryEstimate & { skipped: number; fiveHourPct?: number }

export const EMPTY_SUMMARY_QUEUE: SummaryQueueState = {
  jobs: [],
  override: false,
  simulated: false
}
