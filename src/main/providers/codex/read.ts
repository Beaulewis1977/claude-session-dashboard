// Reading a Codex rollout (`rollout-*.jsonl`, or `.jsonl.zst` once Codex has
// compressed it). Rollouts can be very large (hundreds of MB once
// decompressed, more than a JavaScript string can hold), and most of that is
// context the viewer never shows: the instructions sent with every turn
// (`world_state`, `base_instructions`), tool lists, encrypted reasoning and
// duplicated progress events. So the file is streamed (decompressed with
// fzstd, pure JS), split into lines, and each line is kept, trimmed or
// dropped; the result is a compact JSONL text with only what the app uses.
//
// Read-only: the file is only ever opened for reading.

import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Decompress } from 'fzstd'
import { isContextItem, isInjected } from './provenance'
import { breathe } from '../../core/breathe'

/** First bytes of a zstd frame. Codex renames a rollout to .zst when it compresses it. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** The compact text stops growing here (the rest is counted, not kept). */
export const COMPACT_LIMIT = 48 * 1024 * 1024
/** A single line longer than this (before trimming) is dropped. */
export const LINE_LIMIT = 64 * 1024 * 1024
/** Long strings (tool output, patches, arguments) are cut to this many characters. */
export const FIELD_LIMIT = 64 * 1024
/** Text that's never shown (context Codex adds, developer messages): only its start. */
export const CONTEXT_KEEP = 2 * 1024

/**
 * The version of the compact text this reader writes. Bump it whenever
 * compactLine keeps or cuts something differently: copies kept in the text
 * cache by an older version are then read again instead of reused.
 * 1: message text cut like tool output. 2: message text kept whole.
 * 3: context Codex adds (never shown) kept only by its start.
 * 4: images kept only as their type (the viewer shows a placeholder), not their data.
 * 5: token_count events kept past the cut too (the context size is the last one's).
 */
export const COMPACT_FORMAT = 5

/** The first line of the compact text: what the reader saw. Parsed by parse.ts. */
export const READ_NOTE_TYPE = 'csd_read_note'

export interface ReadNote {
  type: typeof READ_NOTE_TYPE
  /** Lines in the file. */
  lines: number
  /** Lines left out because the compact text was full. */
  cutLines: number
  /** Lines too long to read at all. */
  hugeLines: number
  /** Bytes of the (decompressed) file. */
  bytes: number
  compressed: boolean
  /** Time of the file's last line (also past the cut). */
  lastAt?: string
  /** The first line's ordinal (Codex numbers every line from 0), if lines have them. */
  firstOrdinal?: number
  /** Places where the ordinals skip. */
  ordinalGaps: number
}

/**
 * Codex's login (auth.json) and anything that looks like a credential: never
 * opened, whatever path reaches the reader.
 */
export function isCredentialPath(path: string): boolean {
  return /(^|[\\/])(auth\.json|[^\\/]*(credential|token|secret)[^\\/]*|[^\\/]*\.(key|pem))$/i.test(
    path
  )
}

function refuseCredentials(path: string): void {
  if (isCredentialPath(path)) throw new Error('Not a session file')
}

export async function isZstdFile(path: string): Promise<boolean> {
  refuseCredentials(path)
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    return bytesRead === 4 && ZSTD_MAGIC.every((b, i) => buf[i] === b)
  } finally {
    await fh.close()
  }
}

/** Event types the app never shows or uses. */
const DROP_TYPES = new Set(['world_state', 'inter_agent_communication_metadata'])
/** `response_item` payloads the app never shows. */
const DROP_ITEMS = new Set(['additional_tools'])
/** `event_msg` payloads that repeat what `response_item`s already hold, or are progress only. */
const DROP_EVENTS = new Set([
  'item_completed',
  'item_started',
  'agent_message_delta',
  'agent_reasoning_delta',
  'agent_reasoning_raw_content',
  'agent_reasoning_raw_content_delta',
  'exec_command_output_delta',
  'exec_command_begin',
  'exec_command_end',
  'patch_apply_begin',
  'patch_apply_end',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'web_search_begin',
  'web_search_end',
  'background_event',
  'raw_response_item'
])

function cut(s: string): string {
  return cutTo(s, FIELD_LIMIT)
}

function cutTo(s: string, n: number): string {
  return s.length > n
    ? `${s.slice(0, n)}\n… [cut by the dashboard: ${s.length - n} more characters]`
    : s
}

