// The phone companion's secrets (home Wi-Fi TLS key, Web Push VAPID key):
// safeStorage's asynchronous API, with keys saved by older versions (the
// synchronous API, no `v`) read and re-encrypted on first use. Paired phones,
// their push subscriptions and the public key never change because of it.

import { createECDH } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MOBILE, type MobileSettings } from '../src/shared/mobile'
import { JsonStore } from '../src/main/core/json-store'
import type { MobileFile, StoredDevice } from '../src/main/mobile/devices'
import {
  openSecret,
  sealSecret,
  SECRET_FORMAT,
  SecretUnavailableError,
  SecretUnreadableError,
  type KeyBox
} from '../src/main/mobile/secrets'
import { MobileService } from '../src/main/mobile/service'
import { fakeTailscale } from '../src/main/mobile/tailscale'
import { createVapidKeys, type PushPost } from '../src/main/mobile/webpush'

/**
 * Like Electron's safeStorage: "sync:" blobs are what encryptString wrote,
 * "async:" what encryptStringAsync writes; decryptStringAsync reads both.
 */
function fakeKeys(
  opts: {
    available?: boolean
    failEncrypt?: boolean
    failDecrypt?: boolean
    reEncrypt?: boolean
  } = {}
): KeyBox & { encrypted: string[] } {
  const encrypted: string[] = []
  return {
    encrypted,
    available: () => opts.available ?? true,
    encrypt: async (s) => {
      if (opts.failEncrypt) throw new Error('encrypt failed')
      encrypted.push(s)
      return Buffer.from(`async:${s}`)
    },
    decrypt: async (b) => {
      if (opts.failDecrypt) throw new Error('decrypt failed')
      const t = b.toString()
      const m = /^(sync|async):(.*)$/s.exec(t)
      if (!m) throw new Error('not ours')
      return { result: m[2], shouldReEncrypt: !!opts.reEncrypt }
    }
  }
}

const syncBlob = (s: string): string => Buffer.from(`sync:${s}`).toString('base64')
const asyncBlob = (s: string): string => Buffer.from(`async:${s}`).toString('base64')

describe('openSecret / sealSecret', () => {
  it('reads an old (synchronous API) secret and gives its re-encrypted form', async () => {
    const r = await openSecret(fakeKeys(), { value: syncBlob('secret'), encrypted: true })
    expect(r.plain).toBe('secret')
    expect(r.resave).toEqual({ value: asyncBlob('secret'), encrypted: true, v: SECRET_FORMAT })
  })

  it('leaves a current secret as it is', async () => {
    const keys = fakeKeys()
    const r = await openSecret(keys, { value: asyncBlob('secret'), encrypted: true, v: 2 })
    expect(r).toEqual({ plain: 'secret', resave: undefined })
    expect(keys.encrypted).toEqual([])
  })

  it('re-encrypts a current secret when Electron asks for it (shouldReEncrypt)', async () => {
    const r = await openSecret(fakeKeys({ reEncrypt: true }), {
      value: asyncBlob('secret'),
      encrypted: true,
      v: 2
    })
    expect(r.resave?.value).toBe(asyncBlob('secret'))
  })

  it('keeps the old copy when re-encrypting fails (no resave), and still reads it', async () => {
    const r = await openSecret(fakeKeys({ failEncrypt: true }), {
      value: syncBlob('secret'),
      encrypted: true
    })
    expect(r).toEqual({ plain: 'secret', resave: undefined })
  })

  it('encrypts a plain-text secret once encryption works', async () => {
    const r = await openSecret(fakeKeys(), { value: 'secret', encrypted: false })
    expect(r).toEqual({
      plain: 'secret',
      resave: { value: asyncBlob('secret'), encrypted: true, v: 2 }
    })
    expect(
      await openSecret(fakeKeys({ available: false }), { value: 'secret', encrypted: false })
    ).toEqual({ plain: 'secret' })
  })

  it('tells "not available now" apart from "can\'t be decrypted"', async () => {
    await expect(
      openSecret(fakeKeys({ available: false }), { value: syncBlob('x'), encrypted: true })
    ).rejects.toBeInstanceOf(SecretUnavailableError)
    await expect(
      openSecret(fakeKeys({ failDecrypt: true }), { value: syncBlob('x'), encrypted: true })
    ).rejects.toBeInstanceOf(SecretUnreadableError)
  })

  it('seals with the asynchronous API, or in plain text only without encryption', async () => {
    expect(await sealSecret(fakeKeys(), 'k')).toEqual({
      value: asyncBlob('k'),
      encrypted: true,
      v: 2
    })
    expect(await sealSecret(fakeKeys({ available: false }), 'k')).toEqual({
      value: 'k',
      encrypted: false
    })
  })
})

