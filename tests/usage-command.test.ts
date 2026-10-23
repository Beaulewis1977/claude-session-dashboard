import { describe, expect, it } from 'vitest'
import { parseResetPhrase, parseUsageCommandOutput } from '@shared/usage/usage-command'
import { analyzeUsage, commandOutput } from '@shared/usage/parse'

const LA = 'America/Los_Angeles'
// Oct 22, 2026 2:47 PM in Los Angeles (PDT, UTC-7).
const printed = Date.parse('2026-10-22T21:47:00Z')

const PANEL = [
  'Current session',
  '\u001b[32m███████▌\u001b[0m                    15% used',
  'Resets 7pm (America/Los_Angeles)',
  '',
  'Current week (all models)',
  '██                          4% used',
  'Resets Oct 28, 7pm (America/Los_Angeles)',
  '',
  'Current week (Sonnet only)',
  '                            1% used',
  'Resets Oct 28, 7pm (America/Los_Angeles)'
].join('\n')

describe('/usage output', () => {
  it('reads the session and weekly windows with their resets', () => {
    const out = parseUsageCommandOutput(PANEL, printed, 'UTC')
    expect(out).toEqual([
      { kind: 'five_hour', pct: 15, resetsAt: Date.parse('2026-10-23T02:00:00Z') },
      { kind: 'seven_day', pct: 4, resetsAt: Date.parse('2026-10-29T02:00:00Z') }
    ])
  })

  it('understands other reset phrasings', () => {
    expect(parseResetPhrase('3:59pm', printed, LA)).toBe(Date.parse('2026-10-22T22:59:00Z'))
    // Earlier in the day than now → tomorrow.
    expect(parseResetPhrase('9am', printed, LA)).toBe(Date.parse('2026-10-23T16:00:00Z'))
    expect(parseResetPhrase('in 2h 14m', printed, LA)).toBe(printed + (2 * 60 + 14) * 60_000)
    expect(parseResetPhrase('Oct 28 at 7:30 pm (UTC)', printed, LA)).toBe(
      Date.parse('2026-10-28T19:30:00Z')
    )
    expect(parseResetPhrase('18:00', printed, 'UTC')).toBe(
      Date.parse('2026-10-22T18:00:00Z') + 86_400_000
    )
    expect(parseResetPhrase('soon', printed, LA)).toBeUndefined()
  })

  it('drops resets that are too far away for the window and ignores text without percentages', () => {
    const odd = 'Current session\n  20% used\nResets Dec 1, 7pm'
    expect(parseUsageCommandOutput(odd, printed, LA)).toEqual([{ kind: 'five_hour', pct: 20 }])
    expect(parseUsageCommandOutput('Current session: nothing yet', printed, LA)).toEqual([])
  })

  it('finds /usage output in transcripts, in both logged forms, and skips pasted text', () => {
    const base = { sessionId: 's1', cwd: 'C:\\x', version: '2.1.200' }
    const events = [
      {
        ...base,
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-10-22T21:46:59Z',
        message: { role: 'user', content: '<command-name>/usage</command-name>' }
      },
      {
        ...base,
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-10-22T21:47:00Z',
        message: { role: 'user', content: `<local-command-stdout>${PANEL}</local-command-stdout>` }
      },
      {
        ...base,
        type: 'system',
        subtype: 'local_command',
        uuid: 'u3',
        timestamp: '2026-10-22T23:47:00Z',
        content: PANEL.replace('15%', '31%')
      },
      // Pasted into a prompt: not a reading.
      {
        ...base,
        type: 'user',
        uuid: 'u4',
        timestamp: '2026-10-22T23:50:00Z',
        message: { role: 'user', content: `look: ${PANEL}` }
      }
    ]
    expect(commandOutput(events[3])).toBeUndefined()
    const a = analyzeUsage(events, {
      key: 'windows:s1',
      project: 'x',
      env: 'windows',
      timeZone: 'UTC'
    })
    expect(a.usageReadings.map((r) => [r.id, r.kind, r.pct])).toEqual([
      ['u2:five_hour', 'five_hour', 15],
      ['u2:seven_day', 'seven_day', 4],
      ['u3:five_hour', 'five_hour', 31],
      ['u3:seven_day', 'seven_day', 4]
    ])
    // Command output isn't a prompt; only the pasted message is a turn.
    expect(a.turns.map((t) => t.id)).toEqual(['u4'])
  })

  it("never mistakes quoted /usage output for a reading, and keeps the reply's tokens", () => {
    const base = { sessionId: 's1', cwd: 'C:\\x', version: '2.1.200' }
    const quoted = `Here is what that looked like:\n\n\`\`\`\n<local-command-stdout>${PANEL}</local-command-stdout>\n\`\`\``
    const events = [
      {
        ...base,
        type: 'user',
        uuid: 'q1',
        timestamp: '2026-10-22T21:40:00Z',
        message: { role: 'user', content: 'Why does /usage print this?' }
      },
      // Claude explaining /usage output in a reply: a real response with real tokens.
      {
        ...base,
        type: 'assistant',
        uuid: 'a1',
        requestId: 'req_1',
        timestamp: '2026-10-22T21:40:05Z',
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude-opus-4-5',
          content: [{ type: 'text', text: quoted }],
          usage: { input_tokens: 1200, output_tokens: 300 }
        }
      },
      // The envelope pasted inside a longer prompt is not a reading either.
      {
        ...base,
        type: 'user',
        uuid: 'q2',
        timestamp: '2026-10-22T21:41:00Z',
        message: {
          role: 'user',
          content: `compare with <local-command-stdout>${PANEL}</local-command-stdout> please`
        }
      }
    ]
    expect(commandOutput(events[1])).toBeUndefined()
    expect(commandOutput(events[2])).toBeUndefined()
    const a = analyzeUsage(events, {
      key: 'windows:s1',
      project: 'x',
      env: 'windows',
      timeZone: 'UTC'
    })
    expect(a.usageReadings).toEqual([])
    expect(a.records).toHaveLength(1)
    expect(a.records[0]).toMatchObject({ input: 1200, output: 300 })
    expect(a.turns.map((t) => t.id)).toContain('q1')
  })

  it('counts a stdout envelope only right after the /usage command it answers', () => {
    const base = { sessionId: 's1', cwd: 'C:\\x', version: '2.1.200' }
    const env = (uuid: string, parentUuid: string | undefined, ts: string) => ({
      ...base,
      type: 'user',
      uuid,
      ...(parentUuid ? { parentUuid } : {}),
      timestamp: ts,
      message: { role: 'user', content: `<local-command-stdout>${PANEL}</local-command-stdout>` }
    })
    const user = (uuid: string, content: string, ts: string, parentUuid?: string) => ({
      ...base,
      type: 'user',
      uuid,
      ...(parentUuid ? { parentUuid } : {}),
      timestamp: ts,
      message: { role: 'user', content }
    })
    const readings = (events: object[]) =>
      analyzeUsage(events, {
        key: 'windows:s1',
        project: 'x',
        env: 'windows',
        timeZone: 'UTC'
      }).usageReadings.map((r) => r.id)

    // The review's case: an envelope pasted on its own after an ordinary question.
    expect(
      readings([
        user('a', 'Explain usage output', '2026-10-22T21:00:00Z'),
        env('b', 'a', '2026-10-22T21:01:00Z')
      ])
    ).toEqual([])
    // Claude Code's own order: the command, then its output (parent = the command).
    expect(
      readings([
        user('c', '<command-name>/usage</command-name>', '2026-10-22T21:46:59Z'),
        env('d', 'c', '2026-10-22T21:47:00Z')
      ])
    ).toEqual(['d:five_hour', 'd:seven_day'])
    // Plain "/usage" works too.
    expect(
      readings([user('e', '/usage', '2026-10-22T21:46:59Z'), env('f', 'e', '2026-10-22T21:47:00Z')])
    ).toEqual(['f:five_hour', 'f:seven_day'])
    // Right after a /usage line but pointing somewhere else: not its output.
    expect(
      readings([
        user('g', '<command-name>/usage</command-name>', '2026-10-22T21:46:59Z'),
        env('h', 'zzz', '2026-10-22T21:47:00Z')
      ])
    ).toEqual([])
    // Pasted again later in the conversation: only the first one is a reading.
    expect(
      readings([
        user('i', '<command-name>/usage</command-name>', '2026-10-22T21:46:59Z'),
        env('j', 'i', '2026-10-22T21:47:00Z'),
        user('k', 'what about this one', '2026-10-22T22:00:00Z'),
        env('l', 'k', '2026-10-22T22:01:00Z')
      ])
    ).toEqual(['j:five_hour', 'j:seven_day'])
  })
})
