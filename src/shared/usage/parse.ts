// Extracting token usage, per-turn metrics and limit messages from session
// events. Parsed defensively: every field is optional and unknown numeric
// usage fields are kept, so new token types show up automatically.

import type { EnvKind } from '../types'
import { classifyUserText, str, type RawEvent } from '../jsonl'
import { recordId, UsageDeduper } from './dedupe'
import type { LimitHit, TurnSample, UsageAnalysis, UsageRecord } from './types'

export interface UsageContext {
  key: string
  project: string
  env: EnvKind
  /** Session id of the file (a subagent file uses its parent's). Default: the end of `key`. */
  sessionId?: string
  /** File name, to tell apart lines without a message id in subagent files. */
  file?: string
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function time(v: unknown): number | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  const t = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

const KNOWN_USAGE = new Set([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_creation'
])

/** Flatten numeric fields of an object into `prefix.key` entries. */
function flattenNumbers(
  o: Record<string, unknown>,
  prefix: string,
  out: Record<string, number>,
  depth = 0
): void {
  if (depth > 3) return
  for (const [k, v] of Object.entries(o)) {
    const name = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'number' && Number.isFinite(v)) out[name] = v
    else if (obj(v)) flattenNumbers(v as Record<string, unknown>, name, out, depth + 1)
  }
}

export interface ParsedUsage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cw1h?: number
  extra?: Record<string, number>
}

/** Read a `message.usage` object. Returns undefined if it has no tokens at all. */
export function parseUsageObject(u: unknown): ParsedUsage | undefined {
  const o = obj(u)
  if (!o) return undefined
  const cc = obj(o.cache_creation)
  const cw5 = num(cc?.ephemeral_5m_input_tokens)
  const cw1h = num(cc?.ephemeral_1h_input_tokens)
  // When the 5m/1h split is reported it is the source of truth (as in ccusage);
  // older versions only have the total.
  const cacheWrite = cc ? cw5 + cw1h : num(o.cache_creation_input_tokens)
  const p: ParsedUsage = {
    input: num(o.input_tokens),
    output: num(o.output_tokens),
    cacheWrite,
    cacheRead: num(o.cache_read_input_tokens)
  }
  if (cw1h) p.cw1h = cw1h
  const extra: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) {
    if (KNOWN_USAGE.has(k) || k === 'iterations') continue
    if (typeof v === 'number' && Number.isFinite(v)) extra[k] = v
    else if (obj(v)) flattenNumbers(v as Record<string, unknown>, k, extra)
  }
  if (cc) {
    for (const [k, v] of Object.entries(cc)) {
      if (k === 'ephemeral_5m_input_tokens' || k === 'ephemeral_1h_input_tokens') continue
      if (typeof v === 'number' && Number.isFinite(v)) extra[`cache_creation.${k}`] = v
    }
  }
  if (Object.keys(extra).length) p.extra = extra
  if (!p.input && !p.output && !p.cacheWrite && !p.cacheRead && !p.extra) return undefined
  return p
}

const count = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0

/**
 * The checks ccusage applies before counting a line: input and output token
 * counts must be present, the other counts valid when present, the version
 * semver-like, and ids and the model non-empty when present.
 */
export function isCountableUsage(e: RawEvent, usage: Record<string, unknown>): boolean {
  if (!count(usage.input_tokens) || !count(usage.output_tokens)) return false
  for (const k of ['cache_creation_input_tokens', 'cache_read_input_tokens'])
    if (usage[k] !== undefined && !count(usage[k])) return false
  if (typeof e.version === 'string' && !/^\d+\.\d+\.\d/.test(e.version)) return false
  const m = obj(e.message)
  for (const v of [e.sessionId, e.requestId, m?.id, m?.model]) if (v === '') return false
  return true
}

/** Advisor sub-calls are billed separately, under their own model. */
function advisorUsages(usage: Record<string, unknown>): { model: string; usage: unknown }[] {
  if (!Array.isArray(usage.iterations)) return []
  const out: { model: string; usage: unknown }[] = []
  for (const it of usage.iterations) {
    const o = obj(it)
    const model = str(o?.model)
    if (o?.type === 'advisor_message' && model) out.push({ model, usage: o })
  }
  return out
}

