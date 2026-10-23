// The files a phone can load: the built mobile page, its hashed assets, the
// PWA manifest and service worker, and app icons. Nothing outside the build
// folder, and only names on this allow-list.

import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { WebAssets } from './server'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}

const ALLOWED = [
  /^\/mobile\.html$/,
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/assets\/[A-Za-z0-9._-]+\.(js|css|woff2?|ttf|svg|png)$/
]

/** /icons/icon-192.png → 192 (sizes the manifest asks for). */
const ICON_RE = /^\/icons\/(icon|maskable|apple-touch-icon)-?(\d+)?\.png$/
const ICON_SIZES = new Set([180, 192, 512])

export function webAssets(
  dir: string,
  icon: (size: number, maskable: boolean) => Buffer | undefined
): WebAssets {
  const root = resolve(dir)
  return {
    async file(path) {
      const m = path.match(ICON_RE)
      if (m) {
        const size = m[1] === 'apple-touch-icon' ? 180 : Number(m[2])
        if (!ICON_SIZES.has(size)) return undefined
        const body = icon(size, m[1] === 'maskable')
        return body ? { body, type: 'image/png' } : undefined
      }
      if (!ALLOWED.some((re) => re.test(path)) || path.includes('..')) return undefined
      const full = resolve(join(root, path))
      if (!full.startsWith(root + sep)) return undefined
      try {
        const body = await readFile(full)
        const ext = path.slice(path.lastIndexOf('.'))
        return {
          body,
          type: TYPES[ext] ?? 'application/octet-stream',
          immutable: path.startsWith('/assets/')
        }
      } catch {
        return undefined
      }
    }
  }
}
