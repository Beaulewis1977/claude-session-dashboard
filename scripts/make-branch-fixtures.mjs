// Adds two sessions that show lineage, derived from the generated fixtures:
//  - a fork of the Safari login session, as `claude --resume <id> --fork-session`
//    leaves it (same message uuids, new session id), continued in a new direction;
//  - a branch of the moment → date-fns session made at the migration plan, as
//    Claude Code's `/branch` writes it (with `forkedFrom` markers), continued.
// Run after scripts/make-fixtures.mjs (which calls it). Only writes these two files.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const project = join(
  root,
  'windows',
  'Users',
  'beau',
  '.claude',
  'projects',
  'C--Users-beau-code-acme-web'
)

const SAFARI = '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d'
const MOMENT = '2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b'
const FORK = 'f07c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b'
const BRANCH = 'b7a1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'

let seq = 0
const hash = (seed) => createHash('sha1').update(`${seed}:${seq++}`).digest('hex')
const uuid = (seed) => {
  const h = hash(seed)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const shortId = (prefix) =>
  `${prefix}_01${Buffer.from(hash(prefix), 'hex').toString('base64url').slice(0, 22)}`

function readEvents(id) {
  return readFileSync(join(project, `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

/** Appends new turns after the copied history. */
class Continue {
  constructor(id, last, start) {
    this.id = id
    this.parent = last.uuid
    this.base = {
      cwd: last.cwd,
      version: '2.0.21',
      gitBranch: last.gitBranch,
      userType: 'external'
    }
    this.t = Date.parse(start)
    this.lines = []
  }
  entry(type, seconds, extra) {
    this.t += seconds * 1000
    const id = uuid(this.id)
    const e = {
      parentUuid: this.parent,
      isSidechain: false,
      ...this.base,
      sessionId: this.id,
      type,
      uuid: id,
      timestamp: new Date(this.t).toISOString(),
      ...extra
    }
    this.parent = id
    this.lines.push(e)
  }
  user(text, seconds = 30) {
    this.entry('user', seconds, { message: { role: 'user', content: text } })
  }
  assistant(blocks, seconds = 8) {
    const id = shortId('msg')
    for (const block of blocks) {
      this.entry('assistant', seconds, {
        requestId: shortId('req'),
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [block],
          stop_reason: null,
          usage: { input_tokens: 1800, output_tokens: 240 }
        }
      })
      seconds = 1
    }
  }
  tool(name, input, result, text) {
    const toolId = shortId('toolu')
    this.assistant(
      [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id: toolId, name, input }],
      6
    )
    this.entry('user', 3, {
      message: {
        role: 'user',
        content: [{ tool_use_id: toolId, type: 'tool_result', content: result }]
      }
    })
  }
}

const write = (id, events) =>
  writeFileSync(
    join(project, `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  )

// 1. --fork-session copy of the Safari session, continued the next morning.
{
  const copied = readEvents(SAFARI)
    .filter((e) => e.type !== 'summary')
    .map((e) => (typeof e.sessionId === 'string' ? { ...e, sessionId: FORK } : e))
  const last = [...copied].reverse().find((e) => e.uuid)
  const c = new Continue(FORK, last, '2026-10-22T08:40:00.000Z')
  c.user(
    'Before we merge: could we keep SameSite=Lax and avoid the cookie path change by redirecting through a first-party route instead?'
  )
  c.tool(
    'Read',
    { file_path: 'C:\\Users\\beau\\code\\acme-web\\src\\app\\api\\auth\\callback\\route.ts' },
    "export async function GET(req: Request) {\n  const token = await exchange(req)\n  return redirect('/dashboard', { headers: setCookie(token) })\n}",
    'Let me look at the callback route again.'
  )
  c.assistant([
    {
      type: 'text',
      text: "Yes. If the callback first redirects to a first-party `/auth/finish` page that sets the cookie with `Path=/`, Safari treats it as a same-site navigation and keeps `SameSite=Lax`.\n\nTrade-off: one extra redirect on login. I'd still keep the `Path=/` fix — it's the real cause of the loop."
    }
  ])
  write(FORK, [...copied, ...c.lines])
}

// 2. /branch copy of the moment → date-fns session at the migration plan, then dayjs.
{
  const events = readEvents(MOMENT)
  const cut = events.findIndex(
    (e) =>
      e.type === 'assistant' &&
      Array.isArray(e.message?.content) &&
      e.message.content.some((b) => b.type === 'text' && b.text.startsWith('## Migration plan'))
  )
  const copied = events
    .slice(0, cut + 1)
    .filter((e) => e.type !== 'summary' && e.type !== 'file-history-snapshot')
    .map((e) => ({
      ...e,
      sessionId: BRANCH,
      ...(e.uuid ? { forkedFrom: { sessionId: MOMENT, messageUuid: e.uuid } } : {})
    }))
  const c = new Continue(BRANCH, copied[copied.length - 1], '2026-10-22T10:30:00.000Z')
  c.user("Let's try dayjs instead — its API is much closer to moment's, so the diff stays small.")
  c.assistant([
    {
      type: 'text',
      text: "Good call. With dayjs most call sites only change the import:\n\n```ts\nimport dayjs from 'dayjs'\nimport utc from 'dayjs/plugin/utc'\nimport timezone from 'dayjs/plugin/timezone'\n\ndayjs.extend(utc)\ndayjs.extend(timezone)\n```\n\n`moment.tz()` becomes `dayjs.tz()`, and `.humanize()` needs the `relativeTime` plugin. Bundle cost is about 7 KB gzipped with those plugins."
    }
  ])
  write(BRANCH, [...copied, ...c.lines])
}

console.log('branch fixtures written to', project)
