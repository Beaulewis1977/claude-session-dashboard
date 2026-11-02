import { createHash } from 'node:crypto'
import { appendFile, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskCommand } from '@shared/ask'
import {
  DEFAULT_SUMMARY_SETTINGS,
  SUMMARY_MARKER,
  SUMMARY_USAGE_KEY,
  type SummarySettings
} from '@shared/summary'
import type { UsageRecord } from '@shared/usage/types'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { createFixturesPlatform } from '../src/main/platform'
import type { AskRunner, RunResult } from '../src/main/services/ask'
import { PrintRunner } from '../src/main/services/print-runner'
import { SessionService } from '../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import {
  AUTO_IDLE_MS,
  autoCandidates,
  NOT_ACCEPTED,
  SummaryService
} from '../src/main/services/summaries'
import { UsageService, usagePaths } from '../src/main/services/usage'
import { FIXTURES } from './helpers'

const SAFARI = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const ORDERS = 'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8'

let root: string
let busy: { idle(): Promise<void> }[] = []

const ANSWER = {
  title: 'Fix the Safari login cookie',
  done: ['Found the SameSite problem', 'Moved the cookie to the parent domain'],
  files: ['src/auth/cookie.ts'],
  decisions: ['Keep HttpOnly'],
  todos: ['Check iOS Safari'],
  pickUp: 'Verify on iOS Safari with the zebrafish test account.'
}

function cliOutput(answer: unknown = ANSWER): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: typeof answer === 'string' ? answer : JSON.stringify(answer),
    total_cost_usd: 0.012,
    modelUsage: {
      'claude-sonnet-5-5': {
        inputTokens: 900,
        outputTokens: 300,
        cacheReadInputTokens: 2300,
        cacheCreationInputTokens: 700,
        costUSD: 0.012
      }
    }
  })
}

interface Call {
  cmd: AskCommand
  stdin: string
}

function fakeRunner(opts: { out?: () => string; hold?: boolean } = {}) {
  const calls: Call[] = []
  const pending: ((r: RunResult) => void)[] = []
  const runner: AskRunner = (cmd, stdin) => {
    calls.push({ cmd, stdin })
    let resolve!: (r: RunResult) => void
    const done = new Promise<RunResult>((r) => (resolve = r))
    const result = (): RunResult => ({
      stdout: (opts.out ?? (() => cliOutput()))(),
      stderr: '',
      code: 0,
      timedOut: false,
      cancelled: false
    })
    if (opts.hold) pending.push(() => resolve(result()))
    else queueMicrotask(() => resolve(result()))
    return {
      done,
      cancel: () =>
        resolve({ stdout: '', stderr: '', code: null, timedOut: false, cancelled: true })
    }
  }
  return { runner, calls, release: () => pending.splice(0).forEach((f) => f({} as RunResult)) }
}

async function setup(
  over: {
    settings?: Partial<SummarySettings>
    pct?: () => number | undefined | Promise<number | undefined>
    runner?: AskRunner
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
  const fake = fakeRunner()
  const runner = new PrintRunner({
    findCli: async () => ({ kind: 'native', path: 'C:\\claude\\claude.exe', label: 'Windows' }),
    checkAuth: async () => ({ ok: true, method: 'claude.ai' }),
    runner: over.runner ?? fake.runner
  })
  const recorded: UsageRecord[] = []
  let settings: SummarySettings = {
    ...DEFAULT_SUMMARY_SETTINGS,
    noticeAccepted: true,
    ...over.settings
  }
  const summaries = new SummaryService({
    sessions,
    dataDir: paths.dataDir,
    runner,
    settings: () => settings,
    timeoutSec: () => 60,
    prices: () => DEFAULT_PRICES,
    fiveHourPct: async () => over.pct?.(),
    dollarsPerPct: () => 0.25,
    recordUsage: (r) => recorded.push(...r)
  })
  return {
    sessions,
    summaries,
    metadata,
    paths,
    layout,
    fake,
    recorded,
    setSettings: (p: Partial<SummarySettings>) => (settings = { ...settings, ...p })
  }
}

/** Until nothing is queued or running. */
async function settle(s: SummaryService): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const st = s.state()
    if (!st.jobs.some((j) => j.status === 'queued' || j.status === 'running') || st.paused) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('queue did not settle')
}

/** SHA-256 of every file under a folder (to prove nothing in .claude changed). */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else
        out.set(
          p,
          createHash('sha256')
            .update(await readFile(p))
            .digest('hex')
        )
    }
  }
  await walk(dir)
  return out
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-summary-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

