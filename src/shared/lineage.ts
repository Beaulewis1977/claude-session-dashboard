// Session lineage: which session was branched or forked from which.
//
// Sources of truth, strongest first:
//  1. The app's own record (Branch from here, Fork and Continue fresh from the app).
//  2. `forkedFrom` markers in the file (Claude Code's `/branch`, and the app's branches).
//  3. Entries that still carry another session's id (older Claude Code copies).
//  4. Shared history: forks keep the original message uuids, so sessions that
//     start with the same messages are one family. Within a family, a session's
//     parent is the member it shares the most messages with. Of the two, the
//     original is the one that stopped where they split; if both went on, the
//     one whose file was created first (a fork's file is always made later).

import { isUuid, type ForkedFrom } from './jsonl'

/** A transcript message (user or assistant) that starts at an entry with this uuid. */
export interface MessageStart {
  uuid: string
  t?: string
}

export type LineageVia = 'app' | 'fork' | 'continue' | 'claude-branch' | 'copy' | 'shared-history'

export interface RecordedBranch {
  parentSessionId: string
  parentKey?: string
  atMessageId?: string
  via: 'app' | 'fork' | 'continue'
}

export interface LineageInput {
  key: string
  sessionId: string
  sourceId: string
  startedAt?: string
  firstUuid?: string
  recorded?: RecordedBranch
  forkedFrom?: ForkedFrom
  /** The file's entries carry this other session id. */
  copiedFrom?: string
  /** Message starts, for families of more than one session. */
  starts?: MessageStart[]
  /** When the session file was created (epoch ms), if known. */
  bornAt?: number
}

export interface SessionLineage {
  /** Undefined when the parent session isn't known to the app (e.g. long gone). */
  parentKey?: string
  parentSessionId: string
  /** Transcript message (in both sessions) after which they split. */
  atMessageId?: string
  atTime?: string
  /** Messages shared with the parent, when known. */
  shared?: number
  via: LineageVia
}

function startIndex(s: LineageInput): number {
  if (!s.starts?.length) return -1
  const i = s.firstUuid ? s.starts.findIndex((m) => m.uuid === s.firstUuid) : -1
  return i >= 0 ? i : 0
}

/** Number of leading messages two sessions share, from their first prompt on. */
export function sharedPrefix(a: LineageInput, b: LineageInput): number {
  const ia = startIndex(a)
  const ib = startIndex(b)
  if (ia < 0 || ib < 0) return 0
  const sa = a.starts!
  const sb = b.starts!
  let n = 0
  while (ia + n < sa.length && ib + n < sb.length && sa[ia + n].uuid === sb[ib + n].uuid) n++
  return n
}

/**
 * Most message-id comparisons spent inferring parents from shared history.
 * Sessions are compared in pairs within a family, so many long, alike
 * transcripts could otherwise keep the main process busy; past this, the rest
 * are left without an inferred parent.
 */
export const LINEAGE_BUDGET = 5_000_000
/** Families bigger than this aren't compared pair by pair at all. */
export const MAX_FAMILY = 200

/** Is `t` the original that `s` was forked from, given they share `n` messages? */
function isOriginalOf(
  t: LineageInput,
  s: LineageInput,
  n: number,
  ti = startIndex(t),
  si = startIndex(s)
): boolean {
  const nextS = s.starts![si + n]
  const nextT = t.starts![ti + n]
  if (!nextS) return false // s adds nothing of its own
  if (!nextT) return true // t stops where s goes on
  if (t.bornAt && s.bornAt && Math.abs(t.bornAt - s.bornAt) > 2000) return t.bornAt < s.bornAt
  const tt = Date.parse(nextT.t ?? '')
  const ts = Date.parse(nextS.t ?? '')
  if (Number.isFinite(tt) && Number.isFinite(ts) && tt !== ts) return tt < ts
  return t.key < s.key
}

