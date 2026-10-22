// A small JSON file store with atomic writes (write a temp file, then rename).

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertAppDataWrite } from './safe-paths'

export async function writeFileAtomic(
  path: string,
  data: string,
  appDataDir: string
): Promise<void> {
  assertAppDataWrite(path, appDataDir)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, data, 'utf8')
  let lastErr: unknown
  // Windows can briefly lock files (antivirus, indexer); retry the rename.
  for (let i = 0; i < 5; i++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 50 * (i + 1)))
    }
  }
  await unlink(tmp).catch(() => undefined)
  throw lastErr
}

export class JsonStore<T extends object> {
  private data: T
  private saveTimer: NodeJS.Timeout | undefined
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly appDataDir: string,
    private readonly defaults: () => T
  ) {
    this.data = defaults()
  }

  get value(): T {
    return this.data
  }

  async load(): Promise<T> {
    try {
      const text = await readFile(this.path, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = { ...this.defaults(), ...(parsed as T) }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of discarding it.
        const backup = `${this.path}.corrupt-${Date.now()}`
        await rename(this.path, backup).catch(() => undefined)
      }
      this.data = this.defaults()
    }
    return this.data
  }

  update(mutator: (data: T) => void): void {
    mutator(this.data)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flush(), 150)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    const snapshot = JSON.stringify(this.data, null, 2)
    this.saving = this.saving.then(() => writeFileAtomic(this.path, snapshot, this.appDataDir))
    return this.saving
  }
}
