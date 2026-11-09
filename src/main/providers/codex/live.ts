// "Running now" for Codex (Phase D1): reads which threads are open (their
// thread-writer locks) and what each one is doing (its rollout, read as it
// grows). The rules that turn this into states are in shared/codex-live.ts.
//
// Read only, and it never gets in Codex's way:
//
// - Windows: Codex holds a byte-range lock (LockFileEx) on
//   `thread-writer-locks/<id>.lock` while a process has the thread open.
//   The probe opens the file for reading only, with every share mode
//   (libuv's CreateFileW always passes FILE_SHARE_READ | FILE_SHARE_WRITE |
//   FILE_SHARE_DELETE), reads one byte at offset 0 and closes it at once. A
//   held lock makes the read fail right away with ERROR_LOCK_VIOLATION
//   (EBUSY); reads never wait on a lock. The probe takes no lock itself, and
//   byte-range locks only conflict with other locks, so it can't block or
//   delay Codex taking, holding or releasing its lock. Its share mode allows
//   any open, write or delete by Codex while the probe's handle exists.
//   (tests/codex-lock-probe.test.ts checks this against a real lock.)
// - WSL: Codex holds a `flock`. The app only reads the distro's `/proc/locks`
//   and `stat`s the lock files (for their inode): it never opens, reads or
//   locks a lock file there. (On Linux, opening a file never conflicts with
//   flock anyway: only another flock call does.)
// - Rollouts are read from where the last read stopped, in bounded chunks.
//
// Only these paths are ever opened: `thread-writer-locks/*.lock` (Windows),
// the threads' rollouts, `/proc/locks` and `/proc/<pid>/cmdline` (WSL), the
// app's own `codex-events/` files, and config.toml (Settings only, to show
// whether the hook is trusted). Never auth.json or anything else.

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  emptyRollout,
  lockThreadId,
  parseProcLocks,
  reduceRollout,
  splitLines,
  type RolloutState
} from '@shared/codex-live'

/** The file system calls the reader makes (a seam for tests). */
export interface CodexLiveFs {
  readdir(dir: string): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number; ino: bigint; isFile: boolean }>
  /**
   * Windows lock probe: true when the file's lock is held. Opens read-only
   * with every share mode, reads one byte, closes. Never locks.
   */
  probeLock(path: string): Promise<boolean | undefined>
  /** A small text file (/proc/locks, /proc/<pid>/cmdline). */
  readSmall(path: string): Promise<string>
  /** Bytes [from, from + length) of a file. */
  readRange(path: string, from: number, length: number): Promise<Buffer>
}

/** libuv's errors for a held byte-range lock (or a file opened without sharing). */
const HELD_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

export async function probeWindowsLock(path: string): Promise<boolean | undefined> {
  let fh
  try {
    // 'r' = O_RDONLY: GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE.
    fh = await open(path, 'r')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (code === 'ENOENT') return false
    // A sharing violation: someone has it open exclusively. Count it as held.
    return HELD_CODES.has(code) ? true : undefined
  }
  try {
    await fh.read(Buffer.alloc(1), 0, 1, 0)
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    return code === 'EBUSY' ? true : undefined
  } finally {
    await fh.close().catch(() => undefined)
  }
}

export const realCodexLiveFs: CodexLiveFs = {
  readdir: (dir) => readdir(dir),
  async stat(path) {
    const st = await stat(path, { bigint: true })
    return {
      mtimeMs: Number(st.mtimeMs),
      size: Number(st.size),
      ino: st.ino,
      isFile: st.isFile()
    }
  },
  probeLock: probeWindowsLock,
  readSmall: (path) => readFile(path, 'utf8'),
  async readRange(path, from, length) {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, from)
      return buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  }
}

/** A process whose command line runs Codex (its binary, or its npm/pnpm package). */
const CODEX_CMDLINE = /(^|[/\0 ])codex(\0|$| )|\/codex[^/\0]*\/|codex-/i

export const LOCKS_DIR = 'thread-writer-locks'

/** One thread lock file and whether a process holds it. */
export interface ThreadLock {
  threadId: string
  path: string
  /** When the current holder took it, epoch ms (file time; the caller adds the clock offset). */
  mtimeMs: number
  /** true: held · false: free · undefined: can't tell. */
  held: boolean | undefined
  /** The holder's PID (WSL: in the distro's own namespace). */
  pid?: number
}

export interface LockSource {
  env: 'windows' | 'wsl'
  /** The Codex home (host path). */
  home: string
  /** WSL: the distro root (host path), for /proc. */
  distroRoot?: string
}

/** First read of a rollout: its last part only. */
const TAIL_BYTES = 2 * 1024 * 1024
/** Most read from one rollout in one poll; more than that starts again from the tail. */
const MAX_READ = 8 * 1024 * 1024
/** WSL lock files' inodes are looked at again this often (new files at once). */
const INODE_TTL_MS = 60_000

