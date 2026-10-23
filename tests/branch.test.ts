import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { branchName, buildBranchFile, planBranch, type BranchPlanOk } from '@shared/branch'
import { analyzeEvents, buildMessages, parseJsonl, type RawEvent } from '@shared/jsonl'
import { FIXTURES, read } from './helpers'

const PARENT = '11111111-1111-4111-8111-111111111111'
const NEW_ID = '22222222-2222-4222-8222-222222222222'

/** Builds a session the way Claude Code writes it: one line per content block. */
class S {
  events: RawEvent[] = []
  private parent: string | null = null
  private t = Date.parse('2026-10-01T10:00:00.000Z')
  constructor(private readonly id = PARENT) {}
  private base(type: string, uuid: string, extra: RawEvent = {}): RawEvent {
    this.t += 5000
    const e: RawEvent = {
      parentUuid: this.parent,
      isSidechain: false,
      cwd: 'C:\\code\\app',
      sessionId: this.id,
      type,
      uuid,
      timestamp: new Date(this.t).toISOString(),
      ...extra
    }
    this.parent = uuid
    this.events.push(e)
    return e
  }
  raw(e: RawEvent): this {
    this.events.push(e)
    return this
  }
  user(uuid: string, text: string): this {
    this.base('user', uuid, { message: { role: 'user', content: text } })
    return this
  }
  results(uuid: string, ...ids: string[]): this {
    this.base('user', uuid, {
      message: {
        role: 'user',
        content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' }))
      }
    })
    return this
  }
  /** One API response: each block on its own line, sharing the message id. */
  say(msgId: string, blocks: [string, Record<string, unknown>][]): this {
    for (const [uuid, block] of blocks) {
      this.base('assistant', uuid, {
        message: { id: msgId, role: 'assistant', model: 'claude-opus-4-5', content: [block] }
      })
    }
    return this
  }
}

const text = (t: string) => ({ type: 'text', text: t })
const tool = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} })

/** The main sample: parallel tool calls, a summary, a snapshot and a custom title. */
function sample(): RawEvent[] {
  const s = new S()
  s.raw({ type: 'summary', summary: 'Fixing the login bug', leafUuid: 'u2' })
  s.raw({ type: 'file-history-snapshot', messageId: 'u1', snapshot: {} })
  s.user('u1', 'Fix the login bug')
  s.say('msg_1', [
    ['a1', text('Let me look.')],
    ['a2', tool('t1', 'Read')],
    ['a3', tool('t2', 'Grep')]
  ])
  s.results('r1', 't1')
  s.results('r2', 't2')
  s.say('msg_2', [
    ['a4', text('Found it.')],
    ['a5', tool('t3', 'Edit')]
  ])
  s.results('r3', 't3')
  s.say('msg_3', [['a6', text('Done. The cookie path was wrong.')]])
  s.raw({ type: 'custom-title', customTitle: 'Login bug', sessionId: PARENT })
  s.user('u2', 'Now add a test')
  s.say('msg_4', [['a7', tool('t4', 'Bash')]])
  return s.events
}

const ok = (p: ReturnType<typeof planBranch>): BranchPlanOk => {
  if (!p.ok) throw new Error(p.error)
  return p
}

/** True if a cut after `end` keeps a tool call whose result comes after the cut. */
function splitsToolCall(events: RawEvent[], end: number): boolean {
  const results = new Map<string, number>()
  events.forEach((e, i) => {
    const c = (e.message as { content?: unknown } | undefined)?.content
    if (e.type === 'user' && Array.isArray(c))
      for (const b of c)
        if (b.type === 'tool_result' && !results.has(b.tool_use_id)) results.set(b.tool_use_id, i)
  })
  return events.slice(0, end + 1).some((e) => {
    const c = (e.message as { content?: unknown } | undefined)?.content
    return (
      e.type === 'assistant' &&
      e.isSidechain !== true &&
      Array.isArray(c) &&
      c.some((b) => b.type === 'tool_use' && (results.get(b.id) ?? -1) > end)
    )
  })
}

