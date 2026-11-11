// Token speed (TPS) and time to first token: the timing math, the outlier
// rules, copies, fast mode, weekly medians, pricing of new models and fast
// mode, and the CSV columns.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJsonl } from '@shared/jsonl'
import { analyzeUsage } from '@shared/usage/parse'
import { claudeResponseTimings } from '@shared/usage/timing'
import { UsageDeduper } from '@shared/usage/dedupe'
import {
  buildSpeedTrends,
  medianSpeed,
  outputSpeed,
  speedSignal,
  speedStats,
  thinkingTokens,
  ttftCoverageText,
  visibleSpeed
} from '@shared/usage/speed'
import { buildTrends, compareTrends } from '@shared/usage/trends'
import { buildCodexTrends, compareCodexTrends } from '@shared/usage/codex-trends'
import { breakdown, periodCards, toCsv } from '@shared/usage/aggregate'
import {
  addSnapshotExtras,
  DEFAULT_CODEX_PRICES,
  DEFAULT_PRICES,
  estimateCost,
  fillExtras,
  findPrice,
  modelLabel,
  unpricedModels
} from '@shared/usage/pricing'
import { codexUsageSettings } from '@shared/usage/codex-settings'
import type { CodexTurnSample, UsageRecord } from '@shared/usage/types'
import { analyzeCodexUsage } from '../src/main/providers/codex/usage'
import { readCodexUsageText } from '../src/main/providers/codex/read'

// ------------------------------------------------------------ Claude Code

