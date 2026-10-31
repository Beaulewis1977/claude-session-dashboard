// Running now: parsing hook payloads and running-session files, and working
// out each session's state (dead PIDs, stale files, crashed sessions).

import { describe, expect, it } from 'vitest'
import {
  computeLive,
  EXITED_KEEP_MS,
  HOOK_ONLY_MAX_MS,
  hookSignal,
  liveOrder,
  parseHookEvent,
  parseRunningFile,
  remoteUrlOf,
  stateLine,
  type HookEvent,
  type LiveInputs,
  type LiveSession,
  type ProcInput,
  type RunningFile
} from '@shared/live'

const meta = { ts: 1_000_000, source: 'windows' }
const SID = '6947c311-1bb3-4621-8da0-582984121410'

describe('hook payloads', () => {
  it('reads the documented fields of each event', () => {
    expect(
      parseHookEvent(
        JSON.stringify({
          session_id: SID,
          transcript_path: 'C:/x.jsonl',
          cwd: 'C:\\code\\app',
          hook_event_name: 'Notification',
          message: 'Claude needs your permission to use Bash',
          title: 'Permission needed',
          notification_type: 'permission_prompt'
        }),
        meta
      )
    ).toEqual({
      ts: 1_000_000,
      source: 'windows',
      event: 'Notification',
      sessionId: SID,
      cwd: 'C:\\code\\app',
      notificationType: 'permission_prompt',
      message: 'Claude needs your permission to use Bash'
    })
    expect(
      parseHookEvent(
        {
          session_id: 's1',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf x' }
        },
        meta
      )
    ).toMatchObject({ event: 'PermissionRequest', toolName: 'Bash' })
    expect(
      parseHookEvent(
        { session_id: 's1', hook_event_name: 'SessionStart', source: 'resume', model: 'x' },
        meta
      )
    ).toMatchObject({ startSource: 'resume' })
    expect(
      parseHookEvent(
        { session_id: 's1', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
        meta
      )
    ).toMatchObject({ reason: 'prompt_input_exit' })
    expect(
      parseHookEvent(
        { session_id: 's1', hook_event_name: 'StopFailure', error_type: 'rate_limit' },
        meta
      )
    ).toMatchObject({ error: 'rate_limit' })
  })

  it('never keeps prompts, replies or tool input', () => {
    const e = parseHookEvent(
      {
        session_id: 's1',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'my secret plan',
        session_title: 'Checkout'
      },
      meta
    )!
    expect(JSON.stringify(e)).not.toContain('secret')
    expect(e.sessionTitle).toBe('Checkout')
    const stop = parseHookEvent(
      {
        session_id: 's1',
        hook_event_name: 'Stop',
        last_assistant_message: 'All done, here is the key…'
      },
      meta
    )!
    expect(JSON.stringify(stop)).not.toContain('key')
  })

  it('skips malformed and unsafe payloads, tolerates a BOM and long text', () => {
    expect(parseHookEvent('not json', meta)).toBeUndefined()
    expect(parseHookEvent('[1]', meta)).toBeUndefined()
    expect(parseHookEvent('{"hook_event_name":"Stop"}', meta)).toBeUndefined()
    expect(
      parseHookEvent('{"session_id":"../../x","hook_event_name":"Stop"}', meta)
    ).toBeUndefined()
    expect(parseHookEvent('{"session_id":"s","hook_event_name":"a b"}', meta)).toBeUndefined()
    expect(parseHookEvent('\uFEFF{"session_id":"s","hook_event_name":"Stop"}', meta)?.event).toBe(
      'Stop'
    )
    const long = parseHookEvent(
      { session_id: 's', hook_event_name: 'Notification', message: 'x'.repeat(5000) },
      meta
    )!
    expect(long.message!.length).toBeLessThanOrEqual(200)
  })
})

describe('running-session files', () => {
  it('reads new and old formats', () => {
    const now = parseRunningFile(
      JSON.stringify({
        pid: 102680,
        sessionId: SID,
        cwd: 'C:\\Users\\me\\proj',
        startedAt: 1793472298779,
        // Written as a bare number (past 2^53), like Claude Code does.
        procStart: '@PROCSTART@',
        version: '2.1.316',
        kind: 'interactive',
        entrypoint: 'cli',
        name: 'Checkout flow',
        status: 'waiting',
        waitingFor: 'dialog open',
        updatedAt: 1793473003126,
        statusUpdatedAt: 1793473003126,
        bridgeSessionId: 'session_01JQKwT8G2N3cG1z4xn9k1Fw',
        messagingSocketPath: '\\\\.\\pipe\\LOCAL\\x'
      }).replace('"@PROCSTART@"', '134379458977253282')
    )!
    expect(now).toMatchObject({
      pid: 102680,
      status: 'waiting',
      waitingFor: 'dialog open',
      bridgeSessionId: 'session_01JQKwT8G2N3cG1z4xn9k1Fw'
    })
    // A FILETIME is past 2^53, so JSON rounds it slightly; procs.ts allows a second's slack.
    expect(now.procStart).toMatch(/^1343794589772532\d\d$/)
    // Linux start time as a string; the oldest files have only three fields.
    expect(parseRunningFile('{"pid":5560,"sessionId":"s","procStart":"885630"}')?.procStart).toBe(
      '885630'
    )
    expect(
      parseRunningFile('{"pid":14082,"sessionId":"a118e88d","startedAt":1774401138267}')
    ).toEqual({
      pid: 14082,
      sessionId: 'a118e88d',
      startedAt: 1774401138267
    })
    expect(parseRunningFile('{"pid":0,"sessionId":"s"}')).toBeUndefined()
    expect(parseRunningFile('{"pid":-4,"sessionId":"s"}')).toBeUndefined()
    expect(parseRunningFile('{"pid":12}')).toBeUndefined()
    expect(
      parseRunningFile('{"pid":12,"sessionId":"s","bridgeSessionId":"javascript:x"}')
        ?.bridgeSessionId
    ).toBeUndefined()
  })

  it('builds the Remote Control link only from a real session id', () => {
    expect(remoteUrlOf('session_01JQKwT8G2N3cG1z4xn9k1Fw')).toBe(
      'https://claude.ai/code/session_01JQKwT8G2N3cG1z4xn9k1Fw'
    )
    expect(remoteUrlOf('session_x')).toBeUndefined()
    expect(remoteUrlOf(undefined)).toBeUndefined()
  })
})

// ------------------------------------------------------------------ state

const NOW = 2_000_000_000_000
const min = 60_000

function file(over: Partial<RunningFile> = {}): RunningFile {
  return {
    pid: 4242,
    sessionId: SID,
    cwd: 'C:\\code\\app',
    startedAt: NOW - 30 * min,
    status: 'busy',
    updatedAt: NOW - 1 * min,
    statusUpdatedAt: NOW - 1 * min,
    ...over
  }
}

function proc(over: Partial<ProcInput> = {}, f: Partial<RunningFile> = {}): ProcInput {
  return {
    sourceId: 'windows',
    env: 'windows',
    file: file(f),
    mtime: NOW - 1 * min,
    alive: true,
    ...over
  }
}

function ev(event: string, ago: number, extra: Partial<HookEvent> = {}): HookEvent {
  return { ts: NOW - ago, source: 'windows', event, sessionId: SID, ...extra }
}

function run(over: Partial<LiveInputs> = {}): LiveSession[] {
  return computeLive({
    now: NOW,
    procs: [],
    events: [],
    transcript: () => undefined,
    hooksOn: new Set(['windows']),
    sourceEnv: (id) => (id === 'windows' ? { env: 'windows' } : { env: 'wsl', distro: 'Ubuntu' }),
    ...over
  })
}

describe('session state', () => {
  it('maps Claude Code’s own status', () => {
    expect(run({ procs: [proc()] })[0]).toMatchObject({
      key: `windows:${SID}`,
      state: 'working',
      basis: 'status',
      since: NOW - min
    })
    expect(run({ procs: [proc({}, { status: 'idle' })] })[0].state).toBe('idle')
    expect(run({ procs: [proc({}, { status: 'shell' })] })[0]).toMatchObject({
      state: 'idle',
      background: true
    })
    expect(
      run({ procs: [proc({}, { status: 'waiting', waitingFor: 'dialog open' })] })[0]
    ).toMatchObject({
      state: 'approval',
      detail: undefined
    })
  })

  it('takes the detail from a matching hook, and the newest signal wins', () => {
    const waiting = proc({}, { status: 'waiting', statusUpdatedAt: NOW - 2 * min })
    const r = run({
      procs: [waiting],
      events: [
        ev('Notification', 2 * min - 3000, {
          notificationType: 'permission_prompt',
          message: 'Claude needs your permission to use Bash'
        })
      ]
    })[0]
    expect(r).toMatchObject({
      state: 'approval',
      detail: 'Claude needs your permission to use Bash'
    })
    // Approved: the status says busy again, newer than the notification.
    const busy = proc({}, { status: 'busy', statusUpdatedAt: NOW - 1 * min })
    expect(
      run({
        procs: [busy],
        events: [ev('Notification', 2 * min, { notificationType: 'permission_prompt' })]
      })[0].state
    ).toBe('working')
    // A Stop newer than an old "busy".
    const stale = proc({}, { status: 'busy', statusUpdatedAt: NOW - 5 * min })
    expect(run({ procs: [stale], events: [ev('Stop', 1 * min)] })[0]).toMatchObject({
      state: 'idle',
      basis: 'hook'
    })
    expect(
      run({ procs: [stale], events: [ev('StopFailure', 1 * min, { error: 'rate_limit' })] })[0]
    ).toMatchObject({
      state: 'idle',
      failed: true,
      detail: 'Stopped: rate_limit'
    })
  })

  it('drops stale files of dead processes and shows a recent crash as Exited', () => {
    // Left behind three days ago.
    expect(
      run({
        procs: [
          proc(
            { alive: false, mtime: NOW - 3 * 1440 * min },
            {
              updatedAt: NOW - 3 * 1440 * min,
              statusUpdatedAt: NOW - 3 * 1440 * min,
              startedAt: NOW - 3 * 1440 * min
            }
          )
        ]
      })
    ).toEqual([])
    // Crashed (no SessionEnd) five minutes ago, found dead at startup.
    const crashed = proc(
      { alive: false, mtime: NOW - 5 * min },
      { updatedAt: NOW - 5 * min, statusUpdatedAt: NOW - 5 * min }
    )
    expect(run({ procs: [crashed] })[0]).toMatchObject({ state: 'exited', since: NOW - 5 * min })
    // Seen running, then gone: ended when it was noticed.
    expect(run({ procs: [{ ...crashed, goneAt: NOW - 1 * min }] })[0].since).toBe(NOW - min)
    // Exited long enough ago: dropped.
    expect(run({ procs: [{ ...crashed, goneAt: NOW - EXITED_KEEP_MS - 1 }] })).toEqual([])
  })

  it('ends a session on SessionEnd even if its process lives on (/clear)', () => {
    const r = run({ procs: [proc()], events: [ev('SessionEnd', 10_000, { reason: 'clear' })] })[0]
    expect(r).toMatchObject({ state: 'exited', detail: 'Ended (clear)' })
  })

  it('keeps an unverifiable process only while there is recent news', () => {
    expect(run({ procs: [proc({ alive: undefined })] })[0]).toMatchObject({
      state: 'working',
      unverified: true
    })
    const quiet = proc(
      { alive: undefined, mtime: NOW - 120 * min },
      { updatedAt: NOW - 120 * min, statusUpdatedAt: NOW - 120 * min, startedAt: NOW - 200 * min }
    )
    expect(run({ procs: [quiet] })).toEqual([])
  })

  it('a restarted session: the running file wins over the old dead one', () => {
    const old = proc(
      { alive: false, mtime: NOW - 3 * min },
      { pid: 1, updatedAt: NOW - 3 * min, statusUpdatedAt: NOW - 3 * min }
    )
    const fresh = proc({ mtime: NOW - 1 * min }, { pid: 2, status: 'idle' })
    const r = run({ procs: [old, fresh] })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ pid: 2, state: 'idle' })
  })

  it('older versions without a status: hooks, then transcript activity', () => {
    const noStatus = proc(
      {},
      { status: undefined, updatedAt: undefined, statusUpdatedAt: undefined }
    )
    expect(run({ procs: [noStatus] })[0]).toMatchObject({ state: 'idle', basis: 'activity' })
    expect(
      run({ procs: [noStatus], transcript: () => ({ lastActivityAt: NOW - 20_000 }) })[0]
    ).toMatchObject({ state: 'working', basis: 'activity' })
    // Waiting for approval, then the transcript moves on: back to work.
    const asked = [ev('PermissionRequest', 60_000, { toolName: 'Bash' })]
    expect(run({ procs: [noStatus], events: asked })[0]).toMatchObject({
      state: 'approval',
      detail: 'Wants to use Bash'
    })
    expect(
      run({
        procs: [noStatus],
        events: asked,
        transcript: () => ({ lastActivityAt: NOW - 10_000 })
      })[0].state
    ).toBe('working')
  })

  it('sessions known only from hooks need the bridge on, and recent news', () => {
    const events = [ev('UserPromptSubmit', 2 * min)]
    expect(run({ events })[0]).toMatchObject({ state: 'working', unverified: true, basis: 'hook' })
    expect(run({ events, hooksOn: new Set() })).toEqual([])
    expect(run({ events: [ev('Stop', HOOK_ONLY_MAX_MS + 1)] })).toEqual([])
    expect(run({ events: [ev('SessionEnd', 3 * min)] })[0]).toMatchObject({ state: 'exited' })
    expect(run({ events: [ev('SessionEnd', EXITED_KEEP_MS + 1)] })).toEqual([])
  })

  it('keeps when a state began across polls, and puts sessions that need me first', () => {
    const first = run({ procs: [proc({}, { status: 'waiting', statusUpdatedAt: NOW - 10 * min })] })
    const prev = new Map(first.map((s) => [s.key, s]))
    // The status file is rewritten, still waiting.
    const again = run({
      prev,
      procs: [proc({}, { status: 'waiting', statusUpdatedAt: NOW - 1 * min })]
    })
    expect(again[0].since).toBe(NOW - 10 * min)
    const a = { state: 'working', since: 1, key: 'a' } as LiveSession
    const b = { state: 'approval', since: 5, key: 'b' } as LiveSession
    const c = { state: 'idle', since: 2, key: 'c' } as LiveSession
    const d = { state: 'exited', since: 0, key: 'd' } as LiveSession
    expect([a, b, c, d].sort(liveOrder).map((s) => s.key)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('describes the state with a time', () => {
    const at = (ms: number): string => `T${(NOW - ms) / min}`
    const s = run({ procs: [proc({}, { status: 'waiting', statusUpdatedAt: NOW - 3 * min })] })[0]
    expect(stateLine(s, NOW, at)).toBe('Needs approval since T3')
    expect(stateLine({ ...s, state: 'working', since: NOW - 75 * min }, NOW, at)).toBe(
      'Working for 1h 15m'
    )
  })

  it('reads every hook event that matters, and ignores the rest', () => {
    expect(hookSignal(ev('Notification', 0, { notificationType: 'idle_prompt' }))?.state).toBe(
      'idle'
    )
    expect(hookSignal(ev('Notification', 0, { notificationType: 'auth_success' }))).toBeUndefined()
    expect(
      hookSignal(ev('Notification', 0, { notificationType: 'elicitation_dialog' }))?.state
    ).toBe('approval')
    expect(
      hookSignal(ev('Notification', 0, { message: 'Claude needs your permission to use Edit' }))
        ?.state
    ).toBe('approval')
    expect(hookSignal(ev('SessionStart', 0, { startSource: 'startup' }))?.state).toBe('idle')
    expect(hookSignal(ev('SessionStart', 0, { startSource: 'compact' }))?.state).toBe('working')
    expect(hookSignal(ev('SubagentStop', 0))?.state).toBe('working')
    expect(hookSignal(ev('PreCompact', 0))).toBeUndefined()
  })
})
