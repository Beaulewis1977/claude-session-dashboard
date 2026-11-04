// Writes the sample Codex homes in fixtures/codex/ (sample data only).
// Run with Node 22.15+ (it uses node:zlib's zstd to compress two rollouts;
// the app itself reads them with fzstd, pure JS):
//   node scripts/make-codex-fixtures.mjs
//
// Shapes follow real Codex rollouts (key names checked against codex-cli
// 0.163/0.164 and the desktop app), with made-up content.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'codex')
const WIN = join(root, 'windows', 'Users', 'beau', '.codex')
const WSL = join(root, 'wsl', 'Ubuntu', 'home', 'beau', '.codex')

const ID = {
  cli: '019a1111-0000-7000-8000-000000000001',
  desktop: '019a2222-0000-7000-8000-000000000002',
  sub: '019a3333-0000-7000-8000-000000000003',
  fork: '019a4444-0000-7000-8000-000000000004',
  old: '019a5555-0000-7000-8000-000000000005',
  gap: '019a6666-0000-7000-8000-000000000006',
  wsl: '019a7777-0000-7000-8000-000000000007',
  now: '019a8888-0000-7000-8000-000000000008'
}

function rollout(start, lines, { ordinals = true } = {}) {
  let t = Date.parse(start)
  return (
    lines
      .map((l, i) => {
        if (typeof l === 'string') return l // a malformed line, as it is
        t += l.dt ?? 4000
        const rest = { ...l }
        delete rest.dt
        const head = { timestamp: new Date(t).toISOString() }
        if (ordinals) head.ordinal = rest.ordinal ?? i
        delete rest.ordinal
        return JSON.stringify({ ...head, ...rest })
      })
      .join('\n') + '\n'
  )
}

const meta = (id, extra = {}) => ({
  type: 'session_meta',
  payload: {
    id,
    session_id: id,
    timestamp: extra.timestamp,
    cwd: extra.cwd,
    originator: extra.originator ?? 'codex_cli_rs',
    cli_version: extra.cli_version ?? '0.164.0',
    source: extra.source ?? 'cli',
    thread_source: extra.thread_source ?? 'user',
    model_provider: 'openai',
    base_instructions: { text: 'You are Codex, a coding agent. (sample instructions)' },
    history_mode: extra.history_mode ?? 'paginated',
    ...(extra.forked_from_id ? { forked_from_id: extra.forked_from_id } : {}),
    ...(extra.git ? { git: extra.git } : {}),
    ...(extra.more ?? {})
  }
})

const turn = (cwd, model, effort) => ({
  type: 'turn_context',
  payload: {
    turn_id: 't',
    cwd,
    approval_policy: 'on-request',
    sandbox_policy: { type: 'workspace-write' },
    model,
    collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort } }
  }
})

const user = (text) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
})
const env = (cwd) =>
  user(
    `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>powershell</shell>\n</environment_context>`
  )
const dev = {
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [
      { type: 'input_text', text: '<permissions instructions>sample</permissions instructions>' }
    ]
  }
}
const say = (text) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
})
const think = (text) => ({
  type: 'response_item',
  payload: {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text }],
    encrypted_content: 'gAAAAA-sample-not-readable'
  }
})
const shell = (callId, command, output) => [
  {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell_command',
      arguments: JSON.stringify({ command, workdir: '.' }),
      call_id: callId
    }
  },
  {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output }
  }
]
const patch = (callId, file, body) => [
  {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'apply_patch',
      status: 'completed',
      call_id: callId,
      input: `*** Begin Patch\n*** Update File: ${file}\n${body}\n*** End Patch`
    }
  },
  {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: callId,
      output: [{ type: 'input_text', text: `Success. Updated the following files:\nM ${file}` }]
    }
  }
]
// Token counts as Codex writes them: each response's own usage (last) and the
// session's running total; input includes cached input, output includes reasoning.
const usage = (u = {}) => {
  const input = u.input ?? 0
  const output = u.output ?? 0
  return {
    input_tokens: input,
    cached_input_tokens: u.cached ?? 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: u.reasoning ?? 0,
    total_tokens: input + output
  }
}
function counter(window = 272000) {
  let total = usage()
  return (last, rateLimits = null) => {
    const l = usage(last)
    total = Object.fromEntries(Object.keys(total).map((k) => [k, total[k] + l[k]]))
    return {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { ...total },
          last_token_usage: l,
          model_context_window: window
        },
        rate_limits: rateLimits
      }
    }
  }
}
const sec = (iso) => Math.round(Date.parse(iso) / 1000)
const credits = { has_credits: false, unlimited: false, balance: null }
/** Plus: a 5-hour and a weekly window. */
const plus = (p5, r5, pw, rw) => ({
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: p5, window_minutes: 300, resets_at: sec(r5) },
  secondary: { used_percent: pw, window_minutes: 10080, resets_at: sec(rw) },
  credits,
  plan_type: 'plus',
  rate_limit_reached_type: null
})
/** Pro ($100, "prolite"): weekly only, reported as primary. */
const pro = (pw, rw) => ({
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: pw, window_minutes: 10080, resets_at: sec(rw) },
  secondary: null,
  credits,
  plan_type: 'prolite',
  rate_limit_reached_type: null
})
/** One model's own limit. */
const spark = (pw, rw) => ({
  limit_id: 'codex_bengalfox',
  limit_name: 'GPT-5.3-Codex-Spark',
  primary: { used_percent: pw, window_minutes: 10080, resets_at: sec(rw) },
  secondary: null,
  credits,
  plan_type: 'prolite',
  rate_limit_reached_type: null
})
/** A next response after `ev`, continuing its running total. */
function after(ev, last, rateLimits) {
  const l = usage(last)
  const t = ev.payload.info.total_token_usage
  return {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: Object.fromEntries(Object.keys(t).map((k) => [k, t[k] + l[k]])),
        last_token_usage: l,
        model_context_window: ev.payload.info.model_context_window
      },
      rate_limits: rateLimits
    }
  }
}
const resend = (ev, rateLimits) => ({ ...ev, payload: { ...ev.payload, rate_limits: rateLimits } })
const PLUS_WEEK = '2026-10-25T08:00:00Z'
const PRO_WEEK = '2026-10-28T12:00:00Z'

