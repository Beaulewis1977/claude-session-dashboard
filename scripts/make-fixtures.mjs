// Generates the sample session files in fixtures/.
// Run with `node scripts/make-fixtures.mjs`. Output is deterministic.

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

let seq = 0
function uuid(seed = '') {
  const h = createHash('sha1').update(`${seed}:${seq++}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
function shortId(prefix) {
  return `${prefix}_01${createHash('sha1').update(String(seq++)).digest('base64url').slice(0, 22)}`
}

/** Builds one session file event by event. */
class Session {
  constructor({
    id,
    cwd,
    version,
    gitBranch,
    start,
    model = 'claude-sonnet-4-5-20250929',
    legacy = false
  }) {
    this.id = id
    this.cwd = cwd
    this.version = version
    this.gitBranch = gitBranch
    this.t = new Date(start).getTime()
    this.model = model
    this.legacy = legacy
    this.lines = []
    this.parent = null
  }
  tick(seconds) {
    this.t += seconds * 1000
    return new Date(this.t).toISOString()
  }
  base(type, seconds) {
    const uuidValue = uuid(this.id)
    const e = {
      parentUuid: this.parent,
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.id,
      version: this.version
    }
    if (this.gitBranch && !this.legacy) e.gitBranch = this.gitBranch
    e.type = type
    e.uuid = uuidValue
    e.timestamp = this.tick(seconds)
    this.parent = uuidValue
    return e
  }
  raw(obj) {
    this.lines.push(typeof obj === 'string' ? obj : JSON.stringify(obj))
    return this
  }
  user(text, seconds = 20, extra = {}) {
    const e = this.base('user', seconds)
    e.message = { role: 'user', content: this.legacy ? text : text }
    Object.assign(e, extra)
    return this.raw(e)
  }
  userBlocks(content, seconds = 20, extra = {}) {
    const e = this.base('user', seconds)
    e.message = { role: 'user', content }
    Object.assign(e, extra)
    return this.raw(e)
  }
  assistant(blocks, seconds = 8) {
    const id = shortId('msg')
    // Claude Code writes one line per content block, all sharing the message id.
    for (const block of blocks) {
      const e = this.base('assistant', seconds)
      seconds = 1
      e.message = {
        id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [block],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1200 + (seq % 900), output_tokens: 80 + (seq % 400) }
      }
      e.requestId = shortId('req')
      this.raw(e)
    }
    return this
  }
  say(text, seconds) {
    return this.assistant([{ type: 'text', text }], seconds)
  }
  /** One assistant message with optional text, then a tool call and its result. */
  tool(name, input, result, { text, isError = false, seconds = 6 } = {}) {
    const toolId = shortId('toolu')
    const blocks = []
    if (text) blocks.push({ type: 'text', text })
    blocks.push({ type: 'tool_use', id: toolId, name, input })
    this.assistant(blocks, seconds)
    const content = [
      {
        tool_use_id: toolId,
        type: 'tool_result',
        content: result,
        ...(isError ? { is_error: true } : {})
      }
    ]
    this.userBlocks(content, 3, {
      toolUseResult: isError
        ? `Error: ${result}`
        : { stdout: typeof result === 'string' ? result.slice(0, 200) : '' }
    })
    return this
  }
  think(thinking, text, seconds = 10) {
    return this.assistant(
      [
        { type: 'thinking', thinking, signature: 'EqQBCkYIBxgCKkB' + 'x'.repeat(40) },
        { type: 'text', text }
      ],
      seconds
    )
  }
  summary(text) {
    this.lines.unshift(JSON.stringify({ type: 'summary', summary: text, leafUuid: uuid('leaf') }))
    return this
  }
  snapshot() {
    return this.raw({
      type: 'file-history-snapshot',
      messageId: uuid('snap'),
      snapshot: {
        messageId: uuid('snap2'),
        trackedFileBackups: {},
        timestamp: new Date(this.t).toISOString()
      },
      isSnapshotUpdate: false
    })
  }
  write(path) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, this.lines.join('\n') + '\n')
  }
}

function encodeProject(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// ---------------------------------------------------------------------------

rmSync(join(root, 'windows'), { recursive: true, force: true })
rmSync(join(root, 'wsl'), { recursive: true, force: true })
rmSync(join(root, 'archived'), { recursive: true, force: true })

const winHome = join(root, 'windows', 'Users', 'beau')
const winProjects = join(winHome, '.claude', 'projects')
const ubuntuHome = join(root, 'wsl', 'Ubuntu', 'home', 'beau')
const ubuntuProjects = join(ubuntuHome, '.claude', 'projects')
const ubuntuRootProjects = join(root, 'wsl', 'Ubuntu', 'root', '.claude', 'projects')

// 1. Windows — fix a login redirect loop (new format, summary, thinking, edits)
{
  const cwd = 'C:\\Users\\beau\\code\\acme-web'
  const s = new Session({
    id: '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d',
    cwd,
    version: '2.0.14',
    gitBranch: 'fix/login-redirect',
    start: '2026-10-21T13:02:11.000Z'
  })
  s.snapshot()
  s.user(
    'After logging in, users on Safari get stuck in a redirect loop between /login and /dashboard. Can you find out why and fix it?'
  )
  s.think(
    'The loop is between /login and /dashboard. Likely the middleware checks a cookie the client sets after the redirect. Safari blocks third-party cookies and is strict with SameSite. I should read the middleware and the auth callback first.',
    "I'll start by looking at the auth middleware and how the session cookie is set."
  )
  s.tool(
    'Grep',
    {
      pattern: 'session_token',
      path: 'C:\\Users\\beau\\code\\acme-web\\src',
      output_mode: 'files_with_matches'
    },
    'Found 3 files\nsrc\\middleware.ts\nsrc\\lib\\auth\\cookies.ts\nsrc\\app\\api\\auth\\callback\\route.ts'
  )
  s.tool(
    'Read',
    { file_path: 'C:\\Users\\beau\\code\\acme-web\\src\\lib\\auth\\cookies.ts' },
    `     1\timport { cookies } from 'next/headers'
     2\t
     3\texport const SESSION_COOKIE = 'session_token'
     4\t
     5\texport function setSessionCookie(token: string) {
     6\t  cookies().set(SESSION_COOKIE, token, {
     7\t    httpOnly: true,
     8\t    secure: true,
     9\t    sameSite: 'none',
    10\t    domain: '.acme.dev',
    11\t    path: '/auth',
    12\t  })
    13\t}
`
  )
  s.say(`Found it. The cookie is scoped to \`path: '/auth'\`, so the browser never sends it to \`/dashboard\`. Chrome happens to work because an old cookie with \`path: '/'\` is still around from before the change, but Safari users who logged in after the change only have the new one.

There's a second issue: \`sameSite: 'none'\` isn't needed for a first-party login and Safari's ITP treats it more strictly. I'll switch to \`lax\` and fix the path.`)
  s.tool(
    'Edit',
    {
      file_path: 'C:\\Users\\beau\\code\\acme-web\\src\\lib\\auth\\cookies.ts',
      old_string: "    sameSite: 'none',\n    domain: '.acme.dev',\n    path: '/auth',",
      new_string: "    sameSite: 'lax',\n    path: '/',"
    },
    "The file C:\\Users\\beau\\code\\acme-web\\src\\lib\\auth\\cookies.ts has been updated. Here's the result of running `cat -n` on a snippet of the edited file:\n     6\t  cookies().set(SESSION_COOKIE, token, {\n     7\t    httpOnly: true,\n     8\t    secure: true,\n     9\t    sameSite: 'lax',\n    10\t    path: '/',\n    11\t  })"
  )
  s.tool(
    'Bash',
    { command: 'npm test -- auth', description: 'Run auth tests' },
    `> acme-web@3.4.0 test
> vitest run auth

 ✓ src/lib/auth/cookies.test.ts (4 tests) 12ms
 ✓ src/middleware.test.ts (6 tests) 31ms
 ✓ src/app/api/auth/callback/route.test.ts (3 tests) 44ms

 Test Files  3 passed (3)
      Tests  13 passed (13)
   Duration  1.21s`
  )
  s.say(`All auth tests pass. Summary of the fix:

| Setting | Before | After |
|---|---|---|
| \`path\` | \`/auth\` | \`/\` |
| \`sameSite\` | \`none\` | \`lax\` |
| \`domain\` | \`.acme.dev\` | *(host-only)* |

**Why it looped:** \`/dashboard\` never received the cookie, so the middleware redirected to \`/login\`, which saw a valid session in the callback and redirected back.

You may want to add a regression test that asserts the cookie path is \`/\`. Want me to add one?`)
  s.user("Yes please, and also make the test cover Safari's behaviour if possible.", 95)
  s.tool(
    'Write',
    {
      file_path: 'C:\\Users\\beau\\code\\acme-web\\src\\lib\\auth\\cookies.test.ts',
      content:
        "import { describe, it, expect, vi } from 'vitest'\nimport { setSessionCookie } from './cookies'\n\nconst set = vi.fn()\nvi.mock('next/headers', () => ({ cookies: () => ({ set }) }))\n\ndescribe('setSessionCookie', () => {\n  it('scopes the cookie to the whole site', () => {\n    setSessionCookie('abc')\n    expect(set).toHaveBeenCalledWith('session_token', 'abc', expect.objectContaining({ path: '/', sameSite: 'lax' }))\n  })\n})\n"
    },
    'File created successfully at: C:\\Users\\beau\\code\\acme-web\\src\\lib\\auth\\cookies.test.ts',
    {
      text: "Browsers can't be emulated in a unit test, but we can lock in the cookie attributes that matter for Safari:"
    }
  )
  s.tool(
    'Bash',
    { command: 'npm test -- cookies' },
    ' ✓ src/lib/auth/cookies.test.ts (5 tests) 9ms\n\n Test Files  1 passed (1)\n      Tests  5 passed (5)'
  )
  s.say('Added `cookies.test.ts`, which asserts `path: "/"` and `sameSite: "lax"`. Both pass. 🎉')
  s.summary('Fix Safari login redirect loop caused by cookie path')
  s.write(join(winProjects, encodeProject(cwd), `${s.id}.jsonl`))
}

