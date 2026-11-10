// Running now for Codex (Phase D1): rollout events, /proc/locks, hook trust,
// and the states worked out from them (locks held, released, reused PIDs,
// the desktop app's unlocked threads, subagents, plugin and exec threads).

import { describe, expect, it } from 'vitest'
import {
  APPROVAL_GUESS_MS,
  computeCodexLive,
  emptyRollout,
  hooksFeatureOff,
  lockThreadId,
  parseHookTrust,
  parseProcLocks,
  reduceRollout,
  snakeEvent,
  splitLines,
  trustOf,
  UNLOCKED_ACTIVE_MS,
  UNLOCKED_IDLE_MS,
  type CodexLiveInputs,
  type CodexThreadInput,
  type RolloutState
} from '@shared/codex-live'
import { EXITED_KEEP_MS, stateLine, type HookEvent, type LiveSession } from '@shared/live'
import { alertVerdict, DEFAULT_LIVE_ALERTS, desktopText, detectAlerts } from '@shared/live-alerts'

const T0 = Date.parse('2026-11-08T20:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const line = (ms: number, type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: iso(ms), type, payload })
const started = (ms: number, turn = 'turn-1'): string =>
  line(ms, 'event_msg', { type: 'task_started', turn_id: turn, started_at: Math.floor(ms / 1000) })
const complete = (ms: number, turn = 'turn-1'): string =>
  line(ms, 'event_msg', {
    type: 'task_complete',
    turn_id: turn,
    completed_at: Math.floor(ms / 1000),
    last_agent_message: 'Done: the secret plan.'
  })
const aborted = (ms: number, reason: string, turn = 'turn-1'): string =>
  line(ms, 'event_msg', { type: 'turn_aborted', turn_id: turn, reason })
const escalated = (ms: number, id = 'call-1'): string =>
  line(ms, 'response_item', {
    type: 'function_call',
    name: 'exec_command',
    call_id: id,
    arguments: JSON.stringify({ cmd: 'npm publish', sandbox_permissions: 'require_escalated' })
  })
const output = (ms: number, id = 'call-1'): string =>
  line(ms, 'response_item', { type: 'function_call_output', call_id: id, output: 'ok' })

const roll = (...lines: string[]): RolloutState => reduceRollout(emptyRollout(), lines)

const TID = '019b0000-0000-7000-8000-00000000c0de'
const thread = (over: Partial<CodexThreadInput> = {}): CodexThreadInput => ({
  sourceId: 'codex-windows',
  env: 'windows',
  threadId: TID,
  held: true,
  heldSince: T0 - 60 * 60_000,
  rollout: roll(started(T0 - 60_000)),
  rolloutMtime: T0 - 60_000,
  info: { label: 'codex-cli', cwd: 'C:\\code\\app' },
  ...over
})
const inputs = (over: Partial<CodexLiveInputs> = {}): CodexLiveInputs => ({
  now: T0,
  threads: [thread()],
  events: [],
  exactApprovals: new Set(),
  seenWorking: new Set(),
  ...over
})
const one = (over: Partial<CodexLiveInputs> = {}): LiveSession | undefined =>
  computeCodexLive(inputs(over))[0]
const prevOf = (s: LiveSession[]): Map<string, LiveSession> => new Map(s.map((x) => [x.key, x]))

describe('rollout events', () => {
  it('tracks turns: started, completed, aborted', () => {
    const r = roll(started(T0), complete(T0 + 30_000))
    expect(r.open).toEqual({})
    expect(r.lastEnd).toBe('complete')
    expect(r.lastEndAt).toBe(Math.floor((T0 + 30_000) / 1000) * 1000)
    const a = roll(started(T0), aborted(T0 + 5000, 'interrupted'))
    expect(a.lastEnd).toBe('aborted')
    expect(a.abortReason).toBe('interrupted')
    expect(roll(started(T0)).open).toEqual({ 'turn-1': T0 })
  })

  it('keeps nested turns open until the last one ends', () => {
    const r = roll(started(T0, 'a'), started(T0 + 1000, 'b'), complete(T0 + 2000, 'b'))
    expect(Object.keys(r.open)).toEqual(['a'])
    reduceRollout(r, [complete(T0 + 3000, 'a')])
    expect(r.open).toEqual({})
  })

  it('knows which tool calls still wait for their output', () => {
    const r = roll(started(T0), escalated(T0 + 1000))
    expect(r.pending['call-1']).toMatchObject({ escalated: true, question: false })
    reduceRollout(r, [output(T0 + 9000)])
    expect(r.pending).toEqual({})
  })

  it('finds escalation inside a code-mode script and a direct question', () => {
    const script = line(T0, 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'c2',
      input:
        'const r = await tools.exec_command({cmd:"rm -rf dist", sandbox_permissions:"require_escalated"})'
    })
    const ask = line(T0, 'response_item', {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'c3',
      arguments: '{"questions":[]}'
    })
    const r = roll(started(T0 - 1), script, ask)
    expect(r.pending.c2).toMatchObject({ escalated: true, direct: false })
    expect(r.pending.c3).toMatchObject({ question: true, direct: true })
  })

  it('reads a huge tool call by pattern, without parsing it', () => {
    const big = line(T0, 'response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'huge',
      input: `/* ${'x'.repeat(400_000)} */ sandbox_permissions:"require_escalated"`
    })
    const r = roll(started(T0 - 1), big)
    expect(r.pending.huge?.escalated).toBe(true)
  })

  it('keeps the approval policy and never the text of prompts or replies', () => {
    const r = roll(
      line(T0, 'turn_context', { approval_policy: 'never', cwd: 'C:\\x' }),
      started(T0),
      complete(T0 + 1000)
    )
    expect(r.approvalPolicy).toBe('never')
    expect(JSON.stringify(r)).not.toMatch(/secret plan/)
  })

  it('skips broken and foreign lines', () => {
    const r = roll('not json', '{"broken', '', started(T0), '{"type":"event_msg"}')
    expect(r.open).toEqual({ 'turn-1': T0 })
  })

  it('splits chunks into whole lines, keeping the unfinished rest', () => {
    expect(splitLines('a\nb\r\nc', '')).toEqual({ lines: ['a', 'b'], rest: 'c' })
    expect(splitLines('d\n', 'c')).toEqual({ lines: ['cd'], rest: '' })
    expect(splitLines('no end', 'x')).toEqual({ lines: [], rest: 'xno end' })
  })
})

