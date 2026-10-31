// Web Push for the phone companion (exception #5, opt-in per phone).
//
// A phone that turned push alerts on gives the PC a push "subscription": an
// endpoint at its browser's push service (Google, Apple, Mozilla, Microsoft)
// and two keys. The PC encrypts each alert for that phone alone (RFC 8291,
// aes128gcm) and POSTs it to that endpoint, signed with the app's own VAPID
// key (RFC 8292). The push service can't read it, and there is little to read
// anyway: a push holds only `{v, kind, ref}` (see PushNotice), never a session
// name, project, path or message text. The phone loads the details over
// Tailscale when the alert is tapped.
//
// Only endpoints on the push services' own hosts are ever contacted, over
// HTTPS on the default port, with no redirects followed. No dependencies:
// node:crypto and node:https only.

import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  ECDH
} from 'node:crypto'
import { request } from 'node:https'
import type { PushKind, PushNotice } from '@shared/mobile'

/** The app's VAPID identity: who the push services see as the sender. */
export const VAPID_SUBJECT = 'https://github.com/Beaulewis1977/claude-session-dashboard'

export interface VapidKeys {
  /** Raw uncompressed P-256 point (65 bytes), base64url: the phone's `applicationServerKey`. */
  publicKey: string
  /** PKCS#8 DER, base64. */
  privateKeyPkcs8: string
}

/** What a phone's browser hands over when it subscribes (PushSubscription.toJSON()). */
export interface PushSubscriptionData {
  endpoint: string
  /** The phone's P-256 public key: 65 bytes, base64url. */
  p256dh: string
  /** The phone's auth secret: 16 bytes, base64url. */
  auth: string
}

export const PUSH_KINDS: readonly PushKind[] = [
  'approval',
  'finished',
  'waiting',
  'exited',
  'failed',
  'test'
]

const REF_RE = /^[A-Za-z0-9_-]{8,64}$/
const RECORD_SIZE = 4096
const TIMEOUT_MS = 10_000
const TTL_SECONDS = 3600

const b64u = (b: Buffer): string => b.toString('base64url')

/** Strict base64url (padding tolerated), or undefined. */
function fromB64u(s: unknown): Buffer | undefined {
  if (typeof s !== 'string' || s.length > 200 || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return undefined
  return Buffer.from(s.replace(/=+$/, ''), 'base64url')
}

// ------------------------------------------------------------------ VAPID

export function createVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url')
  ])
  return {
    publicKey: b64u(raw),
    privateKeyPkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  }
}

/** The signed VAPID token for one push service (ES256 JWT, valid 12 hours). */
export function vapidJwt(audience: string, vapid: VapidKeys, nowMs: number): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(nowMs / 1000) + 12 * 3600,
        sub: VAPID_SUBJECT
      })
    )
  )
  const data = `${header}.${claims}`
  const key = createPrivateKey({
    key: Buffer.from(vapid.privateKeyPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  // JWS wants the raw r||s signature, not DER.
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
  return `${data}.${b64u(sig)}`
}

// ------------------------------------------------------------ endpoints

const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com'
])
const SUFFIX_HOSTS = ['.push.apple.com', '.notify.windows.com']

/**
 * Only the push services' own hosts, over HTTPS on the default port, without
 * credentials. A subscription naming anything else (a host on the tailnet, an
 * IP address, a port) is refused, so a phone can't make the PC call it.
 */
export function isAllowedPushEndpoint(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  const host = u.hostname.toLowerCase()
  if (EXACT_HOSTS.has(host)) return true
  return SUFFIX_HOSTS.some((s) => host.endsWith(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host))
}

/** Validate what a phone sent. Anything unexpected is refused, not fixed up. */
export function parseSubscription(v: unknown): PushSubscriptionData | { error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Bad subscription' }
  const o = v as Record<string, unknown>
  if (!isAllowedPushEndpoint(o.endpoint))
    return { error: "That push service isn't one the PC will send to." }
  const keys = (o.keys && typeof o.keys === 'object' ? o.keys : {}) as Record<string, unknown>
  const p256dh = fromB64u(keys.p256dh)
  const auth = fromB64u(keys.auth)
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04 || !auth || auth.length !== 16)
    return { error: 'Bad subscription keys' }
  try {
    // Throws unless it's a point on the curve.
    ECDH.convertKey(p256dh, 'prime256v1')
  } catch {
    return { error: 'Bad subscription keys' }
  }
  return { endpoint: o.endpoint as string, p256dh: b64u(p256dh), auth: b64u(auth) }
}

