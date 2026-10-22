import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ASK_ARGS,
  ASK_MARKER,
  askCommand,
  askQuestionOf,
  buildAskData,
  buildAskPrompt,
  parseAskOutput,
  type AskCommand
} from '@shared/ask'
import { DEFAULT_HEALTH, healthReport, type WindowReading } from '@shared/usage/health'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import { detectSource } from '@shared/source-label'
import type { UsageRecord } from '@shared/usage/types'
import { AskService, createAskStore, spawnRunner, type AskRunner } from '../src/main/services/ask'

const H = 3_600_000
const T0 = Date.parse('2026-09-01T10:00:00Z')
const SECRET = 'TOP-SECRET-PROJECT'

function records(): UsageRecord[] {
  const out: UsageRecord[] = []
  for (let d = 0; d < 10; d++)
    out.push({
      id: `r${d}`,
      ts: T0 + d * 24 * H + H,
      key: `windows:${SECRET}-session`,
      project: SECRET,
      env: 'windows',
      model: 'claude-opus-5-5',
      version: '2.1.300',
      input: 10,
      output: 100_000,
      cacheWrite: 0,
      cacheRead: 0,
      sid: `${SECRET}-sid`
    })
  return out
}

function data() {
  const recs = records()
  const readings: WindowReading[] = recs.map((r) => ({
    ts: r.ts + H,
    pct: 25,
    resetsAt: r.ts + 4 * H,
    from: 'bridge'
  }))
  const opts = {
    kind: 'five_hour' as const,
    prices: DEFAULT_PRICES,
    now: T0 + 30 * 24 * H,
    settings: { ...DEFAULT_HEALTH, baselineFrom: '2026-09-01', baselineTo: '2026-09-05' },
    planHistory: [],
    currentPlan: 'max5' as const
  }
  return buildAskData({
    now: opts.now,
    timeZone: 'UTC',
    plan: 'max5',
    planHistory: [],
    health5h: healthReport(readings, recs, opts),
    records: recs,
    limitHits: [
      {
        id: 'h',
        ts: T0 + 2 * H,
        key: `windows:${SECRET}`,
        text: `${SECRET}: usage limit reached`,
        kind: 'five_hour'
      }
    ],
    prices: DEFAULT_PRICES,
    elsewhere: [{ from: T0, to: T0 + H }]
  })
}

describe('Ask Claude prompt', () => {
  it('sends only aggregated numbers, never session text, project names or ids', () => {
    const d = data()
    const json = JSON.stringify(d)
    expect(json).not.toContain(SECRET)
    expect(json).not.toContain('usage limit reached')
    expect(d.fiveHour?.windows).toHaveLength(10)
    expect(d.fiveHour?.baseline?.windows).toBe(5)
    expect(d.dailyTotals[0]).toMatchObject({ date: '2026-09-01', tokens: 100_010, responses: 1 })
    expect(d.limitReached).toEqual([{ at: '2026-09-01 Tue 12:00', window: 'five_hour' }])
    expect(d.modelFirstSeen).toEqual([{ model: 'claude-opus-5-5', date: '2026-09-01' }])
    expect(d.claudeCodeVersionFirstSeen).toEqual([{ version: '2.1', date: '2026-09-01' }])
  })

  it('starts with the marker so the run can be recognised, and carries the question', () => {
    const p = buildAskPrompt('  Have my\nlimits dropped? ', data())
    expect(p.startsWith(`${ASK_MARKER}\n`)).toBe(true)
    expect(p).toContain('\nQuestion: Have my limits dropped?\n')
    expect(askQuestionOf(p)).toBe('Have my limits dropped?')
    expect(detectSource(undefined, { env: 'windows', firstPrompt: p }).label).toBe('ask-claude')
  })

  it('runs claude -p with no tools, never skipping permissions, and nothing but fixed flags', () => {
    expect(ASK_ARGS).toEqual([
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config'
    ])
    const exe = askCommand({
      kind: 'native',
      path: 'C:\\Users\\beau\\.local\\bin\\claude.exe',
      label: 'Windows'
    })
    expect(exe).toEqual({
      command: 'C:\\Users\\beau\\.local\\bin\\claude.exe',
      args: ASK_ARGS,
      shell: false
    })
    const cmd = askCommand({
      kind: 'native',
      path: 'C:\\Users\\beau\\AppData\\Roaming\\npm\\claude.cmd',
      label: 'Windows'
    })
    expect(cmd.shell).toBe(true)
    expect(cmd.args).toContain('""')
    const wsl = askCommand({ kind: 'wsl', distro: 'Ubuntu', label: 'WSL' })
    expect(wsl).toEqual({
      command: 'wsl.exe',
      args: [
        '-d',
        'Ubuntu',
        '--cd',
        '~',
        '--',
        'bash',
        '-lic',
        'claude -p --output-format json --tools "" --strict-mcp-config'
      ],
      shell: false
    })
    for (const c of [exe, cmd, wsl])
      expect(c.args.join(' ')).not.toMatch(/dangerously|bypassPermissions/)
  })

  it('reads the CLI output, with shell noise before the JSON', () => {
    const out =
      'Welcome to Ubuntu\n{"type":"result","subtype":"success","is_error":false,"result":"**No.** Normal.","total_cost_usd":0.04,"session_id":"abc"}'
    expect(parseAskOutput(out)).toEqual({
      ok: true,
      answer: '**No.** Normal.',
      error: undefined,
      costUsd: 0.04,
      sessionId: 'abc'
    })
    expect(parseAskOutput('{"is_error":true,"result":"Not logged in"}').error).toBe('Not logged in')
    expect(parseAskOutput('', 'claude: command not found', 127)).toMatchObject({
      ok: false,
      error: 'claude: command not found'
    })
  })
})