describe('/proc/locks and lock files', () => {
  const PROC = [
    '3: FLOCK  ADVISORY  WRITE 372 00:3d:800 0 EOF',
    '5: POSIX  ADVISORY  READ 51234 08:30:1715 128 128',
    '7: FLOCK  ADVISORY  READ 69593 08:30:734223 0 EOF',
    '17: FLOCK  ADVISORY  WRITE 51234 08:30:4711001 0 EOF',
    '17: -> FLOCK  ADVISORY  WRITE 70000 08:30:4711001 0 EOF',
    'garbage'
  ].join('\n')

  it('keeps only exclusive flocks, with holder, device and inode', () => {
    expect(parseProcLocks(PROC)).toEqual([
      { pid: 372, dev: '00:3d', inode: '800' },
      { pid: 51234, dev: '08:30', inode: '4711001' }
    ])
  })

  it('takes thread ids only from lock files named after one', () => {
    expect(lockThreadId(`${TID}.lock`)).toBe(TID)
    expect(lockThreadId(`${TID.toUpperCase()}.lock`)).toBe(TID)
    expect(lockThreadId('.coordination.lock')).toBeUndefined()
    expect(lockThreadId('auth.lock')).toBeUndefined()
  })
})

describe('Codex states', () => {
  it('a held lock with an open turn is Working, since the turn started', () => {
    const s = one()!
    expect(s).toMatchObject({
      key: `codex-windows:${TID}`,
      provider: 'codex',
      state: 'working',
      since: T0 - 60_000,
      startedAt: T0 - 60 * 60_000,
      lockHeld: true,
      basis: 'rollout'
    })
    expect(s.unverified).toBeUndefined()
  })

  it('a held lock after the turn ended is Waiting for you, since it ended', () => {
    const s = one({
      threads: [thread({ rollout: roll(started(T0 - 90_000), complete(T0 - 30_000)) })]
    })
    expect(s).toMatchObject({ state: 'idle', since: Math.floor((T0 - 30_000) / 1000) * 1000 })
    expect(s?.failed).toBeUndefined()
  })

  it('a turn stopped for another reason than an interrupt is a failure', () => {
    const s = one({
      threads: [thread({ rollout: roll(started(T0 - 9000), aborted(T0 - 5000, 'model_error')) })]
    })
    expect(s).toMatchObject({ state: 'idle', failed: true, detail: 'Stopped: model error' })
    const i = one({
      threads: [thread({ rollout: roll(started(T0 - 9000), aborted(T0 - 5000, 'interrupted')) })]
    })
    expect(i?.failed).toBeUndefined()
  })

  it('ignores turns from a run before the lock was taken (a crash, then resume)', () => {
    // Started before this holder took the lock and never ended: an earlier run's.
    const s = one({
      threads: [
        thread({
          heldSince: T0 - 10_000,
          rollout: roll(started(T0 - 5 * 60_000, 'old'), escalated(T0 - 4 * 60_000))
        })
      ]
    })
    expect(s?.state).toBe('idle')
    expect(s?.guess).toBeUndefined()
  })

  it('guesses "needs approval" from an escalated command left waiting', () => {
    const r = roll(started(T0 - 60_000), escalated(T0 - APPROVAL_GUESS_MS - 1))
    const s = one({ threads: [thread({ rollout: r })] })
    expect(s).toMatchObject({ state: 'approval', guess: true, since: T0 - APPROVAL_GUESS_MS - 1 })
    expect(stateLine(s!, T0, () => '2:00 PM')).toBe('Probably needs approval since 2:00 PM')
    // Too fresh: just running.
    const fresh = roll(started(T0 - 60_000), escalated(T0 - 1000))
    expect(one({ threads: [thread({ rollout: fresh })] })?.state).toBe('working')
    // Answered: the output arrived.
    reduceRollout(r, [output(T0 - 100)])
    expect(one({ threads: [thread({ rollout: r })] })?.state).toBe('working')
  })

  it('never guesses when approvals are off ("never") or the hook gives exact ones', () => {
    const r = roll(
      line(T0 - 70_000, 'turn_context', { approval_policy: 'never' }),
      started(T0 - 60_000),
      escalated(T0 - 30_000)
    )
    expect(one({ threads: [thread({ rollout: r })] })?.state).toBe('working')
    const r2 = roll(started(T0 - 60_000), escalated(T0 - 30_000))
    expect(
      one({ threads: [thread({ rollout: r2 })], exactApprovals: new Set(['codex-windows']) })?.state
    ).toBe('working')
  })

  it('a question for the user waits for you', () => {
    const ask = line(T0 - 5000, 'response_item', {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'q',
      arguments: '{}'
    })
    const s = one({ threads: [thread({ rollout: roll(started(T0 - 60_000), ask) })] })
    expect(s).toMatchObject({ state: 'approval', detail: 'Asked you a question' })
    expect(s?.guess).toBeUndefined()
  })

  it('takes "needs approval" from the hook until the rollout moves on', () => {
    const r = roll(started(T0 - 60_000), escalated(T0 - 3000))
    const hook: HookEvent = {
      ts: T0 - 2000,
      source: 'codex-windows',
      event: 'PermissionRequest',
      sessionId: TID,
      toolName: 'Bash'
    }
    const s = one({ threads: [thread({ rollout: r })], events: [hook] })
    expect(s).toMatchObject({ state: 'approval', detail: 'Wants to use Bash', basis: 'hook' })
    expect(s?.guess).toBeUndefined()
    // Approved: the command's output (and more) came after.
    reduceRollout(r, [output(T0 - 500)])
    expect(one({ threads: [thread({ rollout: r })], events: [hook] })?.state).toBe('working')
    // A PermissionRequest from an earlier turn doesn't count.
    const later = roll(started(T0 - 1000, 't2'))
    expect(
      one({ threads: [thread({ rollout: later })], events: [{ ...hook, ts: T0 - 50_000 }] })?.state
    ).toBe('working')
  })

  it('a lock released after the app saw it held is Exited, kept a while, then dropped', () => {
    const first = computeCodexLive(inputs())
    const gone = computeCodexLive(
      inputs({ now: T0 + 5000, threads: [thread({ held: false })], prev: prevOf(first) })
    )
    expect(gone[0]).toMatchObject({ state: 'exited', since: T0 + 5000, basis: 'lock' })
    const still = computeCodexLive(
      inputs({ now: T0 + 60_000, threads: [thread({ held: false })], prev: prevOf(gone) })
    )
    expect(still[0]?.state).toBe('exited')
    const later = computeCodexLive(
      inputs({
        now: T0 + 5000 + EXITED_KEEP_MS + 1,
        threads: [thread({ held: false, rolloutMtime: T0 - 60 * 60_000 })],
        prev: prevOf(still)
      })
    )
    expect(later).toEqual([])
  })

  it('a free lock found at startup is not shown (it ended before the app looked)', () => {
    expect(
      computeCodexLive(
        inputs({
          threads: [
            thread({
              held: false,
              rollout: roll(started(T0 - 3 * 60 * 60_000), complete(T0 - 2 * 60 * 60_000)),
              rolloutMtime: T0 - 2 * 60 * 60_000
            })
          ]
        })
      )
    ).toEqual([])
  })

  it('a dead PID or a reused one can never keep a thread open: only the lock counts', () => {
    // The reader reports a lock held only while the kernel holds it for a Codex
    // process; here the PID is gone (no lock line) or belongs to another program now.
    const first = computeCodexLive(inputs({ threads: [thread({ env: 'wsl', pid: 4242 })] }))
    expect(first[0]).toMatchObject({ state: 'working', pid: 4242 })
    const reused = computeCodexLive(
      inputs({
        now: T0 + 5000,
        threads: [thread({ env: 'wsl', held: false, pid: undefined })],
        prev: prevOf(first)
      })
    )
    expect(reused[0]).toMatchObject({ state: 'exited' })
    expect(reused[0].pid).toBeUndefined()
  })

  it('a lock that can’t be checked (WSL /proc unreadable) shows only fresh work, unconfirmed', () => {
    const s = one({ threads: [thread({ env: 'wsl', held: undefined })] })
    expect(s).toMatchObject({ state: 'working', unverified: true })
    expect(
      one({
        threads: [
          thread({
            held: undefined,
            rollout: roll(started(T0 - 2 * UNLOCKED_ACTIVE_MS)),
            rolloutMtime: T0 - 2 * UNLOCKED_ACTIVE_MS
          })
        ]
      })
    ).toBeUndefined()
  })

  it('a thread the desktop app runs without a lock: working while active, then waiting a while', () => {
    const desktop = { label: 'codex-desktop', cwd: 'C:\\code\\app' }
    const w = computeCodexLive(
      inputs({ threads: [thread({ held: false, heldSince: undefined, info: desktop })] })
    )
    expect(w[0]).toMatchObject({ state: 'working', unverified: true })
    const seen = new Set([w[0].key])
    const done = roll(started(T0 - 60_000), complete(T0 + 10_000))
    const d = computeCodexLive(
      inputs({
        now: T0 + 12_000,
        threads: [thread({ held: false, heldSince: undefined, info: desktop, rollout: done })],
        prev: prevOf(w),
        seenWorking: seen
      })
    )
    expect(d[0]).toMatchObject({ state: 'idle', unverified: true })
    // The "finished" alert comes from that change.
    expect(detectAlerts(prevOf(w), d).map((a) => a.kind)).toEqual(['finished'])
    // Long after, it's gone (Codex ends idle threads after 30 minutes).
    expect(
      computeCodexLive(
        inputs({
          now: T0 + 10_000 + UNLOCKED_IDLE_MS + 1000,
          threads: [thread({ held: false, heldSince: undefined, info: desktop, rollout: done })],
          prev: prevOf(d),
          seenWorking: seen
        })
      )
    ).toEqual([])
  })

  it('Claude Code’s Codex plugin and codex exec threads show only while they work', () => {
    for (const label of ['codex-claude-code', 'codex-exec']) {
      expect(one({ threads: [thread({ info: { label } })] })?.state).toBe('working')
      const idle = roll(started(T0 - 9000), complete(T0 - 5000))
      expect(one({ threads: [thread({ info: { label }, rollout: idle })] })).toBeUndefined()
    }
  })

  it('subagents never get a row: their parent shows their work and their approvals', () => {
    const PARENT = '019b0000-0000-7000-8000-0000000000c3'
    const SUB = '019b0000-0000-7000-8000-0000000000d4'
    const idle = roll(started(T0 - 90_000, 'p'), complete(T0 - 60_000, 'p'))
    const parent = thread({ threadId: PARENT, rollout: idle })
    const sub = thread({ threadId: SUB, info: { label: 'codex-subagent', parentId: PARENT } })
    const rows = computeCodexLive(inputs({ threads: [parent, sub] }))
    expect(rows.map((r) => r.sessionId)).toEqual([PARENT])
    expect(rows[0]).toMatchObject({ state: 'working', detail: 'A subagent is working' })
    const asking = thread({
      threadId: SUB,
      info: { label: 'codex-subagent', parentId: PARENT },
      rollout: roll(started(T0 - 60_000), escalated(T0 - 30_000))
    })
    const r2 = computeCodexLive(inputs({ threads: [parent, asking] }))
    expect(r2).toHaveLength(1)
    expect(r2[0]).toMatchObject({ state: 'approval', guess: true })
    expect(r2[0].detail).toMatch(/^A subagent:/)
    // A finished subagent changes nothing.
    const done = thread({
      threadId: SUB,
      info: { label: 'codex-subagent', parentId: PARENT },
      rollout: idle
    })
    expect(computeCodexLive(inputs({ threads: [parent, done] }))[0].state).toBe('idle')
  })

  it('a resumed thread waits since it was resumed, not since its last turn long ago', () => {
    const s = one({
      threads: [
        thread({
          heldSince: T0 - 5 * 60_000,
          rollout: roll(started(T0 - 40 * 864e5), complete(T0 - 40 * 864e5 + 60_000))
        })
      ]
    })
    expect(s).toMatchObject({ state: 'idle', since: T0 - 5 * 60_000 })
  })

  it('VS Code’s and the desktop app’s idle threads show only for a while after their last turn', () => {
    for (const label of ['codex-vscode', 'codex-desktop']) {
      const recent = roll(started(T0 - 9 * 60_000), complete(T0 - 8 * 60_000))
      expect(
        one({
          threads: [thread({ heldSince: T0 - 60 * 60_000, info: { label }, rollout: recent })]
        })?.state
      ).toBe('idle')
      const old = roll(started(T0 - 3 * 864e5), complete(T0 - 3 * 864e5 + 1000))
      expect(
        one({ threads: [thread({ heldSince: T0 - 7 * 864e5, info: { label }, rollout: old })] })
      ).toBeUndefined()
      // A TUI thread stays while its terminal has it open.
      expect(
        one({
          threads: [
            thread({ heldSince: T0 - 7 * 864e5, info: { label: 'codex-cli' }, rollout: old })
          ]
        })?.state
      ).toBe('idle')
    }
  })

  it('a long turn read only in part is working while its lines are fresh', () => {
    const r = roll(line(T0 - 10_000, 'event_msg', { type: 'token_count' }))
    r.partial = true
    r.lastLineAt = T0 - 10_000
    expect(one({ threads: [thread({ rollout: r })] })).toMatchObject({
      state: 'working',
      basis: 'activity'
    })
    r.lastLineAt = T0 - 10 * 60_000
    expect(one({ threads: [thread({ rollout: r })] })?.state).toBe('idle')
  })

  it('keeps "since" across polls while the state stays the same', () => {
    const a = computeCodexLive(
      inputs({ threads: [thread({ rollout: roll(started(T0 - 60_000)) })] })
    )
    const b = computeCodexLive(
      inputs({
        now: T0 + 2000,
        threads: [thread({ rollout: roll(started(T0 - 30_000)) })],
        prev: prevOf(a)
      })
    )
    expect(b[0].since).toBe(T0 - 60_000)
  })
})