// ------------------------------------------------------------ the service

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csd-secrets-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function phoneSub(): StoredDevice['push'] {
  const e = createECDH('prime256v1')
  e.generateKeys()
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: e.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url'),
    at: '2026-11-01T00:00:00.000Z'
  }
}

/** A mobile.json as an older version left it: one paired phone with push on, sync-API keys. */
function oldFile(privateKeyPkcs8: string, publicKey: string): MobileFile {
  const now = new Date().toISOString()
  return {
    version: 1,
    devices: [
      {
        id: 'dev1',
        name: 'Pixel',
        tokenHash: 'ab'.repeat(32),
        createdAt: now,
        lastSeenAt: now,
        push: phoneSub()
      }
    ],
    activity: [],
    vapid: { publicKey, privateKey: syncBlob(privateKeyPkcs8), encrypted: true }
  }
}

function service(file: MobileFile, keys: KeyBox) {
  const settings: MobileSettings = { ...DEFAULT_MOBILE, port: 0, enabled: true }
  const store = new JsonStore<MobileFile>(join(dir, 'mobile.json'), dir, () => ({
    version: 1,
    devices: [],
    activity: []
  }))
  const seed = structuredClone(file)
  store.update((f) => {
    Object.assign(f, seed)
  })
  const posts: string[] = []
  const pushPost: PushPost = async (url) => {
    posts.push(url)
    return { status: 201 }
  }
  const svc = new MobileService({
    store,
    settings: () => settings,
    saveSettings: async () => undefined,
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
    keys,
    appVersion: '1.0.0',
    fixtures: false,
    claudePath: async () => undefined,
    pushPost
  })
  return { svc, store, posts }
}

