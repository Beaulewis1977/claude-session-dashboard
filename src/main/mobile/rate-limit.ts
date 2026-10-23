// Sliding-window rate limits for requests from phones.

export interface Limit {
  /** At most `max` hits… */
  max: number
  /** …in this many milliseconds. */
  windowMs: number
}

export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly limits: Limit[],
    private readonly now: () => number = Date.now
  ) {}

  /** Record a hit for `key`; false (and nothing recorded) when over any limit. */
  take(key: string): boolean {
    const t = this.now()
    const longest = Math.max(...this.limits.map((l) => l.windowMs))
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - longest)
    for (const l of this.limits) {
      if (list.filter((x) => x > t - l.windowMs).length >= l.max) {
        this.hits.set(key, list)
        return false
      }
    }
    list.push(t)
    this.hits.set(key, list)
    // Don't grow without bound if many keys appear.
    if (this.hits.size > 1000) {
      for (const [k, v] of this.hits) if (!v.some((x) => x > t - longest)) this.hits.delete(k)
    }
    return true
  }

  /** Seconds until `key` may try again (0 if now). */
  retryAfter(key: string): number {
    const t = this.now()
    const list = this.hits.get(key) ?? []
    let wait = 0
    for (const l of this.limits) {
      const inWindow = list.filter((x) => x > t - l.windowMs)
      if (inWindow.length >= l.max) {
        const oldest = inWindow[inWindow.length - l.max]
        wait = Math.max(wait, oldest + l.windowMs - t)
      }
    }
    return Math.ceil(wait / 1000)
  }
}
