// Coalescing for change notices sent to the windows: a burst of changes (a
// scan reading hundreds of files, a busy session's status line) becomes at
// most one notice per interval, and the last change is never lost.

/**
 * `fn` runs at once when it hasn't run for `wait()` ms, otherwise once at the
 * end of that interval (however many calls came in between). `wait` is asked
 * each time, so it can be longer while a scan runs.
 */
export function coalesce(fn: () => void, wait: () => number): (() => void) & { flush(): void } {
  let last = -Infinity
  let timer: NodeJS.Timeout | undefined
  const run = (): void => {
    timer = undefined
    last = Date.now()
    fn()
  }
  const call = (): void => {
    if (timer) return
    const due = last + wait() - Date.now()
    if (due <= 0) run()
    else timer = setTimeout(run, due)
  }
  /** Run a pending call now (e.g. before quitting). */
  call.flush = (): void => {
    if (!timer) return
    clearTimeout(timer)
    run()
  }
  return call
}