// Session 1's token counts, also copied into its fork (session 4) as Codex does.
const cliTokens = counter()
const cliCounts = [
  cliTokens(
    { input: 18000, cached: 9000, output: 900, reasoning: 400 },
    plus(12, '2026-10-20T18:30:00Z', 22, PLUS_WEEK)
  ),
  cliTokens(
    { input: 26000, cached: 17500, output: 1300, reasoning: 600 },
    plus(18, '2026-10-20T18:30:00Z', 24, PLUS_WEEK)
  )
]
const noise = [
  {
    type: 'world_state',
    payload: { full: true, state: { agents_md: { text: 'x'.repeat(2000) } } }
  },
  {
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'command', aggregated_output: 'dup' } }
  },
  { type: 'response_item', payload: { type: 'additional_tools', tools: [{ name: 'a' }] } }
]

function write(path, text, { zstd = false } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, zstd ? zstdCompressSync(Buffer.from(text)) : text)
}

// 1. CLI on Windows, a folder with a space, git info, a patch and a failing then passing test run.
const shopCwd = 'C:\\Users\\beau\\code\\shop api'
write(
  join(WIN, 'sessions', '2026', '10', '20', `rollout-2026-10-20T09-15-00-${ID.cli}.jsonl`),
  rollout('2026-10-20T14:15:00Z', [
    meta(ID.cli, {
      timestamp: '2026-10-20T14:15:00.000Z',
      cwd: shopCwd,
      git: {
        commit_hash: 'a1b2c3d4e5f6',
        branch: 'fix/checkout-totals',
        repository_url: 'https://example.com/beau/shop-api.git'
      }
    }),
    ...noise,
    dev,
    env(shopCwd),
    turn(shopCwd, 'gpt-5.5-codex', 'high'),
    user('The checkout total is off by one cent when a coupon is applied. Find and fix it.'),
    think('Looking for where the coupon discount is rounded.'),
    ...shell(
      'call_1',
      'npm test -- checkout',
      'Exit code: 1\nFAIL tests/checkout.test.ts\n  expected 19.99, got 20.00'
    ),
    think('The discount is rounded before tax instead of after.'),
    ...patch(
      'call_2',
      'src/checkout/total.ts',
      '-  const discounted = round(subtotal - coupon)\n+  const discounted = subtotal - coupon'
    ),
    ...shell('call_3', 'npm test -- checkout', 'Exit code: 0\nPASS tests/checkout.test.ts'),
    ...cliCounts,
    // Codex sends the same counts again when only the limits moved: no new usage.
    resend(cliCounts[1], plus(19, '2026-10-20T18:30:00Z', 24, PLUS_WEEK)),
    say(
      'Fixed: the coupon discount was rounded before tax. `src/checkout/total.ts` now rounds once, at the end, and the checkout tests pass.'
    ),
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Fixed.' } }
  ])
)