describe('phone companion keys saved by an older version', () => {
  it('migrates the VAPID key on first use; the phone stays paired and push keeps working', async () => {
    const k = createVapidKeys()
    const before = oldFile(k.privateKeyPkcs8, k.publicKey)
    const { svc, store, posts } = service(before, fakeKeys())
    expect(await svc.pushPublicKey()).toBe(k.publicKey)
    // Re-encrypted with the asynchronous API, same key.
    expect(store.value.vapid).toEqual({
      publicKey: k.publicKey,
      privateKey: asyncBlob(k.privateKeyPkcs8),
      encrypted: true,
      v: 2
    })
    // Phones, their tokens and push subscriptions: untouched.
    expect(store.value.devices).toEqual(before.devices)
    // Signing still works with the migrated key.
    expect(await svc.sendTestPush('dev1')).toBe(1)
    expect(posts).toEqual(['https://fcm.googleapis.com/fcm/send/abc'])
  })

  it('reads it once per run, and the next run reads the new format without saving again', async () => {
    const k = createVapidKeys()
    const keys = fakeKeys()
    const first = service(oldFile(k.privateKeyPkcs8, k.publicKey), keys)
    await Promise.all([first.svc.pushPublicKey(), first.svc.pushPublicKey()])
    expect(keys.encrypted).toHaveLength(1)
    const migrated = structuredClone(first.store.value)
    const keys2 = fakeKeys()
    const second = service(migrated, keys2)
    expect(await second.svc.pushPublicKey()).toBe(k.publicKey)
    expect(keys2.encrypted).toEqual([])
    expect(second.store.value).toEqual(migrated)
  })

  it('keeps the old copy when re-encrypting fails, and push still works', async () => {
    const k = createVapidKeys()
    const before = oldFile(k.privateKeyPkcs8, k.publicKey)
    const { svc, store } = service(before, fakeKeys({ failEncrypt: true }))
    expect(await svc.sendTestPush('dev1')).toBe(1)
    expect(store.value.vapid).toEqual(before.vapid)
    expect(store.value.devices).toEqual(before.devices)
  })

  it("keeps keys and subscriptions when encryption isn't available right now", async () => {
    const k = createVapidKeys()
    const before = oldFile(k.privateKeyPkcs8, k.publicKey)
    const { svc, store, posts } = service(before, fakeKeys({ available: false }))
    await expect(svc.pushPublicKey()).rejects.toBeInstanceOf(SecretUnavailableError)
    expect(await svc.sendTestPush('dev1')).toBe(0)
    expect(posts).toEqual([])
    expect(store.value.vapid).toEqual(before.vapid)
    expect(store.value.devices).toEqual(before.devices)
    expect(store.value.activity[0]?.detail).toMatch(/not sent: Windows can't unlock/)
  })

  it("makes new keys only when the saved one truly can't be decrypted (phones stay paired)", async () => {
    const k = createVapidKeys()
    const before = oldFile(k.privateKeyPkcs8, k.publicKey)
    const { svc, store } = service(before, fakeKeys({ failDecrypt: true }))
    const pub = await svc.pushPublicKey()
    expect(pub).not.toBe(k.publicKey)
    expect(store.value.vapid?.v).toBe(2)
    // Still paired; only the subscription to the old key is gone.
    expect(store.value.devices.map((d) => d.id)).toEqual(['dev1'])
    expect(store.value.devices[0].tokenHash).toBe(before.devices[0].tokenHash)
    expect(store.value.devices[0].push).toBeUndefined()
  })

  it('migrates the home Wi-Fi certificate key on its first read', async () => {
    const { svc, store } = service({ version: 1, devices: [], activity: [] }, fakeKeys())
    const { createSelfSignedCert } = await import('../src/main/mobile/cert')
    const c = createSelfSignedCert('127.0.0.1')
    store.update((f) => {
      f.lanCert = {
        address: '127.0.0.1',
        cert: c.cert,
        key: syncBlob(c.key),
        encrypted: true,
        expiresAt: c.expiresAt
      }
    })
    const tls = await (
      svc as unknown as { lanCert(a: string): Promise<{ cert: string; key: string }> }
    ).lanCert('127.0.0.1')
    expect(tls).toEqual({ cert: c.cert, key: c.key })
    expect(store.value.lanCert).toEqual({
      address: '127.0.0.1',
      cert: c.cert,
      key: asyncBlob(c.key),
      encrypted: true,
      v: 2,
      expiresAt: c.expiresAt
    })
  })

  it("doesn't replace the certificate when encryption isn't available right now", async () => {
    const { svc, store } = service(
      { version: 1, devices: [], activity: [] },
      fakeKeys({ available: false })
    )
    const { createSelfSignedCert } = await import('../src/main/mobile/cert')
    const c = createSelfSignedCert('127.0.0.1')
    const saved = {
      address: '127.0.0.1',
      cert: c.cert,
      key: syncBlob(c.key),
      encrypted: true,
      expiresAt: c.expiresAt
    }
    store.update((f) => {
      f.lanCert = { ...saved }
    })
    await expect(
      (svc as unknown as { lanCert(a: string): Promise<unknown> }).lanCert('127.0.0.1')
    ).rejects.toThrow(/Home Wi-Fi mode can't start/)
    expect(store.value.lanCert).toEqual(saved)
  })
})
