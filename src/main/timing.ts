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
 * For the first `forMs` after start: every second in which the main process's
 * event loop was held up by more than 100 ms (synchronous work), how long.
 */
export function watchEventLoop(forMs = 60_000): void {
  if (!ON) return
  let last = performance.now()
  let worst = 0
  const tick = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 50)
    last = now
  }, 50)
  const report = setInterval(() => {
    if (worst > 100)
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
