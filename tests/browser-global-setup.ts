// Runs once around the browser tests (see vitest.config.ts).
//
// Before: pre-bundles the renderer's dependencies into the browser tests' shared
// cache, under a lock shared with any other test run on this PC. Each test
// file's Vite server then finds the cache ready (same config, see
// browser-harness.ts) and only reads it, so no first page waits for a
// pre-bundle and no run rewrites the cache under another run's pages. Quick
// when the cache is already up to date. It also makes this run's temp folder
// (browser-temp.ts) and removes ones left by runs that were killed.
//
// After: removes this run's temp folder, with every Playwright profile and
// artifacts folder in it, and fails the run if it left anything in %TEMP%:
// a Playwright folder or a csd-* folder that wasn't there before.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { optimizeDeps, resolveConfig } from 'vite'
import { harnessConfig, withCacheLock } from './browser-harness'
import { BROWSER_TEMP, BROWSER_TEMP_PREFIX } from './browser-temp'

const LEFTOVER = /^(playwright_chromiumdev_profile-|playwright-artifacts-|csd-)/
const OWNER = 'owner'

function leftovers(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && LEFTOVER.test(d.name))
    .map((d) => d.name)
    .sort()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Remove a folder this file made (never a link: rm doesn't follow one, and a link is skipped). */
async function removeOwn(dir: string): Promise<void> {
  try {
    if (!lstatSync(dir).isDirectory()) return
  } catch {
    return
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/** Temp folders of earlier runs that were killed before their teardown (their Vitest process is gone). */
async function removeStale(): Promise<void> {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(BROWSER_TEMP_PREFIX)) continue
    const dir = join(tmpdir(), name)
    if (dir === BROWSER_TEMP) continue
    let pid: number
    try {
      pid = Number(readFileSync(join(dir, OWNER), 'utf8').trim())
    } catch {
      continue // Not one of ours, or still being made: leave it.
    }
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) await removeOwn(dir)
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const t = Date.now()
  await removeStale().catch(() => undefined)
  const before = new Set(leftovers())
  mkdirSync(BROWSER_TEMP, { recursive: true })
  writeFileSync(join(BROWSER_TEMP, OWNER), String(process.pid))

  await withCacheLock(async () => {
    const config = await resolveConfig(harnessConfig(), 'serve')
    await optimizeDeps(config)
  })
  if (process.env.CSD_BROWSER_TIMING)
    console.log(`[browser tests] dependency pre-bundle ready in ${Date.now() - t} ms`)

  return async () => {
    await removeOwn(BROWSER_TEMP)
    const left = leftovers().filter((name) => !before.has(name))
    if (left.length === 0) return
    throw new Error(
      `The browser tests left ${left.length} folder(s) in ${tmpdir()}:\n` +
        left.map((name) => `  ${name}`).join('\n') +
        `\nPlaywright's folders should go into ${BROWSER_TEMP} (TEMP/TMP set in vitest.config.ts), ` +
        'which is removed after the run. (Another test run on this PC at the same time can also cause this.)'
    )
  }
}
