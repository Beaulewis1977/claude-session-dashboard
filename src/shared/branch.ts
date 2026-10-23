// "Branch from here": cut a session at a message and turn the prefix into a
// new session file.
//
// Claude Code can't resume an interactive session at a given message (its
// `--resume-session-at` flag is hidden and only works with `--print`), so the
// app writes a new session file: the original's lines up to and including the
// chosen message, with a new session id. Lines are copied the way Claude Code's
// own `/branch` does it: same message uuids, the new `sessionId`, and a
// `forkedFrom` marker pointing back at the original.
//
// A cut never separates a tool call from its result. If the chosen message
// calls tools whose results come later, the results are pulled in (forward);
// if that isn't possible, the cut moves back to the nearest earlier safe point.

import type { ChatMessage } from './types'
import { buildMessagesWithRanges, isToolResultOnly, isUuid, str, type RawEvent } from './jsonl'

export type BranchMode = 'include' | 'before'

export interface BranchPlanOk {
  ok: true
  /** Index of the last event kept (inclusive). */
  endIndex: number
  /** The transcript message the branch now ends with. */
  atMessageId: string
  atRole: 'user' | 'assistant'
  atPreview: string
  atTime?: string
  /** 'forward': tool results were pulled in. 'backward': moved to an earlier safe point. */
  snapped: 'none' | 'forward' | 'backward'
  /** Tools involved in the snap (for the notice). */
  snapTools: string[]
  keptMessages: number
  totalMessages: number
}

export type BranchPlan = BranchPlanOk | { ok: false; error: string }

const conversational = (m: ChatMessage): boolean => m.role === 'user' || m.role === 'assistant'