describe('alerts for Codex sessions follow the same rules', () => {
  const base = computeCodexLive(inputs())
  const settings = { ...DEFAULT_LIVE_ALERTS, minWorkSec: 0 }
  const ctx = { now: T0, muted: () => false, localTime: () => new Date(2026, 10, 8, 12, 0) }

  it('finished, approval (also a guessed one) and exited', () => {
    const done = computeCodexLive(
      inputs({
        now: T0 + 1000,
        threads: [thread({ rollout: roll(started(T0 - 60_000), complete(T0 + 500)) })],
        prev: prevOf(base)
      })
    )
    expect(detectAlerts(prevOf(base), done).map((a) => a.kind)).toEqual(['finished'])
    const asks = computeCodexLive(
      inputs({
        threads: [thread({ rollout: roll(started(T0 - 60_000), escalated(T0 - 10_000)) })],
        prev: prevOf(base)
      })
    )
    const [a] = detectAlerts(prevOf(base), asks)
    expect(a.kind).toBe('approval')
    expect(desktopText(a, 'Checkout').title).toBe('Probably needs your approval')
    expect(alertVerdict(a, settings, ctx)).toEqual({ show: true, desktop: true, phone: true })
    const gone = computeCodexLive(
      inputs({ now: T0 + 3000, threads: [thread({ held: false })], prev: prevOf(base) })
    )
    expect(detectAlerts(prevOf(base), gone).map((x) => x.kind)).toEqual(['exited'])
  })

  it('mute, quiet hours and the cooldown apply as for Claude Code', () => {
    const asks = computeCodexLive(
      inputs({
        threads: [thread({ rollout: roll(started(T0 - 60_000), escalated(T0 - 10_000)) })],
        prev: prevOf(base)
      })
    )
    const [a] = detectAlerts(prevOf(base), asks)
    expect(alertVerdict(a, settings, { ...ctx, muted: () => true })).toEqual({
      show: false,
      why: 'muted'
    })
    expect(
      alertVerdict(
        a,
        {
          ...settings,
          quiet: { enabled: true, from: '00:00', to: '23:59', allowApprovals: false }
        },
        ctx
      )
    ).toEqual({ show: false, why: 'quiet' })
    expect(alertVerdict(a, settings, { ...ctx, lastShown: () => T0 - 1000 })).toEqual({
      show: false,
      why: 'repeat'
    })
  })

  it('never sends Claude Code’s "still waiting" reminder for Codex', () => {
    const idle = computeCodexLive(
      inputs({ threads: [thread({ rollout: roll(started(T0 - 9000), complete(T0 - 1000)) })] })
    )
    // No idle reminders exist for Codex: nothing in idlePrompts names it.
    expect(detectAlerts(prevOf(idle), idle, new Set())).toEqual([])
  })
})

