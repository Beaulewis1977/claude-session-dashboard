// A small, test-only model of how ccusage loads Claude Code usage, written
// to mirror the structure of ccusage's own loader (rust/adapters/claude/src/
// lib.rs at commit 06347d39: read_usage_file, is_valid_usage_entry,
// push_deduped_entry). ccusage is MIT licensed, see THIRD_PARTY_NOTICES.
// The app's code (shared/usage/parse.ts and dedupe.ts) is a separate
// implementation; the parity test checks that both give the same totals.

import { basename, dirname } from 'node:path'

export interface RefEntry {
  mid?: string
  rid?: string
  /** The entry's `sessionId`, else the one from the file path. */
  sid: string
  ts: number
  sc: boolean
  speed?: string
  model?: string
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
}

const u64 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const optU64 = (v: unknown): boolean => v === undefined || v === null || u64(v)
const optStr = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** extract_session_parts: `<project>/<id>.jsonl` or `<project>/<id>/subagents/<x>.jsonl`. */
export function fileSessionId(path: string): string {
  const dir = dirname(path)
  if (basename(dir) === 'subagents') return basename(dirname(dir))
  return basename(path).replace(/\.jsonl$/, '')
}

interface RawUsage {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  speed?: string
}

/** TokenUsageRaw: input/output required, the rest default to 0. */
function tokenUsage(u: unknown): RawUsage | undefined {
  if (!isObj(u) || !u64(u.input_tokens) || !u64(u.output_tokens)) return undefined
  if (!optU64(u.cache_creation_input_tokens) || !optU64(u.cache_read_input_tokens)) return undefined
  const cc = u.cache_creation
  if (cc !== undefined && cc !== null) {
    if (
      !isObj(cc) ||
      !optU64(cc.ephemeral_5m_input_tokens) ||
      !optU64(cc.ephemeral_1h_input_tokens)
    )
      return undefined
  }
  const n = (v: unknown): number => (u64(v) ? v : 0)
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    // cache_creation_token_count: the nested split when present, else the flat total.
    cacheCreate: isObj(cc)
      ? n(cc.ephemeral_5m_input_tokens) + n(cc.ephemeral_1h_input_tokens)
      : n(u.cache_creation_input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    speed: typeof u.speed === 'string' ? u.speed : undefined
  }
}

const semverPrefix = (v: string): boolean => /^\d+\.\d+\.\d/.test(v)

/** read_usage_file */
export function readUsageFile(path: string, text: string): RefEntry[] {
  const fileSid = fileSessionId(path)
  const out: RefEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"usage":{')) continue
    let d: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isObj(parsed)) continue
      d = parsed
    } catch {
      continue
    }
    const m = d.message
    if (typeof d.timestamp !== 'string' || !isObj(m)) continue
    const usage = tokenUsage(m.usage)
    if (!usage) continue
    if (![d.sessionId, d.version, d.requestId, m.model, m.id].every(optStr)) continue
    if (d.isSidechain !== undefined && d.isSidechain !== null && typeof d.isSidechain !== 'boolean')
      continue
    const ts = Date.parse(d.timestamp)
    if (!Number.isFinite(ts)) continue
    // is_valid_usage_entry
    if (typeof d.version === 'string' && !semverPrefix(d.version)) continue
    if ([d.sessionId, d.requestId, m.id, m.model].some((v) => v === '')) continue

    const mid = typeof m.id === 'string' ? m.id : undefined
    const rid = typeof d.requestId === 'string' ? d.requestId : undefined
    const sid = typeof d.sessionId === 'string' ? d.sessionId : fileSid
    const sc = d.isSidechain === true
    const rawModel = typeof m.model === 'string' ? m.model : undefined
    const model =
      rawModel === undefined || rawModel === '<synthetic>'
        ? undefined
        : usage.speed === 'fast'
          ? rawModel.endsWith('-fast')
            ? rawModel
            : `${rawModel}-fast`
          : rawModel
    out.push({ mid, rid, sid, ts, sc, speed: usage.speed, model, ...usage })

    // advisor_usages_from_line
    const its = isObj(m.usage) ? m.usage.iterations : undefined
    if (!line.includes('"advisor_message"') || !Array.isArray(its)) continue
    const parsedIts = its.map((it) => (isObj(it) ? { it, u: tokenUsage(it) } : undefined))
    if (parsedIts.some((p) => !p || !p.u || typeof p.it.type !== 'string')) continue
    let i = 0
    for (const p of parsedIts) {
      const am = p!.it.model
      if (p!.it.type === 'advisor_message' && typeof am === 'string' && am) {
        out.push({
          mid: mid === undefined ? undefined : `${mid}:advisor:${i}`,
          rid,
          sid,
          ts,
          sc,
          speed: p!.u!.speed,
          model: am,
          ...p!.u!
        })
        i++
      }
    }
  }
  return out
}

