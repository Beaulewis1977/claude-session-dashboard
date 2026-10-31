// Is a Claude Code process (from ~/.claude/sessions/<pid>.json) still running?
//
// A PID alone isn't enough: Windows and Linux reuse them, so a file left
// behind by a crashed session could point at some other program. Claude Code
// records when its process started (`procStart`); that must match too, on
// every check (a PID can be reused between two checks).
//   Windows: `process.kill(pid, 0)`, then the start time (a FILETIME) from a
//            small PowerShell helper that stays running, so each check is cheap.
//   WSL:     `\\wsl.localhost\<distro>\proc\<pid>\stat` (the distro's own PID
//            namespace), field 22 = start time in clock ticks since boot.
// When identity can't be checked (no procStart, or the lookup failed), the
// answer is "can't tell", never "running".

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { systemRoot } from './which'

export interface ProcQuery {
  env: 'windows' | 'wsl'
  /** Host path of the distro root (WSL). */
  distroRoot?: string
  pid: number
  procStart?: string
}

/** true: running · false: gone (or the PID belongs to another process now) · undefined: can't tell. */
export type Alive = boolean | undefined

export interface ProcDeps {
  /** process.kill(pid, 0) semantics. */
  signal0: (pid: number) => 'alive' | 'gone' | 'unknown'
  /**
   * Start times of these Windows PIDs: a FILETIME as a decimal string, or "?"
   * when it can't be read. Missing = not running. Undefined = the lookup failed.
   */
  windowsStartTimes: (pids: number[]) => Promise<Map<number, string> | undefined>
  readText: (path: string) => Promise<string>
}

/** Start time (clock ticks) from a /proc/<pid>/stat line. The name may hold spaces and ")". */
export function statStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  // Fields after the name start with field 3 (state); start time is field 22.
  const f = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const v = f[19]
  return v && /^\d+$/.test(v) ? v : undefined
}

/** Windows start times may differ by rounding: within a second is the same process. */
export function sameFiletime(a: string, b: string): boolean {
  try {
    const d = BigInt(a) - BigInt(b)
    return (d < 0n ? -d : d) < 10_000_000n
  } catch {
    return false
  }
}

export class ProcChecker {
  constructor(private readonly deps: ProcDeps) {}

  async check(items: ProcQuery[]): Promise<Alive[]> {
    const out: Alive[] = new Array(items.length).fill(undefined)
    const lookup: number[] = []
    items.forEach((q, i) => {
      if (q.env !== 'windows') return
      const s = this.deps.signal0(q.pid)
      if (s === 'gone') out[i] = false
      // Running, but whose? Only the start time says; without one, can't tell.
      else if (s === 'alive' && q.procStart) lookup.push(q.pid)
    })
    // Looked up on every check, never cached: a PID can be reused between checks.
    const times = lookup.length
      ? await this.deps.windowsStartTimes([...new Set(lookup)]).catch(() => undefined)
      : undefined
    await Promise.all(
      items.map(async (q, i) => {
        if (q.env === 'windows') {
          if (out[i] === false || !q.procStart || !lookup.includes(q.pid)) return
          if (!times) return // lookup failed: can't tell
          const t = times.get(q.pid)
          // '?': running, but its start time can't be read (an elevated process, say).
          out[i] = t === '?' ? undefined : t !== undefined && sameFiletime(t, q.procStart)
          return
        }
        if (!q.distroRoot) return
        try {
          const stat = await this.deps.readText(join(q.distroRoot, 'proc', String(q.pid), 'stat'))
          const start = statStartTime(stat)
          out[i] = q.procStart && start ? start === q.procStart : undefined
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          // The distro answers, but the process isn't there.
          out[i] = code === 'ENOENT' || code === 'ESRCH' ? false : undefined
        }
      })
    )
    return out
  }
}

function signal0(pid: number): 'alive' | 'gone' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM: it exists, it just isn't ours to signal.
    return code === 'ESRCH' ? 'gone' : code === 'EPERM' ? 'alive' : 'unknown'
  }
}

/**
 * Answers one line of comma-separated PIDs with "CSD pid:filetime ...".
 * Fixed text; PIDs reach it only as digits on its input.
 */
const HELPER = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$ProgressPreference = 'SilentlyContinue'",
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $ids = @($line -split "," | Where-Object { $_ -match "^\\d+$" } | ForEach-Object { [int]$_ })',
  '  $parts = @()',
  '  if ($ids.Count) { foreach ($p in (Get-Process -Id $ids)) { try { $parts += ("{0}:{1}" -f $p.Id, $p.StartTime.ToFileTimeUtc()) } catch { $parts += ("{0}:?" -f $p.Id) } } }',
  '  [Console]::Out.WriteLine("CSD " + ($parts -join " "))',
  '  [Console]::Out.Flush()',
  '}'
].join('\n')

const HELPER_TIMEOUT_MS = 8000

/** A PowerShell that stays running and answers start-time lookups, one at a time. */
export class StartTimeHelper {
  private child: ChildProcessWithoutNullStreams | undefined
  private buf = ''
  private pending: ((line: string | undefined) => void) | undefined
  private queue: Promise<unknown> = Promise.resolve()

  query(pids: number[]): Promise<Map<number, string> | undefined> {
    const run = this.queue.then(() => this.ask(pids))
    this.queue = run.catch(() => undefined)
    return run
  }

  dispose(): void {
    this.child?.kill()
    this.child = undefined
  }

  private start(): ChildProcessWithoutNullStreams {
    const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // The script as -EncodedCommand; its input carries only the queries.
    const encoded = Buffer.from(HELPER, 'utf16le').toString('base64')
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'pipe'
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      this.buf += d
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (line.startsWith('CSD')) {
          const p = this.pending
          this.pending = undefined
          p?.(line)
        }
      }
    })
    const gone = (): void => {
      if (this.child === child) this.child = undefined
      const p = this.pending
      this.pending = undefined
      p?.(undefined)
    }
    child.on('exit', gone)
    child.on('error', gone)
    child.stdin.on('error', () => undefined)
    return child
  }

  private ask(pids: number[]): Promise<Map<number, string> | undefined> {
    if (process.platform !== 'win32') return Promise.resolve(undefined)
    const ids = pids.filter((p) => Number.isInteger(p) && p > 0)
    if (!ids.length) return Promise.resolve(new Map())
    this.child ??= this.start()
    const child = this.child
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // No answer: start a fresh helper next time.
        this.pending = undefined
        if (this.child === child) this.dispose()
        resolve(undefined)
      }, HELPER_TIMEOUT_MS)
      this.pending = (line) => {
        clearTimeout(timer)
        if (line === undefined) return resolve(undefined)
        const m = new Map<number, string>()
        for (const part of line.slice(3).trim().split(/\s+/)) {
          const x = /^(\d+):(\d+|\?)$/.exec(part)
          if (x) m.set(Number(x[1]), x[2])
        }
        resolve(m)
      }
      child.stdin.write(`${ids.join(',')}\n`)
    })
  }
}

export function realProcChecker(): ProcChecker & { dispose(): void } {
  const helper = new StartTimeHelper()
  const checker = new ProcChecker({
    signal0,
    windowsStartTimes: (pids) => helper.query(pids),
    readText: (p) => readFile(p, 'utf8')
  })
  return Object.assign(checker, { dispose: () => helper.dispose() })
}
