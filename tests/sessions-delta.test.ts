import { describe, expect, it } from 'vitest'
import { applySessionsDelta, sentOf, sessionsDelta, SessionsSync } from '@shared/sessions-delta'
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

describe('the window keeping its list in step (SessionsSync)', () => {
  /** A main process for one window: full lists and deltas with versions, as ipc.ts sends them. */
  function mainSide() {
    let v = 0
    let sent = sentOf(payload([]))
    let base = 0
    return {
      full(list: SessionSummary[]): SessionsPayload {
        sent = sentOf(payload(list))
        base = ++v
        return { ...payload(list), version: base }
      },
      delta(list: SessionSummary[]) {
        const { delta, next } = sessionsDelta(sent, payload(list))
        sent = next
        const out = { ...delta, base, version: ++v }
        base = out.version
        return out
      }
    }
  }
  function windowSide(fetchFull: () => Promise<SessionsPayload>) {
    let sessions: SessionSummary[] = []
    const sync = new SessionsSync(
      () => sessions,
      (p) => (sessions = p.sessions),
      fetchFull
    )
    return { sync, list: () => sessions }
  }

  it('applies a delta that follows the first list, even if other startup calls are slower', async () => {
    const main = mainSide()
    const a = [session(1), session(2)]
    const b = [session(1, { title: 'Renamed' }), session(2), session(3)]
    const w = windowSide(async () => main.full(b))
    // getSessions() answers, then a change goes out at once: both reach the window in order.
    w.sync.full(main.full(a))
    w.sync.delta(main.delta(b))
    expect(w.list()).toEqual(b)
  })

  it('never lets an older full list replace a newer state', () => {
    const main = mainSide()
    const w = windowSide(async () => main.full([]))
    const old = main.full([session(1)])
    const fresh = main.full([session(1), session(2)])
    w.sync.full(fresh)
    w.sync.full(old)
    expect(w.list()).toEqual([session(1), session(2)])
  })

  it('asks for the full list when a delta does not apply to what it has, and replays early ones', async () => {
    const main = mainSide()
    const start = [session(1)]
    const firstList = main.full(start)
    const w = windowSide(async () => firstList)
    // A delta before any list: kept, and the full list is asked for.
    const d1 = main.delta([session(1), session(2)])
    w.sync.delta(d1)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // The full list came; the early delta (made from it) is replayed on top.
    expect(w.list()).toEqual([session(1), session(2)])
    expect(w.sync.current).toBe(d1.version)
  })
})
