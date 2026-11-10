// A probe for tests/temp-cleanup.test.ts (run on its own, with its own %TEMP%):
// a passing test that forgets its folder. The end-of-run check must fail the run.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'

it('forgets its temp folder', () => {
  mkdtempSync(join(tmpdir(), 'csd-probe-leak-'))
})