const ctx = { key: 'windows:s1', project: 'acme-web', env: 'windows' as const }
const T0 = Date.parse('2026-10-22T10:00:00Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

type Block = Record<string, unknown>
function assistant(
  id: string,
  sec: number,
  output: number,
  content: Block[],
  opts: {
    stop?: string | null
    ref?: string
    thinkingMs?: number
    thinkingTokens?: number
    sidechain?: boolean
    model?: string
    speed?: string
  } = {}
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}-${sec}`,
    timestamp: at(sec),
    isSidechain: opts.sidechain ?? false,
    version: '2.1.300',
    requestId: `req_${id}`,
    ...(opts.ref ? { requestRef: opts.ref } : {}),
    ...(opts.thinkingMs !== undefined ? { thinkingDurationMs: opts.thinkingMs } : {}),
    message: {
      id,
      role: 'assistant',
      model: opts.model ?? 'claude-opus-5-5',
      content,
      stop_reason: opts.stop === undefined ? 'tool_use' : opts.stop,
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 100,
        ...(opts.speed ? { speed: opts.speed } : {}),
        ...(opts.thinkingTokens !== undefined
          ? { output_tokens_details: { thinking_tokens: opts.thinkingTokens } }
          : {})
      }
    }
  })
}
const prompt = (sec: number, text = 'fix it'): string =>
  JSON.stringify({
    type: 'user',
    uuid: `p-${sec}`,
    timestamp: at(sec),
    message: { role: 'user', content: text }
  })
const toolResult = (sec: number, id = 't1', sidechain = false): string =>
  JSON.stringify({
    type: 'user',
    uuid: `r-${sec}-${id}`,
    timestamp: at(sec),
    isSidechain: sidechain,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }
  })
const apiRequest = (id: string, sec: number): string =>
  JSON.stringify({ type: 'api-request', id, timestamp: at(sec), sessionId: 's1', params: {} })
const think: Block = { type: 'thinking', thinking: '' }
const text: Block = { type: 'text', text: 'done' }
const tool = (id = 't1'): Block => ({ type: 'tool_use', id, name: 'Bash', input: {} })

const events = (lines: string[]) => parseJsonl(lines.join('\n')).events

describe('Claude Code response timing', () => {
  it('times a multi-line response from its request to its last line', () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        apiRequest('ar1', 0.05),
        assistant('msg_1', 3, 400, [think], { ref: 'ar1', thinkingMs: 1500 }),
        assistant('msg_1', 5, 400, [text], { ref: 'ar1' }),
        assistant('msg_1', 8.05, 400, [tool()], { ref: 'ar1' })
      ])
    )
    // 0.05 s → 8.05 s; first token when the thinking began: 3 − 1.5 − 0.05.
    expect(t.get('msg_1')).toEqual({ genMs: 8000, ttftMs: 1450 })
  })

  it('leaves tool time out: the next response starts after the tool result', () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        assistant('msg_1', 4, 200, [tool()]),
        // The tool ran for 56 s.
        toolResult(60),
        assistant('msg_2', 62, 300, [text], { stop: 'end_turn' })
      ])
    )
    expect(t.get('msg_1')!.genMs).toBe(4000)
    expect(t.get('msg_2')!.genMs).toBe(2000)
    // No api-request lines (older logs): no time to first token.
    expect(t.get('msg_2')!.ttftMs).toBeUndefined()
  })

  it('handles tools that run while the reply still streams, and parallel tool calls', () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        apiRequest('ar1', 0),
        assistant('msg_1', 2, 500, [tool('t1')], { ref: 'ar1' }),
        toolResult(3, 't1'),
        assistant('msg_1', 6, 500, [tool('t2')], { ref: 'ar1' }),
        toolResult(20, 't2'),
        apiRequest('ar2', 20.02),
        assistant('msg_2', 25.02, 300, [text], { ref: 'ar2', stop: 'end_turn' })
      ])
    )
    // The tool result in the middle doesn't cut msg_1 short.
    expect(t.get('msg_1')!.genMs).toBe(6000)
    expect(t.get('msg_2')!.genMs).toBe(5000)
  })

  it('without a logged request, a response right after another one has no start', () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        assistant('msg_1', 2, 100, [text], { stop: 'end_turn' }),
        assistant('msg_2', 4, 100, [text], { stop: 'end_turn' })
      ])
    )
    expect(t.has('msg_1')).toBe(true)
    expect(t.has('msg_2')).toBe(false)
  })

  it('skips a response cut short (no stop reason) or after an API error', () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        assistant('msg_1', 2, 100, [text], { stop: null }),
        prompt(10),
        JSON.stringify({ type: 'system', subtype: 'api_error', timestamp: at(11) }),
        assistant('msg_2', 40, 100, [text], { stop: 'end_turn' })
      ])
    )
    expect(t.has('msg_1')).toBe(false)
    // The retry wait isn't generation time.
    expect(t.has('msg_2')).toBe(false)
  })

  it('keeps a sidechain (subagent, /btw) apart from the main chain', () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        assistant('msg_main', 1, 100, [tool('t9')]),
        toolResult(1.5, 's1', true),
        assistant('msg_side', 4.5, 100, [text], { sidechain: true, stop: 'end_turn' }),
        toolResult(30, 't9'),
        assistant('msg_main2', 33, 100, [text], { stop: 'end_turn' })
      ])
    )
    expect(t.get('msg_side')!.genMs).toBe(3000)
    expect(t.get('msg_main2')!.genMs).toBe(3000)
  })

  it('puts the timing and thinking tokens on the usage record', () => {
    const a = analyzeUsage(
      events([
        prompt(0),
        apiRequest('ar1', 0),
        assistant('msg_1', 2, 600, [think], { ref: 'ar1', thinkingMs: 1000, thinkingTokens: 200 }),
        assistant('msg_1', 6, 600, [text], {
          ref: 'ar1',
          thinkingTokens: 200,
          stop: 'end_turn'
        })
      ]),
      ctx
    )
    const r = a.records[0]
    expect(r).toMatchObject({ genMs: 6000, ttftMs: 1000, output: 600 })
    expect(thinkingTokens(r)).toBe(200)
    expect(outputSpeed(r)).toBe(100)
    expect(visibleSpeed(r)).toBeCloseTo(400 / 6)
  })
})

// ---------------------------------------------------------- outlier rules

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: over.id ?? `r${Math.random()}`,
    ts: T0,
    key: 'windows:s1',
    project: 'p',
    env: 'windows',
    model: 'claude-opus-5-5',
    input: 10,
    output: 500,
    cacheWrite: 0,
    cacheRead: 0,
    genMs: 5000,
    ...over
  }
}

describe('outlier rules', () => {
  it('counts a normal response', () => {
    expect(outputSpeed(rec())).toBe(100)
  })
  it('leaves out short replies, too short or too long times and impossible speeds', () => {
    expect(outputSpeed(rec({ output: 49 }))).toBeUndefined()
    expect(outputSpeed(rec({ output: 50 }))).toBe(10)
    expect(outputSpeed(rec({ genMs: 200 }))).toBeUndefined()
    expect(outputSpeed(rec({ genMs: 11 * 60_000 }))).toBeUndefined()
    expect(outputSpeed(rec({ output: 10_000, genMs: 5000 }))).toBeUndefined() // 2,000 tok/s
    expect(outputSpeed(rec({ genMs: undefined }))).toBeUndefined()
  })
  it('needs five responses for a median', () => {
    const four = [1, 2, 3, 4].map(() => rec())
    expect(medianSpeed(four).tps).toBeUndefined()
    expect(medianSpeed([...four, rec({ genMs: 2500 })]).tps).toBe(100)
  })
})

// ------------------------------------------------------------- dedupe

describe('copied responses (forks, resumes, branches)', () => {
  it("never let a copy in another session change the original's timing", () => {
    const d = new UsageDeduper()
    d.add(rec({ id: 'm:r', mid: 'm', rid: 'r', genMs: 5000 }))
    const res = d.add(rec({ id: 'm:r', mid: 'm', rid: 'r', key: 'windows:fork', genMs: 10 }))
    expect(res.result).toBe('duplicate')
    expect(d.get('m:r')!.genMs).toBe(5000)
    // Even a copy with more tokens (which replaces the counts) keeps the original's timing.
    d.add(rec({ id: 'm:r', mid: 'm', rid: 'r', key: 'windows:fork', output: 900, genMs: 10 }))
    expect(d.get('m:r')).toMatchObject({ output: 900, genMs: 5000, key: 'windows:s1' })
  })
  it('updates the timing when the same session is read again', () => {
    const d = new UsageDeduper()
    d.add(rec({ id: 'm:r', mid: 'm', rid: 'r', genMs: undefined }))
    const res = d.add(rec({ id: 'm:r', mid: 'm', rid: 'r', genMs: 4000, ttftMs: 900 }))
    expect(res.result).toBe('replaced')
    expect(d.get('m:r')).toMatchObject({ genMs: 4000, ttftMs: 900 })
  })
  it("takes a copy's timing only when the original has none", () => {
    const d = new UsageDeduper()
    d.add(rec({ id: 'm:r', mid: 'm', rid: 'r', genMs: undefined }))
    d.add(rec({ id: 'm:r', mid: 'm', rid: 'r', key: 'windows:fork', genMs: 3000 }))
    expect(d.get('m:r')!.genMs).toBe(3000)
  })
})

// ------------------------------------------------------------------ Codex

const cctx = { key: 'codex-windows:s1', project: 'p', env: 'windows' as const, sessionId: 's1' }
const L = (sec: number, type: string, payload: Record<string, unknown>, extra = {}): string =>
  JSON.stringify({ timestamp: at(sec), ...extra, type, payload })
let total = 0
function usage(sec: number, output: number, reasoning = 0): string {
  total += 100 + output
  const last = {
    input_tokens: 100,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: 100 + output
  }
  return L(sec, 'event_msg', {
    type: 'token_count',
    info: { last_token_usage: last, total_token_usage: { ...last, total_tokens: total } }
  })
}
const meta = (sec: number, extra: Record<string, unknown> = {}): string =>
  L(sec, 'session_meta', { id: 's1', cli_version: '0.167.0', ...extra })
const ctxLine = (model = 'gpt-6.1-sol'): string => L(0, 'turn_context', { model })
const settings = (sec: number, tier?: string): string =>
  L(sec, 'event_msg', {
    type: 'thread_settings_applied',
    thread_settings: tier ? { service_tier: tier } : {}
  })

describe('Codex response timing', () => {
  it('ends a response at its token_usage_record, before its tools ran', () => {
    total = 0
    const a = analyzeCodexUsage(
      [
        meta(0),
        L(0.1, 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
        ctxLine(),
        L(0.2, 'response_item', { type: 'message', role: 'user', content: [{ text: 'hi' }] }),
        L(2, 'response_item', { type: 'reasoning' }),
        L(3, 'response_item', { type: 'custom_tool_call' }),
        L(3.2, 'token_usage_record', {}, { ordinal: 7 }),
        // The tool ran for 30 s; Codex writes the token_count after it.
        L(33.2, 'response_item', { type: 'custom_tool_call_output' }),
        usage(33.3, 300, 100),
        L(35, 'response_item', { type: 'reasoning' }),
        L(36.3, 'response_item', { type: 'message', role: 'assistant' }),
        L(36.3, 'token_usage_record', {}),
        usage(36.4, 150, 50),
        L(36.5, 'event_msg', {
          type: 'task_complete',
          turn_id: 'turn-1',
          time_to_first_token_ms: 1800
        })
      ].join('\n'),
      cctx
    )
    expect(a.records.map((r) => r.genMs)).toEqual([3000, 3000])
    expect(a.codexTurns![0].firstTokenMs).toBe(1800)
    expect(visibleSpeed(a.records[0])).toBeCloseTo(200 / 3)
  })

  it('older Codex (no token_usage_record): ends at the last output item before a tool output', () => {
    total = 0
    const a = analyzeCodexUsage(
      [
        meta(0, { cli_version: '0.146.0' }),
        L(0, 'event_msg', { type: 'task_started', turn_id: 't' }),
        ctxLine(),
        L(1, 'response_item', { type: 'message', role: 'user', content: [{ text: 'go' }] }),
        L(4, 'response_item', { type: 'reasoning' }),
        L(6, 'response_item', { type: 'function_call' }),
        L(16, 'response_item', { type: 'function_call_output' }),
        usage(16.01, 400)
      ].join('\n'),
      cctx
    )
    expect(a.records[0].genMs).toBe(5000)
  })

  it("gives a fork's copied history no timing", () => {
    total = 0
    const a = analyzeCodexUsage(
      [
        L(100, 'session_meta', { id: 's1', forked_from_id: 'parent', cli_version: '0.167.0' }),
        // The parent's events, copied within milliseconds of the fork's meta.
        L(100.001, 'event_msg', { type: 'task_started', turn_id: 'old' }),
        L(100.002, 'response_item', { type: 'reasoning' }),
        L(100.003, 'token_usage_record', {}),
        usage(100.004, 300),
        // The fork's own response.
        L(200, 'event_msg', { type: 'task_started', turn_id: 'new' }),
        L(203, 'response_item', { type: 'reasoning' }),
        L(204, 'token_usage_record', {}),
        usage(204.1, 300)
      ].join('\n'),
      cctx
    )
    expect(a.records.map((r) => r.genMs)).toEqual([undefined, 4000])
  })

  it('counts fast mode (the priority tier) as "<model>-fast"', () => {
    total = 0
    const a = analyzeCodexUsage(
      [
        meta(0),
        settings(0, 'priority'),
        L(0, 'event_msg', { type: 'task_started', turn_id: 'a' }),
        ctxLine(),
        L(1, 'response_item', { type: 'reasoning' }),
        usage(2, 300),
        L(2.1, 'event_msg', { type: 'task_complete', turn_id: 'a', time_to_first_token_ms: 900 }),
        settings(3, 'default'),
        L(3, 'event_msg', { type: 'task_started', turn_id: 'b' }),
        ctxLine(),
        L(4, 'response_item', { type: 'reasoning' }),
        usage(5, 300),
        L(5.1, 'event_msg', { type: 'task_complete', turn_id: 'b', time_to_first_token_ms: 2000 })
      ].join('\n'),
      cctx
    )
    expect(a.records.map((r) => r.model)).toEqual(['gpt-6.1-sol-fast', 'gpt-6.1-sol'])
    expect(a.codexTurns!.map((t) => t.model)).toEqual(['gpt-6.1-sol-fast', 'gpt-6.1-sol'])
    const s = speedStats(a.records, a.codexTurns)
    expect(s.fast).toBe(true)
    // Fast mode never moves the normal-mode time to first token.
    expect(s.ttftSamples).toBe(1)
  })

  it('the usage reader keeps what the timing needs, never any text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csd-speed-'))
    try {
      const file = join(dir, 'rollout-2026-10-22T10-00-00-0000.jsonl')
      total = 0
      writeFileSync(
        file,
        [
          meta(0),
          settings(0, 'priority'),
          L(0, 'event_msg', { type: 'task_started', turn_id: 'a' }),
          ctxLine(),
          L(1, 'response_item', { type: 'reasoning', encrypted_content: 'SECRET-REASONING' }),
          L(2, 'response_item', {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'SECRET-ANSWER' }]
          }),
          L(2.1, 'token_usage_record', { usage: {} }, { ordinal: 3 }),
          usage(2.2, 300)
        ].join('\n')
      )
      const text = await readCodexUsageText(file)
      expect(text).not.toContain('SECRET')
      const a = analyzeCodexUsage(text, cctx)
      expect(a.records[0]).toMatchObject({ model: 'gpt-6.1-sol-fast', genMs: 2100 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------ weekly medians

const WEEK = 7 * 86_400_000
const MON = Date.parse('2026-10-19T12:00:00Z') // a Monday
function many(n: number, over: Partial<UsageRecord>): UsageRecord[] {
  return Array.from({ length: n }, (_, i) => rec({ id: `${over.model}-${over.ts}-${i}`, ...over }))
}

describe('weekly medians', () => {
  const records = [
    ...many(5, { ts: MON, genMs: 5000 }), // 100 tok/s
    ...many(5, { ts: MON + WEEK, genMs: 10_000 }), // 50 tok/s
    ...many(5, { ts: MON + WEEK, model: 'claude-opus-5-5-fast', genMs: 2000 }), // 250 tok/s
    ...many(4, { ts: MON + 2 * WEEK, genMs: 5000 }) // too few
  ]
  const input = {
    records,
    turns: [],
    readings: [],
    timeZone: 'UTC',
    weekStart: 'monday' as const
  }

  it('gives each week its median, and nothing below five responses', () => {
    const r = buildTrends({ ...input, groupBy: 'all' })
    const all = r.series.find((s) => s.metric === 'outputSpeed' && s.group === 'all')!
    expect(all.points.map((p) => p.value)).toEqual([100, 50, undefined])
  })

  it('puts fast mode on its own line, never in the normal baseline', () => {
    const r = buildTrends({ ...input, groupBy: 'all' })
    expect(r.groups.map((g) => g.label)).toEqual(['All', 'All · fast'])
    const fast = r.series.find((s) => s.metric === 'outputSpeed' && s.group === 'all|fast')!
    expect(fast.points[1].value).toBe(250)
    const byModel = buildTrends({ ...input, groupBy: 'model' })
    expect(byModel.groups.map((g) => g.label)).toContain('Opus 5.5 · fast')
    // Fast mode isn't a new model.
    expect(byModel.markers.filter((m) => m.kind === 'model')).toHaveLength(0)
  })

  it('compares fast mode on its own rows, only when there is any', () => {
    const c = compareTrends(input, { to: MON + WEEK / 2 }, { from: MON + WEEK / 2 })
    expect(c.rows.find((x) => x.metric === 'outputSpeed')).toMatchObject({ a: 100, b: 50 })
    expect(c.rows.find((x) => x.metric === 'outputSpeedFast')).toMatchObject({ b: 250 })
    const none = compareTrends(
      { ...input, records: records.filter((x) => !x.model.endsWith('-fast')) },
      {},
      {}
    )
    expect(none.rows.some((x) => x.metric === 'outputSpeedFast')).toBe(false)
  })

  it("notes how much of Claude Code's time to first token is estimated", () => {
    const r = buildTrends({
      ...input,
      records: [...many(3, { ts: MON, ttftMs: 1200 }), ...many(1, { ts: MON })],
      groupBy: 'all'
    })
    expect(r.notes?.firstToken).toBe('est. from 75% of responses')
    expect(ttftCoverageText(0.004)).toBe('est. from <1% of responses')
  })

  it("Codex: speed by week, and fast-mode turns' time to first token apart", () => {
    const codex = (o: Partial<UsageRecord>) =>
      many(5, { provider: 'codex', model: 'gpt-6.1-sol', ...o })
    const turn = (id: string, model: string, ms: number): CodexTurnSample => ({
      id,
      ts: MON,
      key: 'k',
      model,
      firstTokenMs: ms,
      responses: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      aborted: false,
      failed: false,
      prompted: true
    })
    const recs = [
      ...codex({ ts: MON, genMs: 10_000 }),
      ...codex({ ts: MON, model: 'gpt-6.1-sol-fast', genMs: 5000 })
    ]
    const turns = [
      turn('a', 'gpt-6.1-sol', 3000),
      turn('b', 'gpt-6.1-sol', 3000),
      turn('c', 'gpt-6.1-sol-fast', 1000),
      turn('d', 'gpt-6.1-sol-fast', 1000)
    ]
    const r = buildCodexTrends({
      records: recs,
      turns,
      timeZone: 'UTC',
      weekStart: 'monday',
      groupBy: 'all'
    })
    const v = (metric: string, group: string) =>
      r.series.find((s) => s.metric === metric && s.group === group)!.points[0].value
    expect(v('outputSpeed', 'all')).toBe(50)
    expect(v('outputSpeed', 'all|fast')).toBe(100)
    expect(v('firstToken', 'all')).toBe(3)
    expect(v('firstToken', 'all|fast')).toBe(1)
    const c = compareCodexTrends({ records: recs, turns }, {}, {})
    expect(c.rows.find((x) => x.metric === 'firstToken')!.a).toBe(3)
    expect(c.rows.find((x) => x.metric === 'firstTokenFast')!.a).toBe(1)
  })

  it('combines both agents’ models in one chart, each with its provider', () => {
    const r = buildSpeedTrends({
      records: [
        ...many(5, { ts: MON }),
        ...many(6, { ts: MON, provider: 'codex', model: 'gpt-6.1-sol', genMs: 10_000 })
      ],
      timeZone: 'UTC',
      weekStart: 'monday'
    })
    expect(r.groups.map((g) => [g.label, g.provider])).toEqual([
      ['GPT-6.1 Sol', 'codex'],
      ['Opus 5.5', 'claude']
    ])
    expect(r.series.map((s) => s.points[0].value)).toEqual([50, 100])
  })

  it('compares the last week with the weeks before (limit health)', () => {
    const now = MON + 5 * WEEK
    const sig = speedSignal(
      [
        ...many(5, { ts: now - 2 * 86_400_000, genMs: 10_000 }),
        ...many(5, { ts: now - 14 * 86_400_000 })
      ],
      now
    )
    expect(sig.rows[0]).toMatchObject({
      label: 'Opus 5.5',
      recent: 50,
      before: 100,
      changePct: -50
    })
  })
})

describe('session, card and breakdown speeds', () => {
  it('session stats: normal and fast mode apart, with the estimate coverage', () => {
    const s = speedStats([
      ...many(6, { ttftMs: 1000 }),
      ...many(2, {}),
      ...many(5, { model: 'claude-opus-5-5-fast', genMs: 2000 })
    ])
    expect(s).toMatchObject({ tps: 100, samples: 8, fast: true, fastTps: 250, fastSamples: 5 })
    expect(s.ttftMs).toBe(1000)
    expect(s.ttftCoverage).toBe(0.75)
  })

  it('cards leave fast mode out; the model breakdown gives it its own row', () => {
    const now = MON + 3600_000
    const recs = [
      ...many(5, { ts: MON }),
      ...many(5, { ts: MON, model: 'claude-opus-5-5-fast', genMs: 2000 })
    ]
    const c = { timeZone: 'UTC', weekStart: 'monday' as const, prices: DEFAULT_PRICES, now }
    const cards = periodCards(recs, c, new Map())
    expect(cards.find((x) => x.id === 'all')!.tps).toBe(100)
    const rows = breakdown(recs, 'model', c)
    expect(rows.find((x) => x.key === 'claude-opus-5-5-fast')).toMatchObject({
      tps: 250,
      tpsSamples: 5
    })
    expect(rows.find((x) => x.key === 'claude-opus-5-5')).toMatchObject({ tps: 100 })
  })

  it('the CSV export has the speed columns', () => {
    const recs = many(5, { ts: MON, ttftMs: 1234.4 })
    const per = toCsv(recs, { timeZone: 'UTC', prices: DEFAULT_PRICES }, true).split('\r\n')
    expect(per[0].split(',').slice(-6)).toEqual([
      'provider',
      'thinking_tokens',
      'gen_ms',
      'ttft_ms',
      'tokens_per_sec',
      'fast_mode'
    ])
    expect(per[1].split(',').slice(-5)).toEqual(['0', '5000', '1234', '100.0', 'no'])
    const daily = toCsv(recs, { timeZone: 'UTC', prices: DEFAULT_PRICES }).split('\r\n')
    expect(daily[0].endsWith('median_tokens_per_sec,speed_samples')).toBe(true)
    expect(daily[1].endsWith('100.0,5')).toBe(true)
  })
})

// ---------------------------------------------------------------- prices

describe('prices: Claude Fable 5.2 and fast mode', () => {
  it("prices claude-fable-5-2 from Anthropic's pricing page, not as Fable 5", () => {
    const row = findPrice('claude-fable-5-2', DEFAULT_PRICES)!
    expect(row).toMatchObject({
      model: 'claude-fable-5-2',
      input: 8,
      output: 40,
      cacheWrite5m: 10,
      cacheWrite1h: 16,
      cacheRead: 0.2,
      fast: 2
    })
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2')
  })

  it('never prices a newer minor version with an older row', () => {
    const old = DEFAULT_PRICES.filter((p) => p.model === 'claude-fable-5')
    expect(findPrice('claude-fable-5-2', old)).toBeUndefined()
    expect(unpricedModels(['claude-fable-5-2'], old)).toEqual(['claude-fable-5-2'])
    // Dated ids still match their row.
    expect(findPrice('claude-haiku-4-5-20251001', DEFAULT_PRICES)!.model).toBe('claude-haiku-4-5')
  })

  it('adds the official rows to a table saved before them, keeping edits', () => {
    const saved = DEFAULT_PRICES.filter((p) => !p.model.endsWith('-5-2')).map((p) =>
      p.model === 'claude-opus-5-5' ? { ...p, input: 99 } : p
    )
    const t = addSnapshotExtras(saved)
    expect(t.find((p) => p.model === 'claude-fable-5-2')).toBeDefined()
    expect(t.find((p) => p.model === 'claude-opus-5-5')!.input).toBe(99)
  })

  it('prices fast mode: Claude 2x, Codex with OpenAI’s Fast (Priority) prices', () => {
    // Under the long-context lines: 100k input, 1M output.
    const r = { input: 100_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 }
    expect(estimateCost({ ...r, model: 'claude-fable-5-2-fast' }, DEFAULT_PRICES)).toBeCloseTo(81.6)
    expect(estimateCost({ ...r, model: 'gpt-6.1-sol' }, DEFAULT_CODEX_PRICES)).toBeCloseTo(10.2)
    expect(estimateCost({ ...r, model: 'gpt-6.1-sol-fast' }, DEFAULT_CODEX_PRICES)).toBeCloseTo(
      20.4
    )
    expect(estimateCost({ ...r, model: 'gpt-5.5-fast' }, DEFAULT_CODEX_PRICES)).toBeCloseTo(76.25)
    expect(modelLabel('gpt-6.1-sol-fast')).toBe('GPT-6.1 Sol · fast')
    expect(modelLabel('claude-opus-5-5-fast')).toBe('Opus 5.5 · fast')
  })

  it("a saved Codex table gets the fast multipliers it didn't have", () => {
    const saved = DEFAULT_CODEX_PRICES.map(({ fast: _f, ...p }) => p)
    expect(
      fillExtras(saved, DEFAULT_CODEX_PRICES).find((p) => p.model === 'gpt-6.1-sol')!.fast
    ).toBe(2)
    const s = codexUsageSettings({ codexPrices: saved })
    expect(s.codexPrices.find((p) => p.model === 'gpt-5.5')!.fast).toBe(2.5)
  })
})

describe('combined speed chart', () => {
  it('leaves out a model without a week of enough responses', () => {
    const r = buildSpeedTrends({
      records: [
        ...many(5, { ts: MON }),
        ...many(4, { ts: MON, provider: 'codex', model: 'gpt-6.1-sol' })
      ],
      timeZone: 'UTC',
      weekStart: 'monday'
    })
    expect(r.groups.map((g) => g.key)).toEqual(['claude-opus-5-5'])
  })
})

describe('Codex copied history', () => {
  it("gives a subagent's inherited history no timing (one burst after its meta)", () => {
    total = 0
    const a = analyzeCodexUsage(
      [
        L(50, 'session_meta', {
          id: 's1',
          parent_thread_id: 'p',
          subagent_history_start_ordinal: 9
        }),
        // The parent's history, all written at once.
        L(50, 'event_msg', { type: 'task_started', turn_id: 'old' }),
        L(50, 'response_item', { type: 'reasoning' }),
        L(50, 'response_item', { type: 'custom_tool_call' }),
        L(50, 'response_item', { type: 'custom_tool_call_output' }),
        usage(50, 300),
        L(50.05, 'response_item', { type: 'reasoning' }),
        usage(50.06, 300),
        // Its own work.
        L(50.1, 'event_msg', { type: 'task_started', turn_id: 'own' }),
        L(53, 'response_item', { type: 'reasoning' }),
        L(54, 'token_usage_record', {}),
        usage(54.1, 300)
      ].join('\n'),
      cctx
    )
    expect(a.records.map((r) => r.genMs)).toEqual([undefined, undefined, 3900])
  })

  it('a new session (no inherited history) keeps even a quick first response', () => {
    total = 0
    const a = analyzeCodexUsage(
      [
        meta(0),
        L(0.01, 'event_msg', { type: 'task_started', turn_id: 'a' }),
        L(0.05, 'response_item', { type: 'message', role: 'user', content: [{ text: 'hi' }] }),
        L(0.09, 'response_item', { type: 'message', role: 'assistant' }),
        L(0.1, 'token_usage_record', {}),
        usage(0.11, 60)
      ].join('\n'),
      cctx
    )
    expect(a.records[0].genMs).toBe(50)
  })
})

describe('Claude Code timing: one response per message id, request and chain', () => {
  const gw = (sec: number, out: number, stop: string | null, opts: { rid?: string } = {}) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `g-${sec}`,
      timestamp: at(sec),
      version: '2.1.300',
      ...(opts.rid ? { requestId: opts.rid } : {}),
      message: {
        id: 'chatcmpl-1', // a gateway that reuses one id
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [tool()],
        stop_reason: stop,
        usage: { input_tokens: 10, output_tokens: out }
      }
    })

  it('splits a gateway id reused by separate responses', () => {
    const lines = [prompt(0), gw(4, 400, 'tool_use'), toolResult(60), gw(62, 300, 'end_turn')]
    const t = claudeResponseTimings(events(lines))
    expect(t.get('chatcmpl-1', undefined, T0 + 4000)!.genMs).toBe(4000)
    expect(t.get('chatcmpl-1', undefined, T0 + 62_000)!.genMs).toBe(2000)
    // Each usage record gets its own response's time, never one 62-second interval.
    const a = analyzeUsage(events(lines), ctx)
    expect(a.records.map((r) => r.genMs).sort()).toEqual([2000, 4000])
  })

  it('keeps an id with different request ids apart', () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        gw(3, 400, 'tool_use', { rid: 'req_a' }),
        toolResult(30),
        gw(35, 300, 'end_turn', { rid: 'req_b' })
      ])
    )
    expect(t.get('chatcmpl-1', 'req_a')!.genMs).toBe(3000)
    expect(t.get('chatcmpl-1', 'req_b')!.genMs).toBe(5000)
  })

  it("never lets a sidechain replay stretch the main response's time", () => {
    const t = claudeResponseTimings(
      events([
        prompt(0),
        assistant('msg_1', 3, 400, [text], { stop: 'end_turn' }),
        toolResult(100, 'b1', true),
        assistant('msg_1', 101, 400, [text], { stop: 'end_turn', sidechain: true })
      ])
    )
    expect(t.get('msg_1', undefined, undefined, false)!.genMs).toBe(3000)
    expect(t.get('msg_1', undefined, undefined, true)!.genMs).toBe(1000)
  })
})

describe('fast-mode lines never take a version’s place', () => {
  it('keeps the five busiest versions and adds their fast lines', () => {
    const recs = ['2.1.1', '2.1.2', '2.1.3', '2.1.4', '2.1.5'].flatMap((v, i) =>
      many(10 + i, { ts: MON, version: v })
    )
    // A small version, and lots of fast-mode responses on one of them.
    recs.push(...many(3, { ts: MON, version: '2.1.0' }))
    recs.push(...many(40, { ts: MON, version: '2.1.1', model: 'claude-opus-5-5-fast' }))
    const r = buildTrends({
      records: recs,
      turns: [],
      readings: [],
      timeZone: 'UTC',
      weekStart: 'monday',
      groupBy: 'version'
    })
    const keys = r.groups.map((g) => g.key)
    expect(keys.filter((k) => !k.endsWith('|fast'))).toHaveLength(5)
    expect(keys).toContain('2.1.5')
    expect(keys).toContain('2.1.1|fast')
    expect(keys.indexOf('2.1.1|fast')).toBe(keys.indexOf('2.1.1') + 1)
  })
})
