// Is a session's process still running? Dead PIDs, reused PIDs and WSL.

import { describe, expect, it } from 'vitest'
import { ProcChecker, sameFiletime, statStartTime, type ProcDeps } from '../src/main/core/procs'

const STAT =
  '42038 (claude (node) x) S 1 42038 42038 0 -1 4194560 58789 0 3893 0 346 305 95 26 20 0 1 0 16908877 22740992 1721'

describe('process checks', () => {
  it('reads the start time even with spaces and parentheses in the name', () => {
    expect(statStartTime(STAT)).toBe('16908877')
    expect(
      statStartTime(
        '1 (systemd) S 0 1 1 0 -1 4194560 58789 16935681 3893 131710 346 305 95759 26376 20 0 1 0 90 2274'
      )
    ).toBe('90')
    expect(statStartTime('garbage')).toBeUndefined()
  })

  it('treats start times within a second as the same process', () => {
    expect(sameFiletime('134379458977253282', '134379458977253280')).toBe(true)
    expect(sameFiletime('134379458977253282', '134379459077253282')).toBe(false)
    expect(sameFiletime('x', '1')).toBe(false)
  })

  function checker(over: Partial<ProcDeps> = {}) {
    const calls: number[][] = []
    const deps: ProcDeps = {
      signal0: (pid) => (pid === 100 || pid === 200 ? 'alive' : pid === 300 ? 'unknown' : 'gone'),
      windowsStartTimes: async (pids) => {
        calls.push(pids)
        return new Map([
          [100, '134379458977253282'],
          [200, '999']
        ])
      },
      readText: async (p) => {
        if (p.replace(/\\/g, '/').endsWith('/proc/42038/stat')) return STAT
        if (p.includes('stopped')) throw Object.assign(new Error('unreachable'), { code: 'EIO' })
        throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      },
      ...over
    }
    return { c: new ProcChecker(deps), calls }
  }

  it('Windows: running, gone, reused, unknown; start times looked up once', async () => {
    const { c, calls } = checker()
    const q = [
      { env: 'windows' as const, pid: 100, procStart: '134379458977253280' },
      { env: 'windows' as const, pid: 200, procStart: '134379458977253280' },
      { env: 'windows' as const, pid: 999, procStart: '1' },
      { env: 'windows' as const, pid: 300 },
      { env: 'windows' as const, pid: 100 }
    ]
    expect(await c.check(q)).toEqual([true, false, false, undefined, true])
    expect(await c.check(q.slice(0, 2))).toEqual([true, false])
    expect(calls).toEqual([[100, 200]])
  })

  it('a failed start-time lookup still trusts the PID', async () => {
    const { c } = checker({ windowsStartTimes: async () => undefined })
    expect(await c.check([{ env: 'windows', pid: 100, procStart: '5' }])).toEqual([true])
  })

  it('WSL: through the distro’s /proc', async () => {
    const { c } = checker()
    expect(
      await c.check([
        { env: 'wsl', distroRoot: '\\\\wsl.localhost\\Ubuntu', pid: 42038, procStart: '16908877' },
        { env: 'wsl', distroRoot: '\\\\wsl.localhost\\Ubuntu', pid: 42038, procStart: '5' },
        { env: 'wsl', distroRoot: '\\\\wsl.localhost\\Ubuntu', pid: 7 },
        { env: 'wsl', distroRoot: '\\\\wsl.localhost\\stopped', pid: 7 },
        { env: 'wsl', pid: 7 }
      ])
    ).toEqual([true, false, false, undefined, undefined])
  })
})