// 2. The desktop app (compressed by Codex): originator "Codex Desktop", source "vscode".
const siteCwd = 'C:\\Users\\beau\\code\\marketing-site'
write(
  join(WIN, 'sessions', '2026', '10', '18', `rollout-2026-10-18T14-02-11-${ID.desktop}.jsonl.zst`),
  rollout('2026-10-18T19:02:11Z', [
    meta(ID.desktop, {
      timestamp: '2026-10-18T19:02:11.000Z',
      cwd: siteCwd,
      originator: 'Codex Desktop',
      source: 'vscode',
      git: { branch: 'main' }
    }),
    turn(siteCwd, 'gpt-5.5', 'medium'),
    env(siteCwd),
    user('Add a dark mode toggle to the header.'),
    think('The site uses CSS variables, so a class on <html> is enough.'),
    ...patch('call_1', 'src/components/Header.tsx', '+  <ThemeToggle />'),
    counter(272000)(
      { input: 14000, cached: 6000, output: 700, reasoning: 200 },
      plus(8, '2026-10-18T23:30:00Z', 9, PLUS_WEEK)
    ),
    say('Added a ThemeToggle to the header; it stores the choice in localStorage.')
  ]),
  { zstd: true }
)

// 3. A subagent thread started by session 1.
write(
  join(WIN, 'sessions', '2026', '10', '20', `rollout-2026-10-20T09-20-30-${ID.sub}.jsonl`),
  rollout('2026-10-20T14:20:30Z', [
    meta(ID.sub, {
      timestamp: '2026-10-20T14:20:30.000Z',
      cwd: shopCwd,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: ID.cli,
            depth: 1,
            agent_nickname: 'Scout',
            agent_role: 'explorer'
          }
        }
      },
      thread_source: 'subagent',
      more: { agent_nickname: 'Scout', agent_role: 'explorer' }
    }),
    turn(shopCwd, 'gpt-5.5-codex', 'low'),
    user('List every place that rounds money in src/checkout.'),
    ...shell(
      'call_1',
      'rg -n "round\\(" src/checkout',
      'src/checkout/total.ts:12:  const discounted = round(subtotal - coupon)'
    ),
    // A subagent's own counts (it never copies its parent's): real usage, counted in full.
    counter()(
      { input: 9000, cached: 3000, output: 400, reasoning: 100 },
      plus(20, '2026-10-20T18:30:00Z', 25, PLUS_WEEK)
    ),
    say('One place: src/checkout/total.ts line 12.')
  ])
)

// 4. A fork of session 1 (its rollout holds its own meta, then the parent's history).
write(
  join(WIN, 'sessions', '2026', '10', '21', `rollout-2026-10-21T08-00-00-${ID.fork}.jsonl`),
  rollout('2026-10-21T13:00:00Z', [
    meta(ID.fork, { timestamp: '2026-10-21T13:00:00.000Z', cwd: shopCwd, forked_from_id: ID.cli }),
    { ...meta(ID.cli, { timestamp: '2026-10-20T14:15:00.000Z', cwd: shopCwd }), dt: 1 },
    turn(shopCwd, 'gpt-5.5-codex', 'xhigh'),
    user('The checkout total is off by one cent when a coupon is applied. Find and fix it.'),
    // The parent's token counts, copied with new timestamps: the same responses.
    ...cliCounts,
    say('Fixed: the coupon discount was rounded before tax.'),
    user('Now add a regression test for coupons over 100%.'),
    ...patch('call_9', 'tests/checkout.test.ts', '+it("caps coupons at the subtotal", …)'),
    // The fork's own response: its running total goes on from the parent's.
    after(
      cliCounts[1],
      { input: 31000, cached: 24000, output: 800, reasoning: 300 },
      pro(6, PRO_WEEK)
    ),
    say('Added a test that caps coupons at the subtotal.')
  ])
)

// 5. Archived in Codex (`codex archive`), compressed, in the older format: no
//    ordinals, event_msg messages only, the effort in turn_context itself.
const oldCwd = 'C:\\Users\\beau\\code\\old-prototype'
write(
  join(WIN, 'archived_sessions', `rollout-2026-09-30T10-00-00-${ID.old}.jsonl.zst`),
  rollout(
    '2026-09-30T15:00:00Z',
    [
      {
        type: 'session_meta',
        payload: {
          id: ID.old,
          timestamp: '2026-09-30T15:00:00.000Z',
          cwd: oldCwd,
          originator: 'codex_cli_rs',
          cli_version: '0.40.0',
          source: 'cli'
        }
      },
      { type: 'turn_context', payload: { cwd: oldCwd, model: 'gpt-5-codex', effort: 'medium' } },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Sketch a migration plan for the orders table.' }
      },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Plan: add the column, backfill in batches, then switch reads.'
        }
      },
      // Older Codex: only the running total, no last usage (the change is counted).
      ...[
        [5000, 1000, 300],
        [12000, 3000, 700]
      ].map(([input, cached, output]) => ({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              total_tokens: input + output
            }
          }
        }
      }))
    ],
    { ordinals: false }
  ),
  { zstd: true }
)