interface Tail {
  size: number
  mtimeMs: number
  offset: number
  decoder: StringDecoder
  carry: string
  /** The next chunk starts mid-line (a tail read): its first line is dropped. */
  skipFirst: boolean
  state: RolloutState
  usedAt: number
}

export class CodexLiveReader {
  private tails = new Map<string, Tail>()
  private codexPid = new Map<string, { codex: boolean; at: number }>()
  private inodes = new Map<string, { ino: string; mtimeMs: number; at: number }>()
  /** Windows: each held lock's last read time, kept for a moment its file can't be read. */
  private mtimes = new Map<string, number>()

  constructor(private readonly fs: CodexLiveFs = realCodexLiveFs) {}

  /**
   * Every lock file of a Codex home, with whether each is held (Codex keeps
   * old lock files, so there can be many: all are looked at, none skipped).
   * Undefined: the folder can't be read right now (a WSL share, permissions),
   * which is "can't tell", never "nothing is open". A home without the folder
   * has no open threads.
   *
   * `fresh`: threads whose lock file must be looked at again now (recently
   * active ones); WSL inodes of the others are re-read once a minute.
   */
  async locks(
    src: LockSource,
    procLocks?: Map<string, ProcLockIndex>,
    fresh: ReadonlySet<string> = new Set()
  ): Promise<ThreadLock[] | undefined> {
    const dir = join(src.home, LOCKS_DIR)
    let names: string[]
    try {
      names = (await this.fs.readdir(dir)).filter((n) => lockThreadId(n))
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined
    }
    return src.env === 'windows'
      ? this.windowsLocks(dir, names)
      : this.wslLocks(dir, names, src.distroRoot, procLocks, fresh)
  }

  /** Windows: probe every lock (cheap, read only); only held ones need their time. */
  private async windowsLocks(dir: string, names: string[]): Promise<ThreadLock[]> {
    const out: ThreadLock[] = []
    for (const n of names) {
      const path = join(dir, n)
      let held = await this.fs.probeLock(path).catch(() => undefined)
      let mtimeMs = 0
      if (held !== false) {
        try {
          mtimeMs = (await this.fs.stat(path)).mtimeMs
          this.mtimes.set(path, mtimeMs)
        } catch (err) {
          // Gone: nothing holds it. Any other failure: the lock stays (held, or can't tell),
          // with the time last read, never dropped (a dropped lock would read as "ended").
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') held = false
          mtimeMs = this.mtimes.get(path) ?? 0
        }
      }
      out.push({ threadId: lockThreadId(n)!, path, mtimeMs, held })
    }
    const listed = new Set(out.map((l) => l.path))
    for (const k of this.mtimes.keys())
      if (k.startsWith(dir) && !listed.has(k)) this.mtimes.delete(k)
    return out
  }

