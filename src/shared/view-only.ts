// Sessions that can be read, searched and counted, but never launched:
// conversations imported from claude.ai, and Claude desktop Cowork sessions
// (they ran in the desktop app's own sandbox home; the optional Cowork source).

import type { SessionSummary } from './types'

export const VIEW_ONLY_ERROR =
  'Claude desktop (Cowork) sessions are view-only here: read, search and usage, but no Resume, Fork or Continue fresh.'

/** Can't be resumed, forked, branched, continued or summarized from the app. */
export function isViewOnly(s: Pick<SessionSummary, 'availability' | 'viewOnly'>): boolean {
  return s.availability === 'imported' || !!s.viewOnly
}
