import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLaunchCommand, wslenvWithKey, WT_API_REASON } from '../src/main/core/launch'
import { AccountsService, createAccountsStore, type Encryptor } from '../src/main/services/accounts'
import { reportUrl, type Fetcher } from '../src/main/services/anthropic-api'
import {
  keyKind,
  maskKey,
  parseCostReport,
  parseUsageReport,
  sanitizeGrant,
  spendFromReadings,
  spendFromRecords,
  summarizeCredits,
  type CreditGrant,
  type SpendEvent
} from '@shared/usage/credits'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import type { BridgeReading } from '@shared/usage/bridge'
import { FIXTURES, TOOLS } from './helpers'

const KEY = 'sk-ant-api03-SECRETsecretSECRET1234567890abcdefQ7xA'
const ADMIN = 'sk-ant-admin01-ADMINadminADMIN0987654321zyxwm2Pd'

describe('API-billed launches', () => {
  const base = {
    sessionId: '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
    cwd: 'C:\\Users\\Beau Lewis\\code\\acme web',
    fork: false,
    skipPermissions: true,
    tools: TOOLS,
    apiKey: KEY
  }
  const leaks = (cmd: ReturnType<typeof buildLaunchCommand>): boolean =>
    [cmd.command, ...cmd.args, cmd.commandLine, cmd.claudeCommand, ...cmd.claudeArgs].some((s) =>
      s.includes(KEY)
    )

  it('Windows: puts the key only in the child environment, and avoids Windows Terminal', () => {
    const cmd = buildLaunchCommand({ ...base, env: 'windows', terminal: 'wt' })
    expect(cmd.env).toEqual({ ANTHROPIC_API_KEY: KEY })
    expect(leaks(cmd)).toBe(false)
    expect(cmd.command).toBe(TOOLS.powershell)
    expect(cmd.terminal).toBe('powershell')
    expect(cmd.terminalReason).toBe(WT_API_REASON)
    for (const terminal of ['powershell', 'cmd'] as const) {
      const c = buildLaunchCommand({ ...base, env: 'windows', terminal })
      expect(c.env).toEqual({ ANTHROPIC_API_KEY: KEY })
      expect(c.terminal).toBe(terminal)
      expect(c.terminalReason).toBeUndefined()
      expect(leaks(c)).toBe(false)
    }
  })

  it('WSL: passes the key through WSLENV, not the command string', () => {
    for (const terminal of ['wt', 'powershell', 'cmd'] as const) {
      const cmd = buildLaunchCommand({
        ...base,
        env: 'wsl',
        distro: 'Ubuntu',
        cwd: '/home/beau/my project',
        terminal,
        wslenv: 'USERPROFILE/p'
      })
      expect(cmd.env).toEqual({
        ANTHROPIC_API_KEY: KEY,
        WSLENV: 'USERPROFILE/p:ANTHROPIC_API_KEY/u'
      })
      expect(leaks(cmd)).toBe(false)
      expect(cmd.commandLine).not.toContain('ANTHROPIC_API_KEY')
      expect(cmd.terminal).not.toBe('wt')
    }
    expect(wslenvWithKey(undefined)).toBe('ANTHROPIC_API_KEY/u')
    expect(wslenvWithKey('ANTHROPIC_API_KEY/u:X')).toBe('ANTHROPIC_API_KEY/u:X')
  })

  it('leaves subscription launches without any extra environment', () => {
    const cmd = buildLaunchCommand({ ...base, apiKey: undefined, env: 'windows', terminal: 'wt' })
    expect(cmd.env).toBeUndefined()
    expect(cmd.command).toBe(TOOLS.wt)
  })

  it('starts a new session without --resume', () => {
    const cmd = buildLaunchCommand({
      ...base,
      apiKey: undefined,
      newSession: true,
      env: 'wsl',
      distro: 'Ubuntu',
      cwd: '/home/beau/x',
      terminal: 'wt'
    })
    expect(cmd.claudeCommand).toBe('claude --dangerously-skip-permissions')
    expect(cmd.args).toEqual([
      TOOLS.wsl,
      '-d',
      'Ubuntu',
      '--cd',
      '/home/beau/x',
      '--',
      'bash',
      '-lic',
      'claude --dangerously-skip-permissions'
    ])
  })
})

// ------------------------------------------------------------- key storage

