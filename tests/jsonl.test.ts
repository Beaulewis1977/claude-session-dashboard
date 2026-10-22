import { describe, expect, it } from 'vitest'
import { analyzeEvents, buildMessages, classifyUserText, parseJsonl } from '@shared/jsonl'
import type { ContentBlock } from '@shared/types'
import { SESSIONS, line, read } from './helpers'

describe('parseJsonl', () => {
  it('skips and counts malformed lines', () => {
    const text = [
      line({ type: 'user', message: { role: 'user', content: 'hi' } }),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"trunc',
      'not json',
      '[1,2,3]',
      'null',
      '42',
      '',
      '   ',
      line({ type: 'summary', summary: 'S' })
    ].join('\n')
    const { events, malformedLines } = parseJsonl(text)
    expect(events).toHaveLength(2)
    expect(malformedLines).toBe(5)
  })

  it('handles CRLF line endings and a BOM', () => {
    const text = '\uFEFF' + line({ a: 1 }) + '\r\n' + line({ b: 2 }) + '\r\n'
    const { events, malformedLines } = parseJsonl(text)
    expect(events).toEqual([{ a: 1 }, { b: 2 }])
    expect(malformedLines).toBe(0)
  })

  it('counts the malformed lines in the moment.js fixture', () => {
    expect(parseJsonl(read(SESSIONS.moment)).malformedLines).toBe(2)
  })
})

describe('analyzeEvents', () => {
  it('reads a new-format session', () => {
    const a = analyzeEvents(parseJsonl(read(SESSIONS.safari)).events)
    expect(a.sessionId).toBe('7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d')
    expect(a.cwd).toBe('C:\\Users\\beau\\code\\acme-web')
    expect(a.gitBranch).toBe('fix/login-redirect')
    expect(a.version).toBe('2.0.14')
    expect(a.summary).toBe('Fix Safari login redirect loop caused by cookie path')
    expect(a.firstPrompt).toMatch(/^After logging in, users on Safari/)
    expect(a.userMessageCount).toBe(2)
    expect(a.toolCallCount).toBeGreaterThan(4)
    expect(a.models).toEqual(['claude-sonnet-4-5-20250929'])
    expect(a.startedAt).toBe('2026-10-21T13:02:31.000Z')
    expect(Date.parse(a.lastActivityAt!)).toBeGreaterThan(Date.parse(a.startedAt!))
    expect(a.searchText).toContain('redirect loop')
  })

  it('reads a legacy session (string content, no gitBranch)', () => {
    const a = analyzeEvents(parseJsonl(read(SESSIONS.legacy)).events)
    expect(a.cwd).toBe('C:\\Users\\beau\\My Projects\\desktop app')
    expect(a.gitBranch).toBeUndefined()
    expect(a.version).toBe('0.2.115')
    expect(a.userMessageCount).toBe(2)
    expect(a.assistantMessageCount).toBe(1)
    expect(a.summary).toBeUndefined()
    expect(a.firstPrompt).toMatch(/electron-builder/)
  })

  it('ignores slash commands, meta lines and compact summaries for the first prompt', () => {
    const a = analyzeEvents(parseJsonl(read(SESSIONS.dotfiles)).events)
    expect(a.firstPrompt).toBe('make the tmux prefix ctrl-a instead of ctrl-b')
    expect(a.userMessageCount).toBe(2)
  })

  it('merges assistant lines that share a message id', () => {
    const events = [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'a' }] } },
      {
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] }
      },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'b' }] } }
    ]
    expect(analyzeEvents(events).assistantMessageCount).toBe(2)
  })

  it('survives events with unexpected shapes', () => {
    const events = [
      { type: 'user', message: null },
      { type: 'user', message: { content: 42 } },
      { type: 'assistant', message: { content: [null, 'x', { type: 'mystery' }] } },
      {
        type: 'user',
        timestamp: 'not a date',
        message: { content: [{ type: 'text', text: 'ok' }] }
      },
      { cwd: '', sessionId: 5 }
    ]
    const a = analyzeEvents(events)
    expect(a.firstPrompt).toBe('ok')
    expect(a.startedAt).toBeUndefined()
    expect(a.sessionId).toBeUndefined()
  })
})

describe('buildMessages', () => {
  it('attaches tool results to their tool calls', () => {
    const msgs = buildMessages(parseJsonl(read(SESSIONS.safari)).events)
    const tools = msgs
      .flatMap((m) => m.blocks)
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    expect(tools.length).toBeGreaterThan(4)
    expect(tools.every((t) => t.result !== undefined)).toBe(true)
    // No user bubble consisting only of tool results.
    expect(
      msgs
        .filter((m) => m.role === 'user')
        .every((m) => m.blocks.some((b) => b.type !== 'tool_result'))
    ).toBe(true)
    const grep = tools.find((t) => t.name === 'Grep')!
    expect(grep.label).toBe('Grep "session_token" in src')
  })

  it('merges consecutive lines of one assistant message', () => {
    const msgs = buildMessages(parseJsonl(read(SESSIONS.safari)).events)
    const thinking = msgs.find((m) => m.blocks.some((b) => b.type === 'thinking'))!
    expect(thinking.blocks.map((b) => b.type)).toEqual(['thinking', 'text'])
    const write = msgs.find((m) =>
      m.blocks.some((b) => b.type === 'tool_use' && b.name === 'Write')
    )!
    expect(write.blocks.map((b) => b.type)).toEqual(['text', 'tool_use'])
  })

  it('marks error results and keeps array results', () => {
    const msgs = buildMessages(parseJsonl(read(SESSIONS.orders)).events)
    const tools = msgs
      .flatMap((m) => m.blocks)
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    expect(tools.find((t) => t.label === 'Bash: go test ./...')!.result!.isError).toBe(true)
    expect(tools.find((t) => t.name === 'Task')!.result!.text).toContain('openapi.yaml')
    expect(tools.find((t) => t.name.startsWith('mcp__'))!.label).toBe('postgres · query')
  })

  it('renders commands, compaction and command output', () => {
    const msgs = buildMessages(parseJsonl(read(SESSIONS.dotfiles)).events)
    const kinds = msgs.map((m) => m.kind)
    expect(kinds).toContain('command')
    expect(kinds).toContain('compact')
    expect(kinds).toContain('command-output')
    expect(kinds).toContain('system')
    expect(msgs.find((m) => m.kind === 'command')!.blocks[0]).toEqual({
      type: 'text',
      text: '/init'
    })
    // isMeta caveat is hidden
    expect(JSON.stringify(msgs)).not.toContain('Caveat:')
  })

  it('skips sidechain events and keeps orphan tool results', () => {
    const msgs = buildMessages([
      { type: 'user', isSidechain: true, message: { content: 'sub-agent prompt' } },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }] }
      }
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'gone' })
  })
})

describe('classifyUserText', () => {
  it('classifies commands with args', () => {
    expect(
      classifyUserText('<command-name>/review</command-name><command-args>PR 12</command-args>')
    ).toEqual({
      kind: 'command',
      text: '/review PR 12'
    })
  })
  it('treats normal text as a prompt', () => {
    expect(classifyUserText('  fix the build  ')).toEqual({ kind: 'prompt', text: 'fix the build' })
  })
})
