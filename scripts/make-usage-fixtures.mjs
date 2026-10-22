// Generates 13 weeks of realistic usage history for fixtures mode (Phase 5):
//   fixtures/usage/windows/…, fixtures/usage/wsl/…   session files with token usage
//   fixtures/usage/limits-history.ndjson               status line bridge readings
//   fixtures/usage/live/<source>/…                     the latest bridge payloads
//   fixtures/usage/admin/*.json                        Admin API usage and cost reports
//   fixtures/usage/seed.json                           accounts, credit grants, billing tags
// Run with `node scripts/make-usage-fixtures.mjs`. Output is deterministic.

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usage')
const NOW = Date.parse('2026-10-22T15:40:00Z')
const START = Date.parse('2026-07-20T00:00:00Z')
const H = 3_600_000
const MIN = 60_000

// ------------------------------------------------------------------ random

let seed = 20261022
function rand() {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => a + rand() * (b - a)
const int = (a, b) => Math.floor(between(a, b + 1))
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const chance = (p) => rand() < p
let seq = 0
const hash = (s) => createHash('sha1').update(`${s}:${seq++}`).digest('hex')
const uuid = (s = '') => {
  const h = hash(s)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const shortId = (p) =>
  `${p}_01${createHash('sha1').update(`id${seq++}`).digest('base64url').slice(0, 22)}`

// --------------------------------------------------------------- projects

const WIN = { kind: 'windows', home: join(root, 'windows', 'Users', 'beau') }
const WSL = { kind: 'wsl', home: join(root, 'wsl', 'Ubuntu', 'home', 'beau') }

const PROJECTS = [
  {
    env: WIN,
    cwd: 'C:\\Users\\beau\\code\\acme-web',
    branches: ['main', 'feat/checkout-v2', 'fix/hydration', 'chore/deps'],
    prompts: [
      'The checkout page flashes the old price for a second after applying a coupon. Find out why and fix it.',
      'Add an end-to-end test for the guest checkout flow with Playwright.',
      'Hydration warnings on /products/[slug] in production. Can you track them down?',
      'Refactor the cart store to use a reducer, keep the public API the same.',
      'Upgrade Next.js to the latest minor and fix whatever breaks.',
      'Our Lighthouse score dropped to 61 on mobile. Profile the home page and suggest fixes.',
      'Write a migration that backfills the new `currency` column on orders.',
      'The search box fires a request on every keystroke. Debounce it and cancel stale requests.'
    ]
  },
  {
    env: WIN,
    cwd: 'C:\\Users\\beau\\code\\claude-session-dashboard',
    branches: ['main', 'feat/usage', 'fix/wsl-paths'],
    prompts: [
      'Add a usage view that shows tokens per day as a stacked chart.',
      'WSL paths with spaces break the resume command. Reproduce it in a test and fix it.',
      'Make the session list virtualized, it gets slow past 2,000 sessions.',
      'Write the README section on how live limits work.',
      'The archive copies a file twice when it grows during the copy. Fix the race.'
    ]
  },
  {
    env: WIN,
    cwd: 'C:\\Users\\beau\\My Projects\\desktop-app',
    branches: ['master', 'feature/auto-update'],
    prompts: [
      'Set up auto-update with electron-updater and a GitHub releases feed.',
      'The tray menu shows twice on Windows 11 after sleep. Figure out why.',
      'Port the settings window from IPC callbacks to invoke/handle.'
    ]
  },
  {
    env: WSL,
    cwd: '/home/beau/projects/orders-api',
    branches: ['main', 'feature/pagination', 'perf/indexes', 'fix/idempotency'],
    prompts: [
      'Requests to POST /orders are sometimes processed twice. Add idempotency keys.',
      'Add cursor-based pagination to GET /orders and update the OpenAPI spec.',
      'The orders list query takes 2s on prod data. Find the missing index.',
      'Write table-driven tests for the price calculation package.',
      'Add structured logging with request ids across the HTTP handlers.',
      'Migrate from lib/pq to pgx and keep the transaction helpers working.'
    ]
  },
  {
    env: WSL,
    cwd: '/home/beau/projects/ml-pipeline',
    branches: ['main', 'exp/feature-store'],
    prompts: [
      'The nightly training job OOMs at the feature join. Make it stream in chunks.',
      'Add a data validation step with pandera before training.',
      'Write a small CLI to compare two model runs from their metrics files.',
      'Port the notebook prototype for churn prediction into the pipeline package.'
    ]
  },
  {
    env: WSL,
    cwd: '/home/beau/dotfiles',
    branches: ['main'],
    prompts: [
      'Clean up my zshrc, it takes 1.4s to start. Lazy-load nvm and pyenv.',
      'Add a tmux layout script for the orders-api project.',
      'Make my git aliases work in both bash and zsh.'
    ]
  }
]

const FOLLOW_UPS = [
  'Looks good. Can you also add a test for the edge case with an empty list?',
  'Run the full test suite and fix anything that fails.',
  'Great. Now update the docs to match.',
  'Can you explain why that works? Keep it short.',
  'Use the existing helper in utils instead of writing a new one.',
  'Commit this with a clear message.',
  'Also handle the error path, right now it just logs.',
  'Perfect, ship it. Then check the other call sites for the same bug.',
  'Rename that to something clearer and keep going.',
  'What about Windows line endings?'
]
const CORRECTIONS = [
  "no, don't change the public API, keep the old function and add a new one",
  "that's not what I meant. The bug is in the server, not the client.",
  'wrong file, the config lives in packages/core',
  'no, revert that and try a smaller change first'
]
const REPLIES = [
  'Found it. The value is read before the async update finishes, so the first render uses the stale state. I moved the read into the effect and added a guard.',
  "Here's the plan:\n\n1. Reproduce it with a failing test\n2. Fix the root cause\n3. Run the suite\n\nStarting with the test.",
  'Done. All 214 tests pass. The change is limited to two files.',
  'The slow part is a sequential scan on `orders.customer_id`. A composite index on `(customer_id, created_at DESC)` brings it down to 12 ms.',
  'I updated the call sites and kept the old name as a deprecated alias so nothing else breaks.',
  "That works because the key is checked inside the same transaction as the insert, so two concurrent requests can't both pass the check.",
  'Tests are green. I also fixed a flaky timeout in the integration suite while I was there.'
]
const THINK = [
  'The user wants the minimal change. I should read the file first, then check where else this function is called before editing.',
  'Two possibilities: a race between the fetch and the state update, or a stale memoized value. The flash suggests the first. Let me look at the effect order.',
  'Running the whole suite takes a while; I will run the package tests first and only then the full suite.',
  'The index needs to match the ORDER BY to avoid a sort. customer_id first, then created_at descending.'
]
const TOOLS = [
  [
    'Read',
    (p) => ({ file_path: p.file }),
    () =>
      'export function total(items) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0)\n}\n'
  ],
  [
    'Grep',
    () => ({
      pattern: pick(['useCart', 'idempotency', 'currency', 'retry']),
      output_mode: 'files_with_matches'
    }),
    () => 'Found 3 files'
  ],
  [
    'Edit',
    (p) => ({ file_path: p.file, old_string: 'const a = 1', new_string: 'const a = 2' }),
    (p) => `The file ${p.file} has been updated.`
  ],
  [
    'Bash',
    (p) => ({ command: p.test, description: 'Run tests' }),
    () => 'ok  \t214 passed, 0 failed (3.2s)'
  ],
  [
    'Bash',
    () => ({ command: 'git status --short', description: 'Show changes' }),
    () => ' M src/cart.ts\n M src/cart.test.ts'
  ],
  ['Glob', () => ({ pattern: 'src/**/*.ts' }), () => 'src/index.ts\nsrc/cart.ts\nsrc/api/orders.ts']
]

// ---------------------------------------------------------- model eras

function era(ts) {
  if (ts < Date.parse('2026-08-25T00:00:00Z'))
    return {
      models: [
        ['claude-opus-4-8', 0.6],
        ['claude-sonnet-4-6', 0.4]
      ],
      v: [184, 205]
    }
  if (ts < Date.parse('2026-09-29T00:00:00Z'))
    return {
      models: [
        ['claude-opus-5', 0.65],
        ['claude-sonnet-5', 0.35]
      ],
      v: [212, 255]
    }
  return {
    models: [
      ['claude-opus-5-5', 0.72],
      ['claude-sonnet-5-5', 0.28]
    ],
    v: [262, 304]
  }
}
function pickModel(e) {
  let r = rand()
  for (const [m, w] of e.models) if ((r -= w) <= 0) return m
  return e.models[0][0]
}
function versionAt(ts) {
  const e = era(ts)
  const span = Date.parse('2026-10-22T00:00:00Z') - START
  const f = Math.min(1, Math.max(0, (ts - START) / span))
  const lo = e.v[0]
  const hi = e.v[1]
  const eraStart =
    ts < Date.parse('2026-08-25T00:00:00Z')
      ? START
      : ts < Date.parse('2026-09-29T00:00:00Z')
        ? Date.parse('2026-08-25T00:00:00Z')
        : Date.parse('2026-09-29T00:00:00Z')
  const eraEnd =
    ts < Date.parse('2026-08-25T00:00:00Z')
      ? Date.parse('2026-08-25T00:00:00Z')
      : ts < Date.parse('2026-09-29T00:00:00Z')
        ? Date.parse('2026-09-29T00:00:00Z')
        : NOW
  const g = Math.min(1, Math.max(0, (ts - eraStart) / (eraEnd - eraStart)))
  void f
  return `2.1.${Math.round(lo + (hi - lo) * g)}`
}

/** Realistic Claude Code usage for one API response. */
function usageFor(model, ctxTokens, ts) {
  const opus = model.includes('opus')
  const late = ts > Date.parse('2026-10-08T00:00:00Z') && model === 'claude-opus-5-5'
  const out = Math.round(
    between(60, 900) * (opus ? 1.25 : 1) * (late ? 0.86 : 1) +
      (chance(0.12) ? between(800, 4000) : 0)
  )
  const cacheWrite = Math.round(chance(0.25) ? between(4000, 28000) : between(200, 3500))
  return {
    input_tokens: int(3, 60),
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: Math.round(ctxTokens),
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite },
    output_tokens: out,
    service_tier: 'standard',
    ...(chance(0.04)
      ? { server_tool_use: { web_search_requests: int(1, 3), web_fetch_requests: 0 } }
      : {})
  }
}
const WEIGHTS = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }
const weighted = (u) =>
  u.input_tokens * WEIGHTS.input +
  u.output_tokens * WEIGHTS.output +
  u.cache_creation_input_tokens * WEIGHTS.cacheWrite +
  u.cache_read_input_tokens * WEIGHTS.cacheRead