// ------------------------------------------------------------- limit hits

const LIMIT_RE =
  /(usage limit reached|limit reached|hit your (?:usage |weekly |5-hour )?limit|out of extra usage|rate[_ ]limit(?:ed)?|limit will reset)/i

function limitHitFrom(e: RawEvent, text: string, ctx: UsageContext, ts: number): LimitHit {
  const lower = text.toLowerCase()
  let resetsAt: number | undefined
  const pipe = /\|(\d{9,13})\s*$/.exec(text.trim())
  if (pipe) {
    const n = Number(pipe[1])
    resetsAt = n < 1e12 ? n * 1000 : n
  }
  const kind: LimitHit['kind'] = /week|7-day|seven/.test(lower)
    ? 'weekly'
    : /5-hour|five|usage limit|session limit/.test(lower)
      ? 'five_hour'
      : 'other'
  const clean = text.replace(/\|\d{9,13}\s*$/, '').trim()
  return {
    id: str(e.uuid) ?? `${ctx.key}:${ts}`,
    ts,
    key: ctx.key,
    text: clean.slice(0, 200),
    kind,
    resetsAt
  }
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const o = obj(b)
      return o?.type === 'text' && typeof o.text === 'string' ? o.text : ''
    })
    .join('\n')
}

const CORRECTION_RE = /^(no\b|nope\b|wrong\b|that'?s not\b|that is not\b|not what i)/i

// ------------------------------------------------------------- main entry

/**
 * Extract usage records, per-turn samples and limit messages from a session's
 * events. Records are deduped within the file; the caller dedupes across files.
 */
export function analyzeUsage(events: RawEvent[], ctx: UsageContext): UsageAnalysis {
  const local = new UsageDeduper()
  const sessionId = ctx.sessionId ?? ctx.key.slice(ctx.key.lastIndexOf(':') + 1)
  const turns: TurnSample[] = []
  const limitHits: LimitHit[] = []
  let version: string | undefined
  let turn: TurnSample | undefined
  let interruptedPending = false
  const turnMsgIds = new Set<string>()

  const closeTurn = (): void => {
    if (turn) turns.push(turn)
    turn = undefined
    turnMsgIds.clear()
  }

  let lineNo = 0
  for (const e of events) {
    lineNo++
    const v = str(e.version)
    if (v) version = v
    const type = str(e.type)
    const ts = time(e.timestamp)
    const message = obj(e.message)
    const role = type ?? str(message?.role)

    if (type === 'system') {
      // Retries after an API error are logged as system events.
      if (turn && str(e.subtype) === 'api_error') turn.apiErrors++
      continue
    }

    if (role === 'user' && e.isSidechain !== true) {
      if (e.isMeta === true || e.isCompactSummary === true) continue
      const content = message?.content ?? e.content
      // Tool results arrive as user events.
      if (Array.isArray(content)) {
        let hadText = false
        for (const b of content) {
          const o = obj(b)
          if (!o) continue
          if (o.type === 'tool_result') {
            if (turn) {
              turn.toolResults++
              if (o.is_error === true) turn.toolErrors++
            }
          } else if (o.type === 'text' && typeof o.text === 'string') {
            hadText = true
          }
        }
        if (!hadText) continue
      }
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .map((b) => (obj(b)?.type === 'text' ? String(obj(b)?.text ?? '') : ''))
                .join('\n')
            : ''
      if (/^\s*\[Request interrupted by user/.test(text)) {
        if (turn) turn.interrupted = true
        interruptedPending = true
        continue
      }
      const c = classifyUserText(text)
      if (c.kind !== 'prompt' || ts === undefined) continue
      closeTurn()
      turn = {
        id: str(e.uuid) ?? `${ctx.key}:${ts}`,
        ts,
        key: ctx.key,
        version,
        responses: 0,
        outputTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        toolCalls: 0,
        toolResults: 0,
        toolErrors: 0,
        apiErrors: 0,
        thinkingBlocks: 0,
        thinkingChars: 0,
        interrupted: false,
        correction: interruptedPending || CORRECTION_RE.test(c.text)
      }
      interruptedPending = false
      continue
    }

    if (role !== 'assistant') continue
    const model = str(message?.model)
    const content = message?.content
    const synthetic = !model || model === '<synthetic>'

    // API errors and limit messages are synthetic assistant messages.
    if (synthetic || e.isApiErrorMessage === true) {
      const text = assistantText(content)
      if (ts !== undefined && text && LIMIT_RE.test(text)) {
        limitHits.push(limitHitFrom(e, text, ctx, ts))
      }
      if (turn && (e.isApiErrorMessage === true || /^API Error/i.test(text))) turn.apiErrors++
      if (synthetic) continue
    }

    const msgId = str(message?.id)
    const sidechain = e.isSidechain === true
    if (turn && ts !== undefined && !sidechain) {
      if (turn.latencyMs === undefined) turn.latencyMs = Math.max(0, ts - turn.ts)
      if (!turn.model && model) turn.model = model
      if (msgId && !turnMsgIds.has(msgId)) {
        turnMsgIds.add(msgId)
        turn.responses++
      } else if (!msgId) {
        turn.responses++
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          const o = obj(b)
          if (!o) continue
          if (o.type === 'tool_use' || o.type === 'server_tool_use') turn.toolCalls++
          else if (o.type === 'thinking' || o.type === 'redacted_thinking') {
            turn.thinkingBlocks++
            if (typeof o.thinking === 'string') turn.thinkingChars += o.thinking.length
          }
        }
      }
    }

    const rawUsage = obj(message?.usage)
    if (!rawUsage || ts === undefined || !model || !isCountableUsage(e, rawUsage)) continue
    const speed = str(rawUsage.speed)
    const base: Omit<
      UsageRecord,
      'id' | 'model' | 'input' | 'output' | 'cacheWrite' | 'cacheRead'
    > = {
      ts,
      key: ctx.key,
      project: ctx.project,
      env: ctx.env,
      version,
      sid: str(e.sessionId) ?? sessionId
    }
    const rid = str(e.requestId) ?? str(e.request_id)
    if (rid) base.rid = rid
    if (sidechain) base.sc = true
    if (speed) base.speed = speed
    const stop = str(message?.stop_reason)
    const entries: UsageRecord[] = []
    const main = toRecord(rawUsage, {
      ...base,
      mid: msgId,
      model: speed === 'fast' && !model.endsWith('-fast') ? `${model}-fast` : model,
      // Lines without a message id are never deduped (as in ccusage).
      fallback: `${ctx.key}:${ctx.file ?? ''}:L${lineNo}`
    })
    if (main) {
      if (stop) main.stop = stop
      const cost = e.costUSD
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) main.loggedCost = cost
      entries.push(main)
    }
    advisorUsages(rawUsage).forEach((a, i) => {
      const r = toRecord(a.usage, {
        ...base,
        mid: msgId ? `${msgId}:advisor:${i}` : undefined,
        model: a.model,
        fallback: `${main?.id ?? ctx.key}:advisor:${i}`
      })
      if (r) entries.push(r)
    })
    for (const rec of entries) {
      const { result, stored, previous } = local.add(rec)
      if (!turn || sidechain || result === 'duplicate') continue
      turn.outputTokens += stored.output - (previous?.output ?? 0)
      turn.inputTokens += stored.input - (previous?.input ?? 0)
      turn.cacheReadTokens += stored.cacheRead - (previous?.cacheRead ?? 0)
    }
  }
  closeTurn()
  return { records: [...local.values()], turns, limitHits }
}

function toRecord(
  usage: unknown,
  f: Omit<UsageRecord, 'id' | 'input' | 'output' | 'cacheWrite' | 'cacheRead'> & {
    fallback: string
  }
): UsageRecord | undefined {
  const u = parseUsageObject(usage)
  if (!u) return undefined
  const { fallback, ...rest } = f
  const rec: UsageRecord = {
    id: recordId(f.mid, f.rid, f.sid ?? '', f.ts, fallback),
    ...rest,
    input: u.input,
    output: u.output,
    cacheWrite: u.cacheWrite,
    cacheRead: u.cacheRead
  }
  if (!rec.mid) delete rec.mid
  if (rec.version === undefined) delete rec.version
  if (u.cw1h) rec.cw1h = u.cw1h
  if (u.extra) rec.extra = { ...u.extra }
  return rec
}

export function totalTokens(t: {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead
}
