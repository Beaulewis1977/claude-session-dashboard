import { describe, expect, it } from 'vitest'
import { parseJsonl } from '@shared/jsonl'
import { analyzeUsage, parseUsageObject } from '@shared/usage/parse'
import { recordId } from '@shared/usage/dedupe'
import {
  addSnapshotExtras,
  estimateCost,
  findPrice,
  modelLabel,
  DEFAULT_PRICES,
  PRICES_FILLED_IN,
  sanitizePrices
} from '@shared/usage/pricing'
import { line } from './helpers'

const ctx = { key: 'windows:s1', project: 'acme-web', env: 'windows' as const }

function assistant(
  id: string,
  req: string | undefined,
  ts: string,
  usage: unknown,
  content: unknown[] = [{ type: 'text', text: 'ok' }],
  extra: Record<string, unknown> = {}
) {
  return line({
    type: 'assistant',
    uuid: `u-${id}-${ts}`,
    timestamp: ts,
    version: '2.1.300',
    requestId: req,
    message: { id, role: 'assistant', model: 'claude-opus-5-5', content, usage, stop_reason: null },
    ...extra
  })
}

function user(text: string, ts: string, uuid = `p-${ts}`) {
  return line({ type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } })
}

describe('usage extraction', () => {
  it('counts a response once when it spans several lines, keeping the final numbers', () => {
    const u1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 }
    const u2 = { input_tokens: 10, output_tokens: 240, cache_read_input_tokens: 1000 }
    const text = [
      user('fix it', '2026-10-22T10:00:00Z'),
      assistant('msg_1', 'req_1', '2026-10-22T10:00:05Z', u1, [
        { type: 'thinking', thinking: 'hmm' }
      ]),
      assistant('msg_1', 'req_1', '2026-10-22T10:00:06Z', u1, [{ type: 'text', text: 'a' }]),
      assistant('msg_1', 'req_1', '2026-10-22T10:00:07Z', u2, [
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} }
      ])
    ].join('\n')
    const a = analyzeUsage(parseJsonl(text).events, ctx)
    expect(a.records).toHaveLength(1)
    expect(a.records[0]).toMatchObject({
      id: 'msg_1:req_1',
      input: 10,
      output: 240,
      cacheRead: 1000,
      model: 'claude-opus-5-5',
      version: '2.1.300',
      key: 'windows:s1',
      project: 'acme-web',
      env: 'windows'
    })
    expect(a.turns).toHaveLength(1)
    expect(a.turns[0]).toMatchObject({
      responses: 1,
      toolCalls: 1,
      thinkingBlocks: 1,
      outputTokens: 240
    })
  })

  it('treats the same message id with a different request id as a different response', () => {
    const u = { input_tokens: 1, output_tokens: 1 }
    const text = [
      assistant('msg_1', 'req_1', '2026-10-22T10:00:05Z', u),
      assistant('msg_1', 'req_2', '2026-10-22T10:00:06Z', u)
    ].join('\n')
    expect(analyzeUsage(parseJsonl(text).events, ctx).records).toHaveLength(2)
  })

  it('scopes requestless dedupe keys to the session, and gateway ids to the timestamp', () => {
    expect(recordId('msg_1', 'req_1', 's1', 5, 'f')).toBe('msg_1:req_1')
    expect(recordId('msg_1', undefined, 's1', 5, 'f')).toBe('msg_1|s1')
    expect(recordId('gw', undefined, 's1', 5, 'f')).toBe('gw|s1|5')
    expect(recordId(undefined, 'req_1', 's1', 5, 'f')).toBe('f')
  })

  it('keeps unknown numeric usage fields and ignores strings', () => {
    const p = parseUsageObject({
      input_tokens: 3,
      output_tokens: 4,
      cache_creation: {
        ephemeral_5m_input_tokens: 10,
        ephemeral_1h_input_tokens: 20,
        ephemeral_24h_input_tokens: 7
      },
      server_tool_use: { web_search_requests: 2 },
      future_tokens: 9,
      service_tier: 'standard'
    })
    expect(p).toEqual({
      input: 3,
      output: 4,
      cacheWrite: 30,
      cacheRead: 0,
      cw1h: 20,
      extra: {
        'server_tool_use.web_search_requests': 2,
        future_tokens: 9,
        'cache_creation.ephemeral_24h_input_tokens': 7
      }
    })
  })

  it('handles missing, empty and malformed usage', () => {
    expect(parseUsageObject(undefined)).toBeUndefined()
    expect(parseUsageObject('lots')).toBeUndefined()
    expect(parseUsageObject({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
    expect(
      parseUsageObject({ input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: 7 })
    ).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 7
    })
    // Old format: only the total cache write.
    expect(parseUsageObject({ cache_creation_input_tokens: 50 })).toMatchObject({ cacheWrite: 50 })

    const text = [
      'not json',
      line({
        type: 'assistant',
        timestamp: '2026-10-22T10:00:00Z',
        message: { id: 'a', model: 'm' }
      }),
      line({ type: 'assistant', message: { id: 'b', model: 'm', usage: { output_tokens: 3 } } }),
      line({
        type: 'assistant',
        timestamp: '2026-10-22T10:00:00Z',
        message: { id: 'c', model: '<synthetic>', usage: { output_tokens: 3 } }
      })
    ].join('\n')
    expect(analyzeUsage(parseJsonl(text).events, ctx).records).toHaveLength(0)
  })

  it('records stop reasons and per-turn metrics', () => {
    const u = { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 900 }
    const text = [
      user('add a test', '2026-10-22T10:00:00Z'),
      line({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-10-22T10:00:04Z',
        requestId: 'r1',
        message: {
          id: 'm1',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
          usage: u,
          stop_reason: 'tool_use'
        }
      }),
      line({
        type: 'user',
        uuid: 'r',
        timestamp: '2026-10-22T10:00:06Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }]
        }
      }),
      line({
        type: 'system',
        subtype: 'api_error',
        timestamp: '2026-10-22T10:00:07Z',
        level: 'error'
      }),
      line({
        type: 'user',
        uuid: 'i',
        timestamp: '2026-10-22T10:00:09Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }]
        }
      }),
      user("no, that's the wrong file", '2026-10-22T10:01:00Z'),
      user('wrong again', '2026-10-22T10:02:00Z'),
      user('thanks', '2026-10-22T10:03:00Z')
    ].join('\n')
    const a = analyzeUsage(parseJsonl(text).events, ctx)
    expect(a.records[0].stop).toBe('tool_use')
    expect(a.turns).toHaveLength(4)
    expect(a.turns[0]).toMatchObject({
      latencyMs: 4000,
      model: 'claude-sonnet-5-5',
      toolCalls: 1,
      toolResults: 1,
      toolErrors: 1,
      apiErrors: 1,
      interrupted: true,
      correction: false
    })
    expect(a.turns[1].correction).toBe(true) // after an interruption
    expect(a.turns[2].correction).toBe(true) // starts with "wrong"
    expect(a.turns[3].correction).toBe(false)
  })

  it('logs usage-limit messages with their reset time', () => {
    const text = [
      line({
        type: 'assistant',
        uuid: 'l1',
        timestamp: '2026-08-02T15:00:00Z',
        isApiErrorMessage: true,
        message: {
          id: 'x',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Claude AI usage limit reached|1754150400' }]
        }
      }),
      line({
        type: 'assistant',
        uuid: 'l2',
        timestamp: '2026-10-02T15:00:00Z',
        message: {
          id: 'y',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Weekly limit reached ∙ resets Sun 9am' }]
        }
      })
    ].join('\n')
    const hits = analyzeUsage(parseJsonl(text).events, ctx).limitHits
    expect(hits).toEqual([
      expect.objectContaining({
        id: 'l1',
        kind: 'five_hour',
        resetsAt: 1754150400000,
        text: 'Claude AI usage limit reached'
      }),
      expect.objectContaining({ id: 'l2', kind: 'weekly' })
    ])
  })

  it('uses the version in effect when each response was written', () => {
    const u = { input_tokens: 1, output_tokens: 1 }
    const text = [
      line({
        type: 'user',
        version: '1.0.1',
        timestamp: '2026-10-22T10:00:00Z',
        message: { role: 'user', content: 'hi' }
      }),
      assistant('a', 'r', '2026-10-22T10:00:01Z', u, undefined, { version: '1.0.1' }),
      assistant('b', 'r', '2026-10-22T11:00:01Z', u, undefined, { version: '1.0.2' })
    ].join('\n')
    const recs = analyzeUsage(parseJsonl(text).events, ctx).records
    expect(recs.map((r) => r.version)).toEqual(['1.0.1', '1.0.2'])
  })
})