// ------------------------------------------------------- session plans

rmSync(join(root, 'windows'), { recursive: true, force: true })
rmSync(join(root, 'wsl'), { recursive: true, force: true })

const sessions = []
const apiProjects = new Set(['/home/beau/projects/ml-pipeline'])
const API_FROM = Date.parse('2026-10-05T00:00:00Z')

function planSession(project, start, opts = {}) {
  const id = opts.id ?? uuid(project.cwd)
  const s = {
    id,
    project,
    start,
    branch: pick(project.branches),
    prompt: opts.prompt ?? pick(project.prompts),
    turns: [],
    billing: apiProjects.has(project.cwd) && start >= API_FROM ? 'api' : 'subscription',
    model: pickModel(era(start)),
    truncatedAt: undefined,
    limitHit: undefined
  }
  let t = start
  let ctx = between(14000, 22000)
  const nTurns = opts.turns ?? int(4, 9)
  for (let i = 0; i < nTurns; i++) {
    const turn = {
      ts: Math.round(t),
      text: i === 0 ? s.prompt : pick(FOLLOW_UPS),
      responses: [],
      interrupted: false
    }
    if (i > 0 && chance(0.07)) turn.text = pick(CORRECTIONS)
    const n = int(2, 6)
    let rt =
      t +
      between(2.5, 9) *
        1000 *
        (s.model.includes('opus') ? 1.3 : 1) *
        (t > Date.parse('2026-10-08T00:00:00Z') ? 1.15 : 1)
    for (let j = 0; j < n; j++) {
      ctx = Math.min(ctx + between(1500, 9000), 190000)
      const u = usageFor(s.model, ctx, rt)
      turn.responses.push({
        ts: Math.round(rt),
        usage: u,
        tool: j < n - 1 ? pick(TOOLS) : null,
        thinking: chance(0.32) ? pick(THINK) : null,
        toolError: chance(0.07),
        apiError: chance(0.012)
      })
      rt += between(4, 40) * 1000
    }
    if (i > 0 && chance(0.05)) turn.interrupted = true
    s.turns.push(turn)
    t = rt + between(1.5, 9) * MIN
    if (chance(0.06)) ctx = between(18000, 30000) // compacted
  }
  sessions.push(s)
  return s
}

