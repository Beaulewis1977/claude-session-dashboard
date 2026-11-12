// The browser tests' own temp folder for one run: %TEMP%\csd-browser-<pid of
// the Vitest process>. vitest.config.ts points the browser tests' TEMP/TMP (and
// TMPDIR) at it, so the folders Playwright makes for each browser
// (playwright_chromiumdev_profile-*, playwright-artifacts-*) and Chromium's own
// temp files land there. Playwright empties those folders when a browser closes
// but, on Windows, can leave the empty folders behind; tests/browser-global-setup.ts
// removes this whole folder after the run and fails it if anything is left in %TEMP%.

import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const BROWSER_TEMP_PREFIX = 'csd-browser-'
export const BROWSER_TEMP = join(tmpdir(), `${BROWSER_TEMP_PREFIX}${process.pid}`)
