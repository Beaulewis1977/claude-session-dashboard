import { describe, expect, it } from 'vitest'
import { applySessionsDelta, sentOf, sessionsDelta } from '@shared/sessions-delta'
import type { SessionsPayload, SessionSummary } from '@shared/types'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const session = (i: number, patch: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    key: `src:s${i}`,
    sessionId: `s${i}`,
    title: `Session ${i}`,
    messageCount: i,
    meta: {},
    ...patch
  }) as SessionSummary

const payload = (sessions: SessionSummary[], phase = 'ready'): SessionsPayload =>
  ({ sessions, sources: [], scan: { phase, done: 0, total: 0 } }) as unknown as SessionsPayload

describe('session list deltas', () => {
  it('sends only what changed, and merging gives exactly the new list', () => {
    const a = payload(Array.from({ length: 50 }, (_, i) => session(i)))
    const sent = sentOf(a)
    const changed = a.sessions.map((s, i) => (i === 7 ? session(7, { title: 'Renamed' }) : s))
    const b = payload([...changed.slice(0, 40), ...changed.slice(41), session(99)])
    const { delta } = sessionsDelta(sent, b)
    expect(delta.upserts.map((s) => s.key)).toEqual(['src:s7', 'src:s99'])
    expect(delta.removed).toEqual(['src:s40'])
    expect(delta.keys).toBeDefined()
    const merged = applySessionsDelta(a.sessions, delta)
    expect(merged).toEqual(b.sessions)
    // Unchanged sessions are the very same objects (their rows don't redraw).
    expect(merged[0]).toBe(a.sessions[0])
  })

  it('sends no order when it is the same, and nothing when nothing changed', () => {
    const a = payload([session(1), session(2)])
    const sent = sentOf(a)
    const same = sessionsDelta(sent, payload([session(1), session(2)]))
    expect(same.delta.upserts).toEqual([])
    expect(same.delta.removed).toEqual([])
    expect(same.delta.keys).toBeUndefined()
    const one = sessionsDelta(sent, payload([session(1), session(2, { messageCount: 9 })]))
    expect(one.delta.keys).toBeUndefined()
    expect(applySessionsDelta(a.sessions, one.delta)).toEqual([
      session(1),
      session(2, { messageCount: 9 })
    ])
  })

  it('stays exact over many random changes in a row', () => {
    const r = rng(3)
    let list = Array.from({ length: 120 }, (_, i) => session(i))
    let sent = sentOf(payload(list))
    let window = list
    let next = 1000
    for (let step = 0; step < 200; step++) {
      // Some renamed, some gone, some new, sometimes reordered.
      list = list
        .filter(() => r() > 0.03)
        .map((s) =>
          r() < 0.05 ? { ...s, title: `${s.title}!`, messageCount: s.messageCount + 1 } : s
        )
      while (r() < 0.3) list.splice(Math.floor(r() * (list.length + 1)), 0, session(next++))
      if (r() < 0.2) list = [...list].sort(() => r() - 0.5)
      const { delta, next: after } = sessionsDelta(sent, payload(list))
      window = applySessionsDelta(window, delta)
      sent = after
      expect(window).toEqual(list)
    }
  })
})