describe('planBranch: cutting at a message', () => {
  const events = sample()
  const idx = (uuid: string) => events.findIndex((e) => e.uuid === uuid)

  it('cuts right after a plain assistant message', () => {
    const p = ok(planBranch(events, 'a6'))
    expect(p.endIndex).toBe(idx('a6'))
    expect(p).toMatchObject({
      snapped: 'none',
      atMessageId: 'a6',
      atRole: 'assistant',
      atPreview: 'Done. The cookie path was wrong.',
      keptMessages: 4,
      totalMessages: 6
    })
  })

  it('keeps a user message and nothing after it', () => {
    const p = ok(planBranch(events, 'u2'))
    expect(p.endIndex).toBe(idx('u2'))
    expect(p).toMatchObject({ atRole: 'user', atMessageId: 'u2', snapped: 'none' })
  })

  it('"before" keeps only what came before the message', () => {
    const p = ok(planBranch(events, 'u2', 'before'))
    expect(p.endIndex).toBe(idx('a6'))
    expect(p.atMessageId).toBe('a6')
    expect(p.snapped).toBe('none')
    const first = planBranch(events, 'u1', 'before')
    expect(first.ok).toBe(false)
  })

  it('returns an error for an unknown message', () => {
    expect(planBranch(events, 'nope').ok).toBe(false)
  })
})

describe('planBranch: never splits a tool call from its result', () => {
  const events = sample()
  const idx = (uuid: string) => events.findIndex((e) => e.uuid === uuid)

  it('pulls in the results of parallel tool calls (forward)', () => {
    const p = ok(planBranch(events, 'a1'))
    expect(p.endIndex).toBe(idx('r2'))
    expect(p.snapped).toBe('forward')
    expect(p.snapTools.sort()).toEqual(['Grep', 'Read'])
    expect(p.atMessageId).toBe('a1')
  })

  it('pulls in a single tool result', () => {
    const p = ok(planBranch(events, 'a4'))
    expect(p.endIndex).toBe(idx('r3'))
    expect(p).toMatchObject({ snapped: 'forward', snapTools: ['Edit'] })
  })

  it('leaves a call that never got a result alone (nothing to split)', () => {
    const p = ok(planBranch(events, 'a7'))
    expect(p.endIndex).toBe(idx('a7'))
    expect(p.snapped).toBe('none')
  })

  it('moves back to the last safe point when the result comes after a new prompt', () => {
    const s = new S()
    s.user('u1', 'Run the tests')
    s.say('m1', [['a1', text('Running them.')]])
    s.user('u2', 'Also lint')
    s.say('m2', [['a2', tool('t1', 'Bash')]])
    s.user('u3', 'Actually, stop') // the user typed before the result arrived
    s.results('r1', 't1')
    const p = ok(planBranch(s.events, 'a2'))
    expect(p.snapped).toBe('backward')
    expect(p.snapTools).toEqual(['Bash'])
    expect(p.endIndex).toBe(s.events.findIndex((e) => e.uuid === 'u2'))
    expect(p.atMessageId).toBe('u2')
  })

  it('never splits, for every message of every fixture session, in both modes', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (n.endsWith('.jsonl')) files.push(p)
      }
    }
    walk(join(FIXTURES, 'windows'))
    walk(join(FIXTURES, 'wsl'))
    walk(join(FIXTURES, 'archived'))
    const all = [{ name: 'sample', events: sample() }].concat(
      files.map((f) => ({ name: f, events: parseJsonl(read(f)).events }))
    )
    let checked = 0
    for (const { events: ev } of all) {
      for (const m of buildMessages(ev)) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        for (const mode of ['include', 'before'] as const) {
          const p = planBranch(ev, m.id, mode)
          if (!p.ok) continue
          expect(splitsToolCall(ev, p.endIndex)).toBe(false)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(50)
  })
})

