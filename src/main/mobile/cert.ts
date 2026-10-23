// A self-signed TLS certificate for home Wi-Fi mode (no dependencies).
//
// An ECDSA P-256 key and a minimal X.509 v3 certificate for the PC's LAN
// address: subject alternative name = that IP, server auth only, not a CA.
// Phones show a warning for it once; Tailscale mode doesn't need it (it uses
// Tailscale's real certificate).

import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { isIPv4 } from 'node:net'

// --------------------------------------------------------------- DER encoding

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(body.length), body])
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items))
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items))
const octets = (b: Buffer): Buffer => tlv(0x04, b)
const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]))
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]))
const explicit = (n: number, b: Buffer): Buffer => tlv(0xa0 + n, b)

function integer(b: Buffer): Buffer {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  let v = b.subarray(i)
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v])
  return tlv(0x02, v)
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const out = [parts[0] * 40 + parts[1]]
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f]
    let v = p >> 7
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    out.push(...stack)
  }
  return tlv(0x06, Buffer.from(out))
}

function time(d: Date): Buffer {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const body = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  // UTCTime is valid until 2049.
  return tlv(0x17, Buffer.from(body, 'ascii'))
}

function name(cn: string): Buffer {
  return seq(set(seq(oid('2.5.4.3'), utf8(cn))))
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value))
}

const ECDSA_SHA256 = '1.2.840.10045.4.3.2'

// ------------------------------------------------------------------ the cert

export interface SelfSigned {
  cert: string
  key: string
  expiresAt: string
}

export const CERT_DAYS = 397

export function createSelfSignedCert(ip: string, now = new Date()): SelfSigned {
  if (!isIPv4(ip)) throw new Error(`Not an IPv4 address: ${ip}`)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const notBefore = new Date(now.getTime() - 24 * 3600_000)
  const notAfter = new Date(now.getTime() + CERT_DAYS * 24 * 3600_000)
  const serial = randomBytes(16)
  serial[0] &= 0x7f
  const subject = name(`Claude Session Dashboard (${ip})`)
  const ipBytes = Buffer.from(ip.split('.').map(Number))
  const extensions = explicit(
    3,
    seq(
      // Subject alternative name: the LAN address (iPAddress, [7]).
      extension('2.5.29.17', false, seq(tlv(0x87, ipBytes))),
      // Basic constraints: not a CA.
      extension('2.5.29.19', true, seq()),
      // Key usage: digitalSignature.
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      // Extended key usage: TLS server.
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1')))
    )
  )
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    seq(oid(ECDSA_SHA256)),
    subject,
    seq(time(notBefore), time(notAfter)),
    subject,
    spki,
    extensions
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = seq(tbs, seq(oid(ECDSA_SHA256)), bitString(signature))
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n')
  const cert = `-----BEGIN CERTIFICATE-----\n${b64.trim()}\n-----END CERTIFICATE-----\n`
  // Parse it back: throws if anything above is malformed.
  new X509Certificate(cert)
  return {
    cert,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    expiresAt: notAfter.toISOString()
  }
}

/** The certificate's SHA-256 fingerprint, to compare with what the phone shows. */
export function fingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256
}