describe('pricing', () => {
  it('finds prices by exact id or the longest prefix', () => {
    expect(findPrice('claude-sonnet-4-5-20250929', DEFAULT_PRICES)?.model).toBe('claude-sonnet-4-5')
    expect(findPrice('claude-opus-4-1-20250805', DEFAULT_PRICES)?.model).toBe('claude-opus-4-1')
    expect(findPrice('claude-opus-4-20250514', DEFAULT_PRICES)?.model).toBe('claude-opus-4')
    expect(findPrice('claude-opus-5', DEFAULT_PRICES)?.model).toBe('claude-opus-5')
    expect(findPrice('claude-opus-5-5', DEFAULT_PRICES)?.model).toBe('claude-opus-5-5')
    expect(findPrice('gpt-5', DEFAULT_PRICES)).toBeUndefined()
  })

  it('estimates cost per token type, with 1-hour cache writes priced separately', () => {
    const cost = estimateCost(
      {
        model: 'claude-opus-5-5',
        input: 1_000_000,
        output: 1_000_000,
        cacheWrite: 2_000_000,
        cw1h: 1_000_000,
        cacheRead: 10_000_000
      },
      DEFAULT_PRICES
    )
    // 4 + 20 + 5 (5m) + 8 (1h) + 10 × 0.2
    expect(cost).toBeCloseTo(39, 6)
    expect(
      estimateCost(
        { model: 'unknown', input: 5, output: 5, cacheWrite: 0, cacheRead: 0 },
        DEFAULT_PRICES
      )
    ).toBe(0)
  })

  it('pre-fills prices from the bundled LiteLLM snapshot', () => {
    expect(PRICES_FILLED_IN).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(findPrice('claude-opus-5-5', DEFAULT_PRICES)).toMatchObject({
      label: 'Claude Opus 5.5',
      input: 4,
      output: 20,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
      fast: 2
    })
    expect(findPrice('claude-3-5-haiku-20241022', DEFAULT_PRICES)?.input).toBe(0.8)
    // Tables saved before the snapshot get its fast and long-context prices; edits stay.
    const saved = sanitizePrices([
      { model: 'claude-opus-5-5', label: 'Mine', input: 3, output: 20 }
    ])!
    expect(addSnapshotExtras(saved)[0]).toMatchObject({ label: 'Mine', input: 3, fast: 2 })
  })

  it('bills a whole request at the long-context tier above its threshold', () => {
    const haiku = (input: number) =>
      estimateCost(
        { model: 'claude-haiku-5-5', input, output: 1_000_000, cacheWrite: 0, cacheRead: 0 },
        DEFAULT_PRICES
      )
    expect(haiku(100_000)).toBeCloseTo((100_000 * 0.1 + 1_000_000 * 0.5) / 1e6, 10)
    expect(haiku(100_001)).toBeCloseTo((100_001 * 0.5 + 1_000_000 * 2.5) / 1e6, 10)
  })

  it('makes short model labels', () => {
    expect(modelLabel('claude-opus-5-5-fast')).toBe('Opus 5.5 (fast)')
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelLabel('mystery')).toBe('mystery')
  })
})
