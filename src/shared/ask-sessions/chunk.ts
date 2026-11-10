// Passages of a session for the Ask index (docs/ROADMAP.md, feature 7).
//
// What is kept, in message order: my prompts, the agent's answers, one line
// per tool call (its name and file path or command, e.g. "[tool] Edit
// src/app.ts"), plan-mode plans, compaction summaries, and messages between
// agents (Codex `agent_message` items; Claude Code's Task / Agent prompt and
// the subagent's final report), each of those cut to MAX_AGENT_CHARS.
//
// Never kept: tool output (other than that final report), thinking, images,
// slash commands and their output, system messages. One huge message (a
// pasted log) keeps only its start and end (MAX_MESSAGE_CHARS).
//
// A passage starts at each prompt and is cut at about TARGET_CHARS, so a
// question and its answer usually land together. Each passage knows the
// messages it covers: a citation opens the viewer at the first of them.

import type { ChatMessage, ContentBlock } from '../types'

export const TARGET_CHARS = 1600
/** Longest part of one message that is indexed (its start and end). */
export const MAX_MESSAGE_CHARS = 24_000
/** A message between agents (and a plan) is cut to this, like in summaries. */
export const MAX_AGENT_CHARS = 2000
export const MAX_PLAN_CHARS = 6000
const MAX_TOOL_LABEL = 160

export type PassageKind = 'turn' | 'compact' | 'about' | 'summary' | 'commit'

export interface Passage {
  kind: PassageKind
  text: string
  /** Messages it covers (ids), first one first: the citation's target. */
  msgIds: string[]
  /** Time of its first message (epoch ms), when known. */
  ts?: number
  /** A commit passage's SHA. */
  sha?: string
}

/** Claude Code's tools that start a subagent (their prompt and report are messages between agents). */
const AGENT_TOOLS = new Set(['Task', 'Agent'])
const PLAN_TOOLS = new Set(['ExitPlanMode'])

function capped(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.66)
  return `${text.slice(0, head)} … ${text.slice(-(max - head))}`
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** The lines one assistant block adds (undefined: nothing of it is indexed). */
function blockLines(b: ContentBlock, agent: string): string[] {
  switch (b.type) {
    case 'text':
      return b.text.trim() ? [`${agent}: ${capped(b.text.trim(), MAX_MESSAGE_CHARS)}`] : []
    case 'tool_use': {
      const out = [`[tool] ${oneLine(b.label || b.name, MAX_TOOL_LABEL)}`]
      const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<
        string,
        unknown
      >
      if (AGENT_TOOLS.has(b.name)) {
        const prompt = str(input.prompt)
        if (prompt)
          out.push(`[agent ${agent} → subagent] ${capped(prompt.trim(), MAX_AGENT_CHARS)}`)
        // The subagent's final report: the one tool result that is indexed.
        const report = b.result && !b.result.isError ? str(b.result.text) : undefined
        if (report)
          out.push(`[agent subagent → ${agent}] ${capped(report.trim(), MAX_AGENT_CHARS)}`)
      } else if (PLAN_TOOLS.has(b.name)) {
        const plan = str(input.plan)
        if (plan) out.push(`[plan] ${capped(plan.trim(), MAX_PLAN_CHARS)}`)
      }
      return out
    }
    case 'agent_message':
      return b.text.trim()
        ? [
            `[agent ${oneLine(b.author, 80)} → ${oneLine(b.recipient, 80)}] ${capped(b.text.trim(), MAX_AGENT_CHARS)}`
          ]
        : []
    // Thinking, tool results and images are never indexed.
    default:
      return []
  }
}

function tsOf(m: ChatMessage): number | undefined {
  const t = m.timestamp ? Date.parse(m.timestamp) : NaN
  return Number.isFinite(t) ? t : undefined
}

/**
 * The conversation passages of a session. `agent` labels the answers
 * ("Claude", "Codex").
 */
