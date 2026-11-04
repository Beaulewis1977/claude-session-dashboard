// Parsing a Codex rollout (the compact text from read.ts, or a plain rollout
// in tests) into the app's session summary, chat messages and search text.
//
// A rollout is one JSON object per line: `{timestamp, ordinal?, type, payload}`.
// Checked against real rollouts from Codex CLI 0.163/0.164 and the desktop
// app (key names only), and Codex's older format:
// - `session_meta`: id, cwd, originator, cli_version, source (a string, or
//   `{subagent: {thread_spawn: {parent_thread_id, …}}}`), thread_source,
//   forked_from_id, git {commit_hash, branch, repository_url}, history_mode.
//   A forked rollout starts with the fork's own meta, then the parent's.
// - `turn_context`: cwd, model, reasoning effort (in older and newer places).
// - `response_item`: message (role user / assistant / developer), reasoning
//   (summary text; the content itself is encrypted), function_call /
//   function_call_output, custom_tool_call / custom_tool_call_output,
//   local_shell_call, web_search_call.
// - `event_msg`: user_message / agent_message (older files, which may have no
//   response_item messages), thread_settings_applied, token_count, …
// - `compacted`: the history was compacted.
// Lines are parsed defensively: anything unexpected is skipped, and lines
// that aren't JSON objects are counted as malformed.

import type { SessionContext } from '@shared/context'
import type { ChatMessage, ContentBlock, ToolResult } from '@shared/types'
import { READ_NOTE_TYPE, type ReadNote } from './read'
import { isContextItem, isInjected, whoWrote } from './provenance'

/**
 * Search text is cut to this many characters per session (prompts and
 * answers first). Long Codex histories go past it; the viewer then says the
 * session search covers only part (Find in session searches all of it).
 */
export const CODEX_SEARCH_LIMIT = 1_000_000

export interface CodexOrigin {
  originator?: string
  /** `source` as text: "cli", "vscode", "exec", "subagent", … */
  source?: string
  threadSource?: string
}

export interface CodexAnalysis {
  sessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  gitCommit?: string
  gitRemote?: string
  models: string[]
  /** The reasoning effort of the latest turn. */
  effort?: string
  origin: CodexOrigin
  subagent?: { parentId?: string; nickname?: string; role?: string }
  forkedFromId?: string
  historyMode?: string
  firstPrompt?: string
  startedAt?: string
  lastActivityAt?: string
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  malformedLines: number
  searchText: string
  /** Why the history shown may not be the whole conversation. */
  historyNote?: string
  /** The search text was cut at CODEX_SEARCH_LIMIT. */
  searchPartial?: boolean
  /** Decompressed size of the file (from the reader). */
  contentBytes?: number
  /** Context size at the end (from the last token_count), see codexContext. */
  context?: SessionContext
}

interface Line {
  timestamp?: string
  ordinal?: number
  type?: string
  payload: Record<string, unknown>
}

export function parseLines(text: string): {
  lines: Line[]
  malformed: number
  note?: ReadNote
} {
  const lines: Line[] = []
  let malformed = 0
  let note: ReadNote | undefined
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    let v: unknown
    try {
      v = JSON.parse(s)
    } catch {
      malformed++
      continue
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      malformed++
      continue
    }
    const o = v as Record<string, unknown>
    if (o.type === READ_NOTE_TYPE) {
      note = o as unknown as ReadNote
      continue
    }
    const p = o.payload
    lines.push({
      timestamp: typeof o.timestamp === 'string' ? o.timestamp : undefined,
      ordinal: typeof o.ordinal === 'number' ? o.ordinal : undefined,
      type: typeof o.type === 'string' ? o.type : undefined,
      payload: p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
    })
  }
  return { lines, malformed, note }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Text items of a message's content (`input_text`, `output_text`, `text`).
 * For a user message, only what I wrote: the context Codex added is left out.
 */