describe('buildBranchFile: new session id', () => {
  const events = sample()

  it('copies the lines up to the cut with the new session id and a forkedFrom marker', () => {
    const p = ok(planBranch(events, 'a6'))
    const out = buildBranchFile(events, p, NEW_ID, PARENT)
    const lines = out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as RawEvent)
    // Summary pointed past the cut, the custom title comes after it.
    expect(lines.some((e) => e.type === 'summary')).toBe(false)
    expect(lines.some((e) => e.type === 'custom-title')).toBe(false)
    expect(lines[0]).toMatchObject({ type: 'file-history-snapshot', messageId: 'u1' })
    const chain = lines.filter((e) => e.uuid)
    expect(chain.map((e) => e.uuid)).toEqual([
      'u1',
      'a1',
      'a2',
      'a3',
      'r1',
      'r2',
      'a4',
      'a5',
      'r3',
      'a6'
    ])
    for (const e of chain) {
      expect(e.sessionId).toBe(NEW_ID)
      expect(e.forkedFrom).toEqual({ sessionId: PARENT, messageUuid: e.uuid })
    }
    // Everything else is unchanged.
    const orig = events.find((e) => e.uuid === 'a4')!
    const copy = chain.find((e) => e.uuid === 'a4')!
    expect({ ...copy, sessionId: orig.sessionId, forkedFrom: undefined }).toEqual({
      ...orig,
      forkedFrom: undefined
    })
    expect(out.endsWith('\n')).toBe(true)
    // The parent's id only appears in the forkedFrom markers.
    expect(out.split(PARENT).length - 1).toBe(chain.length)
  })

  it('reads back as a branch of the parent, ending at the chosen message', () => {
    const p = ok(planBranch(events, 'a4'))
    const out = buildBranchFile(events, p, NEW_ID, PARENT)
    const parsed = parseJsonl(out)
    expect(parsed.malformedLines).toBe(0)
    const a = analyzeEvents(parsed.events)
    expect(a.sessionId).toBe(NEW_ID)
    expect(a.firstUuid).toBe('u1')
    expect(a.forkedFrom).toEqual({ sessionId: PARENT, messageUuid: 'r3', messageId: 'a4' })
    const msgs = buildMessages(parsed.events)
    expect(msgs.at(-1)?.id).toBe('a4')
    // The Edit call kept its result.
    const edit = msgs.at(-1)!.blocks.find((b) => b.type === 'tool_use')
    expect(edit && edit.type === 'tool_use' && edit.result?.text).toBe('ok')
  })

  it('replaces snake_case session ids and keeps the summary when its leaf is kept', () => {
    const s = new S()
    s.raw({ type: 'summary', summary: 'Kept', leafUuid: 'u1' })
    s.user('u1', 'hi')
    s.raw({ type: 'queue-operation', session_id: PARENT })
    s.say('m', [['a1', text('hello')]])
    const out = buildBranchFile(s.events, ok(planBranch(s.events, 'a1')), NEW_ID, PARENT)
    expect(out).toContain('"summary":"Kept"')
    expect(out).toContain(`"session_id":"${NEW_ID}"`)
    expect(out).not.toContain(`"session_id":"${PARENT}"`)
  })

  it('refuses an invalid new session id', () => {
    const p = ok(planBranch(events, 'a6'))
    expect(() => buildBranchFile(events, p, '../../evil', PARENT)).toThrow(/Invalid/)
    expect(() => buildBranchFile(events, p, 'not-a-uuid', PARENT)).toThrow(/Invalid/)
  })
})

describe('branchName', () => {
  it('appends "— branch" and numbers duplicates', () => {
    expect(branchName('Safari login loop', [])).toBe('Safari login loop — branch')
    expect(branchName('Safari login loop', ['Safari login loop — branch'])).toBe(
      'Safari login loop — branch 2'
    )
    expect(branchName('X', ['x — branch', 'X — branch 2'])).toBe('X — branch 3')
    expect(branchName('  ', [])).toBe('Session — branch')
  })
})