/** A stand-in for safeStorage: reversible, and never contains the plain text. */
const fakeEncryptor = (available = true): Encryptor => ({
  available: () => available,
  encrypt: (t) => Buffer.from([...Buffer.from(t, 'utf8')].map((b) => b ^ 0x5a).reverse()),
  decrypt: (b) => Buffer.from([...b].reverse().map((x) => x ^ 0x5a)).toString('utf8')
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-credits-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function service(enc = fakeEncryptor(), fetcher?: Fetcher) {
  const store = createAccountsStore(root)
  await store.load()
  const calls: { url: string; headers: Record<string, string> }[] = []
  const f: Fetcher =
    fetcher ??
    (async (url, init) => {
      calls.push({ url, headers: init.headers })
      const body = url.includes('cost_report')
        ? JSON.parse(await readFile(join(FIXTURES, 'usage', 'admin', 'cost_report.json'), 'utf8'))
        : JSON.parse(await readFile(join(FIXTURES, 'usage', 'admin', 'usage_report.json'), 'utf8'))
      return { ok: true, status: 200, json: async () => body, text: async () => '' }
    })
  const svc = new AccountsService(store, enc, {
    fetcher: f,
    userAgent: 'test',
    refreshMinutes: () => 0
  })
  return { svc, store, calls }
}

async function allFileText(dir: string): Promise<string> {
  let out = ''
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += await readFile(join(e.parentPath, e.name), 'utf8')
  }
  return out
}

describe('API key storage', () => {
  it('stores only ciphertext and shows the key masked', async () => {
    const { svc, store } = await service()
    const res = await svc.add('Personal credits', `  ${KEY}\n`)
    expect(res.error).toBeUndefined()
    expect(res.account).toMatchObject({
      nickname: 'Personal credits',
      kind: 'standard',
      masked: 'sk-ant-api03-…Q7xA'
    })
    expect(JSON.stringify(res.account)).not.toContain('SECRET')
    await store.flush()
    const disk = await allFileText(root)
    expect(disk).not.toContain(KEY)
    expect(disk).not.toContain('SECRETsecret')
    expect(JSON.stringify(svc.list())).not.toContain('SECRET')
    expect(svc.keyFor(res.account!.id)).toBe(KEY)
  })

  it('refuses to store a key when encryption is unavailable, and never writes it', async () => {
    const { svc } = await service(fakeEncryptor(false))
    const res = await svc.add('x', KEY)
    expect(res.error).toMatch(/encrypt/)
    expect(svc.list()).toEqual([])
    const disk = await allFileText(root).catch(() => '')
    expect(disk).not.toContain('SECRET')
  })

  it('rejects things that are not Anthropic keys', async () => {
    const { svc } = await service()
    expect((await svc.add('x', 'hello')).error).toBeDefined()
    expect(keyKind(KEY)).toBe('standard')
    expect(keyKind(ADMIN)).toBe('admin')
    expect(keyKind('sk-ant-oat01-abcdefghijk')).toBeUndefined()
    expect(maskKey(ADMIN)).toBe('sk-ant-admin01-…m2Pd')
  })
})

describe('Admin API', () => {
  it('only ever calls the two reporting endpoints on api.anthropic.com', async () => {
    const { svc, calls } = await service()
    const { account } = await svc.add('Acme org', ADMIN)
    await svc.refreshAdmin(account!.id)
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([
      'https://api.anthropic.com',
      'https://api.anthropic.com'
    ])
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/organizations/usage_report/messages',
      '/v1/organizations/cost_report'
    ])
    expect(calls[0].headers).toMatchObject({
      'x-api-key': ADMIN,
      'anthropic-version': '2023-06-01'
    })
    expect(new URL(calls[0].url).searchParams.getAll('group_by[]')).toEqual(['model', 'api_key_id'])
    const r = svc.adminReport(account!.id)!
    expect(r.error).toBeUndefined()
    expect(r.usage.length).toBeGreaterThan(30)
    expect(r.costs.reduce((a, c) => a + c.usd, 0)).toBeGreaterThan(10)
    // Standard keys never trigger network calls.
    const before = calls.length
    const std = await svc.add('Personal', KEY)
    await svc.refreshAdmin(std.account!.id)
    expect(calls.length).toBe(before)
  })

  it('refuses any other URL', () => {
    expect(() => reportUrl('/v1/messages' as never, [])).toThrow()
    expect(() => reportUrl('/v1/organizations/cost_report', [['x', 'y']])).not.toThrow()
    expect(reportUrl('/v1/organizations/cost_report', [['group_by[]', 'description']])).toBe(
      'https://api.anthropic.com/v1/organizations/cost_report?group_by%5B%5D=description'
    )
  })

  it('keeps the last report and shows a friendly error when a refresh fails', async () => {
    const fail: Fetcher = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '{}'
    })
    const { svc } = await service(fakeEncryptor(), fail)
    const { account } = await svc.add('Acme', ADMIN)
    await svc.refreshAdmin(account!.id)
    expect(svc.adminReport(account!.id)?.error).toMatch(/401/)
  })

  it('parses usage and cost reports defensively', () => {
    expect(
      parseUsageReport([
        {
          data: [
            {
              starting_at: '2026-10-01T00:00:00Z',
              results: [
                {
                  model: 'm',
                  uncached_input_tokens: 5,
                  output_tokens: '7',
                  cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 }
                }
              ]
            }
          ]
        }
      ])
    ).toEqual([
      {
        date: '2026-10-01T00:00:00Z',
        model: 'm',
        apiKeyId: null,
        input: 5,
        output: 7,
        cacheWrite: 3,
        cacheRead: 0
      }
    ])
    expect(parseUsageReport([{}, null, { data: 'x' }])).toEqual([])
    expect(
      parseCostReport([
        {
          data: [
            {
              starting_at: 'd',
              results: [
                { currency: 'USD', amount: '1234.5', model: 'm' },
                { currency: 'EUR', amount: '1' }
              ]
            }
          ]
        }
      ])
    ).toEqual([{ date: 'd', model: 'm', description: undefined, usd: 12.345 }])
  })
})

