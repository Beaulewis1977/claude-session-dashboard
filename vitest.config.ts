import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { BROWSER_TEMP } from './tests/browser-temp'

const BROWSER_TESTS = 'tests/**/*.browser.test.ts'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: [BROWSER_TESTS],
          // Every csd-* folder a test makes in %TEMP% is removed (even after a
          // late store save), and the run fails if any is left behind.
          setupFiles: ['tests/temp-cleanup.ts'],
          globalSetup: ['tests/temp-global-setup.ts'],
          sequence: { groupOrder: 0 },
          // The fixture tests copy and scan sample homes: well under a second
          // alone, but several seconds on a loaded machine (two suites at once
          // took them to 2-9 s). Waits inside tests are explicit, so this only
          // bounds a slow run; it never makes a passing test slower.
          testTimeout: 30_000
        }
      },
      {
        // Each browser test file starts its own Vite server and Chromium. Run
        // after the Node tests (whose fixture copies and scans load the disk and
        // CPU), one file at a time, so a busy machine can't make a menu or a
        // page miss a timeout. They share one config and one pre-bundled
        // dependency cache, made once before they start (see
        // tests/browser-harness.ts).
        extends: true,
        test: {
          name: 'browser',
          include: [BROWSER_TESTS],
          globalSetup: ['tests/browser-global-setup.ts'],
          // Playwright's profile and artifacts folders go into this run's own temp
          // folder, removed after the run (tests/browser-temp.ts).
          env: { TEMP: BROWSER_TEMP, TMP: BROWSER_TEMP, TMPDIR: BROWSER_TEMP },
          fileParallelism: false,
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
          hookTimeout: 120_000,
          expect: { poll: { timeout: 10_000 } }
        }
      }
    ]
  }
})