/**
 * A message as the compact text keeps it. What I wrote and what the agent
 * answered stay whole; text that's never shown (the context Codex adds as
 * user text, and developer/system messages) keeps only its start, so it
 * can't use up the size budget before later prompts and answers. Images
 * (often base64 screenshots) keep only their type: the viewer shows a
 * placeholder. Content items keep their places (provenance is per item index).
 */
function compactMessage(p: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(p.content)) return p
  const user = p.role === 'user'
  const assistant = p.role === 'assistant'
  const content = p.content.map((c: unknown, i) => {
    if (!c || typeof c !== 'object') return c
    const item = c as Record<string, unknown>
    if (/image/.test(String(item.type))) return { type: item.type }
    if (assistant) return item
    if (typeof item.text !== 'string') return user ? item : trimDeep(item)
    if (user && !isContextItem(p, i, item.text)) return item
    return { ...item, text: cutTo(item.text, CONTEXT_KEEP) }
  })
  return { ...p, content }
}

/** An older `user_message` event's images: only how many (the viewer shows placeholders). */
function withoutImageData(p: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(p.images) && p.images.length ? { ...p, images: p.images.map(() => '') } : p
}

/** Shorten every long string inside a value (tool output, patches, arguments). */
function trimDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return cut(v)
  if (depth > 8 || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((x) => trimDeep(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = trimDeep(x, depth + 1)
  return out
}

/**
 * One line of the rollout as the compact text keeps it, or undefined to drop
 * it. Lines that aren't JSON objects are kept as they are (counted as
 * malformed by the parser).
 */
export function compactLine(line: string): string | undefined {
  // Cheap checks first: most dropped lines are recognised without parsing.
  const head = line.slice(0, 200)
  for (const t of DROP_TYPES) if (head.includes(`"type":"${t}"`)) return undefined
  let o: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(line)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return line
    o = v as Record<string, unknown>
  } catch {
    return line
  }
  const type = o.type
  const payload = (o.payload ?? {}) as Record<string, unknown>
  if (typeof type === 'string' && DROP_TYPES.has(type)) return undefined
  if (type === 'token_usage_record') return undefined
  if (type === 'response_item' && DROP_ITEMS.has(String(payload.type))) return undefined
  if (type === 'event_msg' && DROP_EVENTS.has(String(payload.type))) return undefined
  const keep: Record<string, unknown> = {}
  if (o.timestamp !== undefined) keep.timestamp = o.timestamp
  if (o.ordinal !== undefined) keep.ordinal = o.ordinal
  keep.type = type
  if (type === 'session_meta') {
    // The instructions Codex was started with: large, and never shown.
    const { base_instructions: _bi, ...rest } = payload
    keep.payload = trimDeep(rest)
  } else if (type === 'response_item' && payload.type === 'reasoning') {
    // Encrypted reasoning can't be read; the summary (and any plain text) can.
    const { encrypted_content: _e, ...rest } = payload
    keep.payload = trimDeep(rest)
  } else if (type === 'turn_context') {
    const p = payload
    const cm = (p.collaboration_mode ?? {}) as Record<string, unknown>
    const settings = (cm.settings ?? {}) as Record<string, unknown>
    keep.payload = {
      cwd: p.cwd,
      model: p.model,
      effort: p.effort ?? p.reasoning_effort ?? settings.reasoning_effort,
      approval_policy: p.approval_policy
    }
  } else if (type === 'response_item' && payload.type === 'message') {
    keep.payload = compactMessage(payload)
  } else if (
    type === 'event_msg' &&
    (payload.type === 'user_message' || payload.type === 'agent_message')
  ) {
    // What I wrote and what the agent answered: kept whole. Context Codex added
    // (never shown) only by its start.
    keep.payload =
      payload.type === 'user_message' &&
      typeof payload.message === 'string' &&
      isInjected(payload.message)
        ? { ...payload, message: cutTo(payload.message, CONTEXT_KEEP) }
        : withoutImageData(payload)
  } else {
    keep.payload = trimDeep(payload)
  }
  return JSON.stringify(keep)
}

/**
 * Stream the file's lines (decompressing a zstd file) to `onLine`. Lines
 * longer than LINE_LIMIT are skipped and reported through `onHuge`. Yields to
 * the event loop now and then, so a big file doesn't block the app.
 */
async function eachLine(
  path: string,
  compressed: boolean,
  onLine: (line: string) => void,
  onHuge: () => void,
  /** Checked after each chunk: true stops reading (the rest of the file is skipped). */
  stop: () => boolean = () => false
): Promise<number> {
  let parts: Buffer[] = []
  let partLen = 0
  let skipping = false
  let bytes = 0
  const take = (chunk: Uint8Array): void => {
    let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    bytes += buf.length
    for (;;) {
      const nl = buf.indexOf(0x0a)
      if (nl < 0) {
        if (!skipping) {
          parts.push(Buffer.from(buf))
          partLen += buf.length
          if (partLen > LINE_LIMIT) {
            skipping = true
            parts = []
            partLen = 0
          }
        }
        return
      }
      const piece = buf.subarray(0, nl)
      if (skipping) {
        onHuge()
        skipping = false
      } else {
        const line = partLen ? Buffer.concat([...parts, piece]) : piece
        if (line.length) onLine(line.toString('utf8').replace(/\r$/, ''))
      }
      parts = []
      partLen = 0
      buf = buf.subarray(nl + 1)
    }
  }
  const zstd = compressed ? new Decompress((data) => take(data)) : undefined
  // A compressed chunk unpacks to several times its size (all handled in one
  // push), so those are read in smaller chunks.
  const highWaterMark = zstd ? 128 * 1024 : 1024 * 1024
  for await (const chunk of createReadStream(path, { highWaterMark })) {
    const c = chunk as Buffer
    if (zstd) zstd.push(c)
    else take(c)
    if (stop()) return bytes
    await breathe()
  }
  if (zstd) zstd.push(new Uint8Array(0), true)
  // The last line (no newline after it).
  if (skipping) onHuge()
  else if (partLen) onLine(Buffer.concat(parts).toString('utf8').replace(/\r$/, ''))
  return bytes
}

/**
 * The compact JSONL text of a rollout (see the top of this file). Its first
 * line is a ReadNote; parse.ts turns a cut or unreadable line into the
 * viewer's "history may be incomplete" note.
 */
const ORDINAL_RE = /^\{"timestamp":"[^"]*","ordinal":(\d+)/
const TIMESTAMP_RE = /^\{"timestamp":"([^"]{10,40})"/