// 2. Windows — same project, no summary, a long first prompt, malformed lines
{
  const cwd = 'C:\\Users\\beau\\code\\acme-web'
  const s = new Session({
    id: '2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b',
    cwd,
    version: '2.0.22',
    gitBranch: 'main',
    start: '2026-10-22T08:41:05.000Z'
  })
  s.user(
    'I want to migrate our date handling from moment.js to date-fns across the whole app. There are about 40 files that import moment. Please make a plan first, do not change anything yet, and tell me which usages are risky (timezones, locale formatting, durations).'
  )
  s.tool(
    'Grep',
    { pattern: "from 'moment'", output_mode: 'count' },
    'src\\components\\Calendar.tsx:3\nsrc\\lib\\dates.ts:1\nsrc\\features\\billing\\Invoice.tsx:2\n…\n\nFound 41 total occurrences across 38 files.'
  )
  s.tool(
    'TodoWrite',
    {
      todos: [
        {
          content: 'Inventory moment usages by category',
          status: 'completed',
          activeForm: 'Inventorying'
        },
        {
          content: 'Map each moment API to date-fns',
          status: 'in_progress',
          activeForm: 'Mapping APIs'
        },
        { content: 'Flag timezone-sensitive call sites', status: 'pending', activeForm: 'Flagging' }
      ]
    },
    'Todos have been modified successfully.'
  )
  s.say(`## Migration plan

1. **Add \`date-fns\` and \`date-fns-tz\`** alongside moment so both work during the migration.
2. **Wrap helpers first.** \`src/lib/dates.ts\` already centralises 60% of the calls.
3. **Migrate leaf components** (no timezone logic) in small PRs.
4. **Handle risky usages last:**
   - \`moment.tz()\` in \`Invoice.tsx\` and \`ScheduleGrid.tsx\` — needs \`date-fns-tz\`.
   - \`moment.duration().humanize()\` — use \`formatDistance\`; output wording differs slightly.
   - \`moment.locale('de')\` global switching — date-fns needs the locale passed per call.
5. Remove moment and check the bundle size drop (~67 KB gzipped).

Nothing has been changed yet.`)
  // A line cut off mid-write and a garbage line, as seen in the wild.
  s.raw(
    '{"parentUuid":"x","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"trunc'
  )
  s.raw('not json at all')
  s.user('Looks good. Start with step 1 and 2.', 300)
  s.tool(
    'Bash',
    { command: 'npm install date-fns@4 date-fns-tz@3' },
    'added 2 packages, and audited 812 packages in 4s\n\nfound 0 vulnerabilities'
  )
  s.say(
    "Installed. Next I'll rewrite `src/lib/dates.ts` to use date-fns internally while keeping the same exports."
  )
  s.write(join(winProjects, encodeProject(cwd), `${s.id}.jsonl`))
}

