// The provider-parity snapshot: runs the app's main-process services on the
// fixtures (sessions, archive, launching, usage, limits, limit health, Running
// now, context size, summaries, the phone API and backup) and returns what
// they produce, made machine-independent. Captured on main before the
// provider refactor; tests/provider-parity.test.ts checks it stays the same.
//
// Deterministic by construction: `Date` is frozen at FIXTURES_NOW (the caller
// fakes it), every fixture file gets a fixed mtime, ids that would be random
// are passed in, arrays whose order comes from the file system are sorted,
// object keys are sorted, and the temp folder's path becomes <ROOT>.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { cp, readdir, readFile, utimes } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { basename, join, relative } from 'node:path'
import { FIXTURES_NOW, setClockOffset } from '@shared/clock'
import { DEFAULT_HEALTH } from '@shared/usage/health'
import { DEFAULT_PACE } from '@shared/usage/pace'
import { DEFAULT_WEIGHTS } from '@shared/usage/limits'
import { DEFAULT_LIVE_ALERTS } from '@shared/live-alerts'
import { DEFAULT_SUMMARY_SETTINGS } from '@shared/summary'
import type { LaunchOptions, SessionSummary, TerminalPref } from '@shared/types'
import type { Dimension, Period } from '@shared/usage/types'
import { windowsPathToWsl } from '../../src/main/core/wsl'
import { collectFiles } from '../../src/main/core/backup-files'
import {
  fixtureProcChecker,
  fixturesLayout,
  prepareFixtures,
  seedFixtureAccounts,
  seedFixtureBridge,
  seedFixtureData,
  seedFixtureLive,
  seedFixtureUsage
} from '../../src/main/fixtures'
import { phoneLimits, phoneLive, phoneSessions, phoneSettings } from '../../src/main/mobile/rpc'
import { createFixturesPlatform } from '../../src/main/platform'
import { createAccountsStore } from '../../src/main/services/accounts'
import { BillingService } from '../../src/main/services/billing'
import { BridgeInstaller, createBridgeStore } from '../../src/main/services/bridge'
import { ContextCost, publishContextReadings } from '../../src/main/services/context-cost'
import { createHooksStore, HooksInstaller } from '../../src/main/services/hooks'
import { Launcher } from '../../src/main/services/launcher'
import { LimitsService } from '../../src/main/services/limits'
import { LineageService } from '../../src/main/services/lineage'
import { LiveService } from '../../src/main/services/live'
import { PrintRunner } from '../../src/main/services/print-runner'
import { SessionService } from '../../src/main/services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from '../../src/main/services/store'
import { SummaryService } from '../../src/main/services/summaries'
import { UsageService, usagePaths } from '../../src/main/services/usage'
import { FIXTURES } from '../helpers'

const REPO = join(__dirname, '..', '..')

/** Fixed ids for everything that would otherwise be random. */
const IDS = {
  branch: '0d1e2f3a-4b5c-4d6e-8f70-81920a1b2c3d',
  cont: '1e2f3a4b-5c6d-4e7f-8091-a2b3c4d5e6f7',
  account: 'acct-personal'
}

/** The hand-written fixture sessions (the generated usage history is sampled). */
const HAND_WRITTEN = new Set([
  '2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b',
  '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
  'b7a1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d',
  'f07c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b',
  'c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c',
  '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
  'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8',
  'a0b1c2d3-e4f5-4a6b-9c8d-7e6f5a4b3c2d',
  '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
])

// ------------------------------------------------------------ normalizing

/** Every spelling of the temp folder that can end up in output. */
function rootSpellings(root: string): string[] {
  const forms = new Set<string>()
  for (const r of [root, safeRealpath(root)]) {
    forms.add(r)
    forms.add(r.replace(/\\/g, '/'))
    const wsl = windowsPathToWsl(r)
    if (wsl) forms.add(wsl)
  }
  // JSON-escaped forms (inside file contents), longest first.
  for (const f of [...forms]) forms.add(f.replace(/\\/g, '\\\\'))
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length)
}

