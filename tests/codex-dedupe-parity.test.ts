// The Codex fork dedupe gives exactly what it gave before its allocations were
// cut (tests/codex-usage-reference.ts is the v1.16.3 code), over random fork
// families: copies by identity, copies an older parser made (numbers only),
// independent sibling responses, sessions in two homes, links known, guessed
// or missing, gone parents, and re-reads.

import { describe, expect, it } from 'vitest'
import { CodexUsageStore } from '../src/main/services/codex-usage'
import { CodexUsageStoreReference } from './codex-usage-reference'
import type { CodexLimitReading } from '@shared/usage/codex'
import type { CodexTurnSample, UsageRecord } from '@shared/usage/types'

function rng(seed: number): (n: number) => number {
  let s = seed >>> 0 || 1
  return (n) => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) % n
  }
}

const uuid = (r: (n: number) => number): string => {
  const h = (k: number) => Array.from({ length: k }, () => '0123456789abcdef'[r(16)]).join('')
  return `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`
}

interface Session {
  sid: string
  parent?: string
  start: number
  homes: string[]
  linkKnown: boolean
  gone: boolean
  records: UsageRecord[]
  readings: CodexLimitReading[]
  turns: CodexTurnSample[]
}

const T0 = Date.parse('2026-10-01T00:00:00Z')

function family(seed: number): Session[] {
  const r = rng(seed)
  const n = 2 + r(7)
  const out: Session[] = []
  for (let i = 0; i < n; i++) {
    const parent = i > 0 && r(3) ? out[r(i)] : undefined
    const start = parent ? parent.start + 60_000 * (1 + r(50)) : T0 + 3_600_000 * r(48)
    const s: Session = {
      sid: `s${seed}-${i}`,
      parent: parent?.sid,
      start,
      homes: r(5) ? ['h1'] : ['h1', 'h2'],
      linkKnown: !parent || r(4) > 0,
      gone: !!(i > 0 && !r(6)),
      records: [],
      readings: [],
      turns: []
    }
    // Copies of the parent's history made when the fork was (same identity), or by an
    // older parser (other ids, same numbers).
    if (parent) {
      const legacy = !r(4)
      let k = 0
      for (const x of parent.records.filter((x) => x.ts <= start)) {
        const ts = start + (r(3) ? r(8) : r(1500))
        s.records.push({ ...x, id: legacy ? `old:${s.sid}:${k}` : x.id, ts, sid: s.sid })
        k++
      }
      for (const x of parent.readings.filter((x) => x.ts <= start))
        s.readings.push({ ...x, ts: start + r(10), sessionId: s.sid })
      for (const t of parent.turns.filter((t) => t.ts <= start))
        s.turns.push({ ...t, ts: start + r(10), key: '' })
    }
    // Its own responses (some with the same numbers as others).
    const own = 1 + r(6)
    for (let j = 0; j < own; j++) {
      const ts = start + 2000 + 30_000 * j + r(1000)
      const same = r(5) === 0 && out.length ? out[r(out.length)].records[0] : undefined
      const rec = {
        id: same && r(2) ? same.id : `${s.sid}:${j}`,
        ts,
        key: '',
        sid: r(6) ? s.sid : undefined,
        provider: 'codex',
        model: ['gpt-5', 'gpt-5-codex', 'gpt-5-fast'][r(3)],
        input: same ? same.input : 100 * r(50),
        output: same ? same.output : 10 * r(30),
        cacheRead: same ? same.cacheRead : 1000 * r(20),
        cacheWrite: 0,
        ...(r(3) ? { reasoning: same ? (same.reasoning ?? 0) : r(100) } : {})
      } as unknown as UsageRecord
      s.records.push(rec)
      s.readings.push({
        id: rec.id,
        ts,
        key: '',
        source: 'h1',
        ...(r(4) ? { sessionId: s.sid } : {}),
        limitId: r(8) ? 'codex' : 'codex_other',
        windows: [
          {
            pct: r(100),
            minutes: 300,
            ...(r(5) ? { resetsAt: T0 + 3_600_000 * r(100) } : { resetsAt: ts + 1234.5 })
          }
        ]
      } as CodexLimitReading)
      const turnId = r(2) ? `codex-turn:${uuid(r)}` : `codex-turn:${rec.id}`
      s.turns.push({
        id: turnId,
        ts,
        key: '',
        responses: 1 + r(3),
        outputTokens: rec.output,
        reasoningTokens: 0
      } as unknown as CodexTurnSample)
    }
    out.push(s)
  }
  return out
}

/** Feeds both stores the same calls; their answers must be the same, byte for byte. */
function compare(sessions: Session[], seed: number): void {
  const r = rng(seed * 7 + 3)
  const a = new CodexUsageStore()
  const b = new CodexUsageStoreReference()
  const lineage = sessions
    .filter((s) => s.linkKnown)
    .map((s) => ({
      sessionId: s.sid,
      ...(s.parent ? { forkedFromId: s.parent } : {}),
      ...(r(5) ? { startedAt: new Date(s.start).toISOString() } : {})
    }))
  const same = (when: string) => {
    expect(JSON.stringify(a.records()), `${when}: records`).toBe(JSON.stringify(b.records()))
    expect(JSON.stringify(a.readings()), `${when}: readings`).toBe(JSON.stringify(b.readings()))
    expect(JSON.stringify(a.turns()), `${when}: turns`).toBe(JSON.stringify(b.turns()))
  }
  // Before any lineage is known (the first scan), then with it.
  const feed = (s: Session) => {
    for (const home of s.homes) {
      const key = `codex:${home}:${s.sid}`
      const recs = s.records.map((x) => ({ ...x, key }))
      const reads = s.readings.map((x) => ({ ...x, key }))
      const turns = s.turns.map((t) => ({ ...t, key }))
      a.set(key, recs, reads, 'sig', turns)
      b.set(key, structuredClone(recs), structuredClone(reads), 'sig', structuredClone(turns))
    }
  }
  for (const s of sessions) if (!s.gone || r(2)) feed(s)
  same('no lineage')
  a.setLineage(lineage)
  b.setLineage(lineage)
  same('lineage')
  // A session read again (its rows replaced), and one more link learned.
  const again = sessions[r(sessions.length)]
  feed(again)
  const late = sessions.find((s) => !s.linkKnown && s.parent)
  if (late) {
    const l = [
      {
        sessionId: late.sid,
        forkedFromId: late.parent,
        startedAt: new Date(late.start).toISOString()
      }
    ]
    a.setLineage(l)
    b.setLineage(l)
  }
  same('again')
}

describe('Codex fork dedupe', () => {
  it('gives exactly the old results over 400 random fork families', () => {
    for (let seed = 1; seed <= 400; seed++) compare(family(seed), seed)
  })

  it('gives exactly the old results for a few big families together', () => {
    const all: Session[] = []
    for (let seed = 1000; seed < 1040; seed++) all.push(...family(seed))
    compare(all, 99)
  })
})