export function computeLineage(
  inputs: LineageInput[],
  budget = LINEAGE_BUDGET
): Map<string, SessionLineage> {
  const out = new Map<string, SessionLineage>()
  const byKey = new Map(inputs.map((s) => [s.key, s]))
  const byId = new Map<string, LineageInput[]>()
  for (const s of inputs) {
    const list = byId.get(s.sessionId) ?? []
    list.push(s)
    byId.set(s.sessionId, list)
  }
  const resolve = (sessionId: string, sourceId: string): LineageInput | undefined => {
    const list = byId.get(sessionId)
    return list?.find((x) => x.sourceId === sourceId) ?? list?.[0]
  }
  const splitPoint = (s: LineageInput, parent: LineageInput | undefined) => {
    if (!parent) return {}
    const n = sharedPrefix(s, parent)
    if (!n) return {}
    const m = s.starts![startIndex(s) + n - 1]
    return { atMessageId: m.uuid, atTime: m.t, shared: n }
  }

  // 1–3: explicit links.
  for (const s of inputs) {
    let parentSessionId: string | undefined
    let via: LineageVia | undefined
    let atMessageId: string | undefined
    let parent: LineageInput | undefined
    if (s.recorded && s.recorded.parentSessionId !== s.sessionId) {
      parentSessionId = s.recorded.parentSessionId
      via = s.recorded.via
      atMessageId = s.recorded.atMessageId
      parent = s.recorded.parentKey ? byKey.get(s.recorded.parentKey) : undefined
    } else if (s.forkedFrom && s.forkedFrom.sessionId !== s.sessionId) {
      parentSessionId = s.forkedFrom.sessionId
      via = 'claude-branch'
      atMessageId = s.forkedFrom.messageId
    } else if (s.copiedFrom && isUuid(s.copiedFrom) && s.copiedFrom !== s.sessionId) {
      parentSessionId = s.copiedFrom
      via = 'copy'
    }
    if (!parentSessionId || !via) continue
    parent ??= resolve(parentSessionId, s.sourceId)
    const sp = splitPoint(s, parent)
    out.set(s.key, {
      parentKey: parent?.key,
      parentSessionId,
      via,
      shared: sp.shared,
      atMessageId: atMessageId ?? sp.atMessageId,
      atTime: atMessageId ? s.starts?.find((m) => m.uuid === atMessageId)?.t : sp.atTime
    })
  }

  // 4: shared history within families.
  const families = new Map<string, LineageInput[]>()
  for (const s of inputs) {
    if (!s.firstUuid || !s.starts?.length) continue
    const list = families.get(s.firstUuid) ?? []
    list.push(s)
    families.set(s.firstUuid, list)
  }
  let left = budget
  const offsets = new Map<LineageInput, number>()
  const offset = (s: LineageInput): number => {
    let i = offsets.get(s)
    if (i === undefined) {
      i = startIndex(s)
      offsets.set(s, i)
      left -= s.starts?.length ?? 0
    }
    return i
  }
  const prefix = (a: LineageInput, b: LineageInput): number => {
    const ia = offset(a)
    const ib = offset(b)
    const sa = a.starts!
    const sb = b.starts!
    let n = 0
    while (ia + n < sa.length && ib + n < sb.length && sa[ia + n].uuid === sb[ib + n].uuid) n++
    left -= n + 1
    return n
  }
  families: for (const members of families.values()) {
    if (members.length < 2 || members.length > MAX_FAMILY) continue
    for (const s of members) {
      if (out.has(s.key)) continue
      let best: { t: LineageInput; n: number } | undefined
      for (const t of members) {
        if (left <= 0) break families
        if (t === s || t.sessionId === s.sessionId) continue
        const n = prefix(s, t)
        if (!n || !isOriginalOf(t, s, n, offset(t), offset(s))) continue
        if (
          !best ||
          n > best.n ||
          (n === best.n &&
            ((t.startedAt ?? '') < (best.t.startedAt ?? '') ||
              ((t.startedAt ?? '') === (best.t.startedAt ?? '') && t.key < best.t.key)))
        )
          best = { t, n }
      }
      if (!best) continue
      const m = s.starts![offset(s) + best.n - 1]
      out.set(s.key, {
        parentKey: best.t.key,
        parentSessionId: best.t.sessionId,
        atMessageId: m.uuid,
        atTime: m.t,
        shared: best.n,
        via: 'shared-history'
      })
    }
  }

  // Never a cycle: if following parents loops, cut the weakest link in the loop.
  for (const start of inputs) {
    const path: string[] = []
    const seen = new Set<string>()
    let k: string | undefined = start.key
    while (k && out.get(k)?.parentKey && !seen.has(k)) {
      seen.add(k)
      path.push(k)
      k = out.get(k)!.parentKey
    }
    if (!k || !seen.has(k)) continue
    const loop = path.slice(path.indexOf(k))
    const weakest = loop.find((x) => out.get(x)!.via === 'shared-history') ?? [...loop].sort()[0]
    const l = out.get(weakest)!
    if (l.via === 'shared-history') out.delete(weakest)
    else out.set(weakest, { ...l, parentKey: undefined })
  }
  return out
}

/** Keys of all sessions in `key`'s tree, root first, as `[key, depth]` pairs. */
export function familyTree(
  key: string,
  parentOf: (key: string) => string | undefined,
  childrenOf: (key: string) => string[],
  limit = 200
): { key: string; depth: number }[] {
  let root = key
  const seen = new Set([root])
  for (let p = parentOf(root); p && !seen.has(p); p = parentOf(root)) {
    seen.add(p)
    root = p
  }
  const out: { key: string; depth: number }[] = []
  const visited = new Set<string>()
  const walk = (k: string, depth: number): void => {
    if (visited.has(k) || out.length >= limit) return
    visited.add(k)
    out.push({ key: k, depth })
    for (const c of childrenOf(k)) walk(c, depth + 1)
  }
  walk(root, 0)
  return out
}