// 3. Windows — path with spaces, legacy format (string content, no gitBranch)
{
  const cwd = 'C:\\Users\\beau\\My Projects\\desktop app'
  const s = new Session({
    id: 'c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c',
    cwd,
    version: '0.2.115',
    start: '2026-09-28T19:15:40.000Z',
    model: 'claude-opus-4-1-20250805',
    legacy: true
  })
  s.user('Explain what electron-builder\'s "nsis" target options oneClick and perMachine do.')
  s.raw({
    parentUuid: s.parent,
    type: 'assistant',
    sessionId: s.id,
    cwd,
    version: s.version,
    uuid: uuid('legacy'),
    timestamp: s.tick(12),
    message: {
      role: 'assistant',
      model: s.model,
      content: `Here's how those two options interact:

- **\`oneClick: true\`** (default) — the installer runs without any wizard pages. It installs immediately and launches the app.
- **\`oneClick: false\`** — shows the classic wizard so users can pick the install folder (with \`allowToChangeInstallationDirectory\`).
- **\`perMachine: true\`** — installs for all users into \`Program Files\` and requires admin rights.
- **\`perMachine: false\`** (default) — installs per user into \`%LOCALAPPDATA%\\Programs\`, no UAC prompt.

\`\`\`json
{
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true
  }
}
\`\`\``
    }
  })
  s.user("Thanks, that's exactly what I needed.", 60)
  s.write(join(winProjects, encodeProject(cwd), `${s.id}.jsonl`))
}