const total = (e: RefEntry): number => e.input + e.output + e.cacheCreate + e.cacheRead
const anthropicId = (id: string): boolean => id.startsWith('msg_') || id.startsWith('resp_')

/** should_replace_deduped_entry */
function shouldReplace(c: RefEntry, e: RefEntry): boolean {
  if (c.sc !== e.sc) return e.sc
  if (total(c) !== total(e)) return total(c) > total(e)
  return c.speed !== undefined && e.speed === undefined
}

/** push_deduped_entry over all entries, in file order. */
export function dedupe(entries: RefEntry[]): RefEntry[] {
  const kept: RefEntry[] = []
  const index = new Map<string, { i: number; alias?: string }[]>()
  const push = (k: string, i: number, alias?: string): void => {
    const list = index.get(k) ?? []
    if (!list.some((x) => x.i === i && x.alias === alias)) list.push({ i, alias })
    index.set(k, list)
  }
  const exactKey = (e: RefEntry): string =>
    e.rid !== undefined
      ? `x\n${e.mid}\n${e.rid}`
      : `x\n${e.mid}\n\n${e.sid}${anthropicId(e.mid!) ? '' : `\n${e.ts}`}`
  const replayKey = (mid: string, sid: string): string => `r\n${mid}\n${sid}`
  const replayEntryKey = (mid: string, sid: string): string => `re\n${mid}\n${sid}`

  for (const c of entries) {
    if (c.mid === undefined) {
      kept.push(c)
      continue
    }
    const mid = c.mid
    const hash = exactKey(c)
    let found = index.get(hash)?.find(({ i }) => {
      const e = kept[i]
      return (
        e.mid === mid &&
        e.rid === c.rid &&
        (c.rid !== undefined || (e.sid === c.sid && (anthropicId(mid) || e.ts === c.ts)))
      )
    })?.i
    if (found === undefined) {
      const route = c.sc ? replayKey(mid, c.sid) : replayEntryKey(mid, c.sid)
      found = index.get(route)?.find(({ i, alias }) => {
        const e = kept[i]
        const requestless = c.rid === undefined && e.rid === undefined
        return (
          (alias ?? e.sid) === c.sid &&
          e.mid === mid &&
          (requestless || e.ts === c.ts) &&
          (c.sc || e.sc)
        )
      })?.i
    }
    if (found !== undefined) {
      const e = kept[found]
      if (c.sid !== e.sid) {
        for (const s of [c.sid, e.sid]) {
          push(replayKey(mid, s), found, s)
          push(replayEntryKey(mid, s), found, s)
        }
      }
      if (shouldReplace(c, e)) {
        kept[found] = c
        if (exactKey(e) !== hash) push(hash, found)
        if (e.sid !== c.sid || e.sc !== c.sc) {
          push(replayKey(mid, c.sid), found)
          if (c.sc) push(replayEntryKey(mid, c.sid), found)
        }
      }
      continue
    }
    const i = kept.length
    kept.push(c)
    push(hash, i)
    push(replayKey(mid, c.sid), i)
    if (c.sc) push(replayEntryKey(mid, c.sid), i)
  }
  return kept
}

export interface DayTotals {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
}

/** Like `ccusage daily --timezone UTC`: token totals per day. */
export function dailyTotals(entries: RefEntry[]): Record<string, DayTotals> {
  const out: Record<string, DayTotals> = {}
  for (const e of entries) {
    const day = new Date(e.ts).toISOString().slice(0, 10)
    const t = (out[day] ??= { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 })
    t.input += e.input
    t.output += e.output
    t.cacheCreate += e.cacheCreate
    t.cacheRead += e.cacheRead
  }
  return out
}