function safeRealpath(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * PowerShell `-EncodedCommand` (UTF-16LE base64), with any
 * `FromBase64String('…')` inside it (UTF-8), decoded, so the paths in the
 * hook and status line commands can be normalized like any other text.
 */
function decodeCommands(s: string): string {
  return s.replace(/-EncodedCommand ([A-Za-z0-9+/=]{8,})/g, (_m, b64: string) => {
    const inner = Buffer.from(b64, 'base64')
      .toString('utf16le')
      .replace(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/g, (_n, x: string) => {
        return `FromBase64String(<${Buffer.from(x, 'base64').toString('utf8')}>)`
      })
    return `-EncodedCommand <${inner}>`
  })
}

export function makeNormalizer(root: string): (s: string) => string {
  const re = new RegExp(rootSpellings(root).map(escapeRe).join('|'), 'gi')
  return (s) =>
    decodeCommands(s)
      .replace(re, '<ROOT>')
      // Separators after <ROOT> differ by OS: use "/" (also for JSON-escaped "\\").
      .replace(/<ROOT>[^"'\s<>|]*/g, (m) => m.replace(/\\\\|\\/g, '/'))
}

/** The mtime every fixture file gets (files the app writes keep real ones). */
const FIXED_MTIME = FIXTURES_NOW - 3_600_000

/**
 * Deep copy with strings normalized and object keys sorted. Real-clock file
 * times (files written during the run) become "<file-time>", and search scores
 * are rounded (their last digits depend on the order documents were added).
 */
function canon(v: unknown, norm: (s: string) => string): unknown {
  if (typeof v === 'string') return norm(v)
  if (Array.isArray(v)) return v.map((x) => canon(x, norm))
  if (v instanceof Map) return canon(Object.fromEntries(v), norm)
  if (v instanceof Set) return canon([...v], norm)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k]
      // The provider refactor adds `provider: 'claude'`; before it, absent.
      if (k === 'provider' && x === 'claude') continue
      if (x === undefined) continue
      if (/mtimeMs$/i.test(k) && typeof x === 'number' && x !== FIXED_MTIME && x !== 0)
        out[k] = '<file-time>'
      else if (k === 'score' && typeof x === 'number') out[k] = Number(x.toPrecision(10))
      else out[k] = canon(x, norm)
    }
    return out
  }
  return v
}

/** A data file's content in a form that doesn't depend on write order. */
function canonicalFile(rel: string, text: string, norm: (s: string) => string): string {
  if (rel.endsWith('.ndjson')) {
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.stringify(canon(JSON.parse(l), norm))
        } catch {
          return norm(l)
        }
      })
      .sort()
      .join('\n')
  }
  if (rel.endsWith('.json')) {
    let v: unknown
    try {
      v = JSON.parse(text)
    } catch {
      return norm(text)
    }
    // The session cache: entries in key order; its search index is laid out
    // by load order (search results are compared separately). It is saved at
    // the end of the first scan while archive copies are still being made, so
    // whether an entry has its archivePath yet is a matter of timing (the
    // session list and the archive records show it deterministically).
    if (/^cache\/sessions-v\d+\.json$/.test(rel) && v && typeof v === 'object') {
      const c = v as {
        entries?: { base: { key: string; archivePath?: string } }[]
        search?: unknown
      }
      v = {
        ...c,
        entries: [...(c.entries ?? [])]
          .map((e) => ({ ...e, base: { ...e.base, archivePath: undefined } }))
          .sort((a, b) => a.base.key.localeCompare(b.base.key)),
        search: typeof c.search === 'string' ? '<search index>' : c.search
      }
    }
    return JSON.stringify(canon(v, norm))
  }
  return norm(text)
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** A short hash of a value as it is compared (normalized, keys sorted). */
function digestOf(v: unknown, norm: (s: string) => string): string {
  return sha(JSON.stringify(canon(v, norm)))
}

const byKey = <T extends { key: string }>(a: T, b: T): number => a.key.localeCompare(b.key)
const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id)

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let list
  try {
    list = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of list) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** Every file under `dir` (relative, "/"-separated) with a hash of its canonical content. */
async function fileHashes(
  dir: string,
  norm: (s: string) => string,
  skip: (rel: string) => boolean = () => false
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of (await walk(dir)).sort()) {
    const rel = relative(dir, p).replace(/\\/g, '/')
    if (skip(rel)) continue
    out[rel] = sha(canonicalFile(rel, await readFile(p, 'utf8'), norm))
  }
  return out
}