// Each test copies and scans the fixtures: give them room on a busy machine.
describe('SummaryService (fixtures)', { timeout: 30_000 }, () => {
  it("writes a summary through claude -p and keeps it in the app's metadata only", async () => {
    const t = await setup()
    const before = await snapshot(t.layout.sourcesDir)
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    expect(await t.summaries.enqueue([s.key])).toBe(1)
    await settle(t.summaries)

    // One run: fixed flags only, the prompt on stdin.
    expect(t.fake.calls).toHaveLength(1)
    const { cmd, stdin } = t.fake.calls[0]
    expect(cmd.args).toEqual(
      expect.arrayContaining(['-p', '--tools', '--no-session-persistence', '--model', 'sonnet'])
    )
    expect(cmd.args).not.toContain('--dangerously-skip-permissions')
    expect(cmd.args.join(' ')).not.toContain('Safari')
    expect(stdin.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(stdin).toContain('<transcript>')

    // Stored with its date, model and message count, in the app's metadata.
    const after = t.sessions.get(s.key)!
    expect(after.meta.aiSummary).toMatchObject({
      ...ANSWER,
      model: 'claude-sonnet-5-5',
      messageCount: s.messageCount,
      costUsd: 0.012
    })
    expect(t.metadata.value.sessions[SAFARI].aiSummary?.pickUp).toBe(ANSWER.pickUp)
    expect(t.summaries.state().jobs[0]).toMatchObject({ status: 'done', key: s.key })

    // Usage recorded from the CLI's answer (no session file to read it from).
    expect(t.recorded).toHaveLength(1)
    expect(t.recorded[0]).toMatchObject({
      key: SUMMARY_USAGE_KEY,
      model: 'claude-sonnet-5-5',
      input: 900,
      output: 300,
      loggedCost: 0.012
    })

    // Nothing under any .claude folder changed or was added.
    expect(await snapshot(t.layout.sourcesDir)).toEqual(before)

    // Part of the full-text search.
    await new Promise((r) => setTimeout(r, 50))
    expect(t.sessions.searchKeys('zebrafish').map((h) => h.key)).toContain(s.key)
  })

  it('sends nothing before the notice is accepted', async () => {
    const t = await setup({ settings: { noticeAccepted: false } })
    const s = t.sessions.list()[0]
    await expect(t.summaries.enqueue([s.key])).rejects.toThrow(NOT_ACCEPTED)
    expect(t.fake.calls).toHaveLength(0)
  })

  it('previews exactly what is sent, with an estimate', async () => {
    const t = await setup({ pct: () => 42 })
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    const p = await t.summaries.preview(s.key)
    expect(p.prompt.startsWith(SUMMARY_MARKER)).toBe(true)
    expect(p.bytes).toBe(Buffer.byteLength(p.prompt))
    expect(p.estimate.tokens).toBeGreaterThan(p.chars / 4)
    expect(p.estimate.pct5h).toBeCloseTo(p.estimate.costUsd / 0.25, 6)
    expect(p.fiveHourPct).toBe(42)
    const e = await t.summaries.estimate(t.sessions.list().map((x) => x.key))
    expect(e.sessions + e.skipped).toBe(t.sessions.list().length)
  })

  it('pauses a bulk run above the threshold, and goes on only when resumed', async () => {
    let pct = 85
    const t = await setup({ pct: () => pct })
    const keys = t.sessions
      .list()
      .filter((x) => x.sessionId === SAFARI || x.sessionId === ORDERS)
      .map((x) => x.key)
    await t.summaries.enqueue(keys, 'bulk')
    await settle(t.summaries)
    expect(t.summaries.state().paused).toEqual({ pct: 85, limit: 80 })
    expect(t.fake.calls).toHaveLength(0)

    t.summaries.resume()
    await settle(t.summaries)
    expect(t.fake.calls).toHaveLength(2)
    expect(t.summaries.state().jobs.every((j) => j.status === 'done')).toBe(true)
    expect(t.summaries.state().override).toBe(false)

    // A new request is a new decision: it pauses again above the line.
    await t.summaries.enqueue([keys[0]], 'bulk')
    await settle(t.summaries)
    expect(t.summaries.state().paused).toBeDefined()
    pct = 10
    t.summaries.resume()
    await settle(t.summaries)
    expect(t.fake.calls).toHaveLength(3)
  })

  it('auto-summarize picks big idle sessions, and skips while above the threshold', async () => {
    let pct = 90
    const t = await setup({
      pct: () => pct,
      settings: { autoEnabled: true, autoMinMessages: 2 }
    })
    expect(await t.summaries.autoTick()).toBe(0)
    pct = 20
    const n = await t.summaries.autoTick()
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(6)
    expect(t.summaries.state().jobs.every((j) => j.origin === 'auto')).toBe(true)
    await settle(t.summaries)
    expect(t.fake.calls).toHaveLength(n)

    // Off: nothing at all.
    t.setSettings({ autoEnabled: false })
    t.summaries.clearFinished()
    expect(await t.summaries.autoTick()).toBe(0)
  })

  it('never picks a running session, a hidden one or one edited by hand', async () => {
    const t = await setup()
    const list = t.sessions.list()
    const s = list.find((x) => x.sessionId === SAFARI)!
    const last = Date.parse(s.lastActivityAt!)
    const settings = { autoMinMessages: 2 }
    expect(autoCandidates([s], settings, last + AUTO_IDLE_MS + 1)).toHaveLength(1)
    expect(autoCandidates([s], settings, last + 60_000)).toHaveLength(0)
    expect(autoCandidates([{ ...s, meta: { hidden: true } }], settings, Infinity)).toHaveLength(0)
    const edited = {
      ...s,
      messageCount: 900,
      meta: {
        aiSummary: { ...ANSWER, generatedAt: '', messageCount: 2, editedAt: '2026-01-01' }
      }
    }
    expect(autoCandidates([edited], settings, Infinity)).toHaveLength(0)
    // Not edited and well behind: written again.
    const behind = {
      ...edited,
      meta: { aiSummary: { ...edited.meta.aiSummary, editedAt: undefined } }
    }
    expect(autoCandidates([behind], settings, Infinity)).toHaveLength(1)
  })

  it('cancels a running summary and stores nothing', async () => {
    const held = fakeRunner({ hold: true })
    const t = await setup({ runner: held.runner })
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    await t.summaries.enqueue([s.key])
    for (let i = 0; i < 100 && !held.calls.length; i++) await new Promise((r) => setTimeout(r, 5))
    expect(t.summaries.state().running).toBe(s.key)
    t.summaries.cancel(s.key)
    await settle(t.summaries)
    expect(t.summaries.state().jobs[0].status).toBe('cancelled')
    expect(t.sessions.get(s.key)!.meta.aiSummary).toBeUndefined()
  })

  it('reports an answer that is not a summary, and stores nothing', async () => {
    const bad = fakeRunner({ out: () => cliOutput('I would rather not.') })
    const t = await setup({ runner: bad.runner })
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    await t.summaries.enqueue([s.key])
    await settle(t.summaries)
    expect(t.summaries.state().jobs[0]).toMatchObject({ status: 'failed' })
    expect(t.summaries.state().jobs[0].error).toMatch(/wasn't a summary/)
    expect(t.sessions.get(s.key)!.meta.aiSummary).toBeUndefined()
    // The tokens it used still count.
    expect(t.recorded).toHaveLength(1)
  })

  it('saves edits by hand and removes a summary, in the metadata only', async () => {
    const t = await setup()
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    await t.summaries.enqueue([s.key])
    await settle(t.summaries)
    const edited = t.summaries.save(s.key, {
      pickUp: 'Ship it.',
      done: ['- one', 'two'],
      model: 'x'
    })!
    expect(edited.meta.aiSummary).toMatchObject({
      pickUp: 'Ship it.',
      done: ['one', 'two'],
      model: 'claude-sonnet-5-5'
    })
    expect(edited.meta.aiSummary!.editedAt).toBeTruthy()
    expect(t.summaries.remove(s.key)!.meta.aiSummary).toBeUndefined()
    expect(t.metadata.value.sessions[SAFARI].aiSummary).toBeUndefined()
  })
})

/** A user message appended to a session file, as Claude Code writes them. */
function userLine(sessionId: string, cwd: string, text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      uuid: '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e',
      parentUuid: null,
      timestamp: '2026-10-21T14:00:00.000Z',
      sessionId,
      cwd
    }) + '\n'
  )
}