describe('hook trust (config.toml, read only)', () => {
  const TOML = [
    'model = "gpt"',
    '[features]',
    'hooks = true',
    '',
    '[hooks.state]',
    '',
    "[hooks.state.'C:\\Users\\alex\\.codex\\hooks.json:session_start:0:0']",
    'trusted_hash = "sha256:b29a"',
    '',
    "[hooks.state.'C:\\Users\\alex\\.codex\\hooks.json:permission_request:1:0']",
    'trusted_hash = "sha256:aaaa" # trusted in /hooks',
    '',
    '[hooks.state."/home/alex/.codex/hooks.json:permission_request:0:0"]',
    'enabled = false',
    'trusted_hash = "sha256:bbbb"',
    '[tui]',
    'trusted_hash = "not a hook"'
  ].join('\n')

  it('reads the trust tables and nothing else', () => {
    expect(parseHookTrust(TOML)).toEqual([
      {
        key: 'C:\\Users\\alex\\.codex\\hooks.json:session_start:0:0',
        trusted: true,
        hash: 'sha256:b29a',
        disabled: false
      },
      {
        key: 'C:\\Users\\alex\\.codex\\hooks.json:permission_request:1:0',
        trusted: true,
        hash: 'sha256:aaaa',
        disabled: false
      },
      {
        key: '/home/alex/.codex/hooks.json:permission_request:0:0',
        trusted: true,
        hash: 'sha256:bbbb',
        disabled: true
      }
    ])
  })

  const at = (hooksPath: string, group: number, windows: boolean) => ({
    hooksPath,
    event: 'PermissionRequest',
    group,
    handler: 0,
    windows
  })

  it('finds the trust of a handler by its position (Windows paths in any case and slash)', () => {
    const e = parseHookTrust(TOML)
    expect(trustOf(e, at('c:/users/alex/.codex/hooks.json', 1, true))).toBe('trusted')
    expect(trustOf(e, at('C:\\Users\\alex\\.codex\\hooks.json', 0, true))).toBe('untrusted')
    expect(trustOf(e, at('/home/alex/.codex/hooks.json', 0, false))).toBe('disabled')
    expect(trustOf([], at('/x/hooks.json', 0, false))).toBe('untrusted')
  })

  it('an entry left by an older hook at the same position doesn’t count', () => {
    const e = parseHookTrust(TOML)
    const where = at('C:\\Users\\alex\\.codex\\hooks.json', 1, true)
    // The same hash as before the app added its hook: stale.
    expect(trustOf(e, where, { priorHash: 'sha256:aaaa' })).toBe('untrusted')
    // A new hash since (Codex wrote it when the hook was trusted).
    expect(trustOf(e, where, { priorHash: 'sha256:old' })).toBe('trusted')
    // config.toml not saved since the install: whatever is there is older.
    expect(trustOf(e, where, { installedAt: 2000, configSavedAt: 1000 })).toBe('untrusted')
    expect(trustOf(e, where, { installedAt: 2000, configSavedAt: 3000 })).toBe('trusted')
  })

  it('spots hooks turned off', () => {
    expect(hooksFeatureOff(TOML)).toBe(false)
    expect(hooksFeatureOff('[features]\nhooks = false\n')).toBe(true)
    expect(hooksFeatureOff('features.codex_hooks = false\n')).toBe(true)
    expect(hooksFeatureOff('[other]\nhooks = false\n')).toBe(false)
  })

  it('names events the way Codex does', () => {
    expect(snakeEvent('PermissionRequest')).toBe('permission_request')
    expect(snakeEvent('SessionStart')).toBe('session_start')
  })
})
