// When each Claude Code response was generated, from a session file's
// timestamps only (never its text), for token speed (see speed.ts).
//
// A response is logged as one line per content block, all with the same
// `message.id`; the last line carries the final usage and stop reason.
// - Request sent: the `api-request` line the response points to
//   (`requestRef` = its `id`; Claude Code 2.1 writes one per request, a few
//   ms after the prompt or tool result). Older logs: the latest user line
//   (prompt or tool result) of the same chain before the response, if no
//   other response or API error came in between (then nothing is known).
// - Response end: its last line. Tools run after a tool_use block is
//   written (sometimes while the reply still streams), and the next request
//   is sent only after their results, so tool time is never in a response.
// - Time to first token (an estimate): a response that opens with thinking
//   records how long it thought (`thinkingDurationMs` on that line), so the
//   thinking began at the line's time minus that. Only with a logged request
//   time; other responses have none.
// - A response whose last line has no stop reason was cut short (or is
//   still streaming): no timing.

import { str, type RawEvent } from '../jsonl'

export interface ResponseTiming {
  genMs: number
  ttftMs?: number
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function time(v: unknown): number | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  const t = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

interface Chain {
  /** The latest user line's time. */
  userTs?: number
  /** Something other than a request came after it: a response, or an API error. */
  busy: boolean
}

interface Pending {
  start?: number
  /** The start is the logged request time. */
  exact: boolean
  end: number
  /** When the opening thinking block began. */
  thinkStart?: number
  stop: unknown
}

/** Timing of each response in one session file, keyed by `message.id`. */
export function claudeResponseTimings(events: RawEvent[]): Map<string, ResponseTiming> {
  const requests = new Map<string, number>()
  const chains: Record<'main' | 'side', Chain> = {
    main: { busy: false },
    side: { busy: false }
  }
  const msgs = new Map<string, Pending>()
  for (const e of events) {
    const type = str(e.type)
    const ts = time(e.timestamp)
    const chain = chains[e.isSidechain === true ? 'side' : 'main']
    if (type === 'api-request') {
      const id = str(e.id)
      if (id && ts !== undefined) requests.set(id, ts)
      continue
    }
    if (type === 'system') {
      if (str(e.subtype) === 'api_error') chain.busy = true
      continue
    }
    if (type === 'user') {
      if (ts !== undefined) {
        chain.userTs = ts
        chain.busy = false
      }
      continue
    }
    if (type !== 'assistant') continue
    const m = obj(e.message)
    const model = str(m?.model)
    const id = str(m?.id)
    if (!model || model === '<synthetic>' || e.isApiErrorMessage === true) {
      chain.busy = true
      continue
    }
    if (!id || ts === undefined) continue
    const p = msgs.get(id)
    if (p) {
      if (ts > p.end) p.end = ts
      p.stop = m?.stop_reason
      chain.busy = true
      continue
    }
    const ref = str(e.requestRef)
    const sent = ref ? requests.get(ref) : undefined
    const n: Pending = {
      exact: sent !== undefined,
      start: sent ?? (chain.busy ? undefined : chain.userTs),
      end: ts,
      stop: m?.stop_reason
    }
    const first = Array.isArray(m?.content) ? obj(m.content[0]) : undefined
    const thought = e.thinkingDurationMs
    if (
      first?.type === 'thinking' &&
      typeof thought === 'number' &&
      Number.isFinite(thought) &&
      thought >= 0
    )
      n.thinkStart = ts - thought
    msgs.set(id, n)
    chain.busy = true
  }
  const out = new Map<string, ResponseTiming>()
  for (const [id, p] of msgs) {
    if (p.start === undefined || p.end < p.start) continue
    if (typeof p.stop !== 'string' || !p.stop) continue
    const t: ResponseTiming = { genMs: p.end - p.start }
    if (p.exact && p.thinkStart !== undefined && p.thinkStart >= p.start)
      t.ttftMs = p.thinkStart - p.start
    out.set(id, t)
  }
  return out
}