export async function readCodexText(
  path: string,
  limit = COMPACT_LIMIT,
  opts: {
    /**
     * Stop at the limit instead of reading to the end (for showing or
     * searching a session; the summary needs the end, for its last activity).
     */
    partial?: boolean
  } = {}
): Promise<string> {
  refuseCredentials(path)
  const compressed = await isZstdFile(path)
  const out: string[] = []
  let size = 0
  const note: ReadNote = {
    type: READ_NOTE_TYPE,
    lines: 0,
    cutLines: 0,
    hugeLines: 0,
    bytes: 0,
    compressed,
    ordinalGaps: 0
  }
  let prevOrdinal: number | undefined
  note.bytes = await eachLine(
    path,
    compressed,
    (line) => {
      note.lines++
      const at = TIMESTAMP_RE.exec(line)?.[1]
      if (at) note.lastAt = at
      const ord = ORDINAL_RE.exec(line.slice(0, 120))?.[1]
      if (ord !== undefined) {
        const o = Number(ord)
        if (prevOrdinal === undefined) note.firstOrdinal = o
        else if (o > prevOrdinal + 1) note.ordinalGaps++
        prevOrdinal = o
      }
      if (size >= limit) {
        // Past the cut: only the small settings lines (model, effort) and
        // token counts (the context size) are kept.
        const head = line.slice(0, 200)
        if (head.includes('"type":"turn_context"') || head.includes('"type":"token_count"')) {
          const kept = compactLine(line)
          if (kept) out.push(kept)
        } else note.cutLines++
        return
      }
      const kept = compactLine(line)
      if (kept === undefined) return
      out.push(kept)
      size += kept.length + 1
    },
    () => {
      note.lines++
      note.hugeLines++
    },
    () => !!opts.partial && size >= limit
  )
  if (opts.partial && size >= limit && !note.cutLines) note.cutLines = 1
  return [JSON.stringify(note), ...out].join('\n')
}

