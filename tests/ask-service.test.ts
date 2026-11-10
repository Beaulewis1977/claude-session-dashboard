// Ask across sessions (roadmap #7): the service on the fixture sessions, with
// the index in this thread and a stand-in for `claude -p`. Local answers send
// nothing; content questions send only after Send, exactly what was shown,
// with masked secrets and fixed flags; uncited statements are dropped; a
// phone's question waits for the PC.

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskCommand } from '@shared/ask'
import { setClockOffset } from '@shared/clock'
import { ASK_SESSIONS_MARKER } from '@shared/ask-sessions/prompt'
import { DEFAULT_ASK_SESSIONS, type AskSessionsSettings } from '@shared/ask-sessions/types'
import { ASK_USAGE_KEY, ASK_USAGE_LABEL } from '@shared/summary'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import type { LimitsState } from '@shared/usage/limits'
import type { UsageRecord } from '@shared/usage/types'
import { InProcessHost } from '../src/main/ask-sessions/host'
import {
  AskSessionsService,
  createAskSessionsStore,
  prKey,
  prTime,
  type AskGit
} from '../src/main/ask-sessions/service'
import { JsonStore } from '../src/main/core/json-store'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { DeviceRegistry, type MobileFile } from '../src/main/mobile/devices'
import { allowedHosts } from '../src/main/mobile/network'
import { RemoteLauncher } from '../src/main/mobile/remote-launch'
import { RPC } from '../src/main/mobile/rpc'
import { MobileServer } from '../src/main/mobile/server'
import { createFixturesPlatform } from '../src/main/platform'
import type { AskRunner, RunResult } from '../src/main/services/ask'
import { spawnRunner } from '../src/main/services/cli-process'
import { PrintRunner } from '../src/main/services/print-runner'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { FIXTURES } from './helpers'

const SAFARI = 'windows:7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'

let root: string
let busy: { idle(): Promise<void> }[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-askx-'))
  busy = []
})
afterEach(async () => {
  setClockOffset(0)
  for (const b of busy) await b.idle().catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fakeRunner(answer: () => string) {
  const calls: { cmd: AskCommand; stdin: string }[] = []
  const runner: AskRunner = (cmd, stdin) => {
    calls.push({ cmd, stdin })
    const result: RunResult = {
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: answer(),
        total_cost_usd: 0.02,
        modelUsage: {
          'claude-opus-5-5': {
            inputTokens: 5000,
            outputTokens: 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0
          }
        }
      }),
      stderr: '',
      code: 0,
      timedOut: false,
      cancelled: false
    }
    return { done: Promise.resolve(result), cancel: () => undefined }
  }
  return { runner, calls }
}