function contentTexts(p: Record<string, unknown>, user: boolean): string[] {
  const content = p.content
  if (typeof content === 'string') return user && isInjected(content) ? [] : [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  content.forEach((c: unknown, i) => {
    if (!c || typeof c !== 'object') return
    const t = (c as Record<string, unknown>).text
    if (typeof t !== 'string') return
    if (user && isContextItem(p, i, t)) return
    out.push(t)
  })
  return out
}

function imageCount(p: Record<string, unknown>, user: boolean): number {
  const content = p.content
  if (!Array.isArray(content)) return 0
  return content.filter(
    (c: unknown, i) =>
      c &&
      typeof c === 'object' &&
      /image/.test(String((c as { type?: unknown }).type)) &&
      !(user && whoWrote(p, i) === 'codex')
  ).length
}

function sourceText(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') return Object.keys(v)[0]
  return undefined
}

/** The subagent's parent thread, from `source.subagent.thread_spawn` (or the meta's own fields). */
function subagentOf(
  p: Record<string, unknown>
): { parentId?: string; nickname?: string; role?: string } | undefined {
  const src = p.source as Record<string, unknown> | undefined
  const sub = src && typeof src === 'object' ? (src.subagent as Record<string, unknown>) : undefined
  const spawn = (sub?.thread_spawn ?? {}) as Record<string, unknown>
  if (!sub && p.thread_source !== 'subagent') return undefined
  return {
    parentId: str(spawn.parent_thread_id) ?? str(p.parent_thread_id),
    nickname: str(spawn.agent_nickname) ?? str(p.agent_nickname),
    role: str(spawn.agent_role) ?? str(p.agent_role)
  }
}

/** The meta of the rollout's own thread (a fork's rollout also holds its parent's). */
function ownMeta(lines: Line[], sessionId?: string): Record<string, unknown> | undefined {
  let first: Record<string, unknown> | undefined
  for (const l of lines) {
    if (l.type !== 'session_meta') continue
    if (sessionId && l.payload.id === sessionId) return l.payload
    first ??= l.payload
  }
  return first
}

/** Why the history may be incomplete: ordinals that don't start at 0 or skip, or a cut by the reader. */
function historyNote(lines: Line[], note: ReadNote | undefined): string | undefined {
  const parts: string[] = []
  // The reader saw every line (also the ones it drops); without it, check the lines here.
  let first = note?.firstOrdinal
  let gaps = note?.ordinalGaps ?? 0
  if (!note) {
    const ords = lines.map((l) => l.ordinal).filter((o): o is number => o !== undefined)
    first = ords[0]
    for (let i = 1; i < ords.length; i++) if (ords[i] > ords[i - 1] + 1) gaps++
  }
  if (first !== undefined && first > 0)
    parts.push(`the file starts at entry ${first}, not at the beginning`)
  if (gaps) parts.push(`the file skips entries in ${gaps} place${gaps === 1 ? '' : 's'}`)
  if (note?.cutLines)
    parts.push(
      `it's very large (${Math.round(note.bytes / 1048576)} MB), so only the start is shown and searched`
    )
  if (note?.hugeLines)
    parts.push(
      `${note.hugeLines} entr${note.hugeLines === 1 ? 'y is' : 'ies are'} too large to read`
    )
  return parts.length ? `This conversation may be incomplete: ${parts.join('; ')}.` : undefined
}

export function analyzeCodex(text: string, fileSessionId?: string): CodexAnalysis {
  const { lines, malformed, note } = parseLines(text)
  const meta = ownMeta(lines, fileSessionId) ?? {}
  const git = (meta.git ?? {}) as Record<string, unknown>
  const a: CodexAnalysis = {
    sessionId: str(meta.id),
    cwd: str(meta.cwd),
    version: str(meta.cli_version),
    gitBranch: str(git.branch),
    gitCommit: str(git.commit_hash),
    gitRemote: str(git.repository_url),
    models: [],
    origin: {
      originator: str(meta.originator),
      source: sourceText(meta.source),
      threadSource: str(meta.thread_source)
    },
    subagent: subagentOf(meta),
    forkedFromId: str(meta.forked_from_id),
    historyMode: str(meta.history_mode),
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    malformedLines: malformed,
    searchText: ''
  }
  const models = new Set<string>()
  // Search text: the prompts and answers first, then reasoning and tool calls
  // with what's left, so the budget goes to what the transcript shows.
  const text_: string[] = []
  const extra: string[] = []
  let textLen = 0
  let extraLen = 0
  let total = 0
  const addText = (t: string): void => {
    total += t.length + 1
    if (textLen >= CODEX_SEARCH_LIMIT) return
    text_.push(t)
    textLen += t.length + 1
  }
  const addExtra = (t: string): void => {
    total += t.length + 1
    if (extraLen >= CODEX_SEARCH_LIMIT) return
    extra.push(t)
    extraLen += t.length + 1
  }
  let minT = Infinity
  let maxT = -Infinity
  const messages = conversation(lines)
  const ctx = new CodexContextTrack()
  let model: string | undefined
  for (const l of lines) {
    const t = l.timestamp ? Date.parse(l.timestamp) : NaN
    if (Number.isFinite(t)) {
      minT = Math.min(minT, t)
      maxT = Math.max(maxT, t)
    }
    const p = l.payload
    if (l.type === 'event_msg' && p.type === 'token_count') {
      ctx.tokenCount(p, l.timestamp, model)
      continue
    }
    if (l.type === 'compacted') {
      ctx.compacted(p, l.timestamp)
      continue
    }
    if (l.type === 'turn_context') {
      const m = str(p.model)
      if (m) models.add(m)
      model = m ?? model
      a.effort = str(p.effort) ?? a.effort
      a.cwd ??= str(p.cwd)
      continue
    }
    if (l.type === 'event_msg' && p.type === 'thread_settings_applied') {
      const ts = (p.thread_settings ?? {}) as Record<string, unknown>
      const m = str(ts.model)
      if (m) models.add(m)
      a.effort = str(ts.reasoning_effort) ?? a.effort
      continue
    }
    const msg = messages.get(l)
    if (msg) {
      if (msg.role === 'user') {
        const shown = msg.texts
        if (!shown.length) continue
        a.userMessageCount++
        a.firstPrompt ??= shown.join('\n').trim().slice(0, 2000) || undefined
        for (const x of shown) addText(x)
      } else {
        a.assistantMessageCount++
        for (const x of msg.texts) addText(x)
      }
      continue
    }
    if (l.type === 'response_item') {
      if (p.type === 'reasoning') for (const x of reasoningTexts(p)) addExtra(x)
      const tool = toolCallOf(p)
      if (tool) {
        a.toolCallCount++
        addExtra(tool.label)
      }
    }
  }
  if (Number.isFinite(minT)) a.startedAt = new Date(minT).toISOString()
  if (Number.isFinite(maxT)) a.lastActivityAt = new Date(maxT).toISOString()
  if (note?.lastAt) {
    const t = Date.parse(note.lastAt)
    if (Number.isFinite(t) && t > maxT) a.lastActivityAt = new Date(t).toISOString()
  }
  // The meta's own start time, when the file's first lines are the parent's (a fork).
  const metaStart = str(meta.timestamp)
  if (metaStart && Number.isFinite(Date.parse(metaStart))) a.startedAt = metaStart
  a.models = [...models]
  a.searchText = [...text_, ...extra].join('\n').slice(0, CODEX_SEARCH_LIMIT)
  // Said in the viewer: a word further on isn't found by the session search.
  // Also when the reader stopped early (a very large rollout cut at its size limit, or
  // lines too long to read): what came after isn't searchable either.
  if (total > CODEX_SEARCH_LIMIT || note?.cutLines || note?.hugeLines) a.searchPartial = true
  a.historyNote = historyNote(lines, note)
  if (note) a.contentBytes = note.bytes
  const context = ctx.result()
  if (context) a.context = context
  return a
}

/** Rough characters per token, for a compaction summary (as for Claude Code). */
const CHARS_PER_TOKEN = 4

/**
 * Codex's context size: what its next request sends, the last response's
 * `last_token_usage.total_tokens` (Codex's own "tokens in the context
 * window"), out of `info.model_context_window`. After a compaction with no
 * response since, an estimate: the session's setup (its first request's
 * input) plus the compaction summary.
 */
class CodexContextTrack {
  private last?: { tokens: number; at?: string; model?: string; window?: number }
  private base?: number
  private compactions = 0
  private compactedAfter?: { at?: string; chars: number }

  tokenCount(p: Record<string, unknown>, at: string | undefined, model: string | undefined): void {
    const info = p.info as Record<string, unknown> | null | undefined
    if (!info || typeof info !== 'object') return
    const last = info.last_token_usage as Record<string, unknown> | undefined
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
    const tokens = n(last?.total_tokens) || n(last?.input_tokens) + n(last?.output_tokens)
    if (!tokens) return
    this.base ??= n(last?.input_tokens) || undefined
    const window = n(info.model_context_window) || undefined
    this.last = { tokens, at, model, window }
    this.compactedAfter = undefined
  }

  compacted(p: Record<string, unknown>, at: string | undefined): void {
    this.compactions++
    const msg = typeof p.message === 'string' ? p.message : ''
    this.compactedAfter = { at, chars: msg.length }
  }

  result(): SessionContext | undefined {
    if (!this.last && !this.compactedAfter) return undefined
    const window = this.last?.window
    const common = {
      compactions: this.compactions,
      ...(this.base ? { baseTokens: this.base } : {}),
      ...(this.last?.model ? { model: this.last.model } : {}),
      ...(window
        ? { windowSize: window, ...(this.last?.model ? { windowModel: this.last.model } : {}) }
        : {})
    }
    if (this.compactedAfter) {
      const tokens = (this.base ?? 0) + Math.ceil(this.compactedAfter.chars / CHARS_PER_TOKEN)
      return {
        tokens,
        from: 'compaction',
        ...(this.compactedAfter.at ? { at: this.compactedAfter.at } : {}),
        ...(this.last ? { preCompactTokens: this.last.tokens } : {}),
        ...common
      }
    }
    return {
      tokens: this.last!.tokens,
      from: 'usage',
      ...(this.last!.at ? { at: this.last!.at } : {}),
      ...common
    }
  }
}

interface Msg {
  role: 'user' | 'assistant'
  texts: string[]
  images: number
  id?: string
}

/** A `response_item` user or assistant message. */
function itemMessage(l: Line): Msg | undefined {
  const p = l.payload
  if (l.type !== 'response_item' || p.type !== 'message') return undefined
  if (p.role !== 'user' && p.role !== 'assistant') return undefined
  const user = p.role === 'user'
  return {
    role: p.role,
    // A user message's texts: only what I wrote (see contentTexts).
    texts: contentTexts(p, user),
    images: imageCount(p, user),
    id: str(p.id)
  }
}

/** The older `event_msg` form of a user or assistant message. */
function eventMessage(l: Line): Msg | undefined {
  const p = l.payload
  if (l.type !== 'event_msg') return undefined
  if (p.type === 'user_message' && typeof p.message === 'string')
    return {
      role: 'user',
      texts: isInjected(p.message) ? [] : [p.message],
      images: Array.isArray(p.images) ? p.images.length : 0
    }
  if (p.type === 'agent_message' && typeof p.message === 'string')
    return { role: 'assistant', texts: [p.message], images: 0 }
  return undefined
}

/**
 * The conversation's messages, by line. Codex has written each message as a
 * `response_item`, as an `event_msg`, or (some versions) as both; a history
 * can mix them (older turns of a session resumed with a newer Codex). So
 * each event is matched to an item one by one, and only to one written next
 * to it (Codex writes both forms of a message within a few lines): an event
 * whose text a nearby, still unmatched item of the same role holds is the
 * same message and is left out; the others are kept. Never a whole-file
 * choice (it would drop the older turns), and never a match far away (a
 * later "yes" isn't an older "yes").
 */
const PAIR_DISTANCE = 12

function conversation(lines: Line[]): Map<Line, Msg> {
  const out = new Map<Line, Msg>()
  const keyOf = (m: Msg, text = m.texts.join('\n')): string => `${m.role}\0${text.trim()}`
  // Per key, the line numbers of items not matched yet (a split item: by each part too).
  const free = new Map<string, number[]>()
  const parts = new Map<number, string[]>()
  lines.forEach((l, i) => {
    const m = itemMessage(l)
    if (!m) return
    out.set(l, m)
    const keys = [keyOf(m), ...(m.texts.length > 1 ? m.texts.map((t) => keyOf(m, t)) : [])]
    parts.set(i, keys)
    for (const k of keys) free.set(k, [...(free.get(k) ?? []), i])
  })
  const take = (i: number): void => {
    for (const k of parts.get(i) ?? [])
      free.set(
        k,
        (free.get(k) ?? []).filter((x) => x !== i)
      )
  }
  // Every message's line, item or event: a pair has no other message between its two
  // copies (a reply in between means a new turn, so an equal text there is a new message).
  const shown = (m: Msg | undefined): boolean => !!m && (m.texts.length > 0 || m.images > 0)
  const msgLines = lines.flatMap((l, i) => (shown(out.get(l)) || shown(eventMessage(l)) ? [i] : []))
  const nothingBetween = (a: number, b: number): boolean =>
    !msgLines.some((k) => k > Math.min(a, b) && k < Math.max(a, b))
  lines.forEach((l, i) => {
    const m = eventMessage(l)
    if (!m || (!m.texts.length && !m.images)) return
    // No text to compare (an image-only prompt): never taken for another message.
    const near = m.texts.join('').trim()
      ? (free.get(keyOf(m)) ?? [])
          .filter((j) => Math.abs(j - i) <= PAIR_DISTANCE && nothingBetween(i, j))
          .sort((a, b) => Math.abs(a - i) - Math.abs(b - i))[0]
      : undefined
    if (near !== undefined) {
      take(near)
      return
    }
    out.set(l, m)
  })
  return out
}

function reasoningTexts(p: Record<string, unknown>): string[] {
  const out: string[] = []
  if (Array.isArray(p.summary))
    for (const s of p.summary) {
      const t = (s as Record<string, unknown> | null)?.text
      if (typeof t === 'string' && t.trim()) out.push(t)
    }
  if (Array.isArray(p.content))
    for (const s of p.content) {
      const t = (s as Record<string, unknown> | null)?.text
      if (typeof t === 'string' && t.trim()) out.push(t)
    }
  return out
}

interface ToolCall {
  callId?: string
  name: string
  input: unknown
  label: string
}

function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The command of a shell-like call, as text. */
function commandText(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const c = o.command ?? o.cmd
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const parts = c.filter((x): x is string => typeof x === 'string')
    // ["bash", "-lc", "npm test"] → "npm test"
    if (parts.length === 3 && /^(ba)?sh$|powershell|pwsh|cmd/i.test(parts[0])) return parts[2]
    return parts.join(' ')
  }
  return undefined
}