// 4. WSL Ubuntu — long API session: errors, huge output, MCP tool, subagent
{
  const cwd = '/home/beau/projects/orders-api'
  const s = new Session({
    id: 'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8',
    cwd,
    version: '2.0.22',
    gitBranch: 'feature/pagination',
    start: '2026-10-20T15:30:00.000Z'
  })
  s.snapshot()
  s.user(
    'Add cursor-based pagination to GET /orders. Keep the old ?page= param working for now but mark it deprecated in the OpenAPI spec.'
  )
  s.tool(
    'Glob',
    { pattern: 'internal/http/**/*.go' },
    '/home/beau/projects/orders-api/internal/http/router.go\n/home/beau/projects/orders-api/internal/http/orders.go\n/home/beau/projects/orders-api/internal/http/orders_test.go\n/home/beau/projects/orders-api/internal/http/middleware.go'
  )
  s.tool(
    'Read',
    { file_path: '/home/beau/projects/orders-api/internal/http/orders.go', limit: 60 },
    `     1\tpackage http
     2\t
     3\timport (
     4\t\t"net/http"
     5\t\t"strconv"
     6\t)
     7\t
     8\tfunc (h *Handler) ListOrders(w http.ResponseWriter, r *http.Request) {
     9\t\tpage, _ := strconv.Atoi(r.URL.Query().Get("page"))
    10\t\tif page < 1 {
    11\t\t\tpage = 1
    12\t\t}
    13\t\torders, err := h.store.ListOrders(r.Context(), (page-1)*50, 50)
    14\t\tif err != nil {
    15\t\t\twriteError(w, err)
    16\t\t\treturn
    17\t\t}
    18\t\twriteJSON(w, http.StatusOK, orders)
    19\t}`
  )
  s.think(
    'Cursor should be opaque: base64 of (created_at, id) to keep ordering stable with ties. Store needs a ListOrdersAfter query using a composite index.',
    'Plan: an opaque cursor encoding `(created_at, id)`, a new store method, and a response envelope with `next_cursor`.'
  )
  s.tool(
    'Edit',
    {
      file_path: '/home/beau/projects/orders-api/internal/http/orders.go',
      old_string: '\torders, err := h.store.ListOrders(r.Context(), (page-1)*50, 50)',
      new_string:
        '\tif c := r.URL.Query().Get("cursor"); c != "" {\n\t\th.listOrdersByCursor(w, r, c)\n\t\treturn\n\t}\n\torders, err := h.store.ListOrders(r.Context(), (page-1)*50, 50)'
    },
    'The file /home/beau/projects/orders-api/internal/http/orders.go has been updated.'
  )
  s.tool(
    'Bash',
    { command: 'go test ./...' },
    `# github.com/beau/orders-api/internal/http
internal/http/orders.go:14:5: h.listOrdersByCursor undefined (type *Handler has no field or method listOrdersByCursor)
FAIL\tgithub.com/beau/orders-api/internal/http [build failed]
ok  \tgithub.com/beau/orders-api/internal/store\t0.412s
FAIL`,
    { isError: true }
  )
  s.say(
    "Expected — the handler method doesn't exist yet. Adding it now along with the cursor encoding."
  )
  s.tool(
    'Write',
    {
      file_path: '/home/beau/projects/orders-api/internal/http/cursor.go',
      content:
        'package http\n\nimport (\n\t"encoding/base64"\n\t"encoding/json"\n\t"time"\n)\n\ntype cursor struct {\n\tCreatedAt time.Time `json:"t"`\n\tID        int64     `json:"i"`\n}\n\nfunc encodeCursor(c cursor) string {\n\tb, _ := json.Marshal(c)\n\treturn base64.RawURLEncoding.EncodeToString(b)\n}\n'
    },
    'File created successfully at: /home/beau/projects/orders-api/internal/http/cursor.go'
  )
  const bigLog = Array.from(
    { length: 400 },
    (_, i) =>
      `=== RUN   TestListOrders/case_${String(i).padStart(3, '0')}\n--- PASS: TestListOrders/case_${String(i).padStart(3, '0')} (0.00s)`
  ).join('\n')
  s.tool(
    'Bash',
    { command: 'go test ./internal/http -run TestListOrders -v' },
    `${bigLog}\nPASS\nok  \tgithub.com/beau/orders-api/internal/http\t0.981s`
  )
  s.tool(
    'mcp__postgres__query',
    {
      sql: 'EXPLAIN SELECT * FROM orders WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 50'
    },
    'Limit  (cost=0.43..4.12 rows=50 width=96)\n  ->  Index Scan Backward using orders_created_at_id_idx on orders  (cost=0.43..9876.54 rows=133921 width=96)\n        Index Cond: (ROW(created_at, id) < ROW($1, $2))'
  )
  s.tool(
    'Task',
    {
      description: 'Update OpenAPI spec',
      prompt: 'Update api/openapi.yaml: add cursor + next_cursor, mark page deprecated.',
      subagent_type: 'general-purpose'
    },
    [
      {
        type: 'text',
        text: 'Updated api/openapi.yaml:\n- Added `cursor` query parameter\n- Added `next_cursor` to the ListOrders response\n- Marked `page` as `deprecated: true`'
      }
    ]
  )
  s.say(`Done. Cursor pagination is live on \`GET /orders\`:

\`\`\`bash
curl 'localhost:8080/orders?limit=50'
curl 'localhost:8080/orders?cursor=eyJ0IjoiMjAyNi0xMC0yMFQxNTo0NTowMFoiLCJpIjo5ODEyfQ'
\`\`\`

- The query uses the existing \`(created_at, id)\` index (see the \`EXPLAIN\` above).
- \`?page=\` still works and is marked deprecated in the spec.
- All 400 table-driven cases pass.`)
  s.summary('Cursor-based pagination for GET /orders')
  s.write(join(ubuntuProjects, encodeProject(cwd), `${s.id}.jsonl`))
}