// ------------------------------------------------------------ the services

async function services(root: string, opts: { seed: boolean }) {
  const layout = fixturesLayout(root)
  const platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await Promise.all([metadata.load(), settings.load()])
  const accountsStore = createAccountsStore(paths.dataDir)
  await accountsStore.load()
  if (opts.seed) {
    await seedFixtureData(root, paths.archiveDir, metadata)
    await seedFixtureUsage(root, paths.dataDir)
    await seedFixtureAccounts(root, accountsStore, metadata, settings)
  }
  const sessions = new SessionService(platform, paths, metadata, settings)
  const lineage = new LineageService(sessions, 1)
  const account = (id: string) => accountsStore.value.accounts.find((a) => a.id === id)
  let bridgeGuess: (sid: string) => 'subscription' | 'api' | 'unknown' = () => 'unknown'
  const billing = new BillingService(
    sessions,
    (sid) => bridgeGuess(sid),
    (id) => !!account(id)
  )
  const launcher = new Launcher(
    platform,
    sessions,
    () => settings.value.terminal,
    {
      keyFor: (id) => (account(id) ? 'sk-ant-api03-golden-not-a-real-key' : undefined),
      label: (id) => {
        const a = account(id)
        return a ? `API · ${a.nickname}` : undefined
      },
      subscriptionLabel: () => 'Subscription (Max 5x)',
      launched: (s, o, cwd, ctx) => {
        const at = new Date().toISOString()
        const tag = {
          mode: o.billingAccountId ? ('api' as const) : ('subscription' as const),
          accountId: o.billingAccountId,
          source: 'launch' as const,
          at
        }
        const remote = o.remoteControl ? { at, via: ctx.via, device: ctx.device } : undefined
        if (o.fork || o.newSession) billing.expect(s.sourceId, cwd, tag, remote)
        else {
          sessions.tagBilling(s.sessionId, tag)
          if (remote) sessions.tagRemote(s.sessionId, remote)
        }
        if (o.fork) lineage.expectFork(s)
      }
    },
    () => settings.value,
    paths.dataDir
  )
  const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
    weekStart: settings.value.weekStart,
    prices: settings.value.prices
  }))
  const bridgeStore = createBridgeStore(paths.dataDir)
  await bridgeStore.load()
  const installer = new BridgeInstaller(bridgeStore, {
    dataDir: paths.dataDir,
    scriptsDir: join(REPO, 'resources', 'bridge'),
    gitBash: async () => undefined
  })
  const sourceOf = (key: string): string => sessions.get(key)?.source ?? 'unknown'
  const limits = new LimitsService(
    sessions,
    usage,
    installer,
    bridgeStore,
    join(paths.dataDir, 'limits-history.ndjson'),
    paths.dataDir,
    () => ({
      plan: settings.value.plan,
      alertsEnabled: false,
      alertThresholds: settings.value.alertThresholds,
      weights: DEFAULT_WEIGHTS,
      prices: settings.value.prices,
      health: settings.value.health ?? DEFAULT_HEALTH,
      planHistory: settings.value.planHistory,
      pace: settings.value.pace ?? DEFAULT_PACE,
      elsewhere: settings.value.elsewhere
    }),
    () => undefined,
    undefined,
    sourceOf
  )
  bridgeGuess = (sid) => limits.billingOf(sid)
  sessions.contextResolver = (sid) => limits.contextOf(sid)
  publishContextReadings(limits, sessions)
  const contextCost = new ContextCost({ limits, usage, settings: () => settings.value })
  launcher.contextEstimate = (s, l) => contextCost.estimate(s, l)
  const hooksStore = createHooksStore(paths.dataDir)
  await hooksStore.load()
  const hooks = new HooksInstaller(hooksStore, {
    dataDir: paths.dataDir,
    scriptsDir: join(REPO, 'resources', 'bridge'),
    readScript: (p) => readFile(p, 'utf8')
  })
  const live = new LiveService({
    sessions,
    hooks,
    procs: fixtureProcChecker(),
    settings: () => DEFAULT_LIVE_ALERTS,
    distroRoot: (id) => sessions.source(id)?.distroRoot,
    notify: () => undefined,
    push: async () => 0,
    mono: () => 0
  })
  const summaries = new SummaryService({
    sessions,
    dataDir: paths.dataDir,
    runner: new PrintRunner({ findCli: async () => undefined }),
    settings: () => DEFAULT_SUMMARY_SETTINGS,
    timeoutSec: () => 60,
    prices: () => settings.value.prices,
    fiveHourPct: async () => undefined,
    dollarsPerPct: () => undefined,
    recordUsage: () => undefined,
    simulate: true
  })

  await sessions.start()
  await sessions.idle()
  if (opts.seed) {
    await seedFixtureBridge(paths.dataDir, sessions, installer)
  }
  await usage.start()
  await usage.idle()
  await limits.start()
  limits.stop()
  if (opts.seed) await seedFixtureLive(paths.dataDir, sessions, hooks)
  await live.poll(true)
  live.stop()
  return {
    layout,
    paths,
    metadata,
    settings,
    sessions,
    launcher,
    usage,
    limits,
    live,
    summaries,
    lineage,
    /**
     * Wait for the lineage refresh that a session change schedules.
     * SessionService announces a change on a timer and LineageService
     * refreshes on its own timer after that, so right after `sessions.idle()`
     * a session the app just branched may or may not have its lineage yet,
     * depending on load. `refresh()` runs that same recompute now; if the
     * timer's refresh is already running it waits for it and computes once
     * more, so the lineage always matches the current session list. A timer
     * that fires later recomputes the same result and changes nothing.
     */
    async settled() {
      await sessions.idle()
      await lineage.refresh()
    },
    async idle() {
      await this.settled()
      await sessions.idle()
      await usage.idle()
      await Promise.all([metadata.flush(), settings.flush(), accountsStore.flush()])
    }
  }
}