async function setup(
  over: {
    settings?: Partial<AskSessionsSettings>
    answer?: () => string
    /** No Claude Code found, the subscription check refused, or the program couldn't be started. */
    cli?: 'missing' | 'refused' | 'unstartable'
    git?: AskGit
    /** Each new index host (n counts from 1), e.g. to make the first one fail. */
    onHost?: (h: InProcessHost, n: number) => void
  } = {}
) {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settingsStore = createSettingsStore(paths)
  await metadata.load()
  await settingsStore.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(platform, paths, metadata, settingsStore)
  busy.push(sessions)
  await sessions.start()
  await sessions.idle()
  // A secret in a description: it must never be sent.
  sessions.updateMeta(SAFARI, {
    description: 'Safari cookie notes. Token sk-ant-api03-SECRETSECRETSECRET123 here.'
  })
  const fake = fakeRunner(
    over.answer ??
      (() =>
        'It was the cookie path [S1]. Also a guess with no source. And a wrong id [S99].\n- Moved the cookie [S1]')
  )
  const runner = new PrintRunner({
    findCli: async () =>
      over.cli === 'missing'
        ? undefined
        : { kind: 'native', path: 'C:\\claude\\claude.exe', label: 'Windows' },
    checkAuth: async () =>
      over.cli === 'refused'
        ? { ok: false, reason: 'Not signed in with a Claude subscription.' }
        : { ok: true, method: 'claude.ai' },
    // "unstartable": the program found earlier is gone, so its process never starts.
    runner:
      over.cli === 'unstartable'
        ? () => ({
            done: Promise.resolve({
              stdout: '',
              stderr: 'spawn C:\\claude\\claude.exe ENOENT',
              code: null,
              timedOut: false,
              cancelled: false,
              notStarted: true
            }),
            cancel: () => undefined
          })
        : fake.runner
  })
  let ask: AskSessionsSettings = {
    ...DEFAULT_ASK_SESSIONS,
    enabled: true,
    noticeAccepted: true,
    ...over.settings
  }
  const recorded: UsageRecord[] = []
  let remembered: unknown
  let revealed = 0
  let host: InProcessHost | undefined
  let hosts = 0
  const store = createAskSessionsStore(paths.dataDir)
  await store.load()
  const service = new AskSessionsService({
    dataDir: paths.dataDir,
    store,
    sessions,
    ...(over.git ? { git: over.git } : {}),
    usage: {
      recordsOf: () => [],
      limitHits: () => [],
      addDashboardRecords: (r) => recorded.push(...r)
    },
    limits: { state: async () => ({}) as LimitsState, dollarsPerPct: () => 0.25 },
    settings: () => ({
      askSessions: ask,
      weekStart: 'monday',
      prices: DEFAULT_PRICES,
      codexPrices: [],
      plan: 'max5',
      planHistory: [],
      pauseAbovePct: 80,
      timeoutSec: 60,
      showSubagents: false
    }),
    remember: (c) => (remembered = c),
    fiveHourPct: async () => ({ pct: 12 }),
    runner,
    createHost: () => {
      host = new InProcessHost({
        dir: join(paths.dataDir, 'cache', 'ask'),
        dataDir: paths.dataDir,
        minReindexMs: 0
      })
      over.onHost?.(host, ++hosts)
      return host
    },
    reveal: () => revealed++,
    timeZone: () => 'UTC'
  })
  busy.push({ idle: () => service.stop() })
  service.start()
  // The first sync runs on a timer; then the index reads every session.
  await new Promise((r) => setTimeout(r, 30))
  await host?.idle()
  return {
    service,
    sessions,
    fake,
    recorded,
    remembered: () => remembered,
    revealed: () => revealed,
    hosts: () => hosts,
    host: () => host,
    setAsk: (p: Partial<AskSessionsSettings>) => {
      ask = { ...ask, ...p }
      service.settingsChanged()
    }
  }
}

describe('local questions', () => {
  it('are answered and saved with nothing sent', async () => {
    const { service, fake } = await setup()
    const r = await service.ask('How many sessions used Sonnet?')
    expect(r.mode).toBe('local')
    if (r.mode !== 'local') return
    expect(r.item.local?.headline).toMatch(/\*\*\d+ sessions?\*\*/)
    expect(fake.calls).toEqual([])
    expect(service.history()[0].id).toBe(r.item.id)
  })

  it('work while content questions are off', async () => {
    const { service } = await setup({ settings: { enabled: false } })
    expect((await service.ask('how many sessions last month')).mode).toBe('local')
    const c = await service.ask('why did Safari get stuck in a redirect loop?')
    expect(c).toMatchObject({
      mode: 'content',
      blocked: expect.stringContaining('Content questions are off')
    })
  })
})

