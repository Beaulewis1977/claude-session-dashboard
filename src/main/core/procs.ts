// Is a Claude Code process (from ~/.claude/sessions/<pid>.json) still running?
//
// A PID alone isn't enough: Windows and Linux reuse them, so a file left
// behind by a crashed session could point at some other program. Claude Code
// records when its process started (`procStart`); that must match too.
//   Windows: `process.kill(pid, 0)`, then the start time (a FILETIME) from one
//            PowerShell call for all new PIDs, cached per PID.
//   WSL:     `\\wsl.localhost\<distro>\proc\<pid>\stat` (the distro's own PID
//            namespace), field 22 = start time in clock ticks since boot.

import { execFile } from 'node:child_process'
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

/** true: running · false: gone or reused · undefined: can't tell. */
export type Alive = boolean | undefined

export interface ProcDeps {
  /** process.kill(pid, 0) semantics. */
  signal0: (pid: number) => 'alive' | 'gone' | 'unknown'
  /** Start times (FILETIME as a decimal string) of these Windows PIDs; missing = not found. */
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
  /** pid → start time, for Windows processes already looked up. */
  private started = new Map<number, string>()

  constructor(private readonly deps: ProcDeps) {}

  async check(items: ProcQuery[]): Promise<Alive[]> {
    const out: Alive[] = new Array(items.length).fill(undefined)
    const lookup: number[] = []
    items.forEach((q, i) => {
      if (q.env !== 'windows') return
      const s = this.deps.signal0(q.pid)
      if (s === 'gone') {
        this.started.delete(q.pid)
        out[i] = false
      } else if (s === 'alive') {
        out[i] = true
        if (q.procStart && !this.started.has(q.pid)) lookup.push(q.pid)
      }
    })
    if (lookup.length) {
      const times = await this.deps.windowsStartTimes([...new Set(lookup)]).catch(() => undefined)
      if (times) for (const [pid, t] of times) this.started.set(pid, t)
    }
    await Promise.all(
      items.map(async (q, i) => {
        if (q.env === 'windows') {
          const t = this.started.get(q.pid)
          // Running, but started at another time: the PID belongs to another program now.
          if (out[i] && q.procStart && t && !sameFiletime(t, q.procStart)) out[i] = false
          return
        }
        if (!q.distroRoot) return
        try {
          const stat = await this.deps.readText(join(q.distroRoot, 'proc', String(q.pid), 'stat'))
          const start = statStartTime(stat)
          out[i] = !q.procStart || !start || start === q.procStart
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

/** PIDs reach PowerShell only as an environment variable of digits and commas. */
const START_TIMES = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$ids = $env:CSD_PIDS -split "," | Where-Object { $_ -match "^\\d+$" } | ForEach-Object { [int]$_ }',
  'foreach ($p in (Get-Process -Id $ids)) { try { "{0} {1}" -f $p.Id, $p.StartTime.ToFileTimeUtc() } catch { } }'
].join('; ')

function windowsStartTimes(pids: number[]): Promise<Map<number, string> | undefined> {
  if (process.platform !== 'win32' || !pids.length) return Promise.resolve(undefined)
  const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command', START_TIMES],
      {
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, CSD_PIDS: pids.filter((p) => Number.isInteger(p)).join(',') }
      },
      (err, stdout) => {
        if (err && !stdout) return resolve(undefined)
        const m = new Map<number, string>()
        for (const line of String(stdout).split(/\r?\n/)) {
          const x = /^(\d+) (\d+)$/.exec(line.trim())
          if (x) m.set(Number(x[1]), x[2])
        }
        resolve(m)
      }
    )
  })
}

export function realProcChecker(): ProcChecker {
  return new ProcChecker({
    signal0,
    windowsStartTimes,
    readText: (p) => readFile(p, 'utf8')
  })
}
