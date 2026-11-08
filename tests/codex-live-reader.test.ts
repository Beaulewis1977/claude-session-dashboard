// CodexLiveReader: which thread locks are held (Windows probe, WSL /proc/locks)
// and rollouts read as they grow. Every file call goes through a recording
// fake, so the tests also show what is (and isn't) ever opened.

import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodexLiveReader,
  realCodexLiveFs,
  type CodexLiveFs,
  type ProcLockIndex
} from '../src/main/providers/codex/live'

const A = '019dbbec-30b8-7813-99b5-b121a31f8414'
const B = '019e1e68-6c13-73d1-9b42-a738398966de'

interface Calls {
  probe: string[]
  small: string[]
  range: string[]
  stat: string[]
}

function fakeFs(files: {
  dirs: Record<string, string[]>
  inodes: Record<string, bigint>
  small: Record<string, string>
  held?: Set<string>
}): { fs: CodexLiveFs; calls: Calls } {
  const calls: Calls = { probe: [], small: [], range: [], stat: [] }
  const fs: CodexLiveFs = {
    readdir: async (dir) => {
      const d = files.dirs[dir]
      if (!d) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return d
    },
    stat: async (path) => {
      calls.stat.push(path)
      const ino = files.inodes[path]
      if (ino === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { mtimeMs: 1000, size: 0, ino, isFile: true }
    },
    probeLock: async (path) => {
      calls.probe.push(path)
      return files.held?.has(path) ?? false
    },
    readSmall: async (path) => {
      calls.small.push(path)
      const t = files.small[path]
      if (t === undefined) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return t
    },
    readRange: async (path) => {
      calls.range.push(path)
      return Buffer.alloc(0)
    }
  }
  return { fs, calls }
}

describe('WSL: /proc/locks and inodes only', () => {
  const root = '\\\\wsl.localhost\\Ubuntu'
  const home = `${root}\\home\\beau\\.codex`
  const locks = `${home}\\thread-writer-locks`
  const base = (procLocks: string, cmdlines: Record<number, string>) =>
    fakeFs({
      dirs: { [locks]: [`${A}.lock`, `${B}.lock`, '.coordination.lock'] },
      inodes: { [join(locks, `${A}.lock`)]: 5490614n, [join(locks, `${B}.lock`)]: 2289n },
      small: {
        [join(root, 'proc', 'locks')]: procLocks,
        ...Object.fromEntries(
          Object.entries(cmdlines).map(([pid, c]) => [join(root, 'proc', pid, 'cmdline'), c])
        )
      }
    })

  it('a lock is held when /proc/locks lists its inode for a Codex process', async () => {
    const { fs, calls } = base('17: FLOCK  ADVISORY  WRITE 69434 08:30:5490614 0 EOF\n', {
      69434: '/home/beau/.local/bin/codex\0resume\0' + A + '\0'
    })
    const r = new CodexLiveReader(fs)
    const out = await r.locks({ env: 'wsl', home, distroRoot: root })
    expect(out.map((l) => [l.threadId, l.held, l.pid])).toEqual([
      [A, true, 69434],
      [B, false, undefined]
    ])
    // Never opened, read or locked a lock file: only stat for its inode.
    expect(calls.probe).toEqual([])
    expect(calls.range).toEqual([])
    expect(calls.small.every((p) => /[\\/]proc[\\/]/.test(p))).toBe(true)
    expect(calls.small.some((p) => /\.lock$/.test(p))).toBe(false)
  })

  it('a dead PID holds nothing: the kernel dropped its lock, so no line names the inode', async () => {
    const { fs } = base('3: FLOCK  ADVISORY  WRITE 372 00:3d:800 0 EOF\n', {})
    const out = await new CodexLiveReader(fs).locks({ env: 'wsl', home, distroRoot: root })
    expect(out.every((l) => l.held === false)).toBe(true)
  })

  it('the same inode held by another program (a reused PID, another file system) is not Codex', async () => {
    const { fs } = base('9: FLOCK  ADVISORY  WRITE 4242 00:3d:5490614 0 EOF\n', {
      4242: '/usr/bin/dockerd\0'
    })
    const out = await new CodexLiveReader(fs).locks({ env: 'wsl', home, distroRoot: root })
    expect(out.find((l) => l.threadId === A)?.held).toBe(false)
  })

  it('an unreadable /proc (a stopped distro) means "can’t tell", never "running"', async () => {
    const { fs } = fakeFs({
      dirs: { [locks]: [`${A}.lock`] },
      inodes: { [join(locks, `${A}.lock`)]: 5490614n },
      small: {}
    })
    const out = await new CodexLiveReader(fs).locks({ env: 'wsl', home, distroRoot: root })
    expect(out[0].held).toBeUndefined()
  })

  it('reads /proc/locks once per distro and poll, however many homes it has', async () => {
    const { fs, calls } = base('', {})
    const r = new CodexLiveReader(fs)
    const cache = new Map<string, ProcLockIndex>()
    await r.locks({ env: 'wsl', home, distroRoot: root }, cache)
    await r.locks({ env: 'wsl', home, distroRoot: root }, cache)
    expect(calls.small.filter((p) => p.endsWith('locks'))).toHaveLength(1)
  })

  it('a missing lock folder is an empty list', async () => {
    const { fs } = fakeFs({ dirs: {}, inodes: {}, small: {} })
    expect(await new CodexLiveReader(fs).locks({ env: 'wsl', home, distroRoot: root })).toEqual([])
  })
})

describe('Windows: the read-only probe', () => {
  it('asks the probe for each lock file and never reads anything else of the home', async () => {
    const home = 'C:\\Users\\beau\\.codex'
    const dir = join(home, 'thread-writer-locks')
    const held = join(dir, `${A}.lock`)
    const { fs, calls } = fakeFs({
      dirs: { [dir]: [`${A}.lock`, `${B}.lock`, 'auth.json'] },
      inodes: { [held]: 1n, [join(dir, `${B}.lock`)]: 2n },
      small: {},
      held: new Set([held])
    })
    const out = await new CodexLiveReader(fs).locks({ env: 'windows', home })
    expect(out.map((l) => [l.threadId, l.held])).toEqual([
      [A, true],
      [B, false]
    ])
    expect(calls.probe).toEqual([held, join(dir, `${B}.lock`)])
    expect([...calls.stat, ...calls.small, ...calls.range].some((p) => /auth\.json/.test(p))).toBe(
      false
    )
  })
})

describe('rollouts, read as they grow', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'csd-codex-roll-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  const ln = (ts: string, payload: Record<string, unknown>): string =>
    `${JSON.stringify({ timestamp: ts, type: 'event_msg', payload })}\n`

  it('reads only what was added, across chunks and split lines', async () => {
    const path = join(dir, `rollout-x-${A}.jsonl`)
    await writeFile(path, ln('2026-11-08T20:00:00.000Z', { type: 'task_started', turn_id: 't' }))
    const r = new CodexLiveReader(realCodexLiveFs)
    expect(Object.keys((await r.rollout(path))!.state.open)).toEqual(['t'])
    // Half a line, then the rest.
    const done = ln('2026-11-08T20:01:00.000Z', { type: 'task_complete', turn_id: 't' })
    await appendFile(path, done.slice(0, 20))
    expect(Object.keys((await r.rollout(path))!.state.open)).toEqual(['t'])
    await appendFile(path, done.slice(20))
    const s = (await r.rollout(path))!.state
    expect(s.open).toEqual({})
    expect(s.lastEnd).toBe('complete')
  })

  it('keeps multi-byte characters whole across reads', async () => {
    const path = join(dir, `rollout-y-${A}.jsonl`)
    const msg = ln('2026-11-08T20:00:00.000Z', {
      type: 'task_started',
      turn_id: 'ü—ß',
      note: '✳ '.repeat(10)
    })
    const buf = Buffer.from(msg, 'utf8')
    // Cut inside a multi-byte character.
    const cut = buf.indexOf(Buffer.from('—', 'utf8')) + 1
    await writeFile(path, buf.subarray(0, cut))
    const r = new CodexLiveReader(realCodexLiveFs)
    await r.rollout(path)
    await appendFile(path, buf.subarray(cut))
    expect(Object.keys((await r.rollout(path))!.state.open)).toEqual(['ü—ß'])
  })

  it('starts again when the file got shorter (rewritten), and skips compressed rollouts', async () => {
    const path = join(dir, `rollout-z-${A}.jsonl`)
    await writeFile(
      path,
      ln('2026-11-08T20:00:00.000Z', { type: 'task_started', turn_id: 'a' }) +
        ln('2026-11-08T20:00:01.000Z', { type: 'task_started', turn_id: 'b' })
    )
    const r = new CodexLiveReader(realCodexLiveFs)
    expect(Object.keys((await r.rollout(path))!.state.open).sort()).toEqual(['a', 'b'])
    await writeFile(path, ln('2026-11-08T20:02:00.000Z', { type: 'task_started', turn_id: 'c' }))
    expect(Object.keys((await r.rollout(path))!.state.open)).toEqual(['c'])
    expect(await r.rollout(join(dir, 'rollout-old.jsonl.zst'))).toBeUndefined()
    expect(await r.rollout(join(dir, 'auth.json'))).toBeUndefined()
  })

  it('reads only the end of a big rollout the first time', async () => {
    const path = join(dir, `rollout-big-${A}.jsonl`)
    const filler = `${JSON.stringify({ timestamp: '2026-11-08T19:00:00.000Z', type: 'response_item', payload: { type: 'message', text: 'x'.repeat(4000) } })}\n`
    await writeFile(
      path,
      ln('2026-11-08T19:00:00.000Z', { type: 'task_started', turn_id: 'old' }) +
        filler.repeat(700) +
        ln('2026-11-08T20:00:00.000Z', { type: 'task_complete', turn_id: 'old' })
    )
    const s = (await new CodexLiveReader(realCodexLiveFs).rollout(path))!.state
    expect(s.lastEnd).toBe('complete')
    expect(s.partial).toBeUndefined()
  })
})