  /**
   * WSL: the held flocks in /proc/locks, matched by inode. Inodes are cached
   * (a minute), except for new files, recently active threads and any whose
   * cached inode is held right now (looked at again for its time).
   */
  private async wslLocks(
    dir: string,
    names: string[],
    root: string | undefined,
    procLocks: Map<string, ProcLockIndex> | undefined,
    fresh: ReadonlySet<string>
  ): Promise<ThreadLock[]> {
    const index = root ? await this.procLocks(root, procLocks) : undefined
    const now = Date.now()
    const out: ThreadLock[] = []
    const seen = new Set<string>()
    for (const n of names) {
      const path = join(dir, n)
      const threadId = lockThreadId(n)!
      seen.add(path)
      let c = this.inodes.get(path)
      const heldNow = !!c && !!index?.byInode.get(c.ino)?.length
      if (!c || now - c.at > INODE_TTL_MS || fresh.has(threadId) || heldNow) {
        try {
          const st = await this.fs.stat(path)
          if (!st.isFile) continue
          c = { ino: st.ino.toString(), mtimeMs: st.mtimeMs, at: now }
          this.inodes.set(path, c)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // Gone: nothing holds it.
            this.inodes.delete(path)
            continue
          }
          // Can't be read now: what was known (or "can't tell"), never dropped.
          if (!c) {
            out.push({ threadId, path, mtimeMs: 0, held: undefined })
            continue
          }
        }
      }
      const lock: ThreadLock = { threadId, path, mtimeMs: c.mtimeMs, held: undefined }
      if (index) {
        const pids = index.byInode.get(c.ino)
        if (!pids?.length) lock.held = false
        else {
          // An inode number can repeat on another file system: the holder must be Codex.
          const holder = await this.firstCodex(root!, pids)
          lock.held = holder === 'unknown' ? undefined : holder !== 'none'
          if (typeof holder === 'number') lock.pid = holder
        }
      }
      out.push(lock)
    }
    for (const k of this.inodes.keys()) if (k.startsWith(dir) && !seen.has(k)) this.inodes.delete(k)
    return out
  }

  /** The distro's held flocks by inode (read once per poll per distro). */
  private async procLocks(
    root: string,
    cache?: Map<string, ProcLockIndex>
  ): Promise<ProcLockIndex | undefined> {
    const have = cache?.get(root)
    if (have) return have
    let text: string
    try {
      text = await this.fs.readSmall(join(root, 'proc', 'locks'))
    } catch {
      return undefined
    }
    const byInode = new Map<string, number[]>()
    for (const l of parseProcLocks(text)) {
      const list = byInode.get(l.inode) ?? []
      if (!list.includes(l.pid)) list.push(l.pid)
      byInode.set(l.inode, list)
    }
    const idx = { byInode }
    cache?.set(root, idx)
    return idx
  }

  /** The first holder that is a Codex process; 'unknown' if one couldn't be checked. */
  private async firstCodex(root: string, pids: number[]): Promise<number | 'none' | 'unknown'> {
    const t = Date.now()
    let unknown = false
    for (const pid of pids) {
      const k = `${root}|${pid}`
      let c = this.codexPid.get(k)
      if (!c || t - c.at > 60_000) {
        try {
          const cmd = await this.fs.readSmall(join(root, 'proc', String(pid), 'cmdline'))
          c = { codex: CODEX_CMDLINE.test(cmd), at: t }
          this.codexPid.set(k, c)
          if (this.codexPid.size > 2000) this.codexPid.clear()
        } catch (err) {
          // Gone since /proc/locks was read: it holds nothing. Anything else: can't tell
          // (never cached, never counted as "not Codex").
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unknown = true
          continue
        }
      }
      if (c.codex) return pid
    }
    return unknown ? 'unknown' : 'none'
  }

  /**
   * A rollout's state, reading only what was added since the last read
   * (compressed rollouts are finished ones: never read here).
   */
  async rollout(path: string): Promise<{ state: RolloutState; mtimeMs: number } | undefined> {
    if (!/\.jsonl$/i.test(path)) return undefined
    let st
    try {
      st = await this.fs.stat(path)
    } catch (err) {
      // Gone: forget it. Can't be read right now (a WSL share): what was read before.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.tails.delete(path)
        return undefined
      }
      const t = this.tails.get(path)
      return t ? { state: t.state, mtimeMs: t.mtimeMs } : undefined
    }
    const now = Date.now()
    let t = this.tails.get(path)
    if (t && st.size === t.size && st.mtimeMs === t.mtimeMs) {
      t.usedAt = now
      return { state: t.state, mtimeMs: t.mtimeMs }
    }
    if (!t || st.size < t.offset || st.size - t.offset > MAX_READ) t = this.fresh(st.size)
    while (t.offset < st.size) {
      const len = Math.min(st.size - t.offset, 1024 * 1024)
      let buf: Buffer
      try {
        buf = await this.fs.readRange(path, t.offset, len)
      } catch {
        return { state: t.state, mtimeMs: t.mtimeMs || st.mtimeMs }
      }
      if (!buf.length) break
      t.offset += buf.length
      const { lines, rest } = splitLines(t.decoder.write(buf), t.carry)
      if (t.skipFirst && lines.length) {
        lines.shift()
        t.skipFirst = false
      }
      // A line still being written that's this big (a huge tool output) isn't
      // kept: the rest of it is skipped up to the next line.
      if (rest.length > PARSE_CARRY_MAX) {
        t.carry = ''
        t.skipFirst = true
      } else t.carry = rest
      reduceRollout(t.state, lines)
    }
    t.size = st.size
    t.mtimeMs = st.mtimeMs
    t.usedAt = now
    this.tails.set(path, t)
    return { state: t.state, mtimeMs: st.mtimeMs }
  }

  private fresh(size: number): Tail {
    const offset = Math.max(0, size - TAIL_BYTES)
    const state = emptyRollout()
    if (offset > 0) state.partial = true
    return {
      size: 0,
      mtimeMs: 0,
      offset,
      decoder: new StringDecoder('utf8'),
      carry: '',
      skipFirst: offset > 0,
      state,
      usedAt: Date.now()
    }
  }

  /** Forget rollouts not looked at for a while. */
  prune(maxAgeMs = 60 * 60_000): void {
    const cut = Date.now() - maxAgeMs
    for (const [p, t] of this.tails) if (t.usedAt < cut) this.tails.delete(p)
  }
}

/** A line longer than this (a huge tool output still being written) isn't kept between reads. */
const PARSE_CARRY_MAX = 16 * 1024 * 1024

export interface ProcLockIndex {
  byInode: Map<string, number[]>
}
