// Paired phones and the pairing flow.
//
// Pairing: the PC shows a QR code with the companion URL and a one-time code.
// The phone sends the code back once; it's single-use, expires after a few
// minutes, and too many wrong guesses cancel it. Each phone then gets its own
// random token. Only the token's SHA-256 is stored, so the file can't be used
// to sign in. Phones that haven't been seen for 30 days are forgotten.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ActivityEntry, MobileDevice, PairingInfo } from '@shared/mobile'
import type { JsonStore } from '../core/json-store'

export interface StoredDevice {
  id: string
  name: string
  /** SHA-256 of the token, hex. */
  tokenHash: string
  createdAt: string
  lastSeenAt: string
  agent?: string
}

export interface MobileFile {
  version: 1
  devices: StoredDevice[]
  activity: ActivityEntry[]
  /** The `tailscale serve` rule this app added (so only that one is ever removed). */
  serveRule?: { httpsPort: number; target: string }
  /** The Windows Firewall rule this app added for home Wi-Fi mode. */
  firewallRule?: { name: string; port: number; address: string }
  /** Self-signed certificate for home Wi-Fi mode (the key is encrypted when possible). */
  lanCert?: { address: string; cert: string; key: string; encrypted: boolean; expiresAt: string }
}

export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const PAIRING_TTL_MS = 5 * 60 * 1000
export const PAIRING_MAX_FAILURES = 5
const ACTIVITY_MAX = 1000
/** lastSeenAt is saved at most this often per device. */
const SEEN_WRITE_MS = 60_000

// Crockford base32 without look-alikes (no I, L, O, U).
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newPairingCode(): string {
  const bytes = randomBytes(8)
  let s = ''
  for (const b of bytes) s += CODE_ALPHABET[b & 31]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

/** Upper-case, drop separators and map look-alikes, so typed codes match. */
export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .slice(0, 16)
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export function cleanDeviceName(name: unknown): string {
  const s =
    typeof name === 'string'
      ? name
          .normalize('NFKC')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
      : ''
  return s || 'Phone'
}

export type PairResult =
  | { ok: true; device: StoredDevice; token: string }
  | { ok: false; error: string; status: 400 | 403 | 410 | 429 }

export class DeviceRegistry {
  private pairing: { code: string; expiresAt: number; failures: number } | undefined
  private lastWrite = new Map<string, number>()

  constructor(
    private readonly store: JsonStore<MobileFile>,
    private readonly now: () => number = Date.now
  ) {}

  // ------------------------------------------------------------- pairing

  /** Start (or restart) pairing: a fresh one-time code. */
  startPairing(baseUrl: string): PairingInfo {
    const code = newPairingCode()
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.pairing = { code: normalizeCode(code), expiresAt, failures: 0 }
    return {
      code,
      // The code travels in the fragment, so it never reaches a server log or proxy.
      url: `${baseUrl.replace(/\/+$/, '')}/#pair=${code}`,
      expiresAt: new Date(expiresAt).toISOString()
    }
  }

  cancelPairing(): void {
    this.pairing = undefined
  }

  pairingActive(): boolean {
    return !!this.pairing && this.pairing.expiresAt > this.now()
  }

  pair(code: unknown, name: unknown, agent?: string): PairResult {
    const p = this.pairing
    if (!p || p.expiresAt <= this.now()) {
      this.pairing = undefined
      return {
        ok: false,
        status: 410,
        error: 'Pairing is not open. On your PC, open Settings → Phone and show a new code.'
      }
    }
    const given = typeof code === 'string' ? normalizeCode(code) : ''
    const a = Buffer.from(given.padEnd(16, '\0'))
    const b = Buffer.from(p.code.padEnd(16, '\0'))
    if (given.length !== p.code.length || !timingSafeEqual(a, b)) {
      p.failures++
      if (p.failures >= PAIRING_MAX_FAILURES) {
        this.pairing = undefined
        this.log({ action: 'pair', detail: 'Too many wrong codes: pairing was closed', ok: false })
        return {
          ok: false,
          status: 429,
          error: 'Too many wrong codes. Show a new code on your PC.'
        }
      }
      return { ok: false, status: 403, error: "That code doesn't match. Check it and try again." }
    }
    // Single use.
    this.pairing = undefined
    const token = newToken()
    const at = new Date(this.now()).toISOString()
    const device: StoredDevice = {
      id: randomUUID(),
      name: cleanDeviceName(name),
      tokenHash: hashToken(token),
      createdAt: at,
      lastSeenAt: at,
      agent: typeof agent === 'string' ? agent.slice(0, 200) : undefined
    }
    this.store.update((f) => {
      f.devices.push(device)
    })
    this.log({ action: 'pair', deviceId: device.id, device: device.name, ok: true })
    return { ok: true, device, token }
  }

  // ------------------------------------------------------------- devices

  /** The device a token belongs to, or undefined (unknown, revoked or expired). */
  authenticate(token: unknown): StoredDevice | undefined {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return undefined
    this.prune()
    const h = hashToken(token)
    const d = this.store.value.devices.find((x) => sameHash(x.tokenHash, h))
    if (!d) return undefined
    const t = this.now()
    if ((this.lastWrite.get(d.id) ?? 0) + SEEN_WRITE_MS < t) {
      this.lastWrite.set(d.id, t)
      this.store.update((f) => {
        const x = f.devices.find((y) => y.id === d.id)
        if (x) x.lastSeenAt = new Date(t).toISOString()
      })
    }
    return d
  }

  /** Forget phones not seen for 30 days. */
  prune(): void {
    const cutoff = this.now() - DEVICE_TTL_MS
    const stale = this.store.value.devices.filter((d) => Date.parse(d.lastSeenAt) < cutoff)
    if (!stale.length) return
    this.store.update((f) => {
      f.devices = f.devices.filter((d) => Date.parse(d.lastSeenAt) >= cutoff)
    })
    for (const d of stale)
      this.log({
        action: 'expire',
        deviceId: d.id,
        device: d.name,
        detail: 'Not seen for 30 days',
        ok: true
      })
  }

  revoke(id: string, by: 'pc' | 'phone' = 'pc'): StoredDevice | undefined {
    const d = this.store.value.devices.find((x) => x.id === id)
    if (!d) return undefined
    this.store.update((f) => {
      f.devices = f.devices.filter((x) => x.id !== id)
    })
    this.log({
      action: 'revoke',
      deviceId: d.id,
      device: d.name,
      detail: by === 'phone' ? 'Unpaired from the phone' : 'Revoked on the PC',
      ok: true
    })
    return d
  }

  rename(id: string, name: string): void {
    this.store.update((f) => {
      const d = f.devices.find((x) => x.id === id)
      if (d) d.name = cleanDeviceName(name)
    })
  }

  list(connected: (id: string) => boolean = () => false): MobileDevice[] {
    this.prune()
    return this.store.value.devices.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      agent: d.agent,
      connected: connected(d.id)
    }))
  }

  // ------------------------------------------------------------- activity

  log(e: Omit<ActivityEntry, 'at'>): void {
    const entry: ActivityEntry = { at: new Date(this.now()).toISOString(), ...e }
    this.store.update((f) => {
      f.activity.push(entry)
      if (f.activity.length > ACTIVITY_MAX) f.activity.splice(0, f.activity.length - ACTIVITY_MAX)
    })
  }

  activity(limit = 200): ActivityEntry[] {
    return this.store.value.activity.slice(-limit).reverse()
  }
}