describe('content questions', () => {
  it('preview first, masked; Send sends exactly that, with fixed flags; uncited statements dropped', async () => {
    const { service, fake, recorded, remembered } = await setup()
    const r = await service.ask('why did Safari users get stuck in a redirect loop?')
    expect(r.mode).toBe('content')
    if (r.mode !== 'content' || !r.preview) throw new Error('no preview')
    const p = r.preview
    // Nothing has gone anywhere yet.
    expect(fake.calls).toEqual([])
    expect(p.snippets.length).toBeGreaterThan(0)
    expect(p.snippets[0].sid).toBe('S1')
    expect(p.snippets.some((x) => x.key === SAFARI)).toBe(true)
    expect(JSON.stringify(p.snippets)).not.toContain('SECRETSECRET')
    const keep = p.snippets.map((s) => s.sid)
    const shown = service.promptText(p.id, keep).prompt
    const item = await service.send(p.id, { keep, model: 'opus', effort: 'high' })
    expect(fake.calls).toHaveLength(1)
    const { cmd, stdin } = fake.calls[0]
    expect(stdin).toBe(shown)
    expect(stdin.startsWith(ASK_SESSIONS_MARKER)).toBe(true)
    expect(stdin).not.toContain('SECRETSECRET')
    expect(cmd.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--tools',
        '--strict-mcp-config',
        '--safe-mode',
        '--no-session-persistence',
        '--model',
        'opus',
        '--effort',
        'high'
      ])
    )
    expect(cmd.args.join(' ')).not.toContain('dangerously')
    // The question isn't on the command line.
    expect(cmd.args.join(' ')).not.toContain('Safari')
    expect(item).toMatchObject({
      ok: true,
      mode: 'content',
      modelChoice: 'opus',
      effort: 'high',
      model: 'claude-opus-5-5'
    })
    // How it was answered: what the index was searched for, and how much matched.
    expect(item.searched).toContain('safari')
    expect(item.matched).toBeGreaterThan(0)
    expect(item.answer).toContain('It was the cookie path [S1].')
    expect(item.answer).not.toContain('guess')
    expect(item.answer).not.toContain('S99')
    expect(item.dropped).toEqual(['Also a guess with no source.', 'And a wrong id.'])
    expect(item.citations?.S1).toMatchObject({ key: p.snippets[0].key })
    expect(recorded.every((x) => x.key === ASK_USAGE_KEY && x.project === ASK_USAGE_LABEL)).toBe(
      true
    )
    expect(recorded).toHaveLength(1)
    expect(remembered()).toEqual({ lastModel: 'opus', lastEffort: 'high' })
    // Sent once: the preview can't be sent again.
    await expect(service.send(p.id, { keep, model: 'opus', effort: 'high' })).rejects.toThrow(
      /expired/
    )
  })

  it('sends only the snippets I kept, and nothing when I keep none', async () => {
    const { service, fake } = await setup()
    const r = await service.ask('cookie redirect login safari dashboard')
    if (r.mode !== 'content' || !r.preview) throw new Error('no preview')
    await expect(
      service.send(r.preview.id, { keep: [], model: 'sonnet', effort: 'default' })
    ).rejects.toThrow(/at least one/)
    expect(fake.calls).toEqual([])
    await service.send(r.preview.id, { keep: ['S1'], model: 'sonnet', effort: 'default' })
    expect(fake.calls[0].stdin).toContain('id="S1"')
    expect(fake.calls[0].stdin).not.toContain('id="S2"')
    expect(fake.calls[0].cmd.args).not.toContain('--effort')
  })

  it('NOT_FOUND is saved as not found', async () => {
    const { service } = await setup({ answer: () => 'NOT_FOUND' })
    const r = await service.ask('what did I decide about the safari cookie?')
    if (r.mode !== 'content' || !r.preview) throw new Error('no preview')
    const item = await service.send(r.preview.id, {
      keep: ['S1'],
      model: 'haiku',
      effort: 'default'
    })
    expect(item).toMatchObject({ ok: true, notFound: true, answer: '' })
  })

  it('the history can be deleted one by one', async () => {
    const { service } = await setup()
    const a = await service.ask('how many sessions')
    await service.ask('how many sessions last week')
    if (a.mode !== 'local') throw new Error('not local')
    expect(service.history()).toHaveLength(2)
    expect(service.delete(a.item.id)).toBe(true)
    expect(service.history().map((i) => i.id)).not.toContain(a.item.id)
  })
})