/** Files named in an apply_patch input ("*** Update File: src/a.ts"). */
export function patchFiles(patch: string): string[] {
  const out: string[] = []
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm))
    out.push(m[1].trim())
  return out
}

function toolLabel(name: string, input: unknown): string {
  const cmd = commandText(input)
  if (cmd) return `${name}: ${oneLine(cmd)}`
  if (name === 'apply_patch') {
    const patch =
      typeof input === 'string' ? input : String((input as { input?: unknown })?.input ?? '')
    const files = patchFiles(patch)
    if (files.length)
      return `apply_patch ${files[0]}${files.length > 1 ? ` +${files.length - 1}` : ''}`
  }
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const k of ['path', 'file_path', 'query', 'url', 'pattern', 'plan']) {
      const v = o[k]
      if (typeof v === 'string' && v) return `${name}: ${oneLine(v)}`
    }
  }
  return name
}

/** A tool call item, or undefined. */
function toolCallOf(p: Record<string, unknown>): ToolCall | undefined {
  switch (p.type) {
    case 'function_call': {
      const name = str(p.name) ?? 'tool'
      const ns = str(p.namespace)
      const input = parseArgs(p.arguments)
      const full = ns && !name.startsWith(ns) ? `${ns}.${name}` : name
      return { callId: str(p.call_id), name: full, input, label: toolLabel(full, input) }
    }
    case 'custom_tool_call': {
      const name = str(p.name) ?? 'tool'
      const input = parseArgs(p.input)
      return { callId: str(p.call_id), name, input, label: toolLabel(name, input) }
    }
    case 'local_shell_call': {
      const action = (p.action ?? {}) as Record<string, unknown>
      return {
        callId: str(p.call_id) ?? str(p.id),
        name: 'shell',
        input: action,
        label: toolLabel('shell', action)
      }
    }
    case 'web_search_call': {
      const action = (p.action ?? {}) as Record<string, unknown>
      return {
        callId: str(p.id),
        name: 'web_search',
        input: action,
        label: toolLabel('web_search', action)
      }
    }
  }
  return undefined
}