// 5. WSL Ubuntu — dotfiles: slash commands, compact summary, interruption
{
  const cwd = '/home/beau/dotfiles'
  const s = new Session({
    id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
    cwd,
    version: '2.0.8',
    gitBranch: 'main',
    start: '2026-10-14T21:05:00.000Z'
  })
  s.user(
    '<command-name>/init</command-name>\n<command-message>init is analyzing your codebase…</command-message>\n<command-args></command-args>'
  )
  s.user(
    'Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.',
    1,
    { isMeta: true }
  )
  s.say("I'll create a CLAUDE.md for your dotfiles repo after looking at the structure.")
  s.tool(
    'LS',
    { path: '/home/beau/dotfiles' },
    '- /home/beau/dotfiles/\n  - install.sh\n  - zsh/\n    - .zshrc\n    - aliases.zsh\n  - nvim/\n    - init.lua\n  - tmux/\n    - tmux.conf'
  )
  s.say('Created `CLAUDE.md` describing the install script and the zsh / nvim / tmux layout.')
  s.user('make the tmux prefix ctrl-a instead of ctrl-b', 120)
  s.tool(
    'Edit',
    {
      file_path: '/home/beau/dotfiles/tmux/tmux.conf',
      old_string: 'set -g prefix C-b',
      new_string: 'unbind C-b\nset -g prefix C-a\nbind C-a send-prefix'
    },
    'The file /home/beau/dotfiles/tmux/tmux.conf has been updated.'
  )
  s.user('[Request interrupted by user]', 5)
  s.raw({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: s.tick(30),
    uuid: uuid('sys'),
    sessionId: s.id,
    cwd
  })
  s.user(
    'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nThe user is configuring dotfiles. CLAUDE.md was created and the tmux prefix was changed to C-a.',
    2,
    { isCompactSummary: true }
  )
  s.user(
    '<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>',
    10
  )
  s.user(
    '<local-command-stdout>Total cost: $0.41\nTotal duration (API): 1m 12s</local-command-stdout>',
    1
  )
  s.user('now reload tmux config', 15)
  s.tool(
    'Bash',
    { command: 'tmux source-file ~/.tmux.conf && tmux display-message "reloaded"' },
    ''
  )
  s.say('Reloaded. The new prefix is `Ctrl-a`.')
  s.write(join(ubuntuProjects, encodeProject(cwd), `${s.id}.jsonl`))
}