// ------------------------------------------------------------ encryption

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

/** HKDF-Expand for one block (length ≤ 32). */
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length)
}

export interface EncryptOptions {
  /** For tests: a fixed 16-byte salt. */
  salt?: Buffer
  /** For tests: the sender's key pair (raw private key, 32 bytes). */
  localPrivateKey?: Buffer
}

/**
 * Encrypt one message for one phone (RFC 8291 with RFC 8188 aes128gcm, a
 * single record). Returns the request body: header (salt, record size, the
 * sender's public key) followed by the ciphertext.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: Pick<PushSubscriptionData, 'p256dh' | 'auth'>,
  opts: EncryptOptions = {}
): Buffer {
  const uaPublic = fromB64u(sub.p256dh)
  const authSecret = fromB64u(sub.auth)
  if (!uaPublic || uaPublic.length !== 65 || !authSecret || authSecret.length !== 16)
    throw new Error('Bad subscription keys')
  // Leaves room for the delimiter and the 16-byte tag in one record.
  if (plaintext.length > RECORD_SIZE - 17) throw new Error('Push message too large')
  const ecdh = createECDH('prime256v1')
  if (opts.localPrivateKey) ecdh.setPrivateKey(opts.localPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const ecdhSecret = ecdh.computeSecret(uaPublic)
  const salt = opts.salt ?? randomBytes(16)

  // RFC 8291 §3.4: combine the shared secret with the phone's auth secret.
  const prkKey = hmac(authSecret, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = expand(prkKey, keyInfo, 32)
  // RFC 8188 §2.2: content encryption key and nonce.
  const prk = hmac(salt, ikm)
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02: this is the last (and only) record.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag()
  ])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

// ------------------------------------------------------------ sending

/**
 * The exact message a push carries: `{v: 1, kind, ref?}` and nothing else.
 * Built field by field, so nothing a caller adds can ride along.
 */
export function pushPayload(notice: { kind: PushKind; ref?: string }): string {
  if (!PUSH_KINDS.includes(notice.kind)) throw new Error('Unknown push kind')
  if (notice.ref !== undefined && !REF_RE.test(notice.ref)) throw new Error('Bad push reference')
  const out: PushNotice = { v: 1, kind: notice.kind }
  if (notice.ref !== undefined) out.ref = notice.ref
  return JSON.stringify(out)
}

export interface PushPost {
  (url: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number }>
}

export interface PushResult {
  ok: boolean
  status: number
  /** The subscription no longer exists (404/410): forget it. */
  gone: boolean
  error?: string
}

/** POST over HTTPS. Redirects are not followed (node's request never does). */
export const httpsPost: PushPost = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(body.length) },
        timeout: TIMEOUT_MS
      },
      (res) => {
        // Only the status matters; drain (at most a little) and close.
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error('Push service did not answer in time')))
    req.on('error', reject)
    req.end(body)
  })

export async function sendPush(
  sub: PushSubscriptionData,
  notice: { kind: PushKind; ref?: string },
  vapid: VapidKeys,
  deps: { post?: PushPost; now?: () => number } = {}
): Promise<PushResult> {
  if (!isAllowedPushEndpoint(sub.endpoint))
    return { ok: false, status: 0, gone: true, error: 'Endpoint not allowed' }
  const payload = pushPayload(notice)
  const body = encryptPayload(Buffer.from(payload, 'utf8'), sub)
  const audience = new URL(sub.endpoint).origin
  const jwt = vapidJwt(audience, vapid, (deps.now ?? Date.now)())
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(notice.kind === 'test' ? 60 : TTL_SECONDS),
    Urgency: notice.kind === 'approval' || notice.kind === 'failed' ? 'high' : 'normal',
    Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`
  }
  try {
    const { status } = await (deps.post ?? httpsPost)(sub.endpoint, headers, body)
    return {
      ok: status >= 200 && status < 300,
      status,
      gone: status === 404 || status === 410,
      error: status >= 200 && status < 300 ? undefined : `Push service answered ${status}`
    }
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: (err as Error).message }
  }
}
