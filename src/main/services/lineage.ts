// Works out which sessions were branched or forked from which (see
// @shared/lineage), and names forks launched from the app when they appear.
// Reads only; everything it records goes into the app's own metadata.

import { readFile, stat } from 'node:fs/promises'
import { branchName } from '@shared/branch'
import { buildMessages, isUuid, parseJsonl } from '@shared/jsonl'
import {
  computeLineage,
  type LineageInput,
  type MessageStart,
  type SessionLineage
} from '@shared/lineage'
import type { SessionSummary } from '@shared/types'
import type { SessionService } from './sessions'

interface PendingFork {
  parentKey: string
  parentSessionId: string
  parentTitle: string
  sourceId: string
  firstUuid: string
  at: number
  known: Set<string>
}

const PENDING_MS = 60 * 60_000

export async function messageStarts(path: string): Promise<MessageStart[] | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  return buildMessages(parseJsonl(text).events)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && isUuid(m.id))
    .map((m) => ({ uuid: m.id, t: m.timestamp }))
}

export class LineageService {
  private result = new Map<string, SessionLineage>()
  private starts = new Map<string, { stamp: string; list: MessageStart[]; bornAt?: number }>()
  private pending: PendingFork[] = []
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private again = false

  constructor(
    private readonly sessions: SessionService,
    private readonly delayMs = 400
  ) {
    sessions.lineageResolver = (key) => this.result.get(key)
    sessions.on('changed', () => this.schedule())
  }

  get(key: string): SessionLineage | undefined {
    return this.result.get(key)
  }

  /** Name and link the fork that a Fork launch will create, once it shows up. */
  expectFork(parent: SessionSummary): void {
    if (!parent.firstUuid) return
    this.pending.push({
      parentKey: parent.key,
      parentSessionId: parent.sessionId,
      parentTitle: parent.title,
      sourceId: parent.sourceId,
      firstUuid: parent.firstUuid,
      at: Date.now(),
      known: new Set(this.sessions.list().map((s) => s.key))
    })
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh()
    }, this.delayMs)
  }

  /** Recompute now (also used by tests). */
  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.compute()
      } while (this.again)
    })()
    try {
      await this.running
    } finally {
      this.running = undefined
    }
  }

  /** Returns true if a fork was recorded. */
  private matchPending(list: SessionSummary[]): boolean {
    let matched = false
    const t = Date.now()
    this.pending = this.pending.filter((p) => t - p.at < PENDING_MS)
    for (const s of list) {
      const i = this.pending.findIndex(
        (p) =>
          !p.known.has(s.key) &&
          s.sourceId === p.sourceId &&
          s.firstUuid === p.firstUuid &&
          s.sessionId !== p.parentSessionId
      )
      if (i < 0) continue
      const [p] = this.pending.splice(i, 1)
      if (s.meta.branch) continue
      matched = true
      const names = list.map((x) => x.meta.name).filter((n): n is string => !!n)
      this.sessions.recordBranch(
        s.sessionId,
        {
          parentSessionId: p.parentSessionId,
          parentKey: p.parentKey,
          via: 'fork',
          createdAt: new Date(p.at).toISOString()
        },
        branchName(p.parentTitle, names)
      )
    }
    return matched
  }

  private async startsFor(
    s: SessionSummary
  ): Promise<{ list: MessageStart[]; bornAt?: number } | undefined> {
    const stamp = `${s.filePath}|${s.sizeBytes}|${s.lastActivityAt ?? ''}`
    const hit = this.starts.get(s.key)
    if (hit?.stamp === stamp) return hit
    const list = await messageStarts(s.filePath)
    if (!list) return undefined
    const entry = { stamp, list, bornAt: await this.bornAt(s) }
    this.starts.set(s.key, entry)
    return entry
  }

  /**
   * When the session file was created: the file's birth time while it's live,
   * otherwise when the app first archived it.
   */
  private async bornAt(s: SessionSummary): Promise<number | undefined> {
    if (s.availability === 'live') {
      try {
        const st = await stat(s.originalPath)
        if (st.birthtimeMs > 0) return st.birthtimeMs
      } catch {
        // fall through to the archive record
      }
    }
    const first = this.sessions.archiveRecord(s.key)?.firstArchivedAt
    const t = first ? Date.parse(first) : NaN
    return Number.isFinite(t) ? t : undefined
  }

  private async compute(): Promise<void> {
    let list = this.sessions.list()
    if (this.pending.length && this.matchPending(list)) list = this.sessions.list()

    // Only families of two or more, and sessions with an explicit parent, need
    // their message lists (read from disk, cached by file size and time).
    const family = new Map<string, number>()
    for (const s of list)
      if (s.firstUuid) family.set(s.firstUuid, (family.get(s.firstUuid) ?? 0) + 1)
    const byId = new Map<string, SessionSummary[]>()
    for (const s of list) byId.set(s.sessionId, [...(byId.get(s.sessionId) ?? []), s])
    const need = new Set<string>()
    for (const s of list) {
      if (s.firstUuid && (family.get(s.firstUuid) ?? 0) > 1) need.add(s.key)
      const parentId = s.meta.branch?.parentSessionId ?? s.forkedFrom?.sessionId ?? s.copiedFrom
      if (parentId) {
        need.add(s.key)
        for (const p of byId.get(parentId) ?? []) need.add(p.key)
      }
    }
    const inputs: LineageInput[] = []
    for (const s of list) {
      const b = s.meta.branch
      const st = need.has(s.key) ? await this.startsFor(s) : undefined
      inputs.push({
        key: s.key,
        sessionId: s.sessionId,
        sourceId: s.sourceId,
        startedAt: s.startedAt,
        firstUuid: s.firstUuid,
        recorded: b
          ? {
              parentSessionId: b.parentSessionId,
              parentKey: b.parentKey,
              atMessageId: b.atMessageId,
              via: b.via
            }
          : undefined,
        forkedFrom: s.forkedFrom,
        copiedFrom: s.copiedFrom,
        starts: st?.list,
        bornAt: st?.bornAt
      })
    }
    for (const k of this.starts.keys()) if (!need.has(k)) this.starts.delete(k)

    const next = computeLineage(inputs)
    if (!sameLineage(next, this.result)) {
      this.result = next
      this.sessions.touch()
    }
  }
}

function sameLineage(a: Map<string, SessionLineage>, b: Map<string, SessionLineage>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (JSON.stringify(v) !== JSON.stringify(b.get(k))) return false
  return true
}
