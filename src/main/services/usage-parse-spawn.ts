// The built usage parser worker's path (electron-vite bundles the worker on
// its own). Only the app's entry imports this; tests parse in-process.

import workerPath from './usage-parse-worker?modulePath'
import { WorkerParser } from './usage-parse'

export function startUsageParser(): WorkerParser {
  return new WorkerParser(workerPath)
}