/** A tool output item: its call id and result. */
function toolOutputOf(
  p: Record<string, unknown>
): { callId?: string; result: ToolResult } | undefined {
  if (p.type !== 'function_call_output' && p.type !== 'custom_tool_call_output') return undefined
  const out = p.output
  let text = ''
  let isError = false
  if (typeof out === 'string') {
    // Older shells wrap the output as JSON: {"output": "...", "metadata": {"exit_code": 1}}.
    const parsed = parseArgs(out)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { output?: unknown }).output === 'string'
    ) {
      const o = parsed as { output: string; metadata?: { exit_code?: unknown } }
      text = o.output
      isError = typeof o.metadata?.exit_code === 'number' && o.metadata.exit_code !== 0
    } else text = out
  } else if (Array.isArray(out)) {
    text = contentTexts({ content: out }, false).join('\n')
  } else if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>
    text = contentTexts(o, false).join('\n')
    if (o.success === false) isError = true
  }
  const m = /^Exit code: (\d+)/m.exec(text) ?? /Process exited with code (\d+)/.exec(text)
  if (m && m[1] !== '0') isError = true
  return { callId: str(p.call_id), result: { text, isError } }
}

/**
 * The conversation for the viewer. User prompts become user messages; each
 * assistant turn's reasoning summaries and tool calls go into the assistant
 * message they lead up to, with tool outputs attached to their calls.
 */