describe('a phone’s content question', () => {
  const phone = { id: 'd1', name: 'Pixel' }

  it('waits on the PC: nothing is sent until the PC sends the previewed snippets', async () => {
    const { service, fake, revealed } = await setup()
    const req = service.phoneRequest(phone, 'why the safari redirect loop?', {})
    expect(req.status).toBe('pending')
    expect(revealed()).toBe(1)
    expect(fake.calls).toEqual([])
    expect(service.pending().map((p) => p.id)).toEqual([req.id])
    const r = await service.ask(req.question, { phoneRequest: req.id })
    if (r.mode !== 'content' || !r.preview) throw new Error('no preview')
    expect(r.preview.phone).toEqual({ device: 'Pixel', requestId: req.id })
    const item = await service.send(r.preview.id, {
      keep: ['S1'],
      model: 'sonnet',
      effort: 'default'
    })
    expect(item.phone).toBe('Pixel')
    expect(service.requestStatus(req.id)).toMatchObject({ status: 'sent', itemId: item.id })
    expect(service.pending()).toEqual([])
  })

  it('is refused when content questions are off, rate-limited, can be declined, and expires', async () => {
    const off = await setup({ settings: { enabled: false } })
    expect(() => off.service.phoneRequest(phone, 'q?', {})).toThrow(/Ask on your PC/)
    await off.service.stop()
    const { service, fake } = await setup()
    const a = service.phoneRequest(phone, 'first?', {})
    expect(() => service.phoneRequest(phone, 'second?', {})).toThrow(/Too many/)
    service.decline(a.id)
    expect(service.requestStatus(a.id)?.status).toBe('declined')
    await expect(service.ask('first?', { phoneRequest: a.id })).rejects.toThrow(/no longer waiting/)
    setClockOffset(31_000)
    const b = service.phoneRequest(phone, 'third?', {})
    setClockOffset(31_000 + 16 * 60_000)
    expect(service.requestStatus(b.id)?.status).toBe('expired')
    expect(service.pending()).toEqual([])
    expect(fake.calls).toEqual([])
  })

  it('a phone gets local answers directly, never saved, and can reach only read-only Ask calls', async () => {
    const { service, fake } = await setup()
    const r = await service.phoneLocal('how many sessions used sonnet')
    expect(r.mode).toBe('local')
    expect((await service.phoneLocal('why the safari redirect loop?')).mode).toBe('content')
    expect(service.history()).toEqual([])
    expect(fake.calls).toEqual([])
    const askRpcs = Object.values(RPC).filter((m) => m.channel.startsWith('askSessions:'))
    expect(askRpcs.map((m) => m.channel).sort()).toEqual(
      [
        'askSessions:history',
        'askSessions:phoneLocal',
        'askSessions:phoneStatus',
        'askSessions:status'
      ].sort()
    )
    expect(askRpcs.every((m) => m.kind === 'read')).toBe(true)
  })
})

// --------------------------------------------------------- the phone's endpoint

function req(
  port: number,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: data ? 'POST' : 'GET',
        headers: {
          host: `127.0.0.1:${port}`,
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
        }
      },
      (res) => {
        let body = ''
        res.on('data', (c: Buffer) => (body += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    r.on('error', reject)
    r.end(data)
  })
}

describe('/api/ask on the companion server', () => {
  it('passes a question to the PC (logged), and refuses it in read-only mode', async () => {
    const reg = new DeviceRegistry(
      new JsonStore<MobileFile>(join(root, 'mobile.json'), root, () => ({
        version: 1,
        devices: [],
        activity: []
      }))
    )
    let readOnly = false
    const asked: { device: string; body: unknown }[] = []
    let port = 0
    const server = new MobileServer({
      registry: reg,
      call: async () => null,
      launcher: new RemoteLauncher({
        session: () => undefined,
        preview: async () => {
          throw new Error('no')
        },
        launch: async () => {
          throw new Error('no')
        },
        settings: () => ({ terminal: 'wt', readOnly, confirmOnPc: false, branchConfirmed: true }),
        confirm: async () => false,
        deviceActive: () => true,
        log: () => undefined
      }),
      web: { file: async () => undefined },
      flags: () => ({ readOnly, confirmOnPc: false, mode: 'tailscale', appVersion: '1.0.0' }),
      hosts: () =>
        allowedHosts({
          bind: '127.0.0.1',
          port,
          tailscaleName: 'pc.tail1234.ts.net',
          httpsPort: 8443
        }),
      changed: () => undefined,
      askRequest: async (d, body) => {
        asked.push({ device: d.name, body })
        return { id: 'r1', status: 'pending' }
      }
    })
    await server.start({ host: '127.0.0.1', port: 0 })
    port = server.address()!.port
    try {
      const p = reg.startPairing(`http://127.0.0.1:${port}`)
      const paired = await req(port, '/api/pair', { body: { code: p.code, name: 'Pixel' } })
      const token = (JSON.parse(paired.body) as { token: string }).token
      expect((await req(port, '/api/ask', { body: { question: 'x' } })).status).toBe(401)
      readOnly = true
      expect((await req(port, '/api/ask', { token, body: { question: 'why?' } })).status).toBe(403)
      expect(asked).toEqual([])
      readOnly = false
      const ok = await req(port, '/api/ask', { token, body: { question: 'why?' } })
      expect(ok.status).toBe(200)
      expect(asked).toEqual([{ device: 'Pixel', body: { question: 'why?' } }])
      expect(reg.activity()[0]).toMatchObject({ action: 'ask', device: 'Pixel', ok: true })
    } finally {
      await server.stop()
    }
  })
})