// Working days: 1–3 sessions; weekends: sometimes one.
for (let day = START; day < Date.parse('2026-10-22T00:00:00Z'); day += 24 * H) {
  const wd = new Date(day).getUTCDay()
  const weekend = wd === 0 || wd === 6
  const n = weekend ? (chance(0.3) ? 1 : 0) : int(1, 2)
  let t = day + between(13, 15) * H
  for (let i = 0; i < n; i++) {
    const project = pick(PROJECTS)
    const s = planSession(project, t)
    const last = s.turns[s.turns.length - 1]
    t = last.responses[last.responses.length - 1].ts + between(0.5, 3) * H
    if (new Date(t).getUTCHours() > 23 || new Date(t).getUTCHours() < 6) break
  }
}
// Today (the fixture "now"): one long morning session that is still running.
planSession(PROJECTS[3], Date.parse('2026-10-22T12:54:10Z'), {
  turns: 7,
  prompt:
    'The /orders export times out for big customers. Stream the CSV instead of building it in memory.'
})
planSession(PROJECTS[0], Date.parse('2026-10-22T14:58:00Z'), {
  turns: 3,
  prompt: 'Add a "copy order number" button to the order confirmation page.'
})

// -------------------------------------------- windows, limits, readings

// Capacity per 5-hour window and per week, in weighted tokens. Limits were
// tightened on Oct 1: the detector should notice a ~25% drop.
const CUT = Date.parse('2026-10-01T00:00:00Z')
const cap5h = (ts) => (ts < CUT ? 2.1e6 : 1.6e6)
const capWeek = (ts) => (ts < CUT ? 6.6e6 : 4.95e6)
// Weekly windows reset on Sundays at 09:00 UTC.
const WEEK_ANCHOR = Date.parse('2026-07-19T09:00:00Z')
const weekStartOf = (ts) => WEEK_ANCHOR + Math.floor((ts - WEEK_ANCHOR) / (7 * 24 * H)) * 7 * 24 * H

