import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { fixturesLayout, prepareFixtures } from '../src/main/fixtures'
import { EventEmitter } from 'node:events'
import type { SessionSummary } from '@shared/types'
import { phoneMetaPatch, RPC } from '../src/main/mobile/rpc'
import { createFixturesPlatform } from '../src/main/platform'
import {
  ContextCost,
  publishContextReadings,
  sameCacheScope
} from '../src/main/services/context-cost'
import { Launcher } from '../src/main/services/launcher'
import { SessionService } from '../src/main/services/sessions'
import {
  appPaths,
  cleanMetaPatch,
  createMetadataStore,
  createSettingsStore
} from '../src/main/services/store'
import { FIXTURES } from './helpers'

const BIG = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c'
const PROJECT = join(
  'windows',
  'Users',
  'alex',
  '.claude',
  'projects',
  'C--Users-alex-code-acme-web'
)

/** A session whose last reply carried 180k tokens of context (1-hour cache). */
function bigSession(): string {
  const base = { sessionId: BIG, cwd: 'C:\\Users\\alex\\code\\acme-web', version: '2.1.0' }
  const usage = (input: number, read: number, write: number) => ({
    input_tokens: input,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
    output_tokens: 400
  })
  const lines = [
    {
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-01T10:00:00.000Z',
      message: { role: 'user', content: 'Refactor the checkout flow' }
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-01T10:00:05.000Z',
      message: {
        id: 'm1',
        role: 'assistant',
        model: 'claude-opus-4-5',
        content: [{ type: 'text', text: 'On it.' }],
        usage: usage(4, 0, 21_000)
      }
    },
    {
      ...base,
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-10-01T11:00:00.000Z',
      message: { role: 'user', content: 'Keep going' }
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-10-01T11:00:05.000Z',
      message: {
        id: 'm2',
        role: 'assistant',
        model: 'claude-opus-4-5',
        content: [{ type: 'text', text: 'Done.' }],
        usage: usage(6, 170_000, 9_994)
      }
    }
  ]
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

let root: string
let busy: SessionService[] = []

async function setup() {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root)
  const layout = fixturesLayout(root)
  await writeFile(join(layout.sourcesDir, PROJECT, `${BIG}.jsonl`), bigSession())
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  const sessions = new SessionService(platform, paths, metadata, settings)
  busy.push(sessions)
  const launcher = new Launcher(platform, sessions, () => 'wt')
  await sessions.start()
  await sessions.idle()
  return { sessions, launcher }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-context-'))
})
afterEach(async () => {
  await Promise.all(busy.map((b) => b.idle().catch(() => undefined)))
  busy = []
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('context size (fixtures)', { timeout: 30_000 }, () => {
  it('reads the size from the session file and merges a newer status line reading', async () => {
    const { sessions } = await setup()
    const s = sessions.list().find((x) => x.sessionId === BIG)!
    expect(s.context).toMatchObject({
      tokens: 180_000,
      from: 'usage',
      cache1hShare: 1,
      baseTokens: 21_004,
      compactions: 0
    })
    // Fixture sessions without usage have no size (no badge, no warning).
    expect(sessions.list().find((x) => x.sessionId !== BIG && !x.context)).toBeDefined()

    sessions.contextResolver = (sid) =>
      sid === BIG ? { pct: 19, size: 1_000_000, ts: Date.parse('2026-10-01T12:00:00Z') } : undefined
    const merged = sessions.get(s.key)!
    expect(merged.context).toMatchObject({
      tokens: 190_000,
      from: 'status-line',
      windowSize: 1_000_000
    })
  })

  it('puts the estimate into Resume and Fork previews, not New session', async () => {
    const { sessions, launcher } = await setup()
    const cost = new ContextCost({
      limits: {
        dollarsPerPct: () => 0.5,
        state: async () => ({}) as never,
        isSubscription: () => true
      },
      usage: { allRecords: () => [] },
      settings: () => DEFAULT_SETTINGS
    })
    launcher.contextEstimate = (s, l) => cost.estimate(s, l)
    const key = sessions.list().find((x) => x.sessionId === BIG)!.key
    const opts = { key, fork: false, skipPermissions: false }

    const resume = await launcher.preview(opts)
    expect(resume.context?.tokens).toBe(180_000)
    // Opus 4.5, cold (the reply is a month old): 180k × $10/M (1-hour write) = $1.80 → 3.6%.
    expect(resume.context?.warmUntil).toBeUndefined()
    expect(resume.context?.resume.costUsd).toBeCloseTo(1.8)
    expect(resume.context?.resume.pct5h).toBeCloseTo(3.6)
    expect(resume.context?.basis).toBe('baseline')
    expect(resume.context?.fresh).toBeUndefined()

    // API credits: dollars, no share of the 5-hour window.
    const api = await cost.estimate(sessions.get(key)!, { billingAccountId: 'acct-1' })
    expect(api?.billing).toBe('api')
    expect(api?.resume.pct5h).toBeUndefined()

    expect((await launcher.preview({ ...opts, fork: true })).context?.tokens).toBe(180_000)
    expect((await launcher.preview({ ...opts, newSession: true })).context).toBeUndefined()

    // With a summary, Continue fresh is priced next to Resume.
    sessions.setAiSummary(key, {
      title: 'Checkout',
      done: ['Refactored the flow'],
      files: [],
      decisions: [],
      todos: [],
      pickUp: 'Test it.',
      generatedAt: '2026-10-01T12:00:00.000Z',
      messageCount: 4
    })
    const withSummary = await launcher.preview(opts)
    expect(withSummary.context?.fresh?.tokens).toBeGreaterThan(21_004)
    // No model chosen: Claude Code's default can't be verified, so tokens only.
    expect(withSummary.context?.fresh?.unpriced).toBe(true)
    expect(withSummary.context?.freshModel).toBeUndefined()
    // A chosen model prices both.
    sessions.updateMeta(key, { model: 'opus' })
    const chosen = await launcher.preview(opts)
    expect(chosen.context?.freshModel).toBe(chosen.context?.model)
    expect(chosen.context!.fresh!.pct5h!).toBeLessThan(chosen.context!.resume.pct5h!)
  })

  it('a failing estimate never stops the preview', async () => {
    const { sessions, launcher } = await setup()
    launcher.contextEstimate = async () => {
      throw new Error('boom')
    }
    const key = sessions.list().find((x) => x.sessionId === BIG)!.key
    const p = await launcher.preview({ key, fork: false, skipPermissions: false })
    expect(p.context).toBeUndefined()
    expect(p.claudeCommand).toContain(BIG)
  })
})

describe('cache scope', () => {
  const s = (
    billing?: SessionSummary['billing'],
    taggedAt = '2026-10-01T09:00:00.000Z',
    lastReplyAt = '2026-10-01T10:00:00.000Z'
  ) =>
    ({
      billing,
      meta: { billing: billing && { mode: billing.mode, source: 'launch', at: taggedAt } },
      context: { tokens: 1, from: 'usage', compactions: 0, lastReplyAt }
    }) as SessionSummary
  it('the same account shares the cache; another or an unknown one does not', () => {
    expect(sameCacheScope(s({ mode: 'subscription', source: 'bridge' }), undefined)).toBe(true)
    expect(sameCacheScope(s({ mode: 'subscription', source: 'launch' }), 'acct-1')).toBe(false)
    expect(
      sameCacheScope(s({ mode: 'api', accountId: 'acct-1', source: 'launch' }), 'acct-1')
    ).toBe(true)
    expect(
      sameCacheScope(s({ mode: 'api', accountId: 'acct-1', source: 'launch' }), 'acct-2')
    ).toBe(false)
    expect(
      sameCacheScope(s({ mode: 'api', accountId: 'acct-1', source: 'launch' }), undefined)
    ).toBe(false)
    expect(sameCacheScope(s({ mode: 'unknown', source: 'none' }), undefined)).toBe(false)
    expect(sameCacheScope(s(undefined), undefined)).toBe(false)
    // Tagged by a launch after the last reply: the tag doesn't say who made the cache.
    expect(
      sameCacheScope(
        s(
          { mode: 'api', accountId: 'acct-2', source: 'launch' },
          '2026-10-01T11:00:00.000Z',
          '2026-10-01T10:00:00.000Z'
        ),
        'acct-2'
      )
    ).toBe(false)
    // A reading-based guess isn't a launch tag: it holds.
    expect(
      sameCacheScope(
        s({ mode: 'subscription', source: 'bridge' }, '2026-10-01T11:00:00.000Z'),
        undefined
      )
    ).toBe(true)
  })
})

describe('the phone', () => {
  it("prices its stats as its launches run: on the subscription, whatever the PC's default", () => {
    // The phone can't choose: the RPC always adds { phone: true }.
    expect(RPC.getContextEstimate.args(['browser:s0', { phone: false }])).toEqual([
      'browser:s0',
      { phone: true }
    ])
  })
})

describe('status line context readings', () => {
  it('reach the session list when a newer one arrives', () => {
    let at = 100
    const limits = Object.assign(new EventEmitter(), { lastContextAt: () => at })
    let touched = 0
    publishContextReadings(limits, { touch: () => touched++ })
    limits.emit('changed') // e.g. a limits-only reading
    expect(touched).toBe(0)
    at = 200
    limits.emit('changed')
    expect(touched).toBe(1)
    limits.emit('changed')
    expect(touched).toBe(1)
  })
})

describe('"Don\'t warn for this session"', () => {
  it('is kept by the desktop and phone meta filters', () => {
    expect(cleanMetaPatch({ noContextWarning: true })).toEqual({ noContextWarning: true })
    expect(cleanMetaPatch({ noContextWarning: false })).toEqual({ noContextWarning: undefined })
    expect(phoneMetaPatch({ noContextWarning: true })).toEqual({ noContextWarning: true })
  })
})
