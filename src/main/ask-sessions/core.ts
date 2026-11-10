// The Ask index (docs/ROADMAP.md, feature 7): passages of every session,
// found by their words with BM25 ranking. It runs in a worker thread (see
// worker.ts), so building it never holds up the window; tests run it here.
//
// - Incremental: the main process sends every session's revision (its file's
//   size and time, and the revision of its name, description, tags, summary
//   and commits); only what changed is read again, newest sessions first.
//   A session that keeps growing (a live one) is read again at most every
//   `minReindexMs`.
// - Size budget: past `budgetChars` of text, the oldest sessions are left out.
// - Saved in the app's cache folder (`cache/ask/`, never backed up) as one
//   file, written through a temporary file and a rename. Rebuildable: a
//   saved index of another version is ignored and built again.
// - Reads session files only (see read.ts), never writes outside its folder.

import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { chunkMessages, type Passage, type PassageKind } from '@shared/ask-sessions/chunk'
import {
  addTokens,
  isStopword,
  queryTokens,
  TOKENIZER_VERSION
} from '@shared/ask-sessions/tokenize'
import { readSessionMessages, type ReadDeps, type ReadTarget } from './read'

/** Bumped whenever what is saved changes (the passages, their words, the file). */
export const INDEX_VERSION = 1
/** The saved index. */
export const INDEX_FILE = 'index-v1.json'

const K1 = 1.2
const B = 0.75
/** Two adjacent passages of a session are sent as one snippet up to this size. */
export const MERGED_MAX_CHARS = 3200
const KIND_BOOST: Record<PassageKind, number> = {
  about: 1.5,
  summary: 1.3,
  commit: 1.1,
  compact: 0.9,
  turn: 1
}
const KIND_CODE: Record<PassageKind, string> = {
  turn: 't',
  compact: 'c',
  about: 'a',
  summary: 's',
  commit: 'g'
}
const CODE_KIND: Record<string, PassageKind> = {
  t: 'turn',
  c: 'compact',
  a: 'about',
  s: 'summary',
  g: 'commit'
}

export interface IndexJob {
  key: string
  /** Last activity (epoch ms): newest first, and the oldest go first past the budget. */
  order: number
  /** When it started: of two identical passages (a fork's copy), the older session's is kept. */
  start: number
  /** Its file, and the file's revision. Absent: can't be read now (keep what's indexed). */
  content?: ReadTarget & { rev: string }
  /** Its about, summary and commit passages (made in the main process), and their revision. */
  meta: { rev: string; passages: Passage[] }
}

export interface SearchRequest {
  query: string
  /** Sessions it may return (absent: all). */
  allowed?: string[]
  /** Passages of these dates only ([from, to) in epoch ms); passages without a time pass. */
  from?: number
  to?: number
  limit: number
  perSession: number
}

export interface SearchHit {
  key: string
  kind: PassageKind
  text: string
  ts?: number
  /** Messages it covers (the first is the citation's target). */
  msgIds: string[]
  sha?: string
  score: number
}

export interface SearchResult {
  hits: SearchHit[]
  /** Passages that matched any word. */
  matched: number
}

export interface CoreStatus {
  phase: 'loading' | 'building' | 'ready' | 'error'
  sessions: number
  passages: number
  chars: number
  bytes: number
  done: number
  total: number
  buildMs?: number
  builtAt?: number
  updatedAt?: number
  skipped: number
  since?: number
  error?: string
}

interface SessionRec {
  key: string
  order: number
  start: number
  contentRev?: string
  metaRev?: string
  content: number[]
  meta: number[]
  /** Deflated JSON arrays of the passages' text (content and meta). */
  ct?: Buffer
  mt?: Buffer
  /** Characters of text: all, its conversation's, its about/summary/commits'. */
  chars: number
  cChars: number
  mChars: number
  /** When its file was last read (epoch ms). */
  at: number
}

interface SavedSession {
  key: string
  order: number
  start: number
  cRev?: string
  mRev?: string
  c: number[]
  m: number[]
  ct?: string
  mt?: string
  cc: number
  mc: number
  at: number
}