function blocksOf(e: RawEvent): unknown[] {
  const m = e.message
  const c = m && typeof m === 'object' ? (m as Record<string, unknown>).content : undefined
  return Array.isArray(c) ? c : []
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function assistantMsgId(e: RawEvent): string | undefined {
  return str(e.type) === 'assistant' ? str(rec(e.message)?.id) : undefined
}

export function messagePreview(m: ChatMessage, max = 140): string {
  const parts: string[] = []
  for (const b of m.blocks) {
    if (b.type === 'text') parts.push(b.text)
    else if (b.type === 'tool_use') parts.push(`▸ ${b.label}`)
  }
  const text = parts
    .join(' ')
    .replace(/```[a-z]*\n?/gi, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\|?\s*:?-{3,}:?\s*(?=\|)/g, '')
    .replace(/[`*_|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Plan a cut at transcript message `targetId`.
 * `include` keeps that message; `before` keeps everything before it.
 */
export function planBranch(
  events: RawEvent[],
  targetId: string,
  mode: BranchMode = 'include'
): BranchPlan {
  const { messages, ranges } = buildMessagesWithRanges(events)
  const target = ranges.get(targetId)
  const targetMsg = messages.find((m) => m.id === targetId)
  if (!target || !targetMsg || !conversational(targetMsg))
    return { ok: false, error: 'That message is no longer in the session file.' }

  // Tool calls on the main chain, and where their results are.
  const useAt = new Map<string, number>()
  const useName = new Map<string, string>()
  const resultAt = new Map<string, number>()
  events.forEach((e, i) => {
    if (e.isSidechain === true) return
    const type = str(e.type)
    for (const b of blocksOf(e)) {
      const o = rec(b)
      const id = str(o?.id)
      if (type === 'assistant' && id && (o?.type === 'tool_use' || o?.type === 'server_tool_use')) {
        if (!useAt.has(id)) {
          useAt.set(id, i)
          useName.set(id, str(o?.name) ?? 'tool')
        }
      } else if (type === 'user' && o?.type === 'tool_result') {
        const tid = str(o.tool_use_id)
        if (tid && !resultAt.has(tid)) resultAt.set(tid, i)
      }
    }
  })
  // split[k]: cutting after event k would keep a tool call but drop its result.
  // Calls that never got a result can't be split, so they don't count.
  const diff = new Array<number>(events.length + 1).fill(0)
  for (const [id, u] of useAt) {
    const r = resultAt.get(id)
    if (r === undefined || r <= u) continue
    diff[u]++
    diff[r]--
  }
  const split: boolean[] = []
  let open = 0
  for (let k = 0; k < events.length; k++) {
    open += diff[k]
    split.push(open > 0)
  }
  const splitTools = (end: number): string[] => {
    const names = new Set<string>()
    for (const [id, u] of useAt) {
      const r = resultAt.get(id)
      if (u <= end && r !== undefined && r > end) names.add(useName.get(id) ?? 'tool')
    }
    return [...names]
  }

  // Event indexes where a conversational message ends: safe stopping points.
  const messageEnds = new Set<number>()
  for (const m of messages) if (conversational(m)) messageEnds.add(ranges.get(m.id)![1])
  const safeStop = (k: number): boolean => {
    const e = events[k]
    if (e.isSidechain === true || split[k]) return false
    return messageEnds.has(k) || (str(e.type) === 'user' && isToolResultOnly(e))
  }

  let end = mode === 'include' ? target[1] : target[0] - 1
  let snapped: BranchPlanOk['snapped'] = 'none'
  let snapTools: string[] = []

  if (mode === 'include' && split[end]) {
    // Pull in the results of the message's own tool calls, but don't run into
    // a new prompt or a new assistant message.
    snapTools = splitTools(end)
    const msgId = assistantMsgId(events[target[1]])
    let k = end
    while (k < events.length - 1 && split[k]) {
      const next = events[k + 1]
      const type = str(next.type)
      const continues =
        next.isSidechain === true ||
        (type !== 'user' && type !== 'assistant') ||
        (type === 'user' && (isToolResultOnly(next) || next.isMeta === true)) ||
        (type === 'assistant' && msgId !== undefined && assistantMsgId(next) === msgId)
      if (!continues) break
      k++
    }
    if (!split[k]) {
      end = k
      snapped = 'forward'
    } else {
      end = target[0] - 1
      snapped = 'backward'
    }
  }

  if (mode === 'before' || snapped === 'backward') {
    let k = end
    while (k >= 0 && !safeStop(k)) k--
    if (k < 0)
      return {
        ok: false,
        error:
          mode === 'before'
            ? 'There is nothing before this message to branch from.'
            : 'There is no point before this message where a branch would keep each tool call together with its result.'
      }
    if (mode === 'include') {
      if (!snapTools.length) snapTools = splitTools(target[1])
    } else {
      // Only a snap if conversational messages were skipped on the way back.
      const skipped = messages.some((m) => {
        const r = ranges.get(m.id)!
        return conversational(m) && r[0] > k && r[1] < target[0]
      })
      if (skipped) {
        snapped = 'backward'
        snapTools = splitTools(target[0] - 1)
      }
    }
    end = k
  }

  // The message the branch ends with: the last one that starts at or before the cut.
  let at: ChatMessage | undefined
  let kept = 0
  let total = 0
  for (const m of messages) {
    if (!conversational(m)) continue
    total++
    if (ranges.get(m.id)![0] <= end) {
      at = m
      kept++
    }
  }
  if (!at) return { ok: false, error: 'There is nothing to keep before this point.' }
  return {
    ok: true,
    endIndex: end,
    atMessageId: at.id,
    atRole: at.role as 'user' | 'assistant',
    atPreview: messagePreview(at),
    atTime: at.timestamp,
    snapped,
    snapTools,
    keptMessages: kept,
    totalMessages: total
  }
}

/** Entry types that name a session. A branch gets its own name, so these aren't copied. */
const NAME_TYPES = new Set(['custom-title', 'agent-name'])

/**
 * The new session file: events `0..plan.endIndex`, with `sessionId` set to
 * `newSessionId` and a `forkedFrom` marker on every entry that has a uuid.
 * Message uuids stay the same (that's how Claude Code's own forks look).
 */
export function buildBranchFile(
  events: RawEvent[],
  plan: BranchPlanOk,
  newSessionId: string,
  parentSessionId: string
): string {
  if (!isUuid(newSessionId)) throw new Error(`Invalid new session id: ${newSessionId}`)
  const kept = events.slice(0, plan.endIndex + 1)
  const uuids = new Set(kept.map((e) => str(e.uuid)).filter((u): u is string => !!u))
  const lines: string[] = []
  for (const e of kept) {
    const type = str(e.type)
    if (type && NAME_TYPES.has(type)) continue
    // Summaries and file snapshots that point past the cut belong to the rest of the original.
    if (type === 'summary' && !uuids.has(str(e.leafUuid) ?? '')) continue
    if (type === 'file-history-snapshot' && !uuids.has(str(e.messageId) ?? '')) continue
    const out: RawEvent = { ...e }
    if (typeof out.sessionId === 'string') out.sessionId = newSessionId
    if (typeof out.session_id === 'string') out.session_id = newSessionId
    const uuid = str(e.uuid)
    if (uuid && e.isSidechain !== true)
      out.forkedFrom = { sessionId: parentSessionId, messageUuid: uuid }
    lines.push(JSON.stringify(out))
  }
  return lines.join('\n') + '\n'
}

/** The default name for a new branch, numbered if that name is taken. */
export function branchName(parentTitle: string, taken: Iterable<string>): string {
  const base = `${parentTitle.trim() || 'Session'} — branch`
  const names = new Set([...taken].map((n) => n.toLowerCase()))
  if (!names.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!names.has(candidate.toLowerCase())) return candidate
  }
}