export function buildCodexMessages(text: string): ChatMessage[] {
  const { lines } = parseLines(text)
  const messages = conversation(lines)
  const out: ChatMessage[] = []
  const calls = new Map<string, Extract<ContentBlock, { type: 'tool_use' }>>()
  let current: ChatMessage | undefined
  let model: string | undefined
  let n = 0
  const nextId = (l: Line, own?: string): string => own ?? `codex-${l.ordinal ?? n}-${n}`
  const assistant = (l: Line): ChatMessage => {
    if (!current) {
      current = {
        id: nextId(l),
        role: 'assistant',
        kind: 'response',
        timestamp: l.timestamp,
        model,
        blocks: []
      }
      out.push(current)
    }
    return current
  }
  for (const l of lines) {
    n++
    const p = l.payload
    if (l.type === 'turn_context') {
      model = str(p.model) ?? model
      continue
    }
    if (l.type === 'compacted') {
      current = undefined
      out.push({
        id: nextId(l),
        role: 'system',
        kind: 'compact',
        timestamp: l.timestamp,
        blocks: [{ type: 'text', text: str(p.message) ?? 'The conversation was compacted.' }]
      })
      continue
    }
    const msg = messages.get(l)
    if (msg) {
      if (msg.role === 'user') {
        const shown = msg.texts
        if (!shown.length && !msg.images) continue
        current = undefined
        const blocks: ContentBlock[] = shown.map((t) => ({ type: 'text', text: t }))
        for (let i = 0; i < msg.images; i++) blocks.push({ type: 'image' })
        out.push({
          id: nextId(l, msg.id),
          role: 'user',
          kind: 'prompt',
          timestamp: l.timestamp,
          blocks
        })
      } else {
        const m = assistant(l)
        for (const t of msg.texts) if (t.trim()) m.blocks.push({ type: 'text', text: t })
        // The answer ends the assistant message: the next reasoning starts a new one.
        current = undefined
      }
      continue
    }
    if (l.type !== 'response_item') continue
    if (p.type === 'reasoning') {
      const texts = reasoningTexts(p)
      if (texts.length) assistant(l).blocks.push({ type: 'thinking', text: texts.join('\n\n') })
      else if (p.encrypted_content !== undefined || p.summary !== undefined)
        assistant(l).blocks.push({ type: 'thinking', text: '', redacted: true })
      continue
    }
    const call = toolCallOf(p)
    if (call) {
      const block: Extract<ContentBlock, { type: 'tool_use' }> = {
        type: 'tool_use',
        id: call.callId ?? nextId(l),
        name: call.name,
        input: call.input,
        label: call.label
      }
      assistant(l).blocks.push(block)
      if (call.callId) calls.set(call.callId, block)
      continue
    }
    const res = toolOutputOf(p)
    if (res) {
      const target = res.callId ? calls.get(res.callId) : undefined
      if (target) target.result = res.result
      else
        assistant(l).blocks.push({
          type: 'tool_result',
          toolUseId: res.callId ?? '',
          result: res.result
        })
    }
  }
  return out.filter((m) => m.blocks.length)
}

/** The session id in a rollout's file name (`rollout-<time>-<uuid>.jsonl[.zst]`). */
const ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i

export function rolloutIdOf(fileName: string): string | undefined {
  return ROLLOUT_RE.exec(fileName)?.[1]?.toLowerCase()
}
