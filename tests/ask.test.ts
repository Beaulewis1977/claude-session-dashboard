import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ASK_ARGS,
  ASK_ENV_ALLOW,
  ASK_MARKER,
  askCommand,
  askQuestionOf,
  authStatusCommand,
  buildAskData,
  buildAskPrompt,
  parseAskOutput,
  subscriptionCheck,
  WSL_ENV_ALLOWLIST,
  type AskCli,
  type AskCommand,
  type SubscriptionCheck
} from '@shared/ask'
import { DEFAULT_HEALTH, healthReport, type WindowReading } from '@shared/usage/health'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import { detectSource } from '@shared/source-label'
import type { UsageRecord } from '@shared/usage/types'
import {
  AskService,
  childEnv,
  createAskStore,
  spawnRunner,
  type AskRunner,
  type RunResult
} from '../src/main/services/ask'
import { localShell, shellPath } from './helpers'

const BASH = localShell('bash')

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
      '--strict-mcp-config',
      // No CLAUDE.md, memory, hooks, plugins or skills, and no settings files.
      '--safe-mode',
      '--setting-sources',
      ''
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
        `${WSL_ENV_ALLOWLIST} claude -p --output-format json --tools "" --strict-mcp-config --safe-mode --setting-sources ""`
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
      checkAuth: async () => ({ ok: true, method: 'claude.ai' }),
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

describe('Ask Claude: subscription only, and nothing extra sent', () => {
  const status = (o: Record<string, unknown>) =>
    JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ...o })

  it('accepts only the Claude subscription', () => {
    expect(subscriptionCheck(status({}))).toEqual({ ok: true, method: 'claude.ai' })
    // `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) is the subscription too.
    expect(subscriptionCheck(status({ authMethod: 'oauth_token' })).ok).toBe(true)
    // WSL login shells can print text before the JSON.
    expect(subscriptionCheck(`Welcome!\n${status({})}\n`).ok).toBe(true)
    const no = (out: string, code = 0) => {
      const r = subscriptionCheck(out, code)
      return r.ok ? '' : r.reason
    }
    expect(no(status({ apiKeySource: 'ANTHROPIC_API_KEY' }))).toMatch(/API key .*billed separately/)
    expect(no(status({ apiKeySource: 'apiKeyHelper' }))).toMatch(/API key/)
    expect(no(status({ apiProvider: 'bedrock' }))).toMatch(/Amazon Bedrock/)
    expect(no(status({ apiProvider: 'vertex' }))).toMatch(/Vertex/)
    expect(no(status({ authMethod: 'api_key' }))).toMatch(/not your Claude subscription/)
    expect(no(status({ authMethod: 'third_party' }))).toMatch(/not your Claude subscription/)
    expect(no(status({ loggedIn: false }))).toMatch(/isn't signed in/)
    expect(no('', 1)).toMatch(/Couldn't confirm/)
    // A qualifying answer from a check that failed or never finished proves nothing.
    expect(no(status({}), 1)).toMatch(/Couldn't confirm.*exit code 1/)
    expect(no(status({}), null as unknown as number)).toMatch(/Couldn't confirm/)
    expect(no('error: unknown command')).toMatch(/Couldn't confirm/)
  })

  it('checks with `claude auth status` in the same environment as the question', () => {
    const wsl = authStatusCommand({ kind: 'wsl', distro: 'Ubuntu', label: 'WSL' })
    const inner = wsl.args[wsl.args.length - 1]
    expect(inner).toBe(`${WSL_ENV_ALLOWLIST} claude --safe-mode --setting-sources "" auth status`)
    expect(authStatusCommand({ kind: 'native', path: 'claude.exe', label: 'W' }).args).toEqual([
      '--safe-mode',
      '--setting-sources',
      '',
      'auth',
      'status'
    ])
  })

  it('passes the CLI only allowlisted variables: no keys, headers, gateways or providers', () => {
    const env = childEnv({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\beau',
      HTTPS_PROXY: 'http://proxy:8080',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\beau\\.claude',
      ANTHROPIC_API_KEY: 'sk-ant-api',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'https://gateway',
      // The re-review's case: headers that carry another credential.
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer other\nX-Api-Key: sk-ant-api',
      ANTHROPIC_FOUNDRY_API_KEY: 'f',
      ANTHROPIC_UNIX_SOCKET: '/tmp/s',
      CLAUDE_CODE_GATEWAY_TOKEN: 'g',
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3',
      CLAUDE_CODE_USE_BEDROCK: '1',
      Claude_Code_Use_Foundry: '1',
      SOMETHING_FUTURE: 'x'
    })
    expect(env).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\beau',
      HTTPS_PROXY: 'http://proxy:8080',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\beau\\.claude'
    })
  })

  it('in WSL, starts the CLI with only the allowlist, after the login profile has loaded', () => {
    // bash -lic runs the profile first, then this command: env -i drops everything else.
    const cmd = askCommand({ kind: 'wsl', label: 'WSL' })
    const inner = cmd.args[cmd.args.length - 1]
    expect(inner.startsWith(WSL_ENV_ALLOWLIST)).toBe(true)
    expect(WSL_ENV_ALLOWLIST).toContain('exec env -i')
    expect(WSL_ENV_ALLOWLIST).not.toMatch(/ANTHROPIC_/)
  })

  // A local bash: on Windows Git for Windows' (bash on PATH there may be the WSL launcher).
  it.runIf(!!BASH)('the WSL snippet really drops a hostile environment (run in bash)', () => {
    const run = (script: string, env: NodeJS.ProcessEnv) =>
      execFileSync(BASH!, ['-c', script], { encoding: 'utf8', env })
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('=')[0])
    // What the shell itself adds even to an empty environment (MSYS adds
    // MSYSTEM and the like on Windows): not something the snippet let through.
    const own = run('exec env -i "$(command -v env)"', { PATH: shellPath(BASH!) })
    const out = execFileSync(BASH!, ['-c', `${WSL_ENV_ALLOWLIST} env`], {
      encoding: 'utf8',
      env: {
        PATH: shellPath(BASH!),
        HOME: '/home/beau',
        LANG: 'en_US.UTF-8 with spaces',
        CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
        ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer other',
        ANTHROPIC_API_KEY: 'sk-ant-api',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_GATEWAY_TOKEN: 'g'
      }
    })
    const names = out
      .trim()
      .split('\n')
      .map((l) => l.split('=')[0])
    // Only allowlisted names (bash may add SHELL/TERM itself, both allowed).
    expect(names.filter((n) => !ASK_ENV_ALLOW.includes(n) && !own.includes(n))).toEqual([])
    expect(names).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'LANG', 'PATH'])
    )
    for (const bad of [
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_GATEWAY_TOKEN'
    ])
      expect(names).not.toContain(bad)
    expect(out).toContain('LANG=en_US.UTF-8 with spaces')
  })
})