export function chunkMessages(messages: ChatMessage[], agent = 'Claude'): Passage[] {
  const out: Passage[] = []
  let lines: string[] = []
  let len = 0
  let ids: string[] = []
  let ts: number | undefined
  let kind: PassageKind = 'turn'
  const flush = (): void => {
    if (len) out.push({ kind, text: lines.join('\n'), msgIds: ids, ...(ts ? { ts } : {}) })
    lines = []
    len = 0
    ids = []
    ts = undefined
  }
  const touch = (m: ChatMessage): void => {
    if (ids[ids.length - 1] !== m.id) ids.push(m.id)
    ts ??= tsOf(m)
  }
  const add = (m: ChatMessage, line: string): void => {
    let t = line
    // One line longer than a passage: its own passages, cut at a space.
    while (t.length > TARGET_CHARS) {
      if (len) flush()
      let cut = t.lastIndexOf(' ', TARGET_CHARS)
      if (cut < TARGET_CHARS / 2) cut = TARGET_CHARS
      touch(m)
      lines.push(t.slice(0, cut))
      len = cut
      flush()
      t = t.slice(cut).trimStart()
    }
    if (!t) return
    if (len && len + t.length + 1 > TARGET_CHARS) flush()
    touch(m)
    lines.push(t)
    len += t.length + 1
  }
  for (const m of messages) {
    if (m.kind === 'prompt' && m.role === 'user') {
      const text = m.blocks
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .trim()
      if (!text) continue
      // A new prompt starts a new passage.
      flush()
      kind = 'turn'
      add(m, `User: ${capped(text, MAX_MESSAGE_CHARS)}`)
    } else if (m.kind === 'response' && m.role === 'assistant') {
      for (const b of m.blocks) for (const l of blockLines(b, agent)) add(m, l)
    } else if (m.kind === 'compact') {
      const text = m.blocks
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .trim()
      if (!text) continue
      flush()
      kind = 'compact'
      add(m, `[Summary of earlier context] ${capped(text, MAX_MESSAGE_CHARS)}`)
      flush()
      // What follows a compaction summary is the conversation again.
      kind = 'turn'
    }
    // Slash commands, their output and system messages are left out.
  }
  flush()
  return out
}

export interface AboutInput {
  title: string
  name?: string
  agentName?: string
  description?: string
  tags?: string[]
  project?: string
  branch?: string
}

/** The "about" passage: my name, description and tags, the agent's own name, the project. */
export function aboutPassage(a: AboutInput): Passage {
  const lines = [
    `Session: ${oneLine(a.name || a.title, 300)}`,
    ...(a.agentName && a.agentName !== a.name ? [`Agent's name: ${oneLine(a.agentName, 300)}`] : []),
    ...(a.description?.trim() ? [`Description: ${capped(a.description.trim(), 4000)}`] : []),
    ...(a.tags?.length ? [`Tags: ${a.tags.slice(0, 50).join(', ')}`] : []),
    ...(a.project ? [`Project: ${oneLine(a.project, 200)}`] : []),
    ...(a.branch ? [`Git branch: ${oneLine(a.branch, 120)}`] : [])
  ]
  return { kind: 'about', text: lines.join('\n'), msgIds: [] }
}

/** The session's AI summary (written by Claude, stored in the app's metadata). */
export function summaryPassage(s: {
  title?: string
  done: string[]
  files: string[]
  decisions: string[]
  todos: string[]
  pickUp: string
}): Passage | undefined {
  const list = (label: string, items: string[]): string[] =>
    items.length ? [`${label}: ${items.slice(0, 30).join('; ')}`] : []
  const lines = [
    ...(s.title ? [`Summary: ${oneLine(s.title, 200)}`] : ['Summary']),
    ...list('Done', s.done),
    ...list('Decisions', s.decisions),
    ...list('Still open', s.todos),
    ...list('Files', s.files),
    ...(s.pickUp ? [`Pick up: ${capped(s.pickUp, 2000)}`] : [])
  ]
  return lines.length > 1 ? { kind: 'summary', text: lines.join('\n'), msgIds: [] } : undefined
}

/** A commit linked to the session: its subject and files (repo-relative). */
export function commitPassage(c: {
  sha: string
  subject: string
  files: string[]
  at?: number
  pr?: number
}): Passage {
  const files = c.files.slice(0, 60)
  const text = [
    `Commit ${c.sha.slice(0, 12)}: ${oneLine(c.subject, 300)}`,
    ...(c.pr ? [`Pull request #${c.pr}`] : []),
    ...(files.length
      ? [
          `Files: ${files.join(', ')}${c.files.length > files.length ? ` (+${c.files.length - files.length} more)` : ''}`
        ]
      : [])
  ].join('\n')
  return { kind: 'commit', text, msgIds: [], sha: c.sha, ...(c.at ? { ts: c.at } : {}) }
}