const all = []
for (const s of sessions)
  for (const turn of s.turns) for (const r of turn.responses) all.push({ s, turn, r })
all.sort((a, b) => a.r.ts - b.r.ts)

const readings = []
let win5 = null
let week = null
const dropped = new Set()
for (const item of all) {
  const { s, r } = item
  if (r.ts > NOW || dropped.has(s)) continue
  if (s.billing === 'api') {
    item.reading = true
    continue
  }
  if (!win5 || r.ts >= win5.end) win5 = { start: r.ts, end: r.ts + 5 * H, used: 0 }
  const ws = weekStartOf(r.ts)
  if (!week || week.start !== ws) week = { start: ws, end: ws + 7 * 24 * H, used: 0 }
  const w = weighted(r.usage)
  win5.used += w
  week.used += w
  const p5 = (win5.used / cap5h(r.ts)) * 100
  const pw = (week.used / capWeek(r.ts)) * 100
  if (p5 >= 100 || pw >= 100) {
    // Claude Code stops here with a limit message until the window resets.
    s.truncatedAt = r.ts
    s.limitHit = { ts: r.ts + 2000, resetsAt: pw >= 100 ? week.end : win5.end, weekly: pw >= 100 }
    dropped.add(s)
    continue
  }
  r.fiveHour = { pct: Math.round(p5 * 10) / 10, resetsAt: win5.end }
  r.sevenDay = { pct: Math.round(pw * 10) / 10, resetsAt: week.end }
}

