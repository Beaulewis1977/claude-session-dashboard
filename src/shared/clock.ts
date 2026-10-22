// The app's clock. Fixtures mode shifts it so the sample data always looks
// current ("today" is the day the sample usage was recorded).

let offset = 0

export function setClockOffset(ms: number): void {
  offset = Number.isFinite(ms) ? ms : 0
}

export function clockOffset(): number {
  return offset
}

export function now(): number {
  return Date.now() + offset
}

/** "Now" in fixtures mode: the moment the sample usage data ends. */
export const FIXTURES_NOW = Date.parse('2026-10-22T15:40:00Z')