// 6. History with a gap in its entries, and one malformed line.
const gapCwd = 'C:\\Users\\beau\\code\\notes'
write(
  join(WIN, 'sessions', '2026', '10', '15', `rollout-2026-10-15T11-11-11-${ID.gap}.jsonl`),
  rollout('2026-10-15T16:11:11Z', [
    meta(ID.gap, { timestamp: '2026-10-15T16:11:11.000Z', cwd: gapCwd }),
    turn(gapCwd, 'gpt-5.5', 'medium'),
    user('Summarize the meeting notes in notes/2026-10.md.'),
    { ...say('The notes cover three decisions about the release.'), ordinal: 9 },
    '{"timestamp":"2026-10-15T16:12:00Z", this line is cut off',
    { ...user('Turn them into a checklist.'), ordinal: 10 },
    {
      ...say('- [ ] Freeze the API\n- [ ] Write the changelog\n- [ ] Tag the release'),
      ordinal: 11
    }
  ])
)

// Codex's login file: the app must never open it (tests check that).
write(
  join(WIN, 'auth.json'),
  JSON.stringify({ note: 'sample decoy: the dashboard never reads this file' }) + '\n'
)

// Thread names: one per line, the newest per id wins (1 was renamed; 6 was named, then cleared).
write(
  join(WIN, 'session_index.jsonl'),
  [
    { id: ID.cli, thread_name: 'Checkout rounding', updated_at: '2026-10-20T14:16:00Z' },
    { id: ID.desktop, thread_name: 'Dark mode toggle', updated_at: '2026-10-18T19:03:00Z' },
    { id: ID.cli, thread_name: 'Fix checkout totals', updated_at: '2026-10-20T15:00:00Z' },
    { id: ID.gap, thread_name: 'Meeting notes', updated_at: '2026-10-15T16:12:00Z' },
    { id: ID.gap, thread_name: '', updated_at: '2026-10-15T16:30:00Z' }
  ]
    .map((x) => JSON.stringify(x))
    .join('\n') + '\n'
)

// 7. WSL: the TUI, in the user's dotfiles.
const dotCwd = '/home/beau/projects/dotfiles'
write(
  join(WSL, 'sessions', '2026', '10', '21', `rollout-2026-10-21T20-30-00-${ID.wsl}.jsonl`),
  rollout('2026-10-22T01:30:00Z', [
    meta(ID.wsl, {
      timestamp: '2026-10-22T01:30:00.000Z',
      cwd: dotCwd,
      originator: 'codex-tui',
      cli_version: '0.163.0',
      git: { branch: 'main' }
    }),
    turn(dotCwd, 'gpt-5.5-codex', 'medium'),
    env(dotCwd),
    user('Make my bash prompt show the git branch.'),
    ...shell('call_1', ['bash', '-lc', 'grep -n PS1 ~/.bashrc'], '42:PS1="\\u@\\h:\\w$ "'),
    ...patch('call_2', '.bashrc', '+PS1="\\u@\\h:\\w$(__git_ps1)$ "'),
    counter()({ input: 22000, cached: 12000, output: 1100, reasoning: 500 }, pro(14, PRO_WEEK)),
    // One model's own limit, reported in an event of its own.
    resend(counter()({ input: 0 }), spark(3, PRO_WEEK)),
    say('Done: the prompt now shows the branch with __git_ps1.')
  ])
)

// 8. A session running right now (fixtures' clock: 2026-10-22 15:40 UTC), on Pro.
const apiCwd = 'C:\\Users\\beau\\code\\shop api'
const nowTokens = counter(353400)
write(
  join(WIN, 'sessions', '2026', '10', '22', `rollout-2026-10-22T10-05-00-${ID.now}.jsonl`),
  rollout('2026-10-22T15:05:00Z', [
    meta(ID.now, { timestamp: '2026-10-22T15:05:00.000Z', cwd: apiCwd, cli_version: '0.166.0' }),
    turn(apiCwd, 'gpt-6.1-sol', 'high'),
    env(apiCwd),
    user('Add rate limiting to the public API.'),
    nowTokens({ input: 41000, cached: 30000, output: 2100, reasoning: 900 }, pro(21, PRO_WEEK)),
    ...patch('call_1', 'src/api/limits.ts', '+export const limiter = rateLimit({ max: 100 })'),
    {
      ...nowTokens(
        { input: 64000, cached: 52000, output: 1800, reasoning: 700 },
        pro(23, PRO_WEEK)
      ),
      dt: 900_000
    },
    say('Added a limiter of 100 requests per minute to the public routes.')
  ])
)
write(
  join(WSL, 'session_index.jsonl'),
  JSON.stringify({
    id: ID.wsl,
    thread_name: 'Git branch in prompt',
    updated_at: '2026-10-22T01:31:00Z'
  }) + '\n'
)
console.log('wrote', root)