describe('Ask Claude service: billing check and cancelling', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'csd-ask2-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const ok: RunResult = {
    stdout: '{"result":"Fine.","is_error":false}',
    stderr: '',
    code: 0,
    timedOut: false,
    cancelled: false
  }
  const cli: AskCli = { kind: 'native', path: 'claude.exe', label: 'Windows' }
  /** 'auth' for the subscription check, else the first argument. */
  const step = (cmd: AskCommand): string => (cmd.args.includes('auth') ? 'auth' : cmd.args[0])
  function deferred<T>() {
    let resolve: (v: T) => void = () => undefined
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('never sends the question when Claude Code would bill something else', async () => {
    const calls: AskCommand[] = []
    const ask = new AskService({
      store: createAskStore(dir),
      dataDir: dir,
      data: async () => data(),
      timeoutSec: () => 60,
      findCli: async () => cli,
      runner: (cmd) => {
        calls.push(cmd)
        const out = cmd.args.includes('auth')
          ? '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}'
          : ok.stdout
        return { done: Promise.resolve({ ...ok, stdout: out }), cancel: () => undefined }
      }
    })
    const p = await ask.preview('Have my limits dropped?')
    const item = await ask.run(p.id)
    expect(item).toMatchObject({ ok: false, answer: '' })
    expect(item.error).toMatch(/API key/)
    // Only the status check ran; the prompt never went anywhere.
    expect(calls.map((c) => c.args.slice(-2))).toEqual([['auth', 'status']])
  })

  it('runs the status check first, then the question, when it is the subscription', async () => {
    const calls: { cmd: AskCommand; stdin: string }[] = []
    const ask = new AskService({
      store: createAskStore(dir),
      dataDir: dir,
      data: async () => data(),
      timeoutSec: () => 60,
      findCli: async () => cli,
      runner: (cmd, stdin) => {
        calls.push({ cmd, stdin })
        const out = cmd.args.includes('auth')
          ? '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
          : ok.stdout
        return { done: Promise.resolve({ ...ok, stdout: out }), cancel: () => undefined }
      }
    })
    const p = await ask.preview('Have my limits dropped?')
    expect(await ask.run(p.id)).toMatchObject({ ok: true, answer: 'Fine.' })
    expect(calls.map((c) => step(c.cmd))).toEqual(['auth', '-p'])
    expect(calls[0].stdin).toBe('')
    expect(calls[1].stdin).toBe(p.prompt)
    // A confirmed check is reused for a while.
    const q = await ask.preview('Compare this month to last month')
    await ask.run(q.id)
    expect(calls.map((c) => step(c.cmd))).toEqual(['auth', '-p', '-p'])
  })

  for (const stage of ['finding Claude Code', 'checking the subscription'] as const) {
    it(`cancels while ${stage}, and then never starts the CLI`, async () => {
      const found = deferred<AskCli | undefined>()
      const checked = deferred<SubscriptionCheck>()
      let started = 0
      const ask = new AskService({
        store: createAskStore(dir),
        dataDir: dir,
        data: async () => data(),
        timeoutSec: () => 60,
        findCli: () => found.promise,
        checkAuth: () => checked.promise,
        runner: () => {
          started++
          return { done: Promise.resolve(ok), cancel: () => undefined }
        }
      })
      const p = await ask.preview('Why did I hit my limit Tuesday?')
      const pending = ask.run(p.id)
      if (stage === 'finding Claude Code') {
        ask.cancel(p.id)
        found.resolve(cli)
        checked.resolve({ ok: true, method: 'claude.ai' })
      } else {
        found.resolve(cli)
        await new Promise((r) => setTimeout(r, 10))
        ask.cancel(p.id)
        checked.resolve({ ok: true, method: 'claude.ai' })
      }
      expect(await pending).toMatchObject({ ok: false, error: 'Cancelled.' })
      expect(started).toBe(0)
    })
  }

  it('says to update Claude Code when it is too old for the privacy flags', async () => {
    const ask = new AskService({
      store: createAskStore(dir),
      dataDir: dir,
      data: async () => data(),
      timeoutSec: () => 60,
      findCli: async () => cli,
      checkAuth: async () => ({ ok: true, method: 'claude.ai' }),
      runner: () => ({
        done: Promise.resolve({
          stdout: '',
          stderr: "error: unknown option '--safe-mode'",
          code: 1,
          timedOut: false,
          cancelled: false
        }),
        cancel: () => undefined
      })
    })
    const p = await ask.preview('Have my limits dropped?')
    expect((await ask.run(p.id)).error).toMatch(/too old .*claude update/)
  })

  it('Cancel during the subscription check stops that process and returns at once', async () => {
    let authCancelled = 0
    let questions = 0
    const ask = new AskService({
      store: createAskStore(dir),
      dataDir: dir,
      data: async () => data(),
      timeoutSec: () => 60,
      findCli: async () => cli,
      runner: (cmd) => {
        if (!cmd.args.includes('auth')) {
          questions++
          return { done: Promise.resolve(ok), cancel: () => undefined }
        }
        // A status check that would take its full 30 s.
        return { done: new Promise<RunResult>(() => undefined), cancel: () => authCancelled++ }
      }
    })
    const p = await ask.preview('Have my limits dropped?')
    const pending = ask.run(p.id)
    await new Promise((r) => setTimeout(r, 10))
    ask.cancel(p.id)
    const t = Date.now()
    expect(await pending).toMatchObject({ ok: false, error: 'Cancelled.' })
    expect(Date.now() - t).toBeLessThan(1000)
    expect(authCancelled).toBe(1)
    expect(questions).toBe(0)
  })

  it('Cancel returns at once even while Claude Code is still being looked for', async () => {
    const ask = new AskService({
      store: createAskStore(dir),
      dataDir: dir,
      data: async () => data(),
      timeoutSec: () => 60,
      findCli: () => new Promise<AskCli | undefined>(() => undefined),
      runner: () => ({ done: Promise.resolve(ok), cancel: () => undefined })
    })
    const p = await ask.preview('Have my limits dropped?')
    const pending = ask.run(p.id)
    await new Promise((r) => setTimeout(r, 10))
    ask.cancel(p.id)
    expect(await pending).toMatchObject({ ok: false, error: 'Cancelled.' })
  })
})