type Services = Awaited<ReturnType<typeof services>>

// --------------------------------------------------------------- captures

const TERMINALS: TerminalPref[] = ['wt', 'powershell', 'cmd']

function launchVariants(s: SessionSummary, branchAt?: string): [string, LaunchOptions][] {
  const k = s.key
  const out: [string, LaunchOptions][] = [
    ['resume', { key: k, fork: false, skipPermissions: true }],
    ['resume-ask', { key: k, fork: false, skipPermissions: false }],
    ['fork', { key: k, fork: true, skipPermissions: true }],
    ['new', { key: k, fork: false, skipPermissions: false, newSession: true }],
    ['remote', { key: k, fork: false, skipPermissions: false, remoteControl: true }],
    [
      'phone',
      { key: k, fork: false, skipPermissions: false, remoteControl: true, askPermissions: true }
    ],
    ['api', { key: k, fork: false, skipPermissions: true, billingAccountId: IDS.account }],
    [
      'api-remote',
      {
        key: k,
        fork: false,
        skipPermissions: false,
        billingAccountId: IDS.account,
        remoteControl: true
      }
    ],
    [
      'cwd-override',
      {
        key: k,
        fork: false,
        skipPermissions: true,
        cwdOverride: s.env === 'wsl' ? '/home/alex/elsewhere' : 'C:\\Users\\alex\\Other Folder'
      }
    ],
    [
      'continue',
      { key: k, fork: false, skipPermissions: true, continueFresh: { newSessionId: IDS.cont } }
    ]
  ]
  for (const t of TERMINALS)
    out.push([`resume-${t}`, { key: k, fork: false, skipPermissions: true, terminal: t }])
  if (branchAt) {
    out.push([
      'branch',
      {
        key: k,
        fork: false,
        skipPermissions: true,
        branch: { at: branchAt, mode: 'include', newSessionId: IDS.branch }
      }
    ])
    out.push([
      'branch-before',
      {
        key: k,
        fork: false,
        skipPermissions: false,
        branch: { at: branchAt, mode: 'before', newSessionId: IDS.branch }
      }
    ])
  }
  return out
}

