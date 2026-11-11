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
  rid?: string
  side: boolean
  /** Time of its first line. */
  first: number
  start?: number
  /** The start is the logged request time. */
  exact: boolean
  end: number
  /** When the opening thinking block began. */
  thinkStart?: number
  stop: unknown
}

/** Real Anthropic ids are unique per response; a gateway can reuse one (see dedupe.ts). */
const uniqueId = (id: string): boolean => id.startsWith('msg_') || id.startsWith('resp_')

/**
 * The timing of each response in one session file. A response is one
 * `message.id` within one request (`requestId`) and one chain (main or
 * sidechain: a /btw replay is another occurrence). A gateway may reuse an id
 * for separate responses: once one ended (it has a stop reason) and a user
 * line followed, the same id starts a new response.
 */
export class ResponseTimings {
  constructor(private readonly by: Map<string, (Pending & { timing?: ResponseTiming })[]>) {}

  /** The timing of the response a usage record came from (by its request, chain and time). */
  get(mid: string, rid?: string, ts?: number, sidechain?: boolean): ResponseTiming | undefined {
    let list = this.by.get(mid) ?? []
    if (rid !== undefined) list = list.filter((p) => p.rid === undefined || p.rid === rid)
    if (sidechain !== undefined) list = list.filter((p) => p.side === sidechain)
    if (!list.length) return undefined
    if (ts === undefined) return list[list.length - 1].timing
    const hit =
      [...list].reverse().find((p) => p.first <= ts && ts <= p.end) ??
      [...list].reverse().find((p) => p.first <= ts) ??
      list[0]
    return hit.timing
  }

  has(mid: string): boolean {
    return this.get(mid) !== undefined
  }
}

/** Timing of each response in one session file. */
export function claudeResponseTimings(events: RawEvent[]): ResponseTimings {
  const requests = new Map<string, number>()
  const chains: Record<'main' | 'side', Chain> = {
    main: { busy: false },
    side: { busy: false }
  }
  const msgs = new Map<string, (Pending & { timing?: ResponseTiming })[]>()
  for (const e of events) {
    const type = str(e.type)
    const ts = time(e.timestamp)
    const side = e.isSidechain === true
    const chain = chains[side ? 'side' : 'main']
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
    const rid = str(e.requestId) ?? str(e.request_id)
    let list = msgs.get(id)
    if (!list) msgs.set(id, (list = []))
    const p = [...list]
      .reverse()
      .find((x) => x.side === side && (x.rid === undefined || rid === undefined || x.rid === rid))
    // A gateway's reused id: the earlier response ended, and a prompt or tool result came since.
    const reused =
      !!p &&
      !uniqueId(id) &&
      (rid === undefined || p.rid === undefined) &&
      typeof p.stop === 'string' &&
      !!p.stop &&
      chain.userTs !== undefined &&
      chain.userTs > p.end
    if (p && !reused) {
      if (ts > p.end) p.end = ts
      p.stop = m?.stop_reason
      chain.busy = true
      continue
    }
    const ref = str(e.requestRef)
    const sent = ref ? requests.get(ref) : undefined
    const n: Pending = {
      side,
      first: ts,
      exact: sent !== undefined,
      start: sent ?? (chain.busy ? undefined : chain.userTs),
      end: ts,
      stop: m?.stop_reason
    }
    if (rid) n.rid = rid
    const first = Array.isArray(m?.content) ? obj(m.content[0]) : undefined
    const thought = e.thinkingDurationMs
    if (
      first?.type === 'thinking' &&
      typeof thought === 'number' &&
      Number.isFinite(thought) &&
      thought >= 0
    )
      n.thinkStart = ts - thought
    list.push(n)
    chain.busy = true
  }
  for (const list of msgs.values())
    for (const p of list) {
      if (p.start === undefined || p.end < p.start) continue
      if (typeof p.stop !== 'string' || !p.stop) continue
      const t: ResponseTiming = { genMs: p.end - p.start }
      if (p.exact && p.thinkStart !== undefined && p.thinkStart >= p.start)
        t.ttftMs = p.thinkStart - p.start
      p.timing = t
    }
  return new ResponseTimings(msgs)
}
