// Which URLs are the app's own pages. The windows only ever show the bundled
// renderer (or the dev server in development); IPC calls and navigation from
// anything else are refused.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function parse(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/** Same scheme family (http/ws), host and port as the dev server. Never a prefix match. */
export function isDevServerUrl(url: string, devUrl: string | undefined): boolean {
  const u = parse(url)
  const dev = devUrl ? parse(devUrl) : undefined
  if (!u || !dev || u.username || u.password) return false
  const web = (p: string): string => (p === 'ws:' ? 'http:' : p === 'wss:' ? 'https:' : p)
  return web(u.protocol) === dev.protocol && u.host === dev.host
}

/** The app's page: the bundled index.html (any #hash), or the dev server. */
export function isAppPage(url: string, indexFile: string, devUrl: string | undefined): boolean {
  if (devUrl) return isDevServerUrl(url, devUrl) && !/^wss?:/.test(url)
  const u = parse(url)
  if (!u || u.protocol !== 'file:' || u.host) return false
  let path: string
  try {
    path = fileURLToPath(u)
  } catch {
    return false
  }
  const norm = (p: string): string => resolve(p).toLowerCase()
  return norm(path) === norm(indexFile)
}
