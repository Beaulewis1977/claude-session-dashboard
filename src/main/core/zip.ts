// A small read-only zip reader (stored and deflated entries, zip64 sizes),
// enough for a claude.ai data export. It works on a Buffer the caller read;
// nothing is ever written back to the zip.

import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  /** Offset of the entry's local header. */
  offset: number
}

const EOCD = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EOCD = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
/**
 * Entries bigger than this are refused: a data export's JSON is far smaller,
 * and a JavaScript string (which the JSON is read into) can't be much longer.
 */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Zip entry too large')
  return Number(v)
}

export function listZip(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("This isn't a zip file")
  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  const loc = eocd - 20
  if (loc >= 0 && buf.readUInt32LE(loc) === ZIP64_LOCATOR) {
    const z = u64(buf, loc + 8)
    if (z + 56 <= buf.length && buf.readUInt32LE(z) === ZIP64_EOCD) {
      count = u64(buf, z + 32)
      cdOffset = u64(buf, z + 48)
    }
  }
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new Error('Damaged zip file')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    let compressedSize = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let offset = buf.readUInt32LE(p + 42)
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen)
    const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1')
    // zip64 sizes live in extra field 0x0001, in this order, only for 0xffffffff values.
    let e = p + 46 + nameLen
    const end = e + extraLen
    while (e + 4 <= end) {
      const id = buf.readUInt16LE(e)
      const len = buf.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) {
          size = u64(buf, q)
          q += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(buf, q)
          q += 8
        }
        if (offset === 0xffffffff) offset = u64(buf, q)
      }
      e += 4 + len
    }
    entries.push({ name, method, compressedSize, size, offset })
    p = end + commentLen
  }
  return entries
}

/** An entry's bytes. The sizes the zip declares must match what's really there. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.size > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES)
    throw new Error(`${entry.name} is too large`)
  const p = entry.offset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL) throw new Error('Damaged zip file')
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
  if (start + entry.compressedSize > buf.length) throw new Error('Damaged zip file')
  const data = buf.subarray(start, start + entry.compressedSize)
  let out: Buffer
  if (entry.method === 0) out = Buffer.from(data)
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) })
    } catch {
      throw new Error('Damaged zip file')
    }
  } else throw new Error(`${entry.name} uses an unsupported compression method`)
  if (out.length !== entry.size) throw new Error('Damaged zip file')
  return out
}