async function captureState(svc: Services, norm: (s: string) => string) {
  const { sessions, usage, limits, live, summaries, launcher } = svc
  // Background syncs and the lineage refresh (the app's own timers) may still
  // be pending: wait for them first.
  await svc.settled()
  await usage.idle()
  const usageStatus = usage.status()
  const dig = (v: unknown): string => digestOf(v, norm)
  const payload = sessions.payload()
  const list = [...payload.sessions].sort(byKey)
  const hand = list.filter((s) => HAND_WRITTEN.has(s.sessionId))
  // A sample of the generated history: every 9th session by key.
  const sample = list.filter((s, i) => !HAND_WRITTEN.has(s.sessionId) && i % 9 === 0)

  const details: Record<string, unknown> = {}
  for (const s of list) {
    const d = await sessions.detail(s.key)
    details[s.key] = HAND_WRITTEN.has(s.sessionId)
      ? d?.messages
      : { count: d?.messages.length, sha: dig(d?.messages) }
  }

  const search: Record<string, unknown> = {}
  for (const q of [
    'checkout',
    'retries',
    'npm test',
    'dotfiles',
    'safari',
    'migration',
    'prototype',
    'zzzz-none'
  ])
    search[q] = sessions.searchKeys(q)

  const previews: Record<string, unknown> = {}
  for (const s of [...hand, ...sample]) {
    const msgs = (await sessions.detail(s.key))?.messages ?? []
    const at = msgs.length > 2 ? msgs[Math.floor(msgs.length / 2)].id : undefined
    const variants = HAND_WRITTEN.has(s.sessionId)
      ? launchVariants(s, at)
      : launchVariants(s).filter(([n]) => n === 'resume' || n === 'fork')
    const one: Record<string, unknown> = {}
    for (const [name, o] of variants) one[name] = await launcher.preview(o)
    one.modelChoice = launcher.modelChoice(s)
    previews[s.key] = one
  }

  const reports: Record<string, unknown> = {}
  const periods: Period[] = ['hour', 'day', 'week', 'month']
  const dims: Dimension[] = ['model', 'session', 'project', 'env', 'version', 'billing', 'source']
  // In full: a month view and last week by model and by session (their raw
  // record lists hashed); the rest hashed.
  const full = new Set(['all-month', 'week-model', 'week-session'])
  const keep = (name: string, r: unknown): unknown => {
    if (!full.has(name)) return dig(r)
    const { raw, ...rest } = r as { raw?: unknown }
    return { ...rest, raw: dig(raw) }
  }
  for (const period of periods)
    reports[`all-${period}`] = keep(`all-${period}`, usage.report({ period }))
  for (const groupBy of dims)
    reports[`week-${groupBy}`] = keep(
      `week-${groupBy}`,
      usage.report({ period: 'day', groupBy, from: FIXTURES_NOW - 7 * 864e5, to: FIXTURES_NOW })
    )
  const sessionUsage: Record<string, unknown> = {}
  for (const s of [...hand, ...sample]) sessionUsage[s.key] = usage.sessionUsage(s.key)
  const records = [...usage.allRecords()].sort((a, b) => a.id.localeCompare(b.id) || a.ts - b.ts)

  const limitsState = await limits.state()
  const summaryPreviews: Record<string, unknown> = {}
  for (const s of hand) {
    if (s.availability === 'imported') continue
    const p = await summaries.preview(s.key).catch((e: unknown) => ({ error: String(e) }))
    const { id: _id, ...rest } = p as { id?: string }
    summaryPreviews[s.key] = rest
  }

  const liveSnap = live.snapshot()
  return {
    sources: [...payload.sources].sort(byId),
    scan: payload.scan,
    // Hand-written sessions in full; the generated history one hash per session.
    sessions: list.map((s) => (HAND_WRITTEN.has(s.sessionId) ? s : { key: s.key, sha: dig(s) })),
    details,
    search,
    previews,
    reports,
    sessionUsage,
    usageStatus,
    records: { count: records.length, sha: dig(records) },
    turns: {
      count: usage.allTurns().length,
      sha: dig([...usage.allTurns()].sort((a, b) => a.id.localeCompare(b.id) || a.ts - b.ts))
    },
    limitHits: usage.limitHits(),
    usageCommandReadings: usage.usageCommandReadings(),
    limits: limitsState,
    health: { five_hour: limits.health('five_hour'), seven_day: limits.health('seven_day') },
    readings: limits.readings().length,
    live: { ...liveSnap, sessions: [...liveSnap.sessions].sort(byKey) },
    summaryPreviews,
    phone: {
      sessions: (() => {
        const p = phoneSessions({
          ...payload,
          sessions: list,
          sources: [...payload.sources].sort(byId)
        })
        return { ...p, sessions: p.sessions.map((s) => ({ key: s.key, sha: dig(s) })) }
      })(),
      limits: dig(phoneLimits(limitsState)),
      live: phoneLive(liveSnap),
      settings: phoneSettings(svc.settings.value)
    }
  }
}

