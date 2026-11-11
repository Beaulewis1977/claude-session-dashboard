// The usage parser's worker thread (see usage-parse.ts): reads one session
// file at a time and sends back its usage analysis. It never writes anything.

import { parentPort } from 'node:worker_threads'
import { parseUsageFile, type UsageParseJob } from './usage-parse'

const port = parentPort!

port.on('message', (m: { id: number; job: UsageParseJob }) => {
  parseUsageFile(m.job).then(
    (value) => port.postMessage({ id: m.id, ok: true, value }),
    (err: unknown) =>
      port.postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) })
  )
})
