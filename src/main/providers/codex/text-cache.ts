// The compact text of very large Codex rollouts, kept in the app's own cache
// folder (`<data>/cache/codex/`, never backed up). A big rollout is mostly
// context the app drops; reading it again means decompressing gigabytes for a
// few MB of conversation. The scan reads every rollout once anyway, so it
// keeps the result for the big ones and opening them later is quick.
//
// Keyed by the rollout's path, size and modification time: a changed file is
// read again. Only the app's own files in that folder are ever written or
// removed.

import { createHash } from 'node:crypto'
import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../../core/json-store'
import { isInside } from '../../core/safe-paths'

/** Rollouts at least this big (decompressed) have their compact text kept. */
export const CACHE_FROM_BYTES = 64 * 1024 * 1024

export class CompactTextCache {
  constructor(
    /** `<data>/cache/codex`. */
    private readonly dir: string,
    /** The app's data folder (writes must stay inside it). */
    private readonly dataDir: string
  ) {
    if (!isInside(dir, dataDir)) throw new Error('The text cache must be in the app data folder')
  }

  private prefix(path: string): string {
    return createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 20)
  }

  private file(path: string, size: number, mtimeMs: number): string {
    return join(this.dir, `${this.prefix(path)}-${size}-${Math.round(mtimeMs)}.jsonl`)
  }

  async get(path: string): Promise<string | undefined> {
    try {
      const st = await stat(path)
      return await readFile(this.file(path, st.size, st.mtimeMs), 'utf8')
    } catch {
      return undefined
    }
  }

  /** Keep the text for this version of the file, and drop the app's older copies for it. */
  async put(path: string, size: number, mtimeMs: number, text: string): Promise<void> {
    const target = this.file(path, size, mtimeMs)
    await writeFileAtomic(target, text, this.dataDir)
    const prefix = `${this.prefix(path)}-`
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    for (const n of names)
      if (n.startsWith(prefix) && n.endsWith('.jsonl') && join(this.dir, n) !== target)
        await unlink(join(this.dir, n)).catch(() => undefined)
  }
}
