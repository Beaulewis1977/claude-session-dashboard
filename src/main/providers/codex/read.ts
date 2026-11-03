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

/** First bytes of a zstd frame. Codex renames a rollout to .zst when it compresses it. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** The compact text stops growing here (the rest is counted, not kept). */
export const COMPACT_LIMIT = 48 * 1024 * 1024
/** A single line longer than this (before trimming) is dropped. */
export const LINE_LIMIT = 64 * 1024 * 1024
/** Long strings (tool output, patches, arguments) are cut to this many characters. */
export const FIELD_LIMIT = 64 * 1024

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
  return s.length > FIELD_LIMIT
    ? `${s.slice(0, FIELD_LIMIT)}\n… [cut by the dashboard: ${s.length - FIELD_LIMIT} more characters]`
    : s
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
  let sinceYield = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const c = chunk as Buffer
    if (zstd) zstd.push(c)
    else take(c)
    if (stop()) return bytes
    sinceYield += c.length
    if (sinceYield > 8 * 1024 * 1024) {
      sinceYield = 0
      await new Promise((r) => setImmediate(r))
    }
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
        // Past the cut: only the small settings lines (model, effort) are kept.
        if (line.slice(0, 200).includes('"type":"turn_context"')) {
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
