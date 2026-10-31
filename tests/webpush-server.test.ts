import { createECDH } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MOBILE, type MobileSettings } from '../src/shared/mobile'
import { JsonStore } from '../src/main/core/json-store'
import type { MobileFile } from '../src/main/mobile/devices'
import { MobileService } from '../src/main/mobile/service'
import { fakeTailscale } from '../src/main/mobile/tailscale'
import type { PushPost } from '../src/main/mobile/webpush'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-push-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

interface Res {
  status: number
  body: string
}

function req(port: number, path: string, token: string | undefined, body: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const r = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        let text = ''
        res.on('data', (c: Buffer) => (text += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      }
    )
    r.on('error', reject)
    r.end(data)
  })
}

function phoneKeys(): { p256dh: string; auth: string } {
  const e = createECDH('prime256v1')
  e.generateKeys()
  return {
    p256dh: e.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url')
  }
}

async function setup(opts: { fixtures?: boolean; readOnly?: boolean; status?: number } = {}) {
  let settings: MobileSettings = { ...DEFAULT_MOBILE, port: 0, readOnly: !!opts.readOnly }
  const store = new JsonStore<MobileFile>(join(dir, 'mobile.json'), dir, () => ({
    version: 1,
    devices: [],
    activity: []
  }))
  const posts: { url: string; headers: Record<string, string> }[] = []
  const pushPost: PushPost = async (url, headers) => {
    posts.push({ url, headers })
    return { status: opts.status ?? 201 }
  }
  const svc = new MobileService({
    store,
    settings: () => settings,
    saveSettings: async (next) => {
      settings = next
    },
    call: async () => null,
    launch: {
      session: () => undefined,
      preview: async () => {
        throw new Error('unused')
      },
      launch: async () => ({ ok: false, restored: false, commandLine: '' }),
      settings: () => ({ terminal: 'wt', branchConfirmed: false }),
      confirm: async () => false
    },
    web: { file: async () => undefined },
    webAppFile: join(dir, 'mobile.html'),
    tailscale: fakeTailscale({}),
    keys: {
      available: () => true,
      encrypt: (s) => Buffer.from(`enc:${s}`),
      decrypt: (b) => b.toString().replace(/^enc:/, '')
    },
    appVersion: '1.0.0',
    fixtures: opts.fixtures ?? false,
    claudePath: async () => undefined,
    pushPost
  })
  await svc.start()
  const port = svc.server.address()!.port
  const p = svc.registry.startPairing(`http://127.0.0.1:${port}`)
  const paired = await req(port, '/api/pair', undefined, { code: p.code, name: 'Pixel' })
  const token = (JSON.parse(paired.body) as { token: string }).token
  return { svc, store, port, token, posts }
}

describe('push alerts from the companion server', () => {
  it('hands out the public key and keeps the private key encrypted', async () => {
    const { svc, store, port, token } = await setup()
    try {
      const r = await req(port, '/api/push/key', token, {})
      expect(r.status).toBe(200)
      const { publicKey } = JSON.parse(r.body) as { publicKey: string }
      expect(Buffer.from(publicKey, 'base64url')).toHaveLength(65)
      expect(store.value.vapid?.encrypted).toBe(true)
      expect(store.value.vapid?.privateKey).not.toContain('MIG')
      // Without a token: refused.
      expect((await req(port, '/api/push/key', undefined, {})).status).toBe(401)
    } finally {
      await svc.stop()
    }
  })

  it('stores a valid subscription and refuses other hosts', async () => {
    const { svc, port, token } = await setup()
    try {
      const keys = phoneKeys()
      const bad = await req(port, '/api/push/subscribe', token, {
        subscription: { endpoint: 'https://100.100.1.1/x', keys }
      })
      expect(bad.status).toBe(400)
      expect(svc.registry.pushTargets()).toHaveLength(0)
      const ok = await req(port, '/api/push/subscribe', token, {
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }
      })
      expect(ok.status).toBe(200)
      const st = await svc.status(false)
      expect(st.devices[0].push).toBe(true)
      // The phone learns it has push on.
      const me = await new Promise<string>((resolve) => {
        httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/api/me',
            headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` }
          },
          (res) => {
            let t = ''
            res.on('data', (c: Buffer) => (t += c))
            res.on('end', () => resolve(t))
          }
        ).end()
      })
      expect(JSON.parse(me).push).toBe(true)
      expect((await req(port, '/api/push/unsubscribe', token, {})).status).toBe(200)
      expect(svc.registry.pushTargets()).toHaveLength(0)
    } finally {
      await svc.stop()
    }
  })

  it('works in read-only mode (it changes nothing on the PC)', async () => {
    const { svc, port, token } = await setup({ readOnly: true })
    try {
      const r = await req(port, '/api/push/subscribe', token, {
        subscription: { endpoint: 'https://web.push.apple.com/abc', keys: phoneKeys() }
      })
      expect(r.status).toBe(200)
    } finally {
      await svc.stop()
    }
  })

  it('sends only to phones that turned push on, and logs no endpoints', async () => {
    const { svc, port, token, posts } = await setup()
    try {
      expect(await svc.webPush({ kind: 'finished', ref: 'abcdEFGH1234' })).toBe(0)
      await req(port, '/api/push/subscribe', token, {
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: phoneKeys() }
      })
      expect(await svc.webPush({ kind: 'approval', ref: 'abcdEFGH1234' })).toBe(1)
      expect(posts.map((p) => p.url)).toEqual(['https://fcm.googleapis.com/fcm/send/abc'])
      expect(posts[0].headers.Urgency).toBe('high')
      const test = await req(port, '/api/push/test', token, {})
      expect(JSON.parse(test.body)).toEqual({ sent: 1 })
      const log = JSON.stringify(svc.activity())
      expect(log).toContain('Push “approval” sent to 1 phone')
      expect(log).not.toContain('fcm.googleapis.com')
      // Phone access off: nothing goes out.
      await svc.stop()
      expect(await svc.webPush({ kind: 'finished' })).toBe(0)
      expect(posts).toHaveLength(2)
    } finally {
      await svc.stop()
    }
  })

  it('forgets a subscription the push service says is gone', async () => {
    const { svc, port, token } = await setup({ status: 410 })
    try {
      await req(port, '/api/push/subscribe', token, {
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: phoneKeys() }
      })
      expect(await svc.webPush({ kind: 'finished' })).toBe(0)
      expect(svc.registry.pushTargets()).toHaveLength(0)
    } finally {
      await svc.stop()
    }
  })

  it('the PC can turn a phone’s push off', async () => {
    const { svc, port, token } = await setup()
    try {
      await req(port, '/api/push/subscribe', token, {
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: phoneKeys() }
      })
      const id = svc.registry.pushTargets()[0].id
      svc.pushOff(id)
      expect(svc.registry.pushTargets()).toHaveLength(0)
      expect(svc.activity()[0].detail).toBe('Push alerts turned off on the PC')
    } finally {
      await svc.stop()
    }
  })

  it('sends nothing in fixtures mode', async () => {
    const { svc, port, token, posts } = await setup({ fixtures: true })
    try {
      await req(port, '/api/push/subscribe', token, {
        subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: phoneKeys() }
      })
      expect(await svc.webPush({ kind: 'finished' })).toBe(1)
      expect(posts).toHaveLength(0)
      expect(svc.activity()[0].detail).toContain('simulated')
    } finally {
      await svc.stop()
    }
  })
})
