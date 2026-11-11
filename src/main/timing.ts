// Optional timing for diagnosing slow starts and slow dialogs: off unless the
// app is started with CSD_TIMING=1 (e.g. `$env:CSD_TIMING=1; npm run dev`).
// It only prints durations and step names to the terminal: never paths,
// session names or anything else from the user's data.

const ON = process.env.CSD_TIMING === '1'
const T0 = performance.now()

/** A startup milestone: milliseconds since the main process started. */
export function mark(label: string): void {
  if (ON) console.log(`[timing] ${label}: ${Math.round(performance.now() - T0)} ms after start`)
}

/**
 * For the first `forMs` after start (CSD_TIMING_LOOP_MS, default a minute):
 * every second in which the main process's event loop was held up by more
 * than 50 ms (synchronous work), how long.
 */
export function watchEventLoop(forMs = Number(process.env.CSD_TIMING_LOOP_MS) || 60_000): void {
  if (!ON) return
  let last = performance.now()
  let worst = 0
  const tick = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 50)
    last = now
  }, 50)
  const report = setInterval(() => {
    if (worst > 50)
      console.log(
        `[timing] event loop held up to ${Math.round(worst)} ms (at ${Math.round(performance.now() - T0)} ms)`
      )
    worst = 0
  }, 1000)
  setTimeout(() => {
    clearInterval(tick)
    clearInterval(report)
  }, forMs).unref()
  tick.unref()
  report.unref()
}

/**
 * With CSD_CPU_PROFILE=<file.cpuprofile>: a CPU profile of the main process's
 * first `forMs`, written to that file (open it in Chrome DevTools).
 */
export async function profileStartup(forMs = 30_000): Promise<void> {
  const out = process.env.CSD_CPU_PROFILE
  if (!out) return
  const { Session } = await import('node:inspector/promises')
  const { writeFile } = await import('node:fs/promises')
  const session = new Session()
  session.connect()
  await session.post('Profiler.enable')
  await session.post('Profiler.start')
  setTimeout(() => {
    void session
      .post('Profiler.stop')
      .then(({ profile }) => writeFile(out, JSON.stringify(profile)))
      .then(() => console.log(`[timing] CPU profile written (${forMs} ms)`))
      .catch((e: unknown) => console.log(`[timing] CPU profile failed: ${String(e)}`))
      .finally(() => session.disconnect())
  }, forMs).unref()
}

/** How long a step takes (it's awaited as usual, whether timing is on or not). */
export async function timed<T>(label: string, work: Promise<T>): Promise<T> {
  if (!ON) return work
  const t = performance.now()
  try {
    return await work
  } finally {
    console.log(`[timing] ${label}: ${Math.round(performance.now() - t)} ms`)
  }
}

/** IPC answers bigger than this are logged (with CSD_TIMING=1). */
const BIG_ANSWER = 256 * 1024

/**
 * With CSD_TIMING=1: an IPC handler's time (the synchronous part, which holds
 * up the main process, and the whole call) and the size of its answer, when it
 * took more than 50 ms or answered more than 256 KB. Only the channel name and
 * the numbers are printed. Off: the handler is called as is.
 */
export function timedCall(channel: string, call: () => unknown): unknown {
  if (!ON) return call()
  const t = performance.now()
  const res = call()
  const sync = performance.now() - t
  const report = (value: unknown): void => {
    const total = performance.now() - t
    let size = 0
    try {
      size = value === undefined ? 0 : (JSON.stringify(value)?.length ?? 0)
    } catch {
      // Not JSON (structured clone only): size unknown.
    }
    if (total > 50 || sync > 50 || size > BIG_ANSWER)
      console.log(
        `[timing] ipc ${channel}: ${Math.round(total)} ms (sync ${Math.round(sync)} ms), ${Math.round(size / 1024)} KB`
      )
  }
  if (res instanceof Promise) {
    void res.then(report, () => undefined)
    return res
  }
  report(res)
  return res
}

/** Worker threads whose heaps the memory log shows (by name). */
const workers = new Map<string, { getHeapStatistics?: () => Promise<{ used_heap_size: number }> }>()

/** A worker thread to show in the memory log while it runs (CSD_TIMING=1); undefined when it ends. */
export function noteWorker(
  name: string,
  worker: { getHeapStatistics?: () => Promise<{ used_heap_size: number }> } | undefined
): void {
  if (!ON) return
  if (worker) workers.set(name, worker)
  else workers.delete(name)
}

/**
 * With CSD_TIMING=1, every `everyMs`: the main process's memory and each
 * running worker thread's heap (sizes only).
 */
export function watchMemory(everyMs = Number(process.env.CSD_TIMING_MEM_MS) || 10_000): void {
  if (!ON) return
  const mb = (b: number): number => Math.round(b / 1048576)
  const t = setInterval(() => {
    const m = process.memoryUsage()
    void Promise.all(
      [...workers].map(async ([name, w]) => {
        const h = await w.getHeapStatistics?.().catch(() => undefined)
        return `${name} ${h ? `${mb(h.used_heap_size)} MB` : '?'}`
      })
    ).then((ws) =>
      console.log(
        `[timing] memory: rss ${mb(m.rss)} MB, main heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB, external ${mb(m.external)} MB; workers: ${ws.join(', ') || 'none'} (at ${Math.round(performance.now() - T0)} ms)`
      )
    )
  }, everyMs)
  t.unref()
}