/** How many (decompressed) bytes the file had, from a compact text's first line. */
export function readBytesOf(text: string): number {
  const nl = text.indexOf('\n')
  const first = nl < 0 ? text : text.slice(0, nl)
  try {
    const n = (JSON.parse(first) as Partial<ReadNote>).bytes
    return typeof n === 'number' ? n : 0
  } catch {
    return 0
  }
}

/** Line types the usage reader keeps (everything else is skipped unparsed). */
const USAGE_TYPES_RE =
  /"type":"(?:session_meta|turn_context|compacted|token_count|task_started|task_complete|turn_aborted|user_message|thread_settings_applied)"/

/**
 * For token speed, only by their type and time (never parsed: they can be
 * large): the model's reasoning items, and newer Codex's usage record of each
 * response (written right after it ended).
 */
const REASONING_RE =
  /^\{"timestamp":"[^"]{10,40}",(?:"ordinal":\d+,)?"type":"response_item","payload":\{"type":"reasoning"/
const USAGE_RECORD_RE =
  /^\{"timestamp":"[^"]{10,40}",(?:"ordinal":\d+,)?"type":"token_usage_record"/

/** Tool calls, counted for trends by their type only (never parsed: their input can be large). */
const TOOL_CALL_RE =
  /"payload":\{"type":"(function_call|custom_tool_call|local_shell_call|web_search_call|tool_search_call)"/
/** Tool outputs: only whether they report a failing exit code (from their start). */
const TOOL_OUTPUT_RE = /"payload":\{"type":"(function_call_output|custom_tool_call_output)"/
const EXIT_RE = /Exit code: (\d+)|Process exited with code (\d+)|\\"exit_code\\":(\d+)/
/**
 * A finished tool item with its status (newer Codex): the most reliable error
 * signal. Every kind of tool counts (commands, MCP and dynamic tools, file
 * changes, collaboration tools such as spawn_agent, extensions, …), so the
 * rate isn't taken from a few kinds only; the items that aren't tool calls
 * are left out (see isToolItemType).
 */
const TOOL_ITEM_RE = /"type":"item_completed".*?"item":\{"type":"([A-Za-z]+)"/

/** Finished items that aren't tool calls: messages, reasoning, compaction, subagent activity. */
const NOT_TOOL_ITEMS = new Set([
  'AgentMessage',
  'UserMessage',
  'Reasoning',
  'ContextCompaction',
  'SubAgentActivity',
  // The output of a function call, already counted with its call.
  'FunctionCallOutput'
])

export function isToolItemType(type: unknown): boolean {
  return typeof type === 'string' && /^[A-Za-z]+$/.test(type) && !NOT_TOOL_ITEMS.has(type)
}
const MESSAGE_RE = /"payload":\{"type":"message"/

/** The version of the usage text: bumped when it keeps more (see CODEX_USAGE_VERSION). */
// 4: reasoning items, the model's messages and token_usage_record by type and time (token
//    speed), and the service tier of thread_settings_applied (fast mode).
export const USAGE_TEXT_FORMAT = 4

/**
 * Only what token usage, plan limits and trends need, from the whole file
 * (never cut, however large): each `token_count` event, the model of each
 * turn (`turn_context`), the session's own meta (without its instructions),
 * compaction markers, turn starts and ends (`task_started`,
 * `task_complete`, `turn_aborted`), and for trends: each tool call by its
 * type only, each tool output as "failed or not", each finished tool item's
 * status, and each user message as "a prompt I wrote or context Codex
 * added"; for token speed, the times of the model's reasoning items, its
 * messages and its usage records, and the service tier (fast mode). Never any
 * text. Small even for huge rollouts. Read-only.
 */
export async function readCodexUsageText(path: string): Promise<string> {
  refuseCredentials(path)
  const compressed = await isZstdFile(path)
  const out: string[] = []
  await eachLine(
    path,
    compressed,
    (line) => {
      const head = line.slice(0, 400)
      const ts = TIMESTAMP_RE.exec(head)?.[1]
      if (REASONING_RE.test(head) || USAGE_RECORD_RE.test(head)) {
        const reasoning = REASONING_RE.test(head)
        out.push(
          JSON.stringify(
            reasoning
              ? { timestamp: ts, type: 'response_item', payload: { type: 'reasoning' } }
              : { timestamp: ts, type: 'token_usage_record', payload: {} }
          )
        )
        return
      }
      const call = TOOL_CALL_RE.exec(head)
      if (call) {
        out.push(
          JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: call[1] } })
        )
        return
      }
      const output = TOOL_OUTPUT_RE.exec(head)
      if (output) {
        const m = EXIT_RE.exec(line.slice(0, 8000))
        const code = m ? Number(m[1] ?? m[2] ?? m[3]) : undefined
        out.push(
          JSON.stringify({
            timestamp: ts,
            type: 'response_item',
            payload: { type: output[1], ...(code !== undefined ? { exit: code } : {}) }
          })
        )
        return
      }
      const itemType = TOOL_ITEM_RE.exec(head)?.[1]
      const item = isToolItemType(itemType) ? itemType : undefined
      const message = !item && MESSAGE_RE.test(head)
      if (!item && !message && !USAGE_TYPES_RE.test(line.slice(0, 300))) return
      let o: Record<string, unknown>
      try {
        const v: unknown = JSON.parse(line)
        if (!v || typeof v !== 'object' || Array.isArray(v)) return
        o = v as Record<string, unknown>
      } catch {
        return
      }
      const p = (o.payload ?? {}) as Record<string, unknown>
      const keep: Record<string, unknown> = { timestamp: o.timestamp, type: o.type }
      const src = p.source as Record<string, unknown> | undefined
      if (o.type === 'session_meta') {
        keep.payload = {
          id: p.id,
          timestamp: p.timestamp,
          forked_from_id: p.forked_from_id,
          cli_version: p.cli_version,
          // A subagent's thread (its "prompts" are the main agent's instructions).
          ...((src && typeof src === 'object' && 'subagent' in src) ||
          p.thread_source === 'subagent'
            ? { subagent: true }
            : {})
        }
      } else if (o.type === 'turn_context') {
        keep.payload = { model: p.model }
      } else if (o.type === 'compacted') {
        keep.payload = {}
      } else if (o.type === 'event_msg' && p.type === 'token_count') {
        keep.payload = { type: p.type, info: p.info, rate_limits: p.rate_limits }
      } else if (
        o.type === 'event_msg' &&
        (p.type === 'task_started' || p.type === 'task_complete' || p.type === 'turn_aborted')
      ) {
        const n = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) ? v : undefined
        keep.payload = {
          type: p.type,
          turn_id: typeof p.turn_id === 'string' ? p.turn_id : undefined,
          started_at: n(p.started_at),
          completed_at: n(p.completed_at),
          duration_ms: n(p.duration_ms),
          time_to_first_token_ms: n(p.time_to_first_token_ms),
          ...(p.error ? { error: true } : {}),
          ...(typeof p.reason === 'string' ? { reason: p.reason.slice(0, 40) } : {})
        }
      } else if (o.type === 'event_msg' && p.type === 'item_completed' && item) {
        const it = (p.item ?? {}) as Record<string, unknown>
        keep.payload = {
          type: p.type,
          item: { type: it.type, status: typeof it.status === 'string' ? it.status : undefined }
        }
      } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        // A prompt I wrote, or only context Codex added (environment, AGENTS.md, …)? Never its text.
        const content = Array.isArray(p.content) ? p.content : []
        const mine = content.some((c: unknown, i) => {
          const t = (c as { text?: unknown } | null)?.text
          return typeof t === 'string' && t.trim() !== '' && !isContextItem(p, i, t)
        })
        keep.payload = { type: 'message', role: 'user', prompt: mine }
      } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
        // The model's own message, by its time only (token speed).
        keep.payload = { type: 'message', role: 'assistant' }
      } else if (o.type === 'event_msg' && p.type === 'thread_settings_applied') {
        // Fast mode: Codex's /fast is the "priority" service tier.
        const tier = (p.thread_settings as Record<string, unknown> | undefined)?.service_tier
        keep.payload = {
          type: p.type,
          thread_settings: typeof tier === 'string' ? { service_tier: tier.slice(0, 20) } : {}
        }
      } else if (o.type === 'event_msg' && p.type === 'user_message') {
        // Older Codex: the prompt as an event.
        const t = typeof p.message === 'string' ? p.message : ''
        keep.type = 'response_item'
        keep.payload = { type: 'message', role: 'user', prompt: !!t.trim() && !isInjected(t) }
      } else return
      out.push(JSON.stringify(keep))
    },
    () => undefined
  )
  return out.join('\n')
}