describe('Ask Claude service', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'csd-ask-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function service(runner: AskRunner, timeoutSec = 60) {
    const store = createAskStore(dir)
    return new AskService({
      store,
      dataDir: dir,
      data: async () => data(),
      timeoutSec: () => timeoutSec,
      findCli: async () => ({ kind: 'native', path: 'claude.exe', label: 'Windows' }),
      runner
    })
  }

  it('sends exactly the previewed prompt on stdin, not in the arguments, and saves the answer', async () => {
    const calls: { cmd: AskCommand; stdin: string; cwd: string }[] = []
    const ask = service((cmd, stdin, opts) => {
      calls.push({ cmd, stdin, cwd: opts.cwd })
      return {
        done: Promise.resolve({
          stdout: '{"result":"Looks normal.","is_error":false}',
          stderr: '',
          code: 0,
          timedOut: false,
          cancelled: false
        }),
        cancel: () => undefined
      }
    })
    const p = await ask.preview('Have my limits dropped?')
    const item = await ask.run(p.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].stdin).toBe(p.prompt)
    expect(calls[0].cmd.args).toEqual(ASK_ARGS)
    expect(calls[0].cmd.args.join(' ')).not.toContain('limits dropped')
    expect(calls[0].cwd).toBe(join(dir, 'ask'))
    expect(item).toMatchObject({
      ok: true,
      answer: 'Looks normal.',
      question: 'Have my limits dropped?',
      where: 'Windows'
    })
    expect(ask.history()[0].id).toBe(item.id)
    // A preview is used once.
    await expect(ask.run(p.id)).rejects.toThrow(/expired/)
  })

  it('stops on timeout and on cancel', async () => {
    let cancel: () => void = () => undefined
    const ask = service(() => {
      let resolve: (v: {
        stdout: string
        stderr: string
        code: number | null
        timedOut: boolean
        cancelled: boolean
      }) => void = () => undefined
      const done = new Promise<{
        stdout: string
        stderr: string
        code: number | null
        timedOut: boolean
        cancelled: boolean
      }>((r) => (resolve = r))
      cancel = () =>
        resolve({ stdout: '', stderr: '', code: null, timedOut: false, cancelled: true })
      return { done, cancel }
    })
    const p = await ask.preview('Why did I hit my limit Tuesday?')
    const pending = ask.run(p.id)
    await new Promise((r) => setTimeout(r, 10))
    ask.cancel(p.id)
    expect(await pending).toMatchObject({ ok: false, error: 'Cancelled.' })

    const slow = service(
      () => ({
        done: Promise.resolve({
          stdout: '',
          stderr: '',
          code: null,
          timedOut: true,
          cancelled: false
        }),
        cancel: () => undefined
      }),
      45
    )
    const q = await slow.preview('Compare this month to last month')
    expect((await slow.run(q.id)).error).toMatch(/No answer after 45 seconds/)
    void cancel
  })

  it('the real runner pipes stdin to the process and kills it on timeout', async () => {
    const echo = spawnRunner(
      {
        command: process.execPath,
        args: ['-e', 'process.stdin.pipe(process.stdout)'],
        shell: false
      },
      'hello over stdin',
      { cwd: dir, timeoutMs: 10_000 }
    )
    expect(await echo.done).toMatchObject({ stdout: 'hello over stdin', code: 0, timedOut: false })
    const hang = spawnRunner(
      { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], shell: false },
      '',
      { cwd: dir, timeoutMs: 200 }
    )
    expect((await hang.done).timedOut).toBe(true)
  })
})
