// Runs once before the browser tests (see vitest.config.ts): pre-bundles the
// renderer's dependencies into the browser tests' shared cache, under a lock
// shared with any other test run on this PC. Each test file's Vite server then
// finds the cache ready (same config, see browser-harness.ts) and only reads
// it, so no first page waits for a pre-bundle and no run rewrites the cache
// under another run's pages. Quick when the cache is already up to date.

import { optimizeDeps, resolveConfig } from 'vite'
import { harnessConfig, withCacheLock } from './browser-harness'

export default async function setup(): Promise<void> {
  const t = Date.now()
  await withCacheLock(async () => {
    const config = await resolveConfig(harnessConfig(), 'serve')
    await optimizeDeps(config)
  })
  if (process.env.CSD_BROWSER_TIMING)
    console.log(`[browser tests] dependency pre-bundle ready in ${Date.now() - t} ms`)
}
