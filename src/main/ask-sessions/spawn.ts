// The built worker's path (electron-vite bundles worker.ts on its own). Only
// the app's entry imports this; tests use InProcessHost.

import workerPath from './worker?modulePath'
import { WorkerHost, type HostOptions } from './host'

/** The heap cap of the index's thread (measured: about 210 MB for 2,500 sessions). */
export const INDEX_HEAP_MB = 512

export function startIndexWorker(opts: HostOptions): WorkerHost {
  return new WorkerHost(workerPath, { ...opts, maxHeapMb: INDEX_HEAP_MB })
}