describe('review fixes (PR #50)', () => {
  it('an attempt that never reached Claude does not say snippets were sent', async () => {
    for (const cli of ['missing', 'refused'] as const) {
      const { service, fake } = await setup({ cli })
      const r = await service.ask('why did Safari users get stuck in a redirect loop?')
      if (r.mode !== 'content' || !r.preview) throw new Error('no preview')
      const item = await service.send(r.preview.id, {
        keep: ['S1'],
        model: 'sonnet',
        effort: 'default'
      })
      expect(item.ok).toBe(false)
      expect(item.sent).toBeUndefined()
      expect(fake.calls).toEqual([])
    }
    // One that ran: sent is recorded.
    const { service } = await setup()
    const r = await service.ask('why did Safari users get stuck in a redirect loop?')
    if (r.mode !== 'content' || !r.preview) throw new Error('no preview')
    const ok = await service.send(r.preview.id, {
      keep: ['S1'],
      model: 'sonnet',
      effort: 'default'
    })
    expect(ok.sent).toMatchObject({ snippets: 1, sessions: 1 })
  })

  it('a Cancel says whether the prompt process had already started', async () => {
    const runner = new PrintRunner({
      findCli: async () => ({ kind: 'native', path: 'C:\\claude\\claude.exe', label: 'Windows' }),
      checkAuth: async () => ({ ok: true, method: 'claude.ai' }),
      runner: () => ({ done: new Promise<RunResult>(() => undefined), cancel: () => undefined })
    })
    const opts = {
      cwd: join(root, 'ask'),
      timeoutMs: 5000,
      command: (): AskCommand => ({ command: 'claude', args: ['-p'], shell: false })
    }
    const early = runner.newRequest()
    runner.cancel(early)
    const before = await runner.run(early, 'question', opts)
    expect(before.kind).toBe('cancelled')
    expect(before.kind === 'cancelled' && before.started).toBeFalsy()
    const late = runner.newRequest()
    const out = runner.run(late, 'question', opts)
    await new Promise((r) => setTimeout(r, 30))
    expect(late.handle).toBeDefined()
    runner.cancel(late)
    expect(await out).toEqual({ kind: 'cancelled', where: 'Windows', started: true })
  })

  it('Rebuild replaces an index worker that failed', async () => {
    const { service, hosts } = await setup({
      onHost: (h, n) => {
        if (n !== 1) return
        // The first worker crashed: it reports an error and rejects every call.
        const s = h.status.bind(h)
        h.status = () => ({ ...(s() ?? EMPTY_STATUS), phase: 'error', error: 'worker gone' })
        h.clear = () => Promise.reject(new Error('worker gone'))
      }
    })
    expect(service.status().phase).toBe('error')
    expect(hosts()).toBe(1)
    await service.rebuild()
    expect(hosts()).toBe(2)
    expect(service.status().phase).not.toBe('error')
    // A healthy host is kept.
    await service.rebuild()
    expect(hosts()).toBe(2)
  })

  it('PRs keep the time the session showed them (or their merge commit), not its last activity', async () => {
    const shown = Date.parse('2025-03-10T12:00:00Z')
    const merged = Date.parse('2025-03-20T12:00:00Z')
    const git: AskGit = {
      enabled: () => true,
      linkedCommits: (key) =>
        key === SAFARI
          ? [{ sha: 'abc1234def', subject: 'Merge pull request #8', at: merged, files: [], pr: 8 }]
          : [],
      prsOf: (key) =>
        key === SAFARI
          ? [
              { number: 7, url: 'https://github.com/o/r/pull/7', via: 'session' },
              { number: 8, url: 'https://github.com/o/r/pull/8', via: 'merge' }
            ]
          : [],
      seenPrs: (key) =>
        key === SAFARI ? [{ number: 7, url: 'https://github.com/o/r/pull/7', at: shown }] : [],
      editedFiles: () => [],
      filter: () => new Set()
    }
    const { service } = await setup({ git })
    const r = await service.ask('which pull requests did I open in March 2025')
    if (r.mode !== 'local') throw new Error('not local')
    expect(r.item.local?.table?.rows.map((x) => x[0]).sort()).toEqual(['#7', '#8'])
    const apr = await service.ask('which pull requests did I open in April 2025')
    if (apr.mode !== 'local') throw new Error('not local')
    expect(apr.item.local?.table?.rows).toEqual([])
  })
})