describe('What is sent is what was approved', { timeout: 30_000 }, () => {
  it('a cancel that comes while the limit is being read sends nothing', async () => {
    let release!: (v: number) => void
    let asked = 0
    const t = await setup({
      pct: () => {
        asked++
        return new Promise<number>((r) => (release = r))
      }
    })
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    await t.summaries.enqueue([s.key])
    for (let i = 0; i < 100 && !asked; i++) await new Promise((r) => setTimeout(r, 5))
    expect(asked).toBe(1)
    t.summaries.cancel(s.key)
    release(10)
    await settle(t.summaries)
    expect(t.fake.calls).toHaveLength(0)
    expect(t.summaries.state().jobs[0].status).toBe('cancelled')
    expect(t.recorded).toHaveLength(0)
  })

  it('sends exactly the previewed text, even after new messages and a settings change', async () => {
    const t = await setup()
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    const p = await t.summaries.preview(s.key)
    await appendFile(s.filePath, userLine(SAFARI, s.cwd!, 'ADDED-AFTER-THE-PREVIEW'))
    await t.sessions.fileChanged(s.sourceId, s.filePath)
    t.setSettings({ maxChars: 10_000, model: 'haiku' })
    expect(await t.summaries.enqueue([s.key], 'manual', p.id)).toBe(1)
    await settle(t.summaries)
    expect(t.fake.calls).toHaveLength(1)
    expect(t.fake.calls[0].stdin).toBe(p.prompt)
    // The previewed model, not the one chosen since.
    expect(t.fake.calls[0].cmd.args).toEqual(expect.arrayContaining(['--model', 'sonnet']))
    expect(t.sessions.get(s.key)!.meta.aiSummary!.messageCount).toBe(s.messageCount)
  })

  it('sends nothing when the previewed text can no longer be rebuilt', async () => {
    const t = await setup()
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    const p = await t.summaries.preview(s.key)
    // An earlier message changes (the file was rewritten).
    const text = await readFile(s.filePath, 'utf8')
    await writeFile(s.filePath, text.replace(/redirect loop/g, 'REWRITTEN'))
    await t.sessions.fileChanged(s.sourceId, s.filePath)
    await t.summaries.enqueue([s.key], 'manual', p.id)
    await settle(t.summaries)
    expect(t.fake.calls).toHaveLength(0)
    expect(t.summaries.state().jobs[0]).toMatchObject({ status: 'failed' })
    expect(t.summaries.state().jobs[0].error).toMatch(/changed since you saw what is sent/)
  })

  it('refuses an unknown or expired preview', async () => {
    const t = await setup()
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    await expect(t.summaries.enqueue([s.key], 'manual', 'ffffffffffffffff')).rejects.toThrow(
      /preview has expired/
    )
    const p = await t.summaries.preview(s.key)
    await t.summaries.enqueue([s.key], 'manual', p.id)
    await settle(t.summaries)
    // A preview is used once.
    await expect(t.summaries.enqueue([s.key], 'manual', p.id)).rejects.toThrow(/expired/)
  })

  it('a queued session sends what it had when it was queued', async () => {
    let release!: (v: number) => void
    const t = await setup({ pct: () => new Promise<number>((r) => (release = r)) })
    const s = t.sessions.list().find((x) => x.sessionId === SAFARI)!
    await t.summaries.enqueue([s.key])
    await appendFile(s.filePath, userLine(SAFARI, s.cwd!, 'ARRIVED-WHILE-QUEUED'))
    await t.sessions.fileChanged(s.sourceId, s.filePath)
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5))
    release(10)
    await settle(t.summaries)
    expect(t.fake.calls).toHaveLength(1)
    expect(t.fake.calls[0].stdin).not.toContain('ARRIVED-WHILE-QUEUED')
    expect(t.sessions.get(s.key)!.meta.aiSummary!.messageCount).toBe(s.messageCount)
  })
})

