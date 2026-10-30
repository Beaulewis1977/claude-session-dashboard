// Live updates. Local folders use chokidar (fs events). WSL folders are on a
// \\wsl$ network share where fs events are unreliable, so they are polled.
// Sources that can't be read (a distro that isn't running yet, or stopped) are
// re-detected now and then, so they come back without a manual rescan.

import { watch, type FSWatcher } from 'chokidar'
import type { SessionService } from './sessions'

const POLL_UNC_MS = 10_000
const POLL_ALL_MS = 60_000
export const RECHECK_MS = 2 * 60_000

function isUnc(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

export class SourceWatcher {
  private watchers: FSWatcher[] = []
  private timers: NodeJS.Timeout[] = []
  private pending = new Map<string, NodeJS.Timeout>()
  private rechecking = false

  constructor(private readonly sessions: SessionService) {}

  async restart(): Promise<void> {
    await this.close()
    for (const src of this.sessions.sources) {
      if (src.status !== 'ok') continue
      if (isUnc(src.projectsDir)) {
        this.timers.push(setInterval(() => void this.sessions.pollSource(src.id), POLL_UNC_MS))
        continue
      }
      const w = watch(src.projectsDir, {
        ignoreInitial: true,
        depth: 1,
        ignored: (path, stats) => !!stats?.isFile() && !path.endsWith('.jsonl')
      })
      const onEvent = (path: string): void => this.debounce(src.id, path)
      w.on('add', onEvent).on('change', onEvent).on('unlink', onEvent)
      w.on('error', (err) => console.warn('watcher error', src.projectsDir, err))
      this.watchers.push(w)
    }
    this.timers.push(setInterval(() => void this.recheck(), RECHECK_MS))
    // Safety net for missed events.
    this.timers.push(
      setInterval(() => {
        for (const src of this.sessions.sources)
          if (!isUnc(src.projectsDir)) void this.sessions.pollSource(src.id)
      }, POLL_ALL_MS)
    )
  }

  /** Re-detect sources while any isn't readable; restart watching if one changed. */
  async recheck(): Promise<boolean> {
    if (this.rechecking || this.sessions.sources.every((s) => s.status === 'ok')) return false
    this.rechecking = true
    try {
      const changed = await this.sessions.recheckSources()
      if (changed) await this.restart()
      return changed
    } catch (err) {
      console.warn('could not re-check sources', err)
      return false
    } finally {
      this.rechecking = false
    }
  }

  private debounce(sourceId: string, path: string): void {
    const k = `${sourceId}|${path}`
    const t = this.pending.get(k)
    if (t) clearTimeout(t)
    this.pending.set(
      k,
      setTimeout(() => {
        this.pending.delete(k)
        void this.sessions.fileChanged(sourceId, path)
      }, 400)
    )
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    for (const t of this.pending.values()) clearTimeout(t)
    this.timers = []
    this.pending.clear()
    await Promise.all(this.watchers.map((w) => w.close()))
    this.watchers = []
  }
}
