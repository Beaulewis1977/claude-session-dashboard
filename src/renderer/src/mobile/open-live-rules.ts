// What to do with a tapped push alert (pure, so it can be tested; see open-live.ts).

export interface PendingLive {
  /** The push's opaque reference, until the PC has resolved it. */
  ref?: string
  /** The session it means. */
  key?: string
  /** When it was tapped (Date.now()). */
  since: number
}

/** Give up on a tapped alert after this long (the session may never appear). */
export const PENDING_MAX_MS = 10 * 60_000

export type OpenStep = 'wait' | 'resolve' | 'open' | 'drop'

/** What to do next with a tapped alert. */
export function nextOpenStep(
  p: PendingLive,
  ctx: { loaded: boolean; known: (key: string) => boolean; inFlight: boolean; now: number }
): OpenStep {
  if (ctx.now - p.since > PENDING_MAX_MS) return 'drop'
  if (p.key) return ctx.loaded && ctx.known(p.key) ? 'open' : 'wait'
  if (!p.ref) return 'drop'
  return ctx.inFlight ? 'wait' : 'resolve'
}
