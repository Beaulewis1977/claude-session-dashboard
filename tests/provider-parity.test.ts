// Provider parity: the whole main-process pipeline on the fixtures must give
// exactly what it gave before the provider refactor (captured on main, in
// tests/golden/). Run with UPDATE_GOLDEN=1 to write the snapshots instead.
//
// Deterministic: Date frozen at FIXTURES_NOW, a fixed time zone per snapshot,
// fixed file times, sorted keys and file-system orders, and the temp folder
// replaced by <ROOT>. Windows only: launching, WSL paths and the handoff
// mapping are Windows behaviour (the app runs there; CI is windows-latest).

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURES_NOW, setClockOffset } from '@shared/clock'
import { captureGolden, differences } from './golden/capture'

const UPDATE = process.env.UPDATE_GOLDEN === '1'
const ZONES = [
  ['chicago', 'America/Chicago'],
  ['utc', 'UTC']
] as const

// The refactor's new `provider: 'claude'` fields are left out by the capture
// itself (before any hashing); every other field must match.

let root: string
let zone: string | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-golden-'))
  zone = process.env.TZ
  vi.useFakeTimers({ toFake: ['Date'], now: FIXTURES_NOW })
})
afterEach(async () => {
  vi.useRealTimers()
  setClockOffset(0)
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
  if (process.env.GOLDEN_KEEP) console.log(`kept ${root}`)
  else await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

describe.runIf(process.platform === 'win32')('provider parity (golden snapshot)', () => {
  for (const [name, tz] of ZONES) {
    it(`matches the pre-refactor snapshot (${tz})`, { timeout: 120_000 }, async () => {
      process.env.TZ = tz
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz)
      const file = join(__dirname, 'golden', `parity-${name}.json`)
      const got = await captureGolden(root)
      if (UPDATE) {
        await writeFile(file, `${JSON.stringify(got, null, 1)}\n`)
        return
      }
      expect(existsSync(file), `missing ${file}: run with UPDATE_GOLDEN=1 on main`).toBe(true)
      const want = JSON.parse(await readFile(file, 'utf8')) as unknown
      expect(differences(want, got)).toEqual([])
    })
  }

  it('the two snapshots really were taken in different time zones', async () => {
    // Sanity check that the two snapshots really were taken in different zones
    // (day buckets differ), so neither can pass by accident.
    const a = await readFile(join(__dirname, 'golden', 'parity-chicago.json'), 'utf8').catch(
      () => ''
    )
    const b = await readFile(join(__dirname, 'golden', 'parity-utc.json'), 'utf8').catch(() => '')
    if (UPDATE) return
    expect(a).not.toBe('')
    expect(b).not.toBe('')
    expect(a).not.toBe(b)
  })
})
