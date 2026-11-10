// A probe for tests/temp-cleanup.test.ts (run on its own, with its own %TEMP%):
// tests that remove their folder while a store save is still to come.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { JsonStore } from '../../src/main/core/json-store'

const store = (dir: string) => new JsonStore(join(dir, 'data', 'x.json'), dir, () => ({ n: 0 }))

it('removes its folder with a save still pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csd-probe-late-'))
  store(dir).update((d) => (d.n = 1))
  await rm(dir, { recursive: true, force: true })
  if (process.env.CSD_PROBE_FAIL) expect.fail('a failing test still has its folder removed')
})

it('removes its folder with a save under way and another pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csd-probe-queued-'))
  const s = store(dir)
  s.update((d) => (d.n = 1))
  // Not waited for. It can fail when the rm below wins the race: that's fine
  // here, as long as nothing is left at the end.
  void s.flush().catch(() => undefined)
  s.update((d) => (d.n = 2))
  await rm(dir, { recursive: true, force: true })
})

it('a later test that takes longer than a save delay', async () => {
  // The stores above save 150 ms after a change: they would have by now.
  await new Promise((r) => setTimeout(r, 600))
})