/** Launches that write (restore, branch, Continue fresh, tags) and what they left. */
async function captureLaunches(svc: Services, norm: (s: string) => string) {
  const { sessions, launcher, layout } = svc
  const out: Record<string, unknown> = {}
  const get = (id: string) => sessions.list().find((s) => s.sessionId === id)!
  const archived = get('9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b')
  out.restore = await launcher.launch({
    key: archived.key,
    fork: false,
    skipPermissions: true,
    cwdOverride: 'C:\\Users\\alex\\code\\new place'
  })
  const safari = get('7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d')
  out.fork = await launcher.launch({ key: safari.key, fork: true, skipPermissions: false })
  out.api = await launcher.launch({
    key: safari.key,
    fork: false,
    skipPermissions: true,
    billingAccountId: IDS.account
  })
  const moment = get('2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b')
  const msgs = (await sessions.detail(moment.key))?.messages ?? []
  svc.settings.update((s) => {
    s.branchConfirmed = true
  })
  out.branch = await launcher.launch({
    key: moment.key,
    fork: false,
    skipPermissions: true,
    branch: {
      at: msgs[Math.floor(msgs.length / 2)].id,
      mode: 'include',
      newSessionId: IDS.branch,
      createOnly: true
    }
  })
  const orders = get('e9a1b2c3-d4e5-4f60-8172-839405a6b7c8')
  sessions.setAiSummary(orders.key, {
    title: 'Orders API retries',
    done: ['Added retry with backoff to the orders client'],
    files: ['src/orders/client.ts'],
    decisions: ['Retry only idempotent requests'],
    todos: ['Add a jitter test'],
    pickUp: 'Write the jitter test',
    model: 'claude-sonnet-5-5',
    generatedAt: new Date().toISOString(),
    messageCount: orders.messageCount
  })
  const legacy = get('c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c')
  sessions.setAiSummary(legacy.key, {
    done: ['Packaged the desktop app'],
    files: [],
    decisions: [],
    todos: [],
    pickUp: 'Sign the installer',
    generatedAt: new Date().toISOString(),
    messageCount: legacy.messageCount
  })
  out.continuePreviewWsl = await launcher.preview({
    key: orders.key,
    fork: false,
    skipPermissions: true,
    continueFresh: { newSessionId: IDS.cont }
  })
  out.continueWsl = await launcher.launch({
    key: orders.key,
    fork: false,
    skipPermissions: true,
    continueFresh: { newSessionId: IDS.cont }
  })
  out.continuePreviewWin = await launcher.preview({
    key: legacy.key,
    fork: false,
    skipPermissions: true,
    remoteControl: true,
    continueFresh: { newSessionId: '2f3a4b5c-6d7e-4f80-91a2-b3c4d5e6f708' }
  })
  out.continueWin = await launcher.launch({
    key: legacy.key,
    fork: false,
    skipPermissions: true,
    remoteControl: true,
    continueFresh: { newSessionId: '2f3a4b5c-6d7e-4f80-91a2-b3c4d5e6f708' }
  })
  out.shellWin = await launcher.openShell(safari.key)
  out.shellWsl = await launcher.openShell(orders.key)
  await svc.idle()
  const raw = await readFile(svc.paths.metadataFile, 'utf8')
  const dig = (v: unknown): string => digestOf(v, norm)
  out.after = {
    sessions: [...sessions.list()]
      .sort(byKey)
      .filter((s) => HAND_WRITTEN.has(s.sessionId) || s.sessionId === IDS.branch),
    lineage: [...sessions.list()]
      .sort(byKey)
      .map((s) => [s.key, s.lineage ?? null])
      .filter(([, l]) => l),
    metadata: (() => {
      const m = JSON.parse(raw) as { archive: Record<string, { sessionId: string }> }
      const archive: Record<string, unknown> = {}
      for (const [k, r] of Object.entries(m.archive))
        archive[k] = HAND_WRITTEN.has(r.sessionId) || r.sessionId === IDS.branch ? r : dig(r)
      return { ...m, archive }
    })(),
    sources: await fileHashes(layout.sourcesDir, norm, (rel) => /\/sessions\/\d+\.json$/.test(rel)),
    handoffs: await fileHashes(join(svc.paths.dataDir, 'handoffs'), norm)
  }
  return out
}

