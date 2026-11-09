// Long jobs in the main process (the startup scan, reading big Codex
// rollouts) run on the same thread as the app's IPC. Without a pause they held
// it for seconds at a time (measured: up to 4 s), so a dialog opened during
// the first scan waited for them (the Resume preview took 6-10 s instead of
// 20 ms). Calling breathe() in their loops lets other work in every ~25 ms.

const BUDGET_MS = 25
let last = performance.now()

/** Yield to the event loop if the thread has been busy for a while; else return at once. */
export async function breathe(): Promise<void> {
  if (performance.now() - last < BUDGET_MS) return
  await new Promise<void>((r) => setImmediate(r))
  last = performance.now()
}
