// The Ask index's worker thread (see host.ts): reads session files and keeps
// the index, so the main process never parses or indexes for it.

import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import { CompactTextCache } from '../providers/codex/text-cache'
import { IndexCore } from './core'

const data = workerData as {
  dir: string
  dataDir: string
  minReindexMs?: number
  saveDelayMs?: number
}
const port = parentPort!
// The session scan's compact text of big Codex rollouts, read only (never cleaned up here).
const codexCache = new CompactTextCache(join(data.dataDir, 'cache', 'codex'), data.dataDir)
const core = new IndexCore({
  dir: data.dir,
  minReindexMs: data.minReindexMs,
  saveDelayMs: data.saveDelayMs,
  read: { cachedCodex: (p) => codexCache.peek(p) },
  onStatus: (status) => port.postMessage({ t: 'status', status })
})
const loaded = core.load()

port.on('message', (m: { t: string; id?: number; [k: string]: unknown }) => {
  void (async () => {
    await loaded
    const reply = (value?: unknown): void =>
      port.postMessage({ t: 'reply', id: m.id, ok: true, value })
    try {
      switch (m.t) {
        case 'sync':
          core.sync(m.jobs as Parameters<IndexCore['sync']>[0], m.budget as number)
          return
        case 'search':
          reply(core.search(m.req as Parameters<IndexCore['search']>[0]))
          return
        case 'save':
          await core.save()
          reply()
          return
        case 'clear':
          await core.clear()
          reply()
          return
        case 'stop':
          await core.stop()
          reply()
          return
      }
    } catch (err) {
      port.postMessage({ t: 'reply', id: m.id, ok: false, error: (err as Error).message })
    }
  })()
})
