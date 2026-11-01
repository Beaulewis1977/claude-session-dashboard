// Backup encryption: a password-derived key (scrypt) and AES-256-GCM.
//
// Everything here is Node's built-in crypto and zlib, so no native module is
// needed. The password itself is never stored: the backup set keeps only the
// scrypt parameters, a random salt and a check value that tells a wrong
// password apart without revealing the key. "Remember on this PC" keeps the
// derived key, protected by Electron safeStorage (see services/backup.ts).
//
// File envelope (objects and sealed manifests):
//   "CSDB" | version (1) | flags (1) | [iv (12)] | body | [GCM tag (16)]
// The body is gzip, encrypted when the flag says so. The header (iv included)
// is authenticated as additional data. Objects are named after their content
// (see objectId), and a restore checks the decrypted content against the name.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions
} from 'node:crypto'
import { open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Transform, type Readable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'

const MAGIC = Buffer.from('CSDB', 'ascii')
const VERSION = 1
const FLAG_GZIP = 1
const FLAG_ENC = 2
const IV_LEN = 12
const TAG_LEN = 16
const BASE_HEADER = MAGIC.length + 2

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password')
  }
}

/** A backup file that can't be read: damaged, cut short, or changed by someone. */
export class DamagedBackupError extends Error {}

export interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  /** base64 */
  salt: string
}

/** One password of a backup set (a set may have older ones, see the set file). */
export interface KeyEntry {
  id: string
  kdf: KdfParams
  /** hex: HMAC of a fixed text with a key derived from the password. */
  check: string
  createdAt: string
}

export interface BackupKeys {
  keyId: string
  /** AES-256-GCM key. */
  enc: Buffer
  /** Names encrypted objects (see objectId). */
  mac: Buffer
}

/** About 128 MiB of memory and a fraction of a second on a typical PC. */
export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 }

const CHECK_TEXT = 'csd-backup-v1 key check'

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFC'), salt, 32, opts, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  )
}

function validKdf(k: unknown): k is KdfParams {
  const o = k as KdfParams
  return (
    !!o &&
    o.name === 'scrypt' &&
    Number.isInteger(o.N) &&
    o.N >= 2 ** 10 &&
    o.N <= 2 ** 22 &&
    (o.N & (o.N - 1)) === 0 &&
    Number.isInteger(o.r) &&
    o.r >= 1 &&
    o.r <= 32 &&
    Number.isInteger(o.p) &&
    o.p >= 1 &&
    o.p <= 16 &&
    typeof o.salt === 'string' &&
    o.salt.length >= 16
  )
}

export function validKeyEntry(e: unknown): e is KeyEntry {
  const o = e as KeyEntry
  return (
    !!o &&
    typeof o.id === 'string' &&
    /^[0-9a-f]{16}$/.test(o.id) &&
    typeof o.check === 'string' &&
    /^[0-9a-f]{64}$/.test(o.check) &&
    validKdf(o.kdf)
  )
}

export async function deriveMaster(password: string, kdf: KdfParams): Promise<Buffer> {
  if (!validKdf(kdf)) throw new DamagedBackupError('Unknown key settings in the backup set')
  return scrypt(password, Buffer.from(kdf.salt, 'base64'), {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r * kdf.p + 16 * 1024 * 1024
  })
}

const sub = (master: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `csd-backup ${info}`, 32))

function checkOf(master: Buffer): string {
  return createHmac('sha256', sub(master, 'check')).update(CHECK_TEXT).digest('hex')
}

/** The keys for a master key, if it belongs to this entry. */
export function keysFromMaster(entry: KeyEntry, master: Buffer): BackupKeys {
  const check = Buffer.from(checkOf(master), 'hex')
  const want = Buffer.from(entry.check, 'hex')
  if (check.length !== want.length || !timingSafeEqual(check, want)) throw new WrongPasswordError()
  return { keyId: entry.id, enc: sub(master, 'enc'), mac: sub(master, 'mac') }
}

export async function unlockKey(
  entry: KeyEntry,
  password: string
): Promise<{ keys: BackupKeys; master: Buffer }> {
  const master = await deriveMaster(password, entry.kdf)
  return { keys: keysFromMaster(entry, master), master }
}

export async function newKeyEntry(
  password: string,
  params: { N: number; r: number; p: number } = DEFAULT_KDF,
  at = new Date().toISOString()
): Promise<{ entry: KeyEntry; keys: BackupKeys; master: Buffer }> {
  const kdf: KdfParams = { name: 'scrypt', ...params, salt: randomBytes(16).toString('base64') }
  const master = await deriveMaster(password, kdf)
  const entry: KeyEntry = {
    id: randomBytes(8).toString('hex'),
    kdf,
    check: checkOf(master),
    createdAt: at
  }
  return { entry, keys: keysFromMaster(entry, master), master }
}

/**
 * An object's file name: the SHA-256 of its content, or for an encrypted set
 * an HMAC of that hash, so the folder doesn't reveal which content it holds.
 */
export function objectId(sha256: string, keys: BackupKeys | null): string {
  if (!keys) return sha256
  return createHmac('sha256', keys.mac).update(`object:${sha256}`).digest('hex')
}

function header(encrypted: boolean, iv?: Buffer): Buffer {
  const h = Buffer.from([...MAGIC, VERSION, FLAG_GZIP | (encrypted ? FLAG_ENC : 0)])
  return iv ? Buffer.concat([h, iv]) : h
}