// --------------------------------------------------------------- writing

function encodeProject(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}
function sessionFile(s) {
  return join(
    s.project.env.home,
    '.claude',
    'projects',
    encodeProject(s.project.cwd),
    `${s.id}.jsonl`
  )
}

const testCmd = (cwd) =>
  cwd.includes('orders-api')
    ? 'go test ./...'
    : cwd.includes('ml-pipeline')
      ? 'pytest -q'
      : cwd.includes('dotfiles')
        ? 'shellcheck *.sh'
        : 'npm test'
const sampleFile = (cwd) =>
  cwd.startsWith('/')
    ? `${cwd}/${pick(['internal/http/orders.go', 'pkg/price/calc.go', 'pipeline/train.py', 'zshrc'])}`
    : `${cwd}\\${pick(['src\\cart\\store.ts', 'src\\app\\checkout\\page.tsx', 'src\\main\\index.ts'])}`

const billingSeed = {}
let costTotal = 0
const apiCostBySession = {}
const priceOf = {
  'claude-opus-5-5': [4, 20, 8, 0.2],
  'claude-sonnet-5-5': [2, 10, 4, 0.1]
}

for (const s of sessions) {
  const lines = []
  let parent = null
  const version = versionAt(s.start)
  const base = (type, ts) => {
    const u = uuid(s.id)
    const e = {
      parentUuid: parent,
      isSidechain: false,
      userType: 'external',
      cwd: s.project.cwd,
      sessionId: s.id,
      version,
      gitBranch: s.branch,
      type,
      uuid: u,
      timestamp: new Date(ts).toISOString()
    }
    parent = u
    return e
  }
  let sessionCost = 0
  outer: for (const turn of s.turns) {
    if (turn.ts > NOW) break
    if (s.truncatedAt !== undefined && turn.ts > s.truncatedAt) break
    const u = base('user', turn.ts)
    u.message = { role: 'user', content: turn.text }
    lines.push(JSON.stringify(u))
    for (let i = 0; i < turn.responses.length; i++) {
      const r = turn.responses[i]
      if (r.ts > NOW) break outer
      if (s.truncatedAt !== undefined && r.ts >= s.truncatedAt) {
        const hit = s.limitHit
        const e = base('assistant', hit.ts)
        const reset = new Date(hit.resetsAt)
        const text =
          hit.ts < Date.parse('2026-09-01T00:00:00Z')
            ? `Claude AI usage limit reached|${Math.floor(hit.resetsAt / 1000)}`
            : hit.weekly
              ? `Weekly limit reached ∙ resets ${reset.toUTCString().slice(0, 11)}`
              : `5-hour limit reached ∙ resets ${String(reset.getUTCHours() % 12 || 12)}${reset.getUTCHours() < 12 ? 'am' : 'pm'}`
        e.message = {
          id: uuid('syn'),
          model: '<synthetic>',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text }],
          stop_reason: 'stop_sequence',
          usage: { input_tokens: 0, output_tokens: 0 }
        }
        e.isApiErrorMessage = true
        lines.push(JSON.stringify(e))
        break outer
      }
      if (r.apiError) {
        const e = base('system', r.ts - 1500)
        Object.assign(e, {
          subtype: 'api_error',
          level: 'error',
          retryInMs: 1200,
          retryAttempt: 1,
          error: { status: 529, message: 'Overloaded' }
        })
        lines.push(JSON.stringify(e))
      }
      const msgId = shortId('msg')
      const reqId = shortId('req')
      const blocks = []
      if (r.thinking)
        blocks.push({ type: 'thinking', thinking: r.thinking, signature: 'Eq' + 'x'.repeat(24) })
      if (r.tool) {
        const [name, input] = r.tool
        blocks.push({
          type: 'tool_use',
          id: shortId('toolu'),
          name,
          input: input({ file: sampleFile(s.project.cwd), test: testCmd(s.project.cwd) })
        })
      } else {
        blocks.push({ type: 'text', text: pick(REPLIES) })
      }
      const isLast = i === turn.responses.length - 1
      // Claude Code writes one line per content block, all with the same ids and usage.
      blocks.forEach((b, k) => {
        const e = base('assistant', r.ts + k * 400)
        e.message = {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: s.model,
          content: [b],
          stop_reason: k === blocks.length - 1 ? (r.tool ? 'tool_use' : 'end_turn') : null,
          stop_sequence: null,
          usage: r.usage
        }
        e.requestId = reqId
        lines.push(JSON.stringify(e))
      })
      if (r.tool) {
        const toolBlock = blocks[blocks.length - 1]
        const e = base('user', r.ts + 1800)
        const out = r.tool[2]({ file: toolBlock.input.file_path ?? 'file' })
        e.message = {
          role: 'user',
          content: [
            {
              tool_use_id: toolBlock.id,
              type: 'tool_result',
              content: r.toolError ? 'Error: command failed with exit code 1' : out,
              ...(r.toolError ? { is_error: true } : {})
            }
          ]
        }
        lines.push(JSON.stringify(e))
      }
      if (s.billing === 'api') {
        const p = priceOf[s.model] ?? [4, 20, 8, 0.2]
        const u = r.usage
        sessionCost +=
          (u.input_tokens * p[0] +
            u.output_tokens * p[1] +
            u.cache_creation_input_tokens * p[2] +
            u.cache_read_input_tokens * p[3]) /
          1e6
      }
      if (isLast && turn.interrupted) {
        const e = base('user', r.ts + 3000)
        e.message = {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }]
        }
        lines.push(JSON.stringify(e))
      }
    }
  }
  if (!lines.length) continue
  const path = sessionFile(s)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.join('\n') + '\n')
  if (s.billing === 'api') {
    billingSeed[s.id] = { mode: 'api', accountId: 'acct-personal' }
    apiCostBySession[s.id] = Math.round(sessionCost * 100) / 100
    costTotal += sessionCost
  }
}