// 6. WSL Ubuntu root — infra session with a project path containing spaces
{
  const cwd = '/root/infra scripts'
  const s = new Session({
    id: 'a0b1c2d3-e4f5-4a6b-9c8d-7e6f5a4b3c2d',
    cwd,
    version: '2.0.14',
    gitBranch: 'ops/backups',
    start: '2026-10-17T06:12:00.000Z'
  })
  s.user(
    'Write a systemd timer that backs up /var/lib/postgresql nightly to /mnt/backup, keeping 14 days.'
  )
  s.tool(
    'Write',
    {
      file_path: '/root/infra scripts/pg-backup.service',
      content:
        '[Unit]\nDescription=Nightly PostgreSQL backup\n\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/pg-backup.sh\n'
    },
    'File created successfully at: /root/infra scripts/pg-backup.service'
  )
  s.tool(
    'Write',
    {
      file_path: '/root/infra scripts/pg-backup.timer',
      content:
        '[Unit]\nDescription=Run pg-backup nightly\n\n[Timer]\nOnCalendar=*-*-* 02:30:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n'
    },
    'File created successfully at: /root/infra scripts/pg-backup.timer'
  )
  s.say(
    'Created `pg-backup.service` and `pg-backup.timer`. Enable with:\n\n```bash\nsudo systemctl enable --now pg-backup.timer\n```\n\nThe script keeps 14 days by running `find /mnt/backup -mtime +14 -delete` after each dump.'
  )
  s.write(join(ubuntuRootProjects, encodeProject(cwd), `${s.id}.jsonl`))
}

// 7. Archived only — the original was cleaned up by Claude Code
{
  const cwd = 'C:\\Users\\beau\\code\\old-prototype'
  const s = new Session({
    id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
    cwd,
    version: '1.0.98',
    gitBranch: 'master',
    start: '2026-08-03T10:00:00.000Z'
  })
  s.user('Sketch a canvas-based particle demo I can show at the meetup.')
  s.say(
    'Here\'s a minimal particle system using `requestAnimationFrame`:\n\n```js\nconst ctx = canvas.getContext("2d")\nconst particles = Array.from({ length: 300 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: rand(), vy: rand() }))\n\nfunction frame() {\n  ctx.clearRect(0, 0, W, H)\n  for (const p of particles) {\n    p.x += p.vx; p.y += p.vy\n    ctx.fillRect(p.x, p.y, 2, 2)\n  }\n  requestAnimationFrame(frame)\n}\nframe()\n```'
  )
  s.summary('Canvas particle demo for meetup')
  s.write(join(root, 'archived', 'windows', `${s.id}.jsonl`))
  writeFileSync(
    join(root, 'archived', 'windows', 'original-path.txt'),
    join('windows', 'Users', 'beau', '.claude', 'projects', encodeProject(cwd), `${s.id}.jsonl`) +
      '\n'
  )
}

// Claude settings (read-only for the app)
writeFileSync(
  join(ubuntuHome, '.claude', 'settings.json'),
  JSON.stringify({ cleanupPeriodDays: 90, model: 'sonnet' }, null, 2) + '\n'
)
mkdirSync(join(winHome, '.claude'), { recursive: true })
writeFileSync(
  join(winHome, '.claude', 'settings.json'),
  JSON.stringify({ theme: 'dark' }, null, 2) + '\n'
)

// `wsl.exe -l -q` output: UTF-16LE, CRLF, trailing blank line.
const utf16 = (s) => Buffer.from(s, 'utf16le')
writeFileSync(join(root, 'wsl-list.utf16'), utf16('Ubuntu\r\nDebian\r\ndocker-desktop\r\n\r\n'))
writeFileSync(join(root, 'wsl-list-running.utf16'), utf16('Ubuntu\r\ndocker-desktop\r\n'))

console.log('fixtures written to', root)

// Sessions that show lineage (a fork and a /branch copy), derived from the above.
await import('./make-branch-fixtures.mjs')
