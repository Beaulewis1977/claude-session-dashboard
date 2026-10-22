// Extracting token usage, per-turn metrics and limit messages from session
// events. Parsed defensively: every field is optional and unknown numeric
// usage fields are kept, so new token types show up automatically.

import type { EnvKind } from '../types'
import { classifyUserText, str, type RawEvent } from '../jsonl'
import type { LimitHit, TurnSample, UsageAnalysis, UsageRecord } from './types'

export interface UsageContext {
  key: string
  project: string
  env: EnvKind
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
  // Some versions only report the nested split; use whichever is larger.
  const cacheWrite = Math.max(num(o.cache_creation_input_tokens), cw5 + cw1h)
  const p: ParsedUsage = {
    input: num(o.input_tokens),
    output: num(o.output_tokens),
    cacheWrite,
    cacheRead: num(o.cache_read_input_tokens)
  }
  if (cw1h) p.cw1h = cw1h
  const extra: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) {
    if (KNOWN_USAGE.has(k)) continue
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

/** Dedupe key for an assistant event: message id + request id (as ccusage does). */
export function usageKey(e: RawEvent): string | undefined {
  const m = obj(e.message)
  const id = str(m?.id)
  const req = str(e.requestId) ?? str(e.request_id)
  if (id && req) return `${id}:${req}`
  if (id) return id
  const uuid = str(e.uuid)
  return uuid ? `uuid:${uuid}` : undefined
}

function mergeMax(a: UsageRecord, b: ParsedUsage, stop?: string): void {
  a.input = Math.max(a.input, b.input)
  a.output = Math.max(a.output, b.output)
  a.cacheWrite = Math.max(a.cacheWrite, b.cacheWrite)
  a.cacheRead = Math.max(a.cacheRead, b.cacheRead)
  if (b.cw1h) a.cw1h = Math.max(a.cw1h ?? 0, b.cw1h)
  if (b.extra) {
    a.extra ??= {}
    for (const [k, v] of Object.entries(b.extra)) a.extra[k] = Math.max(a.extra[k] ?? 0, v)
  }
  if (stop) a.stop = stop
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
  const byKey = new Map<string, UsageRecord>()
  const records: UsageRecord[] = []
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

  for (const e of events) {
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

    const usage = parseUsageObject(message?.usage)
    const key = usageKey(e)
    if (!usage || !key || ts === undefined || !model) continue
    const stop = str(message?.stop_reason)
    const existing = byKey.get(key)
    if (existing) {
      const beforeOut = existing.output
      const beforeIn = existing.input
      const beforeRead = existing.cacheRead
      mergeMax(existing, usage, stop)
      if (turn && !sidechain) {
        turn.outputTokens += existing.output - beforeOut
        turn.inputTokens += existing.input - beforeIn
        turn.cacheReadTokens += existing.cacheRead - beforeRead
      }
      continue
    }
    const rec: UsageRecord = {
      id: key,
      ts,
      key: ctx.key,
      project: ctx.project,
      env: ctx.env,
      model,
      version,
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead
    }
    if (stop) rec.stop = stop
    if (usage.cw1h) rec.cw1h = usage.cw1h
    if (usage.extra) rec.extra = { ...usage.extra }
    byKey.set(key, rec)
    records.push(rec)
    if (turn && !sidechain) {
      turn.outputTokens += rec.output
      turn.inputTokens += rec.input
      turn.cacheReadTokens += rec.cacheRead
    }
  }
  closeTurn()
  return { records, turns, limitHits }
}

export function totalTokens(t: {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead
}