// Bridge readings: one per few responses (the status line runs on every update).
const sourceOf = (s) => (s.project.env.kind === 'windows' ? 'windows' : 'wsl-Ubuntu-beau')
const ctxPct = (u) =>
  Math.min(
    100,
    Math.round(
      ((u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens) / 200000) * 100
    )
  )
let last = 0
for (const { s, r } of all) {
  if (r.ts > NOW || (s.truncatedAt !== undefined && r.ts >= s.truncatedAt)) continue
  if (s.billing === 'api') {
    if (r.ts - last < 6 * MIN) continue
    last = r.ts
    readings.push({
      ts: r.ts + 900,
      source: sourceOf(s),
      sessionId: s.id,
      model: s.model,
      modelName: s.model.includes('opus') ? 'Opus' : 'Sonnet',
      version: versionAt(s.start),
      cwd: s.project.cwd,
      costUsd: apiCostBySession[s.id],
      contextPct: ctxPct(r.usage),
      contextSize: 200000
    })
    continue
  }
  if (!r.fiveHour || r.ts - last < 6 * MIN) continue
  last = r.ts
  readings.push({
    ts: r.ts + 900,
    source: sourceOf(s),
    sessionId: s.id,
    model: s.model,
    modelName: s.model.includes('opus') ? 'Opus' : 'Sonnet',
    version: versionAt(s.start),
    cwd: s.project.cwd,
    fiveHour: r.fiveHour,
    sevenDay: r.sevenDay,
    costUsd: undefined,
    contextPct: ctxPct(r.usage),
    contextSize: 200000
  })
}
readings.sort((a, b) => a.ts - b.ts)

