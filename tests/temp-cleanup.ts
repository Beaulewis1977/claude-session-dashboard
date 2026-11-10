// Runs before every Node test file (see vitest.config.ts): makes sure the
// file's csd-* folders in %TEMP% are really gone when it ends.
//
// Each test removes its own folder in afterEach/afterAll, but the app's JSON
// stores save 150 ms after a change, and a service's background work can
// still save after its test ended, so a save could land after that rm and
// make the folder again (metadata.json, mobile.json, ...). This file keeps
// track of every store a test used. After each test (these hooks run after
// the file's own), a store whose csd-* folder is gone is retired: its later
// saves would only write into a folder nobody reads any more, so they are
// skipped; a save already under way is waited for, and the folder is removed
// again. When the file ends, every such store is retired and its folder goes.
// A failing test still runs both hooks.
//
// GOLDEN_KEEP (tests/provider-parity.test.ts) keeps the folders to look at.

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll } from 'vitest'

/** The parts of a JsonStore used here (`path` and `saving` are private there). */
interface Store {
  readonly path: string
  readonly saving: Promise<void>
  flush(): Promise<void>
  update(mutator: (data: never) => void): void
}

const TEMP = resolve(tmpdir())
const used = new Set<Store>()
const retired = new WeakSet<Store>()
const PATCHED = Symbol.for('csd-tests.jsonStoreTracked')

/** The csd-* folder directly in %TEMP% that holds `path`, if there is one. */
function tempRootOf(path: string): string | undefined {
  const rel = relative(TEMP, resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const top = rel.split(/[\\/]/)[0]
  return top.startsWith('csd-') ? join(TEMP, top) : undefined
}

// Imported here, not at the top, so a test file's vi.mock of node:fs applies
// to the store module too (it's loaded once the test file has been imported).
beforeAll(async () => {
  const { JsonStore } = await import('../src/main/core/json-store')
  const proto = JsonStore.prototype as unknown as Store & Record<symbol, boolean>
  if (proto[PATCHED]) return
  const { update, flush } = proto
  proto.update = function (this: Store, mutator) {
    if (!retired.has(this)) used.add(this)
    update.call(this, mutator)
  }
  proto.flush = function (this: Store) {
    if (retired.has(this)) return Promise.resolve()
    used.add(this)
    return flush.call(this)
  }
  proto[PATCHED] = true
})

/**
 * Retire the used stores whose csd-* folder is gone (or, at the end of the
 * file, every one), wait for their saves under way, then remove the folders.
 */
async function settle(endOfFile: boolean): Promise<void> {
  if (process.env.GOLDEN_KEEP) return
  const roots = new Set<string>()
  const stores: Store[] = []
  for (const store of [...used]) {
    const root = tempRootOf(store.path)
    if (!root) {
      used.delete(store)
      continue
    }
    // Still there: a later test in this file may use it (beforeAll folders).
    if (!endOfFile && existsSync(root)) continue
    used.delete(store)
    retired.add(store)
    stores.push(store)
    roots.add(root)
  }
  // Saves are chained one after another: once the chain settles, none is left.
  for (const store of stores) await store.saving
  for (const root of roots) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

afterEach(() => settle(false))
afterAll(() => settle(true))
