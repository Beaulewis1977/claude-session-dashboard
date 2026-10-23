// Starting the phone app: load everything once, and keep trying until it
// works. A request to load while one is running (the PC came back) is kept,
// not dropped; after a failure it retries on a timer, since nothing else may
// come along to trigger it.

export interface Bootstrap {
  load(): void
  cancel(): void
}

export function bootstrap(opts: {
  /** Loads everything; resolves when the app has what it needs. */
  run: () => Promise<void>
  loaded: () => boolean
  onError: (err: Error) => void
  retryMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}): Bootstrap {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let loading = false
  let again = false
  let cancelled = false
  let timer: unknown
  const load = (): void => {
    if (cancelled || opts.loaded()) return
    if (loading) {
      again = true
      return
    }
    loading = true
    again = false
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    opts
      .run()
      .catch((err: Error) => {
        if (!cancelled) opts.onError(err)
      })
      .finally(() => {
        loading = false
        if (cancelled || opts.loaded()) return
        if (again) load()
        else timer = setTimer(load, opts.retryMs ?? 5000)
      })
  }
  return {
    load,
    cancel() {
      cancelled = true
      if (timer !== undefined) clearTimer(timer)
    }
  }
}
