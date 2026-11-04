// The decoded size of a zstd file (Codex's compressed rollouts and their
// archive copies), streamed with fzstd (pure JS), so a compressed copy can be
// compared by what it holds rather than by its size on disk. A file that
// starts like zstd but isn't complete (cut off mid-copy, damaged) throws.

import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Decompress } from 'fzstd'

/** First bytes of a zstd frame. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Does the file start like zstd? */
export async function hasZstdMagic(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 0)
    return bytesRead === 4 && ZSTD_MAGIC.every((b, i) => buf[i] === b)
  } finally {
    await fh.close()
  }
}

export async function zstdContentSize(path: string): Promise<number> {
  let n = 0
  let frames = 0
  const d = new Decompress((chunk, final) => {
    n += chunk.length
    if (final) frames++
  })
  for await (const c of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const buf = c as Buffer
    d.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  }
  d.push(new Uint8Array(0), true)
  if (!frames) throw new Error(`Not a complete zstd file: ${path}`)
  return n
}

/** What a file holds: decompressed for zstd, else its size. Throws for broken zstd. */
export async function contentSizeOf(path: string): Promise<number> {
  return (await hasZstdMagic(path)) ? zstdContentSize(path) : (await stat(path)).size
}

/** Is this an archive copy kept compressed (`.jsonl.zst`)? */
export function isZstdPath(path: string): boolean {
  return path.toLowerCase().endsWith('.zst')
}