interface Saved {
  v: number
  tok: number
  builtAt?: number
  buildMs?: number
  updatedAt: number
  sessions: SavedSession[]
  chunks: {
    owner: number[]
    kind: string
    part: string
    ts: number[]
    len: number[]
    hash: number[]
    pos: number[]
    ids: (string[] | 0)[]
    sha: (string | 0)[]
  }
  postings: Record<string, string>
}

export interface CoreDeps {
  /** `<data>/cache/ask`. */
  dir: string
  read?: ReadDeps
  now?: () => number
  /** A live session is read again at most this often. */
  minReindexMs?: number
  /** Save at most this often while it changes. */
  saveDelayMs?: number
  onStatus?: (s: CoreStatus) => void
  /** Let other work in (the worker's messages) between sessions. */
  yieldNow?: () => Promise<void>
}

// ------------------------------------------------------------- encodings

function fnv(text: string): number {
  let h = 0x811c9dc5
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase()
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Postings [ord, tf, ord, tf…] (ords ascending) as varints of the gaps. */
export function encodePostings(arr: number[]): string {
  const out: number[] = []
  let prev = 0
  const put = (n: number): void => {
    let v = n
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(v)
  }
  for (let i = 0; i < arr.length; i += 2) {
    put(arr[i] - prev)
    put(arr[i + 1])
    prev = arr[i]
  }
  return Buffer.from(out).toString('base64')
}

export function decodePostings(s: string): number[] {
  const buf = Buffer.from(s, 'base64')
  const out: number[] = []
  let i = 0
  let prev = 0
  const get = (): number => {
    let v = 0
    let mul = 1
    for (;;) {
      const b = buf[i++]
      v += (b & 0x7f) * mul
      if (b < 0x80) return v
      mul *= 128
    }
  }
  while (i < buf.length) {
    prev += get()
    out.push(prev, get())
  }
  return out
}

const pack = (texts: string[]): Buffer => deflateRawSync(Buffer.from(JSON.stringify(texts), 'utf8'))
const unpack = (b: Buffer): string[] => JSON.parse(inflateRawSync(b).toString('utf8')) as string[]

// -------------------------------------------------------------- the index

export class IndexCore {
  private recs = new Map<string, SessionRec>()
  // Passages by ordinal.
  private owner: string[] = []
  private kind: PassageKind[] = []
  private part: ('c' | 'm')[] = []
  private ts: number[] = []
  private len: number[] = []
  private hash: number[] = []
  private pos: number[] = []
  private ids: (string[] | undefined)[] = []
  private sha: (string | undefined)[] = []
  private alive: number[] = []
  private postings = new Map<string, number[]>()
  private live = 0
  private dead = 0
  private totalLen = 0
  private chars = 0
  private budget = 300 * 1024 * 1024

  private latest = new Map<string, IndexJob>()
  private queue: string[] = []
  private queued = new Set<string>()
  private delayed = new Map<string, NodeJS.Timeout>()
  /** Left out past the budget (with the revision they had then). */
  private skipped = new Map<string, string>()
  private pumping = false
  private phase: CoreStatus['phase'] = 'loading'
  private error?: string
  private done = 0
  private total = 0
  private buildStart?: number
  private buildMs?: number
  private builtAt?: number
  private updatedAt?: number
  private bytes = 0
  private dirty = false
  private saveTimer: NodeJS.Timeout | undefined
  private textCache = new Map<string, { c?: string[]; m?: string[] }>()
  private stopped = false

  constructor(private readonly deps: CoreDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  // ------------------------------------------------------------- status

  status(): CoreStatus {
    let since: number | undefined
    if (this.skipped.size)
      for (const r of this.recs.values())
        if (r.content.length && (since === undefined || r.order < since)) since = r.order
    return {
      phase: this.phase,
      sessions: [...this.recs.values()].filter((r) => r.content.length || r.meta.length).length,
      passages: this.live,
      chars: this.chars,
      bytes: this.bytes,
      done: this.done,
      total: this.total,
      ...(this.buildMs !== undefined ? { buildMs: this.buildMs } : {}),
      ...(this.builtAt ? { builtAt: this.builtAt } : {}),
      ...(this.updatedAt ? { updatedAt: this.updatedAt } : {}),
      skipped: this.skipped.size,
      ...(since !== undefined ? { since } : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }

  private emit(): void {
    this.deps.onStatus?.(this.status())
  }

  // ------------------------------------------------------------ passages

  private add(rec: SessionRec, passages: Passage[], part: 'c' | 'm'): number[] {
    const ords: number[] = []
    passages.forEach((p, i) => {
      const ord = this.owner.length
      this.owner.push(rec.key)
      this.kind.push(p.kind)
      this.part.push(part)
      this.ts.push(p.ts ?? 0)
      this.hash.push(fnv(p.text))
      this.pos.push(i)
      this.ids.push(p.msgIds.length ? p.msgIds : undefined)
      this.sha.push(p.sha)
      this.alive.push(1)
      const tf = new Map<string, number>()
      const n = addTokens(p.text, tf)
      this.len.push(n)
      this.totalLen += n
      for (const [t, f] of tf) {
        const arr = this.postings.get(t)
        if (arr) arr.push(ord, f)
        else this.postings.set(t, [ord, f])
      }
      this.live++
      this.chars += p.text.length
      rec.chars += p.text.length
      ords.push(ord)
    })
    const chars = passages.reduce((n, p) => n + p.text.length, 0)
    if (part === 'c') {
      rec.ct = passages.length ? pack(passages.map((p) => p.text)) : undefined
      rec.cChars = chars
    } else {
      rec.mt = passages.length ? pack(passages.map((p) => p.text)) : undefined
      rec.mChars = chars
    }
    this.textCache.delete(rec.key)
    return ords
  }

  private drop(rec: SessionRec, part: 'c' | 'm'): void {
    const ords = part === 'c' ? rec.content : rec.meta
    for (const ord of ords) {
      if (!this.alive[ord]) continue
      this.alive[ord] = 0
      this.live--
      this.dead++
      this.totalLen -= this.len[ord]
    }
    const chars = part === 'c' ? rec.cChars : rec.mChars
    this.chars -= chars
    rec.chars -= chars
    if (part === 'c') {
      rec.content = []
      rec.ct = undefined
      rec.cChars = 0
    } else {
      rec.meta = []
      rec.mt = undefined
      rec.mChars = 0
    }
    this.textCache.delete(rec.key)
  }

  private remove(key: string): void {
    const rec = this.recs.get(key)
    if (!rec) return
    this.drop(rec, 'c')
    this.drop(rec, 'm')
    this.recs.delete(key)
  }

  /** Renumber the live passages (after many were replaced). */
  private compact(): void {
    const map = new Int32Array(this.owner.length).fill(-1)
    let n = 0
    for (let i = 0; i < this.owner.length; i++) if (this.alive[i]) map[i] = n++
    const take = <T>(a: T[]): T[] => a.filter((_x, i) => this.alive[i])
    this.owner = take(this.owner)
    this.kind = take(this.kind)
    this.part = take(this.part)
    this.ts = take(this.ts)
    this.len = take(this.len)
    this.hash = take(this.hash)
    this.pos = take(this.pos)
    this.ids = take(this.ids)
    this.sha = take(this.sha)
    this.alive = new Array<number>(n).fill(1)
    for (const [t, arr] of this.postings) {
      const next: number[] = []
      for (let j = 0; j < arr.length; j += 2) {
        const m = map[arr[j]]
        if (m >= 0) next.push(m, arr[j + 1])
      }
      if (next.length) this.postings.set(t, next)
      else this.postings.delete(t)
    }
    for (const r of this.recs.values()) {
      r.content = r.content.map((o) => map[o]).filter((o) => o >= 0)
      r.meta = r.meta.map((o) => map[o]).filter((o) => o >= 0)
    }
    this.dead = 0
  }

  private maybeCompact(): void {
    if (this.dead > 2000 && this.dead > this.owner.length * 0.3) this.compact()
  }

  // ---------------------------------------------------------------- sync

  /** The current list of sessions. Anything not in it is dropped. */
  sync(jobs: IndexJob[], budgetChars?: number): void {
    if (this.stopped) return
    if (budgetChars && budgetChars !== this.budget) {
      const grew = budgetChars > this.budget
      this.budget = budgetChars
      // More room: what was left out may fit now.
      if (grew) this.skipped.clear()
    }
    const keys = new Set(jobs.map((j) => j.key))
    for (const k of [...this.recs.keys()]) if (!keys.has(k)) this.remove(k)
    for (const k of [...this.skipped.keys()]) if (!keys.has(k)) this.skipped.delete(k)
    let changed = false
    for (const job of jobs) {
      this.latest.set(job.key, job)
      let rec = this.recs.get(job.key)
      if (!rec) {
        rec = {
          key: job.key,
          order: job.order,
          start: job.start,
          content: [],
          meta: [],
          chars: 0,
          cChars: 0,
          mChars: 0,
          at: 0
        }
        this.recs.set(job.key, rec)
      }
      rec.order = job.order
      rec.start = job.start
      if (rec.metaRev !== job.meta.rev && !this.skipped.has(job.key)) {
        this.drop(rec, 'm')
        rec.meta = this.add(rec, job.meta.passages, 'm')
        rec.metaRev = job.meta.rev
        changed = true
      }
      const c = job.content
      if (!c || c.rev === rec.contentRev) continue
      if (this.skipped.get(job.key) === c.rev) continue
      this.skipped.delete(job.key)
      this.enqueue(job.key, rec)
    }
    for (const k of [...this.latest.keys()]) if (!keys.has(k)) this.latest.delete(k)
    if (changed) this.touched()
    this.enforceBudget()
    this.maybeCompact()
    if (this.phase === 'loading' || this.phase === 'error')
      this.phase = this.queue.length ? 'building' : 'ready'
    this.emit()
    void this.pump()
  }

  private enqueue(key: string, rec: SessionRec): void {
    const wait = this.deps.minReindexMs ?? 30_000
    const since = this.now() - rec.at
    if (rec.at && since < wait) {
      if (!this.delayed.has(key)) {
        const t = setTimeout(() => {
          this.delayed.delete(key)
          const r = this.recs.get(key)
          if (r && !this.stopped) {
            this.push(key)
            void this.pump()
          }
        }, wait - since)
        t.unref?.()
        this.delayed.set(key, t)
      }
      return
    }
    this.push(key)
  }

  private push(key: string): void {
    if (this.queued.has(key)) return
    this.queued.add(key)
    this.queue.push(key)
    this.total++
  }

  /** The next session to read: the most recent one waiting. */
  private next(): string | undefined {
    let best = -1
    let bestOrder = -Infinity
    for (let i = 0; i < this.queue.length; i++) {
      const o = this.latest.get(this.queue[i])?.order ?? 0
      if (o > bestOrder) {
        bestOrder = o
        best = i
      }
    }
    if (best < 0) return undefined
    const [key] = this.queue.splice(best, 1)
    this.queued.delete(key)
    return key
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return
    this.pumping = true
    try {
      if (this.queue.length && !this.buildStart && !this.builtAt) this.buildStart = this.now()
      if (this.queue.length) this.phase = 'building'
      let lastEmit = 0
      for (let key = this.next(); key; key = this.next()) {
        if (this.stopped) return
        await this.readOne(key)
        this.done++
        if (this.now() - lastEmit > 250) {
          lastEmit = this.now()
          this.emit()
        }
        await (this.deps.yieldNow ?? (() => new Promise<void>((r) => setImmediate(r))))()
      }
      if (this.buildStart && !this.builtAt) {
        this.buildMs = this.now() - this.buildStart
        this.builtAt = this.now()
        this.buildStart = undefined
      }
      this.phase = 'ready'
      this.done = 0
      this.total = 0
      this.maybeCompact()
      this.emit()
    } finally {
      this.pumping = false
    }
  }

  private async readOne(key: string): Promise<void> {
    const job = this.latest.get(key)
    const rec = this.recs.get(key)
    const c = job?.content
    if (!job || !rec || !c || c.rev === rec.contentRev) return
    // The budget is full and every session in it is newer: this one would go at once.
    if (this.chars >= this.budget && !rec.content.length) {
      let oldest = Infinity
      for (const r of this.recs.values()) if (r.chars > 0 && r.order < oldest) oldest = r.order
      if (job.order <= oldest) {
        this.skipped.set(key, c.rev)
        this.drop(rec, 'm')
        rec.metaRev = undefined
        return
      }
    }
    let passages: Passage[]
    try {
      const messages = await readSessionMessages(c, this.deps.read)
      passages = chunkMessages(messages, c.provider === 'codex' ? 'Codex' : 'Claude')
    } catch {
      // Unreadable now (moved, locked, offline): what was indexed stays.
      rec.at = this.now()
      return
    }
    // Changed or removed while it was read: the newer job reads it again.
    const now = this.latest.get(key)
    if (!now?.content || now.content.rev !== c.rev || this.recs.get(key) !== rec) return
    this.drop(rec, 'c')
    rec.content = this.add(rec, passages, 'c')
    rec.contentRev = c.rev
    rec.at = this.now()
    this.enforceBudget()
    this.touched()
  }

  /** Past the budget, the sessions with the oldest activity go first. */
  private enforceBudget(): void {
    if (this.chars <= this.budget) return
    const byAge = [...this.recs.values()]
      .filter((r) => r.chars > 0)
      .sort((a, b) => a.order - b.order)
    for (const r of byAge) {
      if (this.chars <= this.budget) break
      this.skipped.set(r.key, r.contentRev ?? this.latest.get(r.key)?.content?.rev ?? '')
      this.drop(r, 'c')
      this.drop(r, 'm')
      r.contentRev = undefined
      r.metaRev = undefined
    }
  }

  private touched(): void {
    this.updatedAt = this.now()
    this.dirty = true
    if (this.saveTimer || this.stopped) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save().catch(() => undefined)
    }, this.deps.saveDelayMs ?? 20_000)
    this.saveTimer.unref?.()
  }

  // -------------------------------------------------------------- search

  private textOf(ord: number): string {
    const key = this.owner[ord]
    const rec = this.recs.get(key)
    if (!rec) return ''
    let t = this.textCache.get(key)
    if (!t) {
      t = {}
      this.textCache.set(key, t)
      if (this.textCache.size > 128) this.textCache.delete(this.textCache.keys().next().value!)
    }
    const part = this.part[ord]
    if (part === 'c') t.c ??= rec.ct ? unpack(rec.ct) : []
    else t.m ??= rec.mt ? unpack(rec.mt) : []
    return (part === 'c' ? t.c : t.m)?.[this.pos[ord]] ?? ''
  }

  search(req: SearchRequest): SearchResult {
    const terms = queryTokens(req.query)
    if (!terms.length || !this.live) return { hits: [], matched: 0 }
    const allowed = req.allowed ? new Set(req.allowed) : undefined
    const N = this.live
    const avg = this.totalLen / Math.max(1, N) || 1
    const score = new Map<number, number>()
    const matched = new Map<number, number>()
    for (const t of terms) {
      const arr = this.postings.get(t)
      if (!arr) continue
      let df = 0
      for (let j = 0; j < arr.length; j += 2) if (this.alive[arr[j]]) df++
      if (!df) continue
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (let j = 0; j < arr.length; j += 2) {
        const ord = arr[j]
        if (!this.alive[ord]) continue
        if (allowed && !allowed.has(this.owner[ord])) continue
        const ts = this.ts[ord]
        if (
          ts &&
          ((req.from !== undefined && ts < req.from) || (req.to !== undefined && ts >= req.to))
        )
          continue
        const tf = arr[j + 1]
        const dl = this.len[ord]
        const s = (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * dl) / avg))
        score.set(ord, (score.get(ord) ?? 0) + s)
        matched.set(ord, (matched.get(ord) ?? 0) + 1)
      }
    }
    const now = this.now()
    const ranked = [...score.entries()].map(([ord, s]) => {
      const rec = this.recs.get(this.owner[ord])
      const at = this.ts[ord] || rec?.order || now
      const age = Math.max(0, now - at) / 86_400_000
      const cover = 0.5 + (0.5 * (matched.get(ord) ?? 0)) / terms.length
      return { ord, s: s * KIND_BOOST[this.kind[ord]] * cover * (1 + 0.1 * Math.exp(-age / 180)) }
    })
    ranked.sort((a, b) => b.s - a.s)
    const top = ranked.slice(0, 300)
    // Words next to each other in the question, next to each other in the passage.
    const words = req.query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_.-]+/u)
      .map((w) => w.replace(/[.-]+$/, ''))
      .filter((w) => w.length >= 2 && !isStopword(w))
    const pairs: string[] = []
    for (let i = 0; i + 1 < words.length; i++) pairs.push(`${words[i]} ${words[i + 1]}`)
    if (pairs.length) {
      for (const h of top) {
        const t = this.textOf(h.ord)
          .toLowerCase()
          .replace(/[\s_-]+/g, ' ')
        let n = 0
        for (const p of pairs) if (t.includes(p)) n++
        if (n) h.s *= 1 + 0.2 * Math.min(3, n)
      }
      top.sort((a, b) => b.s - a.s)
    }
    // Identical passages (a fork's copy of its parent): only the oldest session's.
    const bestOf = new Map<number, number>()
    for (const h of top) {
      const hv = this.hash[h.ord]
      const cur = bestOf.get(hv)
      const start = (o: number): number => this.recs.get(this.owner[o])?.start ?? 0
      if (cur === undefined || start(h.ord) < start(cur)) bestOf.set(hv, h.ord)
    }
    const hits: (SearchHit & { pos: number; part: 'c' | 'm'; lo: number; hi: number })[] = []
    const perSession = new Map<string, number>()
    for (const h of top) {
      if (hits.length >= req.limit) break
      if (bestOf.get(this.hash[h.ord]) !== h.ord) continue
      const key = this.owner[h.ord]
      const text = this.textOf(h.ord)
      // Next to a passage already picked: one snippet.
      const near = hits.find(
        (x) =>
          x.key === key &&
          x.part === 'c' &&
          this.part[h.ord] === 'c' &&
          (this.pos[h.ord] === x.lo - 1 || this.pos[h.ord] === x.hi + 1) &&
          x.text.length + text.length + 1 <= MERGED_MAX_CHARS
      )
      if (near) {
        const before = this.pos[h.ord] < near.lo
        near.text = before ? `${text}\n${near.text}` : `${near.text}\n${text}`
        const ids = this.ids[h.ord] ?? []
        near.msgIds = before
          ? [...ids, ...near.msgIds.filter((i) => !ids.includes(i))]
          : [...near.msgIds, ...ids.filter((i) => !near.msgIds.includes(i))]
        if (before) {
          near.lo = this.pos[h.ord]
          if (this.ts[h.ord]) near.ts = this.ts[h.ord]
        } else near.hi = this.pos[h.ord]
        near.score += h.s * 0.5
        continue
      }
      const n = perSession.get(key) ?? 0
      if (n >= req.perSession) continue
      perSession.set(key, n + 1)
      hits.push({
        key,
        kind: this.kind[h.ord],
        text,
        ...(this.ts[h.ord] ? { ts: this.ts[h.ord] } : {}),
        msgIds: [...(this.ids[h.ord] ?? [])],
        ...(this.sha[h.ord] ? { sha: this.sha[h.ord] } : {}),
        score: h.s,
        pos: this.pos[h.ord],
        part: this.part[h.ord],
        lo: this.pos[h.ord],
        hi: this.pos[h.ord]
      })
    }
    return {
      hits: hits.map(({ pos: _p, part: _q, lo: _l, hi: _h, ...h }) => h),
      matched: score.size
    }
  }

  // -------------------------------------------------------------- saving

  private get file(): string {
    return join(this.deps.dir, INDEX_FILE)
  }

  /** Load the saved index (a missing, damaged or older one is ignored). */
  async load(): Promise<void> {
    this.phase = 'loading'
    this.emit()
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const s = JSON.parse(raw) as Saved
      if (s.v !== INDEX_VERSION || s.tok !== TOKENIZER_VERSION) return
      const n = s.chunks.owner.length
      const keys = s.sessions.map((x) => x.key)
      this.owner = s.chunks.owner.map((i) => keys[i])
      this.kind = [...s.chunks.kind].map((k) => CODE_KIND[k] ?? 'turn')
      this.part = [...s.chunks.part] as ('c' | 'm')[]
      this.ts = s.chunks.ts
      this.len = s.chunks.len
      this.hash = s.chunks.hash
      this.pos = s.chunks.pos
      this.ids = s.chunks.ids.map((x) => (x === 0 ? undefined : x))
      this.sha = s.chunks.sha.map((x) => (x === 0 ? undefined : x))
      this.alive = new Array<number>(n).fill(1)
      if (
        [this.kind, this.part, this.ts, this.len, this.hash, this.pos, this.ids, this.sha].some(
          (a) => a.length !== n
        )
      )
        throw new Error('damaged')
      this.postings = new Map(Object.entries(s.postings).map(([t, p]) => [t, decodePostings(p)]))
      this.live = n
      this.totalLen = this.len.reduce((a, b) => a + b, 0)
      this.chars = 0
      for (const x of s.sessions) {
        const rec: SessionRec = {
          key: x.key,
          order: x.order,
          start: x.start,
          contentRev: x.cRev,
          metaRev: x.mRev,
          content: x.c,
          meta: x.m,
          ...(x.ct ? { ct: Buffer.from(x.ct, 'base64') } : {}),
          ...(x.mt ? { mt: Buffer.from(x.mt, 'base64') } : {}),
          chars: x.cc + x.mc,
          cChars: x.cc,
          mChars: x.mc,
          at: x.at
        }
        this.chars += rec.chars
        this.recs.set(x.key, rec)
      }
      this.builtAt = s.builtAt
      this.buildMs = s.buildMs
      this.updatedAt = s.updatedAt
      this.bytes = Buffer.byteLength(raw)
    } catch {
      this.reset()
    }
  }

  private reset(): void {
    this.recs.clear()
    this.owner = []
    this.kind = []
    this.part = []
    this.ts = []
    this.len = []
    this.hash = []
    this.pos = []
    this.ids = []
    this.sha = []
    this.alive = []
    this.postings.clear()
    this.live = 0
    this.dead = 0
    this.totalLen = 0
    this.chars = 0
    this.textCache.clear()
    this.skipped.clear()
    this.builtAt = undefined
    this.buildMs = undefined
    this.buildStart = undefined
  }

  /** Save now if anything changed (through a temporary file and a rename). */
  async save(): Promise<void> {
    if (!this.dirty) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.dirty = false
    if (this.dead) this.compact()
    const sessions = [...this.recs.values()]
    const index = new Map(sessions.map((r, i) => [r.key, i]))
    const postings: Record<string, string> = {}
    for (const [t, arr] of this.postings) postings[t] = encodePostings(arr)
    const saved: Saved = {
      v: INDEX_VERSION,
      tok: TOKENIZER_VERSION,
      ...(this.builtAt ? { builtAt: this.builtAt } : {}),
      ...(this.buildMs !== undefined ? { buildMs: this.buildMs } : {}),
      updatedAt: this.updatedAt ?? this.now(),
      sessions: sessions.map((r) => ({
        key: r.key,
        order: r.order,
        start: r.start,
        ...(r.contentRev ? { cRev: r.contentRev } : {}),
        ...(r.metaRev ? { mRev: r.metaRev } : {}),
        c: r.content,
        m: r.meta,
        ...(r.ct ? { ct: r.ct.toString('base64') } : {}),
        ...(r.mt ? { mt: r.mt.toString('base64') } : {}),
        cc: r.cChars,
        mc: r.mChars,
        at: r.at
      })),
      chunks: {
        owner: this.owner.map((k) => index.get(k) ?? 0),
        kind: this.kind.map((k) => KIND_CODE[k]).join(''),
        part: this.part.join(''),
        ts: this.ts,
        len: this.len,
        hash: this.hash,
        pos: this.pos,
        ids: this.ids.map((x) => x ?? 0),
        sha: this.sha.map((x) => x ?? 0)
      },
      postings
    }
    const text = JSON.stringify(saved)
    await mkdir(this.deps.dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`
    await writeFile(tmp, text, 'utf8')
    try {
      await rename(tmp, this.file)
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      this.dirty = true
      throw err
    }
    this.bytes = Buffer.byteLength(text)
    this.emit()
  }

  /** Forget everything and delete the saved index (it's rebuilt from the sessions). */
  async clear(): Promise<void> {
    this.reset()
    this.queue = []
    this.queued.clear()
    for (const t of this.delayed.values()) clearTimeout(t)
    this.delayed.clear()
    this.latest.clear()
    this.dirty = false
    this.bytes = 0
    this.updatedAt = undefined
    await unlink(this.file).catch(() => undefined)
    this.phase = 'ready'
    this.emit()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.delayed.values()) clearTimeout(t)
    this.delayed.clear()
    await this.save().catch(() => undefined)
  }

  /** Nothing left to read (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 2000 && (this.pumping || this.queue.length); i++)
      await new Promise((r) => setTimeout(r, 2))
  }
}