// ------------------------------------------------------------------ credits

const D = 86_400_000
const NOW = Date.parse('2026-10-22T12:00:00Z')
const iso = (t: number): string => new Date(t).toISOString()
const ev = (daysAgo: number, usd: number, source: SpendEvent['source'] = 'bridge'): SpendEvent => ({
  ts: NOW - daysAgo * D,
  usd,
  sessionKey: `s${daysAgo}`,
  source
})

describe('credits math', () => {
  const grants: CreditGrant[] = [
    {
      id: 'a',
      accountId: 'acct',
      amountUsd: 50,
      receivedAt: iso(NOW - 20 * D),
      expiresAt: iso(NOW + 60 * D)
    },
    {
      id: 'b',
      accountId: 'acct',
      amountUsd: 20,
      receivedAt: iso(NOW - 10 * D),
      expiresAt: iso(NOW + 5 * D)
    },
    { id: 'c', accountId: 'other', amountUsd: 999, receivedAt: iso(NOW - 30 * D) }
  ]

  it('spends the grant that expires first and computes the balance', () => {
    const s = summarizeCredits('acct', grants, [ev(15, 10), ev(8, 12), ev(2, 4)], NOW)
    const a = s.grants.find((g) => g.id === 'a')!
    const b = s.grants.find((g) => g.id === 'b')!
    // Day -15: only grant a exists. Day -8 and -2: grant b expires first.
    expect(a.spent).toBe(10)
    expect(b.spent).toBe(16)
    expect(s.remaining).toBe(44)
    expect(s.spent).toBe(26)
    expect(s.uncovered).toBe(0)
    expect(b.expiresSoon).toBe(true)
    expect(a.expiresSoon).toBe(false)
    expect(s.burnPerDay).toBeCloseTo(16 / 14)
    expect(s.daysLeft).toBeCloseTo(44 / (16 / 14))
    expect(s.spark).toHaveLength(30)
    expect(s.spark[29 - 2]).toBe(4)
  })

  it('loses unspent credit at expiry and counts spending with no active grant', () => {
    const s = summarizeCredits('acct', grants, [ev(25, 3), ev(1, 1)], NOW + 10 * D)
    const b = s.grants.find((g) => g.id === 'b')!
    expect(b.expired).toBe(true)
    expect(b.lost).toBe(19)
    expect(s.uncovered).toBe(3) // before any grant was received
    expect(s.remaining).toBe(50)
  })

  it('turns cumulative bridge costs into increments and handles resets', () => {
    const r = (ts: number, sessionId: string, costUsd: number): BridgeReading => ({
      ts,
      source: 'w',
      sessionId,
      costUsd
    })
    const events = spendFromReadings(
      [r(1, 'x', 0.5), r(2, 'x', 1.25), r(3, 'x', 0.25), r(4, 'y', 2), r(5, 'z', 9)],
      (x) => (x.sessionId === 'z' ? undefined : `k-${x.sessionId}`)
    )
    expect(events.map((e) => [e.sessionKey, e.usd])).toEqual([
      ['k-x', 0.5],
      ['k-x', 0.75],
      ['k-x', 0.25],
      ['k-y', 2]
    ])
  })

  it('falls back to the price table when the bridge has no cost', () => {
    const recs = [
      {
        id: '1',
        ts: NOW,
        key: 'k',
        project: 'p',
        env: 'windows' as const,
        model: 'claude-sonnet-5-5',
        input: 1_000_000,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0
      },
      {
        id: '2',
        ts: NOW,
        key: 'other',
        project: 'p',
        env: 'windows' as const,
        model: 'claude-sonnet-5-5',
        input: 1_000_000,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0
      }
    ]
    const events = spendFromRecords(recs, new Set(['k']), DEFAULT_PRICES)
    expect(events).toEqual([{ ts: NOW, usd: 2, sessionKey: 'k', source: 'estimate' }])
    const s = summarizeCredits('acct', grants, events, NOW)
    expect(s.bySource).toEqual({ bridge: 0, estimate: 2 })
  })

  it('validates grants from the form', () => {
    expect(
      sanitizeGrant({ accountId: 'a', amountUsd: 25.555, receivedAt: '2026-10-01' })
    ).toMatchObject({ amountUsd: 25.56 })
    expect(
      sanitizeGrant({ accountId: 'a', amountUsd: -1, receivedAt: '2026-10-01' })
    ).toBeUndefined()
    expect(sanitizeGrant({ accountId: 'a', amountUsd: 5, receivedAt: 'nope' })).toBeUndefined()
    expect(
      sanitizeGrant({ accountId: 'a', amountUsd: 5, receivedAt: '2026-10-01', expiresAt: 'bad' })
    ).toBeUndefined()
  })
})

