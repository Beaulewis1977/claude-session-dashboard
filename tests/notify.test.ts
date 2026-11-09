// Desktop notifications: each attempt and Windows' answer is logged (no
// titles or text), a toast Windows reports as failed is tried once more, and
// the app's identity for notifications matches the installer's.

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNotifier, LOG_MAX_BYTES, type ToastLike } from '../src/main/notify'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-notify-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

class FakeToast extends EventEmitter implements ToastLike {
  shown = 0
  constructor(readonly o: { title: string; body: string }) {
    super()
  }
  show(): void {
    this.shown++
  }
}

function setup(supported = true) {
  const toasts: FakeToast[] = []
  const logFile = join(dir, 'logs', 'notifications.jsonl')
  const notify = createNotifier({
    isSupported: () => supported,
    create: (o) => {
      const t = new FakeToast(o)
      toasts.push(t)
      return t
    },
    logFile,
    identity: () => ({ appUserModelId: 'com.example.app', packaged: true }),
    retryMs: 5
  })
  const lines = async () => {
    // Writes are queued: wait until they're all done.
    await notify.idle()
    return (await readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }
  return { notify, toasts, lines, logFile }
}

describe('desktop notifications', () => {
  it('logs the identity once, each attempt and what Windows did, never the text', async () => {
    const { notify, toasts, lines } = setup()
    let clicked = 0
    notify({
      kind: 'session-alert',
      title: 'Secret project needs you',
      body: 'Approve rm -rf?',
      onClick: () => clicked++
    })
    expect(toasts[0].shown).toBe(1)
    toasts[0].emit('show')
    toasts[0].emit('click')
    expect(clicked).toBe(1)
    const log = await lines()
    expect(log.map((l) => l.event)).toEqual(['identity', 'sent', 'shown', 'clicked'])
    expect(log[0]).toMatchObject({ appUserModelId: 'com.example.app', packaged: true })
    expect(log[1]).toMatchObject({ id: 1, kind: 'session-alert', try: 1 })
    const text = JSON.stringify(log)
    expect(text).not.toContain('Secret')
    expect(text).not.toContain('rm -rf')
  })

  it('tries a toast Windows reports as failed once more, and logs its error', async () => {
    const { notify, toasts, lines } = setup()
    notify({ kind: 'backup', title: 't', body: 'b' })
    toasts[0].emit('failed', {}, 'Toast notification failed: 0x80070490')
    await expect.poll(() => toasts.length).toBe(2)
    expect(toasts).toHaveLength(2)
    expect(toasts[1].shown).toBe(1)
    // A second failure is logged, not retried again.
    toasts[1].emit('failed', {}, 'again')
    await new Promise((r) => setTimeout(r, 30))
    expect(toasts).toHaveLength(2)
    const log = await lines()
    expect(log.filter((l) => l.event === 'failed')).toEqual([
      expect.objectContaining({ id: 1, try: 1, error: expect.stringContaining('0x80070490') }),
      expect.objectContaining({ id: 1, try: 2, error: 'again' })
    ])
  })

  it('logs when notifications aren’t supported, and shows nothing', async () => {
    const { notify, toasts, lines } = setup(false)
    notify({ kind: 'limits', title: 't', body: 'b' })
    expect(toasts).toEqual([])
    expect((await lines()).map((l) => l.event)).toEqual(['identity', 'unsupported'])
  })

  it('keeps the log small: one older file at most', async () => {
    const { notify, logFile } = setup()
    await mkdir(join(dir, 'logs'), { recursive: true })
    await writeFile(logFile, 'x'.repeat(LOG_MAX_BYTES))
    notify({ kind: 'limits', title: 't', body: 'b' })
    await notify.idle()
    expect((await stat(`${logFile}.1`)).size).toBe(LOG_MAX_BYTES)
    expect((await stat(logFile)).size).toBeLessThan(1024)
  })
})

describe("the app's notification identity", () => {
  it("uses the installer's appId (and a separate one in development)", async () => {
    const root = resolve(import.meta.dirname, '..')
    const yml = await readFile(join(root, 'electron-builder.yml'), 'utf8')
    const appId = /^appId:\s*(\S+)/m.exec(yml)?.[1]
    const main = await readFile(join(root, 'src', 'main', 'index.ts'), 'utf8')
    expect(/const APP_ID = '([^']+)'/.exec(main)?.[1]).toBe(appId)
    expect(main).toContain('app.isPackaged ? APP_ID : `${APP_ID}.dev`')
    // Set before the single-instance lock, i.e. before any window or notification.
    expect(main.indexOf('setAppIdentity()')).toBeLessThan(main.indexOf('requestSingleInstanceLock'))
  })
})