/** The app's data files (what a backup and the next start read). */
async function captureDataFiles(svc: Services, norm: (s: string) => string) {
  const dataDir = svc.paths.dataDir
  const collected = await collectFiles(dataDir)
  const files = await fileHashes(dataDir, norm, (rel) => rel.startsWith('backups/'))
  return {
    files,
    backup: canon(collected, (s) => norm(s)),
    cacheFiles: (await readdir(join(dataDir, 'cache')).catch(() => [])).sort()
  }
}

export interface GoldenResult {
  first: unknown
  data: unknown
  restart: unknown
  dataAfterRestart: unknown
  launches: unknown
}

/**
 * Run everything in `root` (an empty temp folder). The caller has frozen
 * `Date` at FIXTURES_NOW and set the time zone.
 */
export async function captureGolden(root: string): Promise<unknown> {
  setClockOffset(0)
  const norm = makeNormalizer(root)
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { usageHistory: true })
  // Fixed file times: copies get "now" on the real clock otherwise.
  const fixed = new Date(FIXTURES_NOW - 3_600_000)
  for (const p of await walk(fixturesLayout(root).sourcesDir)) await utimes(p, fixed, fixed)

  const svc = await services(root, { seed: true })
  const first = await captureState(svc, norm)
  await svc.idle()
  const data = await captureDataFiles(svc, norm)

  // A second start on the same data: the cache, usage index and archive are
  // reused as they are, and nothing changes.
  const again = await services(root, { seed: false })
  const restart = await captureState(again, norm)
  await again.idle()
  const dataAfterRestart = await captureDataFiles(again, norm)

  const launches = await captureLaunches(again, norm)

  const result: GoldenResult = {
    first,
    data,
    restart: sameOrDiff(first, restart, norm),
    dataAfterRestart: sameOrDiff(data, dataAfterRestart, norm),
    launches
  }
  const out = canon(result, norm)
  assertMachineFree(JSON.stringify(out), root)
  return out
}

/** Where two captures differ: "path: a -> b" (empty when the same). */
function sameOrDiff(a: unknown, b: unknown, norm: (s: string) => string): string[] {
  return differences(canon(a, norm), canon(b, norm), 1000)
}

/** Where two snapshots differ: "path: want -> got", at most `max` of them. */
export function differences(want: unknown, got: unknown, max = 40): string[] {
  const out: string[] = []
  const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 300) ?? 'undefined'
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (out.length >= max || JSON.stringify(a) === JSON.stringify(b)) return
    // Only descend into two arrays or two objects: [] and {} (or ['a'] and
    // {0: 'a'}) have the same keys but are different values.
    const both =
      !!a &&
      !!b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      Array.isArray(a) === Array.isArray(b)
    if (both) {
      const before = out.length
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
      // Different, but no child said why: report the node itself, so a
      // difference can never come back as "none".
      if (out.length > before) return
    }
    out.push(`${path}: ${show(a)} -> ${show(b)}`)
  }
  walk(want, got, '')
  return out
}

/** No temp folder, user name or home path may survive normalizing. */
function assertMachineFree(text: string, root: string): void {
  const leaks = [basename(root), userInfo().username, homedir(), homedir().replace(/\\/g, '\\\\')]
    .filter((s) => s && s.length > 2)
    .filter((s) => text.toLowerCase().includes(s.toLowerCase()))
  if (leaks.length) throw new Error(`machine-specific text in the snapshot: ${leaks.join(', ')}`)
}