describe('Launcher with API billing', () => {
  it('spawns with the key only in the environment and tags the session', async () => {
    const { cp } = await import('node:fs/promises')
    const { fixturesLayout, prepareFixtures } = await import('../src/main/fixtures')
    const { createFixturesPlatform } = await import('../src/main/platform')
    const { SessionService } = await import('../src/main/services/sessions')
    const { Launcher } = await import('../src/main/services/launcher')
    const { BillingService } = await import('../src/main/services/billing')
    const { appPaths, createMetadataStore, createSettingsStore } =
      await import('../src/main/services/store')
    await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
    await prepareFixtures(root)
    const layout = fixturesLayout(root)
    const spawned: import('../src/main/core/launch').LaunchCommand[] = []
    const platform = {
      ...createFixturesPlatform(layout.fixturesDir, layout.sourcesDir),
      canLaunch: true,
      pathExists: async () => true,
      spawnDetached: async (c: import('../src/main/core/launch').LaunchCommand) => {
        spawned.push(c)
      }
    }
    const paths = appPaths(layout.dataDir)
    const metadata = createMetadataStore(paths)
    const settings = createSettingsStore(paths)
    await metadata.load()
    await settings.load()
    const sessions = new SessionService(platform, paths, metadata, settings)
    await sessions.start()
    await sessions.idle()
    const billing = new BillingService(
      sessions,
      () => 'unknown',
      (id) => id === 'acct-1'
    )
    const launcher = new Launcher(platform, sessions, () => 'wt', {
      keyFor: (id) => (id === 'acct-1' ? KEY : undefined),
      label: () => 'API · Personal',
      subscriptionLabel: () => 'Subscription (Max 5x)',
      launched: (s, opts) =>
        sessions.tagBilling(s.sessionId, {
          mode: opts.billingAccountId ? 'api' : 'subscription',
          accountId: opts.billingAccountId,
          source: 'launch'
        })
    })
    const key = 'wsl-Ubuntu-beau:e9a1b2c3-d4e5-4f60-8172-839405a6b7c8'
    const preview = await launcher.preview({
      key,
      fork: false,
      skipPermissions: true,
      billingAccountId: 'acct-1'
    })
    expect(preview).toMatchObject({
      terminal: 'powershell',
      billingLabel: 'API · Personal',
      terminalReason: WT_API_REASON
    })
    expect(preview.commandLine).not.toContain('sk-ant')
    const res = await launcher.launch({
      key,
      fork: false,
      skipPermissions: true,
      billingAccountId: 'acct-1'
    })
    expect(res.ok).toBe(true)
    expect(spawned[0].env?.ANTHROPIC_API_KEY).toBe(KEY)
    expect(spawned[0].env?.WSLENV).toContain('ANTHROPIC_API_KEY/u')
    expect(JSON.stringify([spawned[0].command, spawned[0].args, res.commandLine])).not.toContain(
      'sk-ant'
    )
    expect(sessions.get(key)?.billing).toMatchObject({
      mode: 'api',
      accountId: 'acct-1',
      source: 'launch'
    })
    // The key never reaches the app's own files.
    await metadata.flush()
    expect(await readFile(paths.metadataFile, 'utf8')).not.toContain('sk-ant')
    // Unknown accounts can't launch.
    const bad = await launcher.launch({
      key,
      fork: false,
      skipPermissions: true,
      billingAccountId: 'acct-x'
    })
    expect(bad.ok).toBe(false)
    void billing
  })
})