/** Passes data through, hashing it (SHA-256) and counting bytes. */
export class HashTap extends Transform {
  private readonly hash = createHash('sha256')
  bytes = 0
  override _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (e?: Error | null, d?: Buffer) => void
  ): void {
    this.hash.update(chunk)
    this.bytes += chunk.length
    cb(null, chunk)
  }
  digest(): string {
    return this.hash.digest('hex')
  }
}

/** gzip output in, envelope out (header, encrypted body, tag). */
export function sealStream(keys: BackupKeys | null): Transform {
  const iv = keys ? randomBytes(IV_LEN) : undefined
  const head = header(!!keys, iv)
  const cipher = keys && iv ? createCipheriv('aes-256-gcm', keys.enc, iv) : undefined
  cipher?.setAAD(head)
  let started = false
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      if (!started) {
        this.push(head)
        started = true
      }
      cb(null, cipher ? cipher.update(chunk) : chunk)
    },
    flush(cb) {
      if (!started) this.push(head)
      if (cipher) {
        this.push(cipher.final())
        this.push(cipher.getAuthTag())
      }
      cb()
    }
  })
}

interface Parsed {
  encrypted: boolean
  head: Buffer
  iv?: Buffer
}

function parseHeader(buf: Buffer): Parsed {
  if (buf.length < BASE_HEADER || !buf.subarray(0, 4).equals(MAGIC))
    throw new DamagedBackupError('Not a backup file')
  if (buf[4] !== VERSION) throw new DamagedBackupError('Made by a newer version of the app')
  const flags = buf[5] ?? 0
  if (!(flags & FLAG_GZIP) || flags & ~(FLAG_GZIP | FLAG_ENC))
    throw new DamagedBackupError('Unknown backup file format')
  const encrypted = (flags & FLAG_ENC) !== 0
  if (!encrypted) return { encrypted, head: buf.subarray(0, BASE_HEADER) }
  if (buf.length < BASE_HEADER + IV_LEN) throw new DamagedBackupError('Backup file cut short')
  return {
    encrypted,
    head: buf.subarray(0, BASE_HEADER + IV_LEN),
    iv: buf.subarray(BASE_HEADER, BASE_HEADER + IV_LEN)
  }
}

/** Is this envelope encrypted? (Reads only the header.) */
export function isSealedEncrypted(buf: Buffer): boolean {
  return parseHeader(buf).encrypted
}

/** Small content (manifests): gzip and seal in memory. */
export function sealBuffer(data: Buffer, keys: BackupKeys | null): Buffer {
  const body = gzipSync(data)
  if (!keys) return Buffer.concat([header(false), body])
  const iv = randomBytes(IV_LEN)
  const head = header(true, iv)
  const c = createCipheriv('aes-256-gcm', keys.enc, iv)
  c.setAAD(head)
  return Buffer.concat([head, c.update(body), c.final(), c.getAuthTag()])
}

export function openBuffer(buf: Buffer, keys: BackupKeys | null): Buffer {
  const p = parseHeader(buf)
  let body = buf.subarray(p.head.length)
  if (p.encrypted) {
    if (!keys) throw new WrongPasswordError()
    if (body.length < TAG_LEN) throw new DamagedBackupError('Backup file cut short')
    const d = createDecipheriv('aes-256-gcm', keys.enc, p.iv as Buffer)
    d.setAAD(p.head)
    d.setAuthTag(body.subarray(body.length - TAG_LEN))
    try {
      body = Buffer.concat([d.update(body.subarray(0, body.length - TAG_LEN)), d.final()])
    } catch {
      throw new DamagedBackupError('A backup file was changed or damaged')
    }
  }
  try {
    return gunzipSync(body)
  } catch {
    throw new DamagedBackupError('A backup file is damaged')
  }
}

/**
 * The streams that turn an object file back into its gzip body (decrypting
 * it if needed). The GCM tag is checked when the last stream ends, so a
 * caller writes to a temp file and keeps it only after the pipeline finished.
 */
export async function openObjectStreams(
  path: string,
  keys: BackupKeys | null
): Promise<[Readable, Transform?]> {
  const fh = await open(path, 'r')
  let parsed: Parsed
  let size: number
  let tag: Buffer | undefined
  try {
    size = (await fh.stat()).size
    const first = Buffer.alloc(Math.min(size, BASE_HEADER + IV_LEN))
    await fh.read(first, 0, first.length, 0)
    parsed = parseHeader(first)
    if (parsed.encrypted) {
      if (!keys) throw new WrongPasswordError()
      if (size < parsed.head.length + TAG_LEN) throw new DamagedBackupError('Backup file cut short')
      tag = Buffer.alloc(TAG_LEN)
      await fh.read(tag, 0, TAG_LEN, size - TAG_LEN)
    }
  } finally {
    await fh.close()
  }
  const start = parsed.head.length
  const end = (parsed.encrypted ? size - TAG_LEN : size) - 1
  if (end < start) throw new DamagedBackupError('Backup file cut short')
  const body = createReadStream(path, { start, end })
  if (!parsed.encrypted || !keys || !tag) return [body]
  const d = createDecipheriv('aes-256-gcm', keys.enc, parsed.iv as Buffer)
  d.setAAD(parsed.head)
  d.setAuthTag(tag)
  return [body, d]
}
