// Fixtures mode (`npm run dev -- --fixtures`): copy the sample sessions into
// `.fixtures-data/` and run the app against that copy, with simulated launches.
// Files are only copied when missing; nothing is ever deleted.

import { constants } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonStore } from './core/json-store'
import type { MetadataFile } from './services/store'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Recursively copy `from` into `to`, skipping files that already exist. */
async function copyMissing(
  from: string,
  to: string,
  filter = (_name: string) => true
): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = join(from, e.name)
    const dest = join(to, e.name)
    if (e.isDirectory()) await copyMissing(src, dest, filter)
    else if (e.isFile() && filter(e.name) && !(await exists(dest))) {
      await copyFile(src, dest, constants.COPYFILE_EXCL).catch(() => undefined)
    }
  }
}

export function fixturesLayout(appRoot: string): {
  fixturesDir: string
  sourcesDir: string
  dataDir: string
} {
  const base = join(appRoot, '.fixtures-data')
  return {
    fixturesDir: join(appRoot, 'fixtures'),
    sourcesDir: join(base, 'sources'),
    dataDir: join(base, 'appdata')
  }
}

export async function prepareFixtures(
  appRoot: string,
  opts: { usageHistory?: boolean } = {}
): Promise<void> {
  const { fixturesDir, sourcesDir } = fixturesLayout(appRoot)
  await copyMissing(join(fixturesDir, 'windows'), join(sourcesDir, 'windows'))
  await copyMissing(join(fixturesDir, 'wsl'), join(sourcesDir, 'wsl'))
  if (opts.usageHistory) {
    // 13 weeks of generated sessions with token usage (scripts/make-usage-fixtures.mjs).
    const usage = join(fixturesDir, 'usage')
    await copyMissing(join(usage, 'windows'), join(sourcesDir, 'windows'))
    await copyMissing(join(usage, 'wsl'), join(sourcesDir, 'wsl'))
  }
}

/** Seed user metadata and an "archived only" session on first run. */
export async function seedFixtureData(
  appRoot: string,
  archiveDir: string,
  metadata: JsonStore<MetadataFile>
): Promise<void> {
  const { fixturesDir, sourcesDir } = fixturesLayout(appRoot)
  const seed = JSON.parse(await readFile(join(fixturesDir, 'metadata-seed.json'), 'utf8')) as Pick<
    MetadataFile,
    'sessions'
  >
  const archivedDir = join(fixturesDir, 'archived', 'windows')
  const relOriginal = (await readFile(join(archivedDir, 'original-path.txt'), 'utf8')).trim()
  const files = (await readdir(archivedDir)).filter((f) => f.endsWith('.jsonl'))

  await copyMissing(archivedDir, join(archiveDir, 'windows'), (n) => n.endsWith('.jsonl'))
  metadata.update((d) => {
    if (Object.keys(d.sessions).length === 0) d.sessions = seed.sessions
    for (const f of files) {
      const sessionId = f.slice(0, -6)
      const key = `windows:${sessionId}`
      if (d.archive[key]) continue
      const now = new Date().toISOString()
      d.archive[key] = {
        sessionId,
        sourceId: 'windows',
        sourceLabel: 'Windows',
        env: 'windows',
        originalPath: join(sourcesDir, ...relOriginal.split('/')),
        archivePath: join(archiveDir, 'windows', f),
        cwd: 'C:\\Users\\beau\\code\\old-prototype',
        size: 0,
        sha256: '',
        sourceMtimeMs: 0,
        firstArchivedAt: now,
        archivedAt: now
      }
    }
  })
  await metadata.flush()
}
