// The Codex lock probe can't get in Codex's way (Windows, against a real lock).
//
// A PowerShell process stands in for Codex: it opens the lock file the way
// Rust's std does (read/write, sharing read, write and delete) and takes the
// whole-file exclusive lock Codex takes (LockFileEx), with
// LOCKFILE_FAIL_IMMEDIATELY so that any interference shows up as a failure
// instead of a wait. Meanwhile the app's probe and a Restart Manager query run
// against the same file as fast as they can. Codex must never fail to take,
// rewrite or release its lock, the probe must see both states, Restart
// Manager must name the holder, and the lock must be free once the holder is
// gone. (WSL never opens a lock file: see codex-live-reader.test.ts.)

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileHolders } from '../src/main/core/focus'
import { systemRoot } from '../src/main/core/which'
import { probeWindowsLock } from '../src/main/providers/codex/live'

const CODEX_STAND_IN = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CsdTestLock {
  [StructLayout(LayoutKind.Sequential)] public struct OV { public IntPtr a; public IntPtr b; public uint o; public uint oh; public IntPtr e; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool LockFileEx(SafeFileHandle h, uint f, uint r, uint lo, uint hi, ref OV o);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UnlockFileEx(SafeFileHandle h, uint r, uint lo, uint hi, ref OV o);
  // LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, the whole file (as Rust's File::lock).
  public static bool Lock(SafeFileHandle h) { var o = new OV(); return LockFileEx(h, 3, 0, 0xFFFFFFFF, 0xFFFFFFFF, ref o); }
  public static bool Unlock(SafeFileHandle h) { var o = new OV(); return UnlockFileEx(h, 0, 0xFFFFFFFF, 0xFFFFFFFF, ref o); }
}
'@
$p = $env:CSD_TEST_LOCK
$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
function Open-Lock { New-Object IO.FileStream($p, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, $share) }
# 1. Hold it while the test probes and asks Restart Manager.
$fs = Open-Lock
if (-not [CsdTestLock]::Lock($fs.SafeFileHandle)) { [Console]::Out.WriteLine('LOCKFAIL'); exit 1 }
[Console]::Out.WriteLine('HELD'); [Console]::Out.Flush()
$null = [Console]::In.ReadLine()
[void][CsdTestLock]::Unlock($fs.SafeFileHandle); $fs.Dispose()
[Console]::Out.WriteLine('LOOP'); [Console]::Out.Flush()
# 2. Take, rewrite and release it over and over while the test probes in a loop.
$ok = 0; $fail = 0; $unlockFail = 0; $max = 0.0
$sw = [Diagnostics.Stopwatch]::new()
for ($i = 0; $i -lt 400; $i++) {
  $sw.Restart()
  $f = Open-Lock
  if ([CsdTestLock]::Lock($f.SafeFileHandle)) { $ok++ } else { $fail++ }
  $f.SetLength(0)
  $ms = $sw.Elapsed.TotalMilliseconds
  if ($ms -gt $max) { $max = $ms }
  Start-Sleep -Milliseconds 1
  if (-not [CsdTestLock]::Unlock($f.SafeFileHandle)) { $unlockFail++ }
  $f.Dispose()
}
[Console]::Out.WriteLine("DONE $ok $fail $unlockFail $([Math]::Round($max, 2))"); [Console]::Out.Flush()
# 3. Take it and end without releasing it: Windows drops it with the process.
$g = Open-Lock
[void][CsdTestLock]::Lock($g.SafeFileHandle)
[Console]::Out.WriteLine('EXITING'); [Console]::Out.Flush()
[Environment]::Exit(0)
`

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-lock-probe-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10 })
})

describe.runIf(process.platform === 'win32')('Windows lock probe vs a real lock', () => {
  it('never blocks, delays or breaks taking, rewriting and releasing the lock', async () => {
    const path = join(dir, '019b0000-0000-7000-8000-00000000c0de.lock')
    await writeFile(path, '')
    const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', CODEX_STAND_IN], {
      env: { ...process.env, CSD_TEST_LOCK: path },
      windowsHide: true
    })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
    let out = ''
    const seen = (marker: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          const i = out.indexOf(marker)
          if (i >= 0) resolve(out.slice(i).split(/\r?\n/)[0])
        }
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString()
          check()
        })
        child.on('exit', () => {
          check()
          reject(new Error(`stand-in ended: ${out}`))
        })
        check()
      })

    await seen('HELD')
    // Held: the probe says so at once, and Restart Manager names the holder.
    expect(await probeWindowsLock(path)).toBe(true)
    const holders = await fileHolders(path)
    expect(holders.map((h) => h.pid)).toContain(child.pid)
    expect(await probeWindowsLock(path)).toBe(true)

    // Let it loop, probing as fast as possible (and one more Restart Manager query) meanwhile.
    const loop = seen('LOOP')
    child.stdin.write('\n')
    await loop
    const done = seen('DONE')
    let finished = false
    void done.then(() => (finished = true))
    const rm = fileHolders(path)
    let probes = 0
    const states = new Set<boolean | undefined>()
    while (!finished) {
      states.add(await probeWindowsLock(path))
      probes++
    }
    await rm
    const [, ok, fail, unlockFail, maxMs] = (await done).split(' ')
    // Codex's side never failed to take or release its lock…
    expect(Number(fail)).toBe(0)
    expect(Number(unlockFail)).toBe(0)
    expect(Number(ok)).toBe(400)
    // …while the probe really ran alongside, and saw it both held and free.
    expect(probes).toBeGreaterThan(100)
    expect(states.has(true)).toBe(true)
    expect(states.has(false)).toBe(true)
    expect(states.has(undefined)).toBe(false)
    expect(Number(maxMs)).toBeGreaterThan(0)
    // For the record (CSD_PROBE_STATS=<file>): how hard it was pushed.
    if (process.env.CSD_PROBE_STATS)
      await writeFile(
        process.env.CSD_PROBE_STATS,
        JSON.stringify({
          probes,
          codexLocks: Number(ok),
          codexFailures: Number(fail),
          maxLockMs: Number(maxMs)
        })
      )

    // Gone without releasing it: the lock went with the process.
    await seen('EXITING')
    await exited
    expect(await probeWindowsLock(path)).toBe(false)
  }, 60_000)

  it('a missing lock file is simply free', async () => {
    expect(await probeWindowsLock(join(dir, 'gone.lock'))).toBe(false)
  })
})