rmSync(join(root, 'limits-history.ndjson'), { force: true })
mkdirSync(root, { recursive: true })
// Leave the newest readings for the live files (the app records them on start).
const latestByEnv = {}
for (const r of readings) latestByEnv[r.source] = r
const history = readings.filter((r) => !Object.values(latestByEnv).includes(r))
writeFileSync(
  join(root, 'limits-history.ndjson'),
  history.map((r) => JSON.stringify(r)).join('\n') + '\n'
)

// The raw status line payloads the bridge script saved most recently.
rmSync(join(root, 'live'), { recursive: true, force: true })
for (const r of Object.values(latestByEnv)) {
  const s = sessions.find((x) => x.id === r.sessionId)
  const payload = {
    session_id: r.sessionId,
    transcript_path:
      s.project.env.kind === 'windows'
        ? `C:\\Users\\beau\\.claude\\projects\\${encodeProject(s.project.cwd)}\\${s.id}.jsonl`
        : `/home/beau/.claude/projects/${encodeProject(s.project.cwd)}/${s.id}.jsonl`,
    cwd: r.cwd,
    model: { id: r.model, display_name: r.modelName },
    workspace: { current_dir: r.cwd, project_dir: r.cwd, added_dirs: [] },
    version: r.version,
    output_style: { name: 'default' },
    cost: {
      total_cost_usd: r.costUsd ?? 12.4,
      total_duration_ms: 2_520_000,
      total_api_duration_ms: 610_000,
      total_lines_added: 312,
      total_lines_removed: 88
    },
    context_window: {
      total_input_tokens: 92000,
      total_output_tokens: 3100,
      context_window_size: 200000,
      used_percentage: r.contextPct,
      remaining_percentage: 100 - r.contextPct,
      current_usage: {
        input_tokens: 12,
        output_tokens: 640,
        cache_creation_input_tokens: 2100,
        cache_read_input_tokens: 89888
      }
    },
    exceeds_200k_tokens: false,
    ...(r.fiveHour
      ? {
          rate_limits: {
            five_hour: {
              used_percentage: r.fiveHour.pct,
              resets_at: Math.floor(r.fiveHour.resetsAt / 1000)
            },
            seven_day: {
              used_percentage: r.sevenDay.pct,
              resets_at: Math.floor(r.sevenDay.resetsAt / 1000)
            }
          }
        }
      : {})
  }
  const dir = join(root, 'live', r.source)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${r.sessionId}.json`), JSON.stringify(payload))
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(payload))
  writeFileSync(join(dir, 'captured-at.txt'), new Date(r.ts).toISOString() + '\n')
}

// ------------------------------------------- Admin API fixtures (Acme org)

const adminModels = [
  ['claude-opus-5-5', 1.0],
  ['claude-sonnet-5-5', 2.6],
  ['claude-haiku-5-5', 6.0]
]
const usageBuckets = []
const costBuckets = []
const dayStart = Date.parse('2026-09-22T00:00:00Z')
for (let d = dayStart; d <= Date.parse('2026-10-22T00:00:00Z'); d += 24 * H) {
  const wd = new Date(d).getUTCDay()
  const factor = wd === 0 || wd === 6 ? 0.35 : 1
  const results = []
  const costs = []
  for (const [model, scale] of adminModels) {
    const partial = d === Date.parse('2026-10-22T00:00:00Z') ? 0.62 : 1
    const out = Math.round(between(0.9e6, 1.4e6) * scale * factor * partial)
    const input = Math.round(out * between(2.5, 3.5))
    const read = Math.round(out * between(18, 26))
    const write = Math.round(out * between(1.2, 2))
    results.push({
      uncached_input_tokens: input,
      cache_creation: {
        ephemeral_1h_input_tokens: Math.round(write * 0.3),
        ephemeral_5m_input_tokens: Math.round(write * 0.7)
      },
      cache_read_input_tokens: read,
      output_tokens: out,
      server_tool_use: { web_search_requests: int(0, 40) },
      api_key_id: null,
      workspace_id: null,
      model,
      service_tier: 'standard',
      context_window: '0-200k'
    })
    const p = {
      'claude-opus-5-5': [4, 20, 5, 8, 0.2],
      'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.1],
      'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01]
    }[model]
    const parts = [
      ['input', input * p[0]],
      ['output', out * p[1]],
      ['cache_creation', write * 0.7 * p[2] + write * 0.3 * p[3]],
      ['cache_read', read * p[4]]
    ]
    for (const [tokenType, usd] of parts) {
      costs.push({
        currency: 'USD',
        amount: ((usd / 1e6) * 100).toFixed(4),
        workspace_id: null,
        description: `${model} ${tokenType} tokens`,
        cost_type: 'tokens',
        context_window: '0-200k',
        model,
        service_tier: 'standard',
        token_type:
          tokenType === 'input'
            ? 'uncached_input_tokens'
            : tokenType === 'output'
              ? 'output_tokens'
              : tokenType === 'cache_read'
                ? 'cache_read_input_tokens'
                : 'cache_creation.ephemeral_5m_input_tokens'
      })
    }
  }
  const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z')
  usageBuckets.push({ starting_at: iso(d), ending_at: iso(d + 24 * H), results })
  costBuckets.push({ starting_at: iso(d), ending_at: iso(d + 24 * H), results: costs })
}
rmSync(join(root, 'admin'), { recursive: true, force: true })
mkdirSync(join(root, 'admin'), { recursive: true })
writeFileSync(
  join(root, 'admin', 'usage_report.json'),
  JSON.stringify({ data: usageBuckets, has_more: false, next_page: null }, null, 1)
)
writeFileSync(
  join(root, 'admin', 'cost_report.json'),
  JSON.stringify({ data: costBuckets, has_more: false, next_page: null }, null, 1)
)

// ------------------------------------------------------------ seed data

writeFileSync(
  join(root, 'seed.json'),
  JSON.stringify(
    {
      accounts: [
        {
          id: 'acct-personal',
          nickname: 'Personal credits',
          kind: 'standard',
          masked: 'sk-ant-api03-…Q7xA',
          createdAt: '2026-10-04T18:20:00Z'
        },
        {
          id: 'acct-acme',
          nickname: 'Acme org (admin)',
          kind: 'admin',
          masked: 'sk-ant-admin01-…m2Pd',
          createdAt: '2026-09-30T16:02:00Z'
        }
      ],
      grants: [
        {
          id: 'grant-1',
          accountId: 'acct-personal',
          amountUsd: 100,
          receivedAt: '2026-10-04T00:00:00Z',
          expiresAt: '2027-01-04T00:00:00Z',
          note: 'Anthropic credit grant'
        },
        {
          id: 'grant-2',
          accountId: 'acct-personal',
          amountUsd: 25,
          receivedAt: '2026-10-15T00:00:00Z',
          expiresAt: '2026-11-01T00:00:00Z',
          note: 'Hackathon credits'
        }
      ],
      billing: billingSeed,
      projectBilling: { '/home/beau/projects/ml-pipeline': 'acct-personal' },
      apiCostTotal: Math.round(costTotal * 100) / 100
    },
    null,
    2
  ) + '\n'
)

const written = sessions.filter((s) => s.turns[0].ts <= NOW).length
const maxP5 = Math.max(...readings.filter((r) => r.fiveHour).map((r) => r.fiveHour.pct))
const maxPw = Math.max(...readings.filter((r) => r.sevenDay).map((r) => r.sevenDay.pct))
console.log(`max5h ${maxP5} maxWeek ${maxPw}`)
console.log(
  `sessions: ${written}, readings: ${readings.length}, limit hits: ${sessions.filter((s) => s.limitHit).length}, api cost: $${costTotal.toFixed(2)}`
)
