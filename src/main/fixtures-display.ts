// Fixtures mode keeps its sample homes and its app data inside the checkout
// (`.fixtures-data/`), so every path the app shows there would start with the
// real checkout's path, user name included (C:\Users\<you>\<repo>\…). That
// ended up in screenshots. In fixtures mode, what the main process sends to
// the windows (and the phone) shows those paths as the sample PC's instead:
//
//   <checkout>\.fixtures-data\sources\windows\Users\alex  →  C:\Users\alex
//   <checkout>\.fixtures-data\sources\wsl                 →  \\wsl.localhost
//   <checkout>\.fixtures-data\appdata                     →  C:\Users\alex\AppData\Roaming\ClaudeSessionDashboard
//   <checkout>                                            →  C:\Users\alex\code\claude-session-dashboard
//
// Display only: files are still read and written at their real paths, and
// nothing coming back from a window is translated (fixtures mode launches
// nothing). Each path is also matched written with forward slashes, with JSON's
// doubled backslashes, as a WSL /mnt/<drive>/… path, and inside a PowerShell
// -EncodedCommand (the session-alert hooks), as those are shown too.

import { join } from 'node:path'

export interface DisplayRule {
  /** The real path (as the platform writes it). */
  from: string
  /** What is shown instead (a Windows path). */
  to: string
}

export const SAMPLE_HOME = 'C:\\Users\\alex'
export const SAMPLE_DATA_DIR = 'C:\\Users\\alex\\AppData\\Roaming\\ClaudeSessionDashboard'
export const SAMPLE_CHECKOUT = 'C:\\Users\\alex\\code\\claude-session-dashboard'
export const SAMPLE_WSL_ROOT = '\\\\wsl.localhost'

/** The rules for a checkout at `appRoot` (see fixturesLayout in fixtures.ts). */
export function fixturesDisplayRules(appRoot: string): DisplayRule[] {
  const base = join(appRoot, '.fixtures-data')
  return [
    { from: join(base, 'sources', 'windows', 'Users', 'alex'), to: SAMPLE_HOME },
    { from: join(base, 'sources', 'wsl'), to: SAMPLE_WSL_ROOT },
    { from: join(base, 'appdata'), to: SAMPLE_DATA_DIR },
    { from: appRoot, to: SAMPLE_CHECKOUT }
  ]
}

const back = (s: string): string => s.replace(/\//g, '\\')
const fwd = (s: string): string => s.replace(/\\/g, '/')
const doubled = (s: string): string => back(s).replace(/\\/g, '\\\\')
/** C:\a\b → /mnt/c/a/b (undefined for a path without a drive letter). */
function mnt(s: string): string | undefined {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(back(s))
  return m ? `/mnt/${m[1].toLowerCase()}/${fwd(m[2])}`.replace(/\/$/, '') : undefined
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Each way a rule's path can be written, and what it becomes. */
function variants(rule: DisplayRule): [string, string][] {
  const from = rule.from.replace(/[\\/]+$/, '')
  const out: [string, string][] = [
    [back(from), back(rule.to)],
    [fwd(from), fwd(rule.to)],
    [doubled(from), doubled(rule.to)]
  ]
  const m = mnt(from)
  if (m) out.push([m, mnt(rule.to) ?? fwd(rule.to)])
  // A path that starts with `/` (Linux) is written the same in every form.
  return out.filter(([f]) => f.length > 3)
}

const ENCODED = /(-EncodedCommand\s+)([A-Za-z0-9+/]{8,}={0,2})/gi

/** Masks the rules' paths in a string. Longer paths first, case-insensitive. */
export function createPathMasker(rules: readonly DisplayRule[]): (s: string) => string {
  const table = new Map<string, string>()
  for (const r of rules)
    for (const [f, t] of variants(r)) if (!table.has(f.toLowerCase())) table.set(f.toLowerCase(), t)
  const keys = [...table.keys()].sort((a, b) => b.length - a.length)
  if (!keys.length) return (s) => s
  // Not followed by more of a file or folder name (…\appdata2 stays).
  const re = new RegExp(`(?:${keys.map(escapeRe).join('|')})(?![A-Za-z0-9_.-])`, 'gi')
  const plain = (s: string): string => s.replace(re, (m) => table.get(m.toLowerCase()) ?? m)
  return (s) => {
    let out = plain(s)
    if (/-EncodedCommand/i.test(out))
      out = out.replace(ENCODED, (all, flag: string, b64: string) => {
        const text = Buffer.from(b64, 'base64').toString('utf16le')
        const masked = plain(text)
        return masked === text ? all : flag + Buffer.from(masked, 'utf16le').toString('base64')
      })
    return out
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** A copy of `value` with every string masked (arrays and plain objects only; the rest as is). */
export function maskDeep<T>(value: T, mask: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return mask(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object' && isPlainObject(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = walk(x)
      return out
    }
    return v
  }
  return walk(value) as T
}

/** What the main process sends out in fixtures mode: `value` with the checkout's paths masked. */
export function createFixturesDisplay(appRoot: string): <T>(value: T) => T {
  const mask = createPathMasker(fixturesDisplayRules(appRoot))
  return (value) => maskDeep(value, mask)
}
