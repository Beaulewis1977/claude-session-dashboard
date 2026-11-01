import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createVapidKeys,
  encryptPayload,
  isAllowedPushEndpoint,
  parseSubscription,
  pushPayload,
  sendPush,
  vapidJwt,
  VAPID_SUBJECT,
  type PushPost
} from '../src/main/mobile/webpush'

const b = (s: string): Buffer => Buffer.from(s, 'base64url')

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

/** The phone's side (RFC 8291 decryption), to check messages end to end. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const ct = body.subarray(21 + idLen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const h = (k: Buffer, d: Buffer): Buffer => createHmac('sha256', k).update(d).digest()
  const one = Buffer.from([1])
  const ikm = h(
    h(auth, secret),
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, one])
  )
  const prk = h(salt, ikm)
  const cek = h(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), one])).subarray(
    0,
    16
  )
  const nonce = h(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), one])).subarray(
    0,
    12
  )
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  // Strip the padding delimiter (0x02, then optional zeros).
  const end = plain.lastIndexOf(2)
  return plain.subarray(0, end).toString('utf8')
}

describe('Web Push encryption (RFC 8291)', () => {
  it('matches the RFC test vector byte for byte', () => {
    const out = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: b(RFC.salt), localPrivateKey: b(RFC.asPrivate) }
    )
    expect(out.toString('base64url')).toBe(RFC.message)
  })

  it('round-trips with fresh keys, and every message is different', () => {
    const phone = createECDH('prime256v1')
    phone.generateKeys()
    const auth = Buffer.alloc(16, 7)
    const sub = {
      p256dh: phone.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url')
    }
    const a = encryptPayload(Buffer.from('{"v":1,"kind":"finished"}'), sub)
    const c = encryptPayload(Buffer.from('{"v":1,"kind":"finished"}'), sub)
    expect(a.equals(c)).toBe(false)
    expect(decrypt(a, phone.getPrivateKey(), auth)).toBe('{"v":1,"kind":"finished"}')
  })

  it('refuses bad keys', () => {
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: RFC.auth })).toThrow()
  })
})

describe('VAPID', () => {
  it('signs a JWT that verifies with the public key', () => {
    const keys = createVapidKeys()
    expect(b(keys.publicKey)).toHaveLength(65)
    const now = Date.parse('2026-10-31T12:00:00Z')
    const jwt = vapidJwt('https://fcm.googleapis.com', keys, now)
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(b(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(b(c).toString())
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: VAPID_SUBJECT
    })
    const raw = b(keys.publicKey)
    const pub = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url')
      },
      format: 'jwk'
    })
    expect(
      verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b(s))
    ).toBe(true)
  })
})

describe('push endpoints', () => {
  it('allows only the push services, over https on the default port', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/QGx1',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-by3p.notify.windows.com/w/?token=x'
    ])
      expect(isAllowedPushEndpoint(ok), ok).toBe(true)
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilpush.apple.com/x',
      'https://push.apple.com.evil.example/x',
      'https://100.64.0.1/x',
      'https://pc.tail1234.ts.net/x',
      'https://localhost/x',
      'file:///etc/passwd',
      'not a url',
      42
    ])
      expect(isAllowedPushEndpoint(bad), String(bad)).toBe(false)
  })

  it('validates subscriptions from the phone', () => {
    const ok = parseSubscription({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: RFC.uaPublic, auth: RFC.auth }
    })
    expect(ok).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      p256dh: RFC.uaPublic,
      auth: RFC.auth
    })
    expect(
      'error' in
        parseSubscription({
          endpoint: 'https://evil.example/x',
          keys: { p256dh: RFC.uaPublic, auth: RFC.auth }
        })
    ).toBe(true)
    expect(
      'error' in
        parseSubscription({
          endpoint: 'https://fcm.googleapis.com/x',
          keys: { p256dh: RFC.uaPublic, auth: 'AAAA' }
        })
    ).toBe(true)
    // 65 bytes starting with 0x04, but not a point on the curve.
    const offCurve = Buffer.alloc(65, 1)
    offCurve[0] = 4
    expect(
      'error' in
        parseSubscription({
          endpoint: 'https://fcm.googleapis.com/x',
          keys: { p256dh: offCurve.toString('base64url'), auth: RFC.auth }
        })
    ).toBe(true)
    expect('error' in parseSubscription(null)).toBe(true)
  })
})

describe('sending a push', () => {
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: RFC.uaPublic,
    auth: RFC.auth
  }

  it('carries only {v, kind, ref}', () => {
    expect(pushPayload({ kind: 'approval', ref: 'abcdEFGH1234' })).toBe(
      '{"v":1,"kind":"approval","ref":"abcdEFGH1234"}'
    )
    expect(
      pushPayload({ kind: 'finished', ref: 'abcdEFGH1234', name: 'Secret project' } as never)
    ).toBe('{"v":1,"kind":"finished","ref":"abcdEFGH1234"}')
    expect(pushPayload({ kind: 'test' })).toBe('{"v":1,"kind":"test"}')
    expect(() => pushPayload({ kind: 'approval', ref: 'C:\\Users\\beau\\secret' })).toThrow()
    expect(() => pushPayload({ kind: 'hello' as never })).toThrow()
  })

  it('posts an encrypted, VAPID-signed message with the right headers', async () => {
    const vapid = createVapidKeys()
    const seen: { url: string; headers: Record<string, string>; body: Buffer }[] = []
    const post: PushPost = async (url, headers, body) => {
      seen.push({ url, headers, body })
      return { status: 201 }
    }
    const r = await sendPush(sub, { kind: 'approval', ref: 'abcdEFGH1234' }, vapid, { post })
    expect(r).toEqual({ ok: true, status: 201, gone: false, error: undefined })
    const { url, headers, body } = seen[0]
    expect(url).toBe(sub.endpoint)
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.Urgency).toBe('high')
    expect(Number(headers.TTL)).toBeGreaterThan(0)
    expect(headers.Authorization).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`)
    )
    const plain = decrypt(body, b(RFC.uaPrivate), b(RFC.auth))
    expect(JSON.parse(plain)).toEqual({ v: 1, kind: 'approval', ref: 'abcdEFGH1234' })
    // Nothing readable in the body.
    expect(body.includes(Buffer.from('approval'))).toBe(false)
  })

  it('reports a subscription that is gone (404/410) and other failures', async () => {
    const vapid = createVapidKeys()
    const at =
      (status: number): PushPost =>
      async () => ({ status })
    expect((await sendPush(sub, { kind: 'finished' }, vapid, { post: at(410) })).gone).toBe(true)
    expect((await sendPush(sub, { kind: 'finished' }, vapid, { post: at(404) })).gone).toBe(true)
    const busy = await sendPush(sub, { kind: 'finished' }, vapid, { post: at(429) })
    expect(busy).toMatchObject({ ok: false, gone: false })
    const down = await sendPush(sub, { kind: 'finished' }, vapid, {
      post: async () => {
        throw new Error('ECONNRESET')
      }
    })
    expect(down).toMatchObject({ ok: false, gone: false, error: 'ECONNRESET' })
  })

  it('never posts to an endpoint off the allow-list', async () => {
    let called = false
    const r = await sendPush(
      { ...sub, endpoint: 'https://evil.example/x' },
      { kind: 'finished' },
      createVapidKeys(),
      {
        post: async () => {
          called = true
          return { status: 201 }
        }
      }
    )
    expect(called).toBe(false)
    expect(r.ok).toBe(false)
  })
})
