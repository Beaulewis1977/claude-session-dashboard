// Runs once around the Node tests (see vitest.config.ts): fails the run if it
// left any csd-* folder in %TEMP% (each test removes its own; see
// tests/temp-cleanup.ts). Folders that were there before the run are not
// counted. Nothing is deleted here: another test run on this PC (another
// checkout) could be using a new one, and that would also be reported, so
// a leftover is named for a look instead.
//
// GOLDEN_KEEP (tests/provider-parity.test.ts) keeps folders on purpose: no check.

import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

export function tempFolders(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('csd-'))
    .map((d) => d.name)
    .sort()
}

export default function setup(): () => void {
  const before = new Set(tempFolders())
  return () => {
    if (process.env.GOLDEN_KEEP) return
    const left = tempFolders().filter((name) => !before.has(name))
    if (left.length === 0) return
    throw new Error(
      `The tests left ${left.length} csd-* folder(s) in ${tmpdir()}:\n` +
        left.map((name) => `  ${name}`).join('\n') +
        '\nEach test must remove its own temp folders (afterEach/afterAll, or try/finally). ' +
        '(Another test run on this PC at the same time can also cause this.)'
    )
  }
}