describe('Usage of summary runs', { timeout: 30_000 }, () => {
  it('is kept in its own file, survives Recalculate and shows as "Summaries (dashboard)"', async () => {
    const t = await setup()
    const make = () => {
      const u = new UsageService(
        t.sessions,
        usagePaths(t.paths.dataDir, t.paths.archiveDir),
        () => ({
          weekStart: 'monday',
          prices: DEFAULT_PRICES
        })
      )
      busy.push(u)
      return u
    }
    const usage = make()
    await usage.start()
    const rec: UsageRecord = {
      id: 'summary:abc:claude-sonnet-5-5',
      ts: Date.parse('2026-10-20T10:00:00Z'),
      key: SUMMARY_USAGE_KEY,
      project: 'Summaries (dashboard)',
      env: 'windows',
      model: 'claude-sonnet-5-5',
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      loggedCost: 0.5
    }
    usage.addDashboardRecords([rec, rec])
    expect(usage.allRecords().filter((r) => r.key === SUMMARY_USAGE_KEY)).toHaveLength(1)
    await usage.recalculate()
    expect(usage.allRecords().filter((r) => r.key === SUMMARY_USAGE_KEY)).toHaveLength(1)
    await usage.idle()
    await stat(join(t.paths.dataDir, 'usage', 'dashboard-runs.ndjson'))

    const again = make()
    await again.start()
    const report = again.report({ period: 'day', groupBy: 'session' })
    const row = report.breakdown.find((r) => r.key === SUMMARY_USAGE_KEY)
    expect(row?.label).toBe('Summaries (dashboard)')
    expect(row?.cost).toBeCloseTo(0.5, 6)
  })
})