describe('second review fixes (PR #50)', () => {
  it('a Claude Code that could not be started sends nothing and is looked for again', async () => {
    const { service, fake } = await setup({ cli: 'unstartable' })
    const r = await service.ask('why did Safari users get stuck in a redirect loop?')
    if (r.mode !== 'content' || !r.preview) throw new Error('no preview')
    const item = await service.send(r.preview.id, {
      keep: ['S1'],
      model: 'sonnet',
      effort: 'default'
    })
    expect(item.ok).toBe(false)
    expect(item.sent).toBeUndefined()
    expect(item.error).toMatch(/couldn't be started.*Nothing was sent/)
    expect(fake.calls).toEqual([])

    // The runner forgets the CLI it found, so the next run looks for it again.
    let finds = 0
    const runner = new PrintRunner({
      findCli: async () => (
        finds++,
        { kind: 'native', path: 'C:\\gone\\claude.exe', label: 'Windows' }
      ),
      checkAuth: async () => ({ ok: true, method: 'claude.ai' }),
      runner: () => ({
        done: Promise.resolve({
          stdout: '',
          stderr: 'spawn ENOENT',
          code: null,
          timedOut: false,
          cancelled: false,
          notStarted: true
        }),
        cancel: () => undefined
      })
    })
    const opts = {
      cwd: join(root, 'ask'),
      timeoutMs: 5000,
      command: (): AskCommand => ({ command: 'claude', args: ['-p'], shell: false })
    }
    expect(await runner.run(runner.newRequest(), 'q', opts)).toMatchObject({ kind: 'refused' })
    await runner.run(runner.newRequest(), 'q', opts)
    expect(finds).toBe(2)
  })

  it('the real process runner says when a program never started', async () => {
    const opts = { cwd: root, timeoutMs: 10_000 }
    const missing = join(root, 'no-such-folder', 'claude.exe')
    const exe = await spawnRunner({ command: missing, args: ['-p'], shell: false }, 'q', opts).done
    expect(exe.notStarted).toBe(true)
    // A .cmd shim runs through the shell, which would start anyway: the file is checked first.
    const shim = join(root, 'no-such-folder', 'claude.cmd')
    const cmd = await spawnRunner({ command: `"${shim}"`, args: ['-p'], shell: true }, 'q', opts)
      .done
    expect(cmd.notStarted).toBe(true)
    // A program that runs: started, whatever its exit code.
    const ran = await spawnRunner(
      { command: process.execPath, args: ['-e', 'process.exit(3)'], shell: false },
      '',
      opts
    ).done
    expect(ran.notStarted).toBeUndefined()
    expect(ran.code).toBe(3)
  })

  it("a PR's time comes from its own repo, never from another repo's PR with the same number", () => {
    const shownA = Date.parse('2025-03-10T12:00:00Z')
    const shownB = Date.parse('2025-05-01T12:00:00Z')
    const merged = Date.parse('2025-03-20T12:00:00Z')
    // The session printed repo-b's #8 (in May) and repo-a's #7.
    const seen = [
      { number: 7, url: 'https://github.com/o/repo-a/pull/7', at: shownA },
      { number: 8, url: 'https://github.com/o/repo-b/pull/8', at: shownB }
    ]
    const commits = [{ at: merged, pr: 8 }]
    // repo-a's #8 (from its merge commit): its merge time, not repo-b's #8's.
    expect(
      prTime({ number: 8, url: 'https://github.com/o/repo-a/pull/8', via: 'merge' }, seen, commits)
    ).toBe(merged)
    // The same PR written another way still matches.
    expect(
      prTime({ number: 7, url: 'https://GitHub.com/O/Repo-A/pull/7/', via: 'session' }, seen, [])
    ).toBe(shownA)
    expect(
      prTime(
        { number: 8, url: 'https://github.com/o/repo-b/pull/8', via: 'session' },
        seen,
        commits
      )
    ).toBe(shownB)
    // A session PR of another repo never takes a merge commit's time (that number is this repo's).
    expect(
      prTime({ number: 8, url: 'https://github.com/x/other/pull/8', via: 'session' }, [], commits)
    ).toBeUndefined()
    expect(prKey('https://github.com/O/R/pulls/12')).toBe('o/r#12')
  })
})

const EMPTY_STATUS = {
  phase: 'ready' as const,
  sessions: 0,
  passages: 0,
  chars: 0,
  bytes: 0,
  done: 0,
  total: 0,
  skipped: 0
}
