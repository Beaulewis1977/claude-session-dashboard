// The probes of tests/temp-cleanup.test.ts: each runs in its own vitest run,
// with its own %TEMP% (set by that test), through the same temp cleanup and
// end-of-run check as the Node tests (see vitest.config.ts).
// CSD_PROBE_NO_CLEANUP leaves the cleanup out, to show a probe catches a
// late save without it.

import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(import.meta.dirname, '..', '..'),
  test: {
    include: ['tests/temp-probes/*.probe.ts'],
    setupFiles: process.env.CSD_PROBE_NO_CLEANUP ? [] : ['tests/temp-cleanup.ts'],
    globalSetup: ['tests/temp-global-setup.ts'],
    fileParallelism: false
  }
})
