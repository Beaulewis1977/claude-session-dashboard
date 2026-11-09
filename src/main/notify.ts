// Desktop notifications, all through one place, so each attempt and what
// Windows did with it is recorded (logs/notifications.jsonl in the app's data
// folder, never backed up): when one doesn't show up, the log says whether it
// was sent, shown, failed (with Windows' error) or clicked.
//
// Windows needs the app's identity (AppUserModelID, plus the Toast Activator
// CLSID Electron registers for it) before the first toast; see index.ts. A
// toast that Windows reports as failed is tried once more a few seconds
// later (the first one after the app's registration changed can be dropped
// while Windows takes it in).
//
// The log has no titles or text: only the kind of alert, the event and
// timings.

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export type NotifyKind = 'session-alert' | 'limits' | 'codex-limits' | 'backup'

export interface NotifyOptions {
  kind: NotifyKind
  title: string
  body: string
  onClick?: () => void
}

/** The parts of Electron's Notification this uses. */
export interface ToastLike {
  on(event: 'show' | 'click' | 'close', cb: () => void): unknown
  on(event: 'failed', cb: (e: unknown, error: string) => void): unknown
  show(): void
}

export interface NotifierDeps {
  isSupported(): boolean
  create(o: { title: string; body: string }): ToastLike
  /** logs/notifications.jsonl */
  logFile: string
  /** What the log records about the app's identity (once, at the first toast). */
  identity: () => Record<string, unknown>
  now?: () => number
  /** For tests: the retry delay. */
  retryMs?: number
}

/** At this size the log is moved to notifications.jsonl.1 (one older file is kept). */
export const LOG_MAX_BYTES = 256 * 1024
const RETRY_MS = 3_000

export function createNotifier(
  deps: NotifierDeps
): ((o: NotifyOptions) => void) & { idle(): Promise<void> } {
  const now = deps.now ?? Date.now
  const t0 = now()
  // Each toast stays referenced until Windows is done with it: an object that
  // was garbage-collected loses its click handler.
  const live = new Set<ToastLike>()
  let seq = 0
  let identityLogged = false
  let writing: Promise<void> = Promise.resolve()

  const log = (entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + '\n'
    writing = writing.then(() => write(deps.logFile, line)).catch(() => undefined)
  }

  const attempt = (o: NotifyOptions, id: number, tryNo: number): void => {
    const base = { id, kind: o.kind, try: tryNo }
    let n: ToastLike
    try {
      n = deps.create({ title: o.title, body: o.body })
    } catch (e) {
      log({ ...base, event: 'error', error: String(e).slice(0, 300) })
      return
    }
    live.add(n)
    const sent = now()
    const done = (): void => {
      live.delete(n)
    }
    n.on('show', () => log({ ...base, event: 'shown', ms: now() - sent }))
    n.on('click', () => {
      log({ ...base, event: 'clicked' })
      done()
      o.onClick?.()
    })
    n.on('close', () => {
      log({ ...base, event: 'closed' })
      done()
    })
    n.on('failed', (_e, error) => {
      log({ ...base, event: 'failed', error: String(error).slice(0, 300), ms: now() - sent })
      done()
      if (tryNo === 1) setTimeout(() => attempt(o, id, 2), deps.retryMs ?? RETRY_MS).unref?.()
    })
    log({ ...base, event: 'sent', sinceStartMs: now() - t0 })
    n.show()
  }

  const notify = (o: NotifyOptions): void => {
    const id = ++seq
    if (!identityLogged) {
      identityLogged = true
      log({ event: 'identity', ...deps.identity() })
    }
    if (!deps.isSupported()) {
      log({ id, kind: o.kind, event: 'unsupported' })
      return
    }
    attempt(o, id, 1)
  }
  /** Resolves once every log line queued so far is written. */
  const idle = async (): Promise<void> => {
    let w: Promise<void>
    do {
      w = writing
      await w
    } while (w !== writing)
  }
  return Object.assign(notify, { idle })
}

async function write(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const size = await stat(file).then(
    (s) => s.size,
    () => 0
  )
  // Keep one older file; the app's own log only.
  if (size + line.length > LOG_MAX_BYTES) await rename(file, `${file}.1`).catch(() => undefined)
  await appendFile(file, line)
}
