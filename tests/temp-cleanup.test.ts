// The temp folder cleanup (tests/temp-cleanup.ts) and the end-of-run check
// (tests/temp-global-setup.ts), exercised for real: each probe in
// tests/temp-probes runs in its own vitest run with its own %TEMP% (so the
// other test files running meanwhile can't affect it), and the test looks at
// what that run left there and how it ended.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs')
const CONFIG = join(REPO, 'tests', 'temp-probes', 'vitest.config.ts')

let temp: string
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'csd-temp-check-'))
})
afterEach(async () => {
  await rm(temp, { recursive: true, force: true, maxRetries: 5 })
})

/** Run one probe file in its own vitest run, with `temp` as its %TEMP%. */
function probe(
  name: string,
  env: Record<string, string> = {}
): Promise<{ code: number; output: string }> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'GOLDEN_KEEP')
  )
  return new Promise((done) => {
    execFile(
      process.execPath,
      [VITEST, 'run', '--config', CONFIG, `tests/temp-probes/${name}.probe.ts`],
      {
        cwd: REPO,
        env: { ...base, TEMP: temp, TMP: temp, TMPDIR: temp, NO_COLOR: '1', ...env },
        timeout: 90_000,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        done({ code, output: `${stdout}\n${stderr}` })
      }
    )
  })
}

/** The csd-* folders in the probe's %TEMP%. */
async function left(): Promise<string[]> {
  return (await readdir(temp, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith('csd-'))
    .map((d) => d.name)
}

describe('temp folder cleanup', { timeout: 120_000 }, () => {
  it('a store save after its test removed the folder makes nothing again', async () => {
    const r = await probe('late-save')
    expect(r.output).toContain('3 passed')
    expect(r.code, r.output).toBe(0)
    expect(await left(), r.output).toEqual([])
  })

  it('… also when the test fails', async () => {
    const r = await probe('late-save', { CSD_PROBE_FAIL: '1' })
    expect(r.output).toContain('1 failed')
    expect(r.output).not.toContain('csd-* folder(s)')
    expect(r.code, r.output).not.toBe(0)
    expect(await left(), r.output).toEqual([])
  })

  it('without the cleanup, the late save is left behind and the run fails', async () => {
    const r = await probe('late-save', { CSD_PROBE_NO_CLEANUP: '1' })
    expect(r.output).toContain('3 passed')
    expect(r.output).toMatch(/left \d csd-\* folder\(s\)/)
    expect(r.output).toContain('csd-probe-late-')
    expect(r.code, r.output).not.toBe(0)
  })

  it('a forgotten folder fails a passing run, is named, and is not deleted', async () => {
    // Folders that were there before the run are not counted (or touched).
    const before = join(temp, 'csd-before-the-run')
    await mkdir(before)
    const r = await probe('leak')
    expect(r.output).toContain('1 passed')
    expect(r.output).toContain('left 1 csd-* folder(s)')
    expect(r.output).toContain('csd-probe-leak-')
    expect(r.output).not.toContain('csd-before-the-run')
    expect(r.code, r.output).not.toBe(0)
    const kept = await left()
    expect(kept).toHaveLength(2)
    expect(kept.some((n) => n.startsWith('csd-probe-leak-'))).toBe(true)
    expect(existsSync(before)).toBe(true)
  })
})
