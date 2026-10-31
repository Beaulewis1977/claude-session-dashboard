// Keys for per-project defaults (billing, model and effort), shared by the
// main process, the desktop renderer and the phone.
//
// Windows folders are lower-cased: Windows ignores case in paths. WSL folders
// are "wsl:<distro>:<path>" with the case kept: Linux paths are
// case-sensitive, and each distro has its own files, so /home/me/App and
// /home/me/app, or the same path in two distros, are different projects.
//
// Billing defaults from before this (1.4.0 and older) were keyed by the
// lower-cased folder alone, so a WSL project's key was a bare Linux path.
// migrateLegacyKeys() moves those to the new form once the app knows which
// WSL sessions they matched.

/** Which project a session belongs to: its folder, in its environment. */
export interface ProjectRef {
  env?: 'windows' | 'wsl'
  distro?: string
  cwd?: string
}

const WSL_KEY = /^wsl:([^:]+):(\/.*)$/

/** The key for a session's project, or undefined without a folder (or a WSL session without a distro). */
export function projectDefaultKey(p: ProjectRef | undefined): string | undefined {
  if (!p?.cwd) return undefined
  if (p.env === 'wsl') return p.distro ? `wsl:${p.distro}:${p.cwd}` : undefined
  return p.cwd.toLowerCase()
}

/** A bare Linux path: a WSL project's key from before distros were part of it. */
export function isLegacyWslKey(k: string): boolean {
  return k.startsWith('/')
}

/**
 * A stored key in its current form: WSL keys as they are, Windows folders
 * lower-cased. Legacy bare Linux paths are kept as they are when `keepLegacy`
 * (billing: they wait for migrateLegacyKeys), else undefined.
 */
export function normalizeProjectKey(k: string, keepLegacy = false): string | undefined {
  if (!k || k.length >= 1000) return undefined
  if (k.startsWith('wsl:')) return WSL_KEY.test(k) ? k : undefined
  if (isLegacyWslKey(k)) return keepLegacy ? k : undefined
  return k.toLowerCase()
}

/** "WSL: Ubuntu · /home/me/app", or the Windows folder, for Settings. */
export function projectKeyLabel(k: string): string {
  const m = WSL_KEY.exec(k)
  return m ? `WSL: ${m[1]} · ${m[2]}` : k
}

/**
 * Move legacy bare-Linux-path keys to "wsl:<distro>:<path>" for every known
 * WSL project they matched before (same path, ignoring case, in any distro),
 * so nothing behaves differently. A key already in the new form wins over a
 * legacy one. A legacy key that matches no known session yet (a distro not
 * scanned yet, say) is kept for a later try. Returns the same object when
 * nothing changed.
 */
export function migrateLegacyKeys<T>(
  defaults: Record<string, T>,
  projects: Iterable<ProjectRef>
): Record<string, T> {
  const legacy = Object.keys(defaults).filter(isLegacyWslKey)
  if (!legacy.length) return defaults
  const byLower = new Map<string, Set<string>>()
  for (const p of projects) {
    if (p.env !== 'wsl') continue
    const key = projectDefaultKey(p)
    if (!key || !p.cwd) continue
    const lower = p.cwd.toLowerCase()
    if (!byLower.has(lower)) byLower.set(lower, new Set())
    byLower.get(lower)!.add(key)
  }
  let changed = false
  const next: Record<string, T> = { ...defaults }
  for (const k of legacy) {
    const keys = byLower.get(k.toLowerCase())
    if (!keys) continue
    for (const key of keys) if (!Object.hasOwn(next, key)) next[key] = defaults[k]
    delete next[k]
    changed = true
  }
  return changed ? next : defaults
}

/**
 * A project's default: its own key, else (WSL) a legacy bare-path key that
 * hasn't been migrated yet, matched the way it was before (ignoring case).
 */
export function projectDefault<T>(
  defaults: Record<string, T>,
  p: ProjectRef | undefined
): T | undefined {
  const key = projectDefaultKey(p)
  if (key && Object.hasOwn(defaults, key)) return defaults[key]
  if (p?.env !== 'wsl' || !p.cwd) return undefined
  const lower = p.cwd.toLowerCase()
  const legacy = Object.keys(defaults).find((k) => isLegacyWslKey(k) && k.toLowerCase() === lower)
  return legacy !== undefined ? defaults[legacy] : undefined
}

/**
 * Set (or with `value` undefined, clear) one project's default. Legacy keys
 * are migrated first, so clearing one WSL project's default doesn't leave a
 * legacy key behind that still applies to it, nor remove another distro's.
 */
export function withProjectDefault<T>(
  defaults: Record<string, T>,
  p: ProjectRef,
  value: T | undefined,
  projects: Iterable<ProjectRef>
): Record<string, T> {
  const key = projectDefaultKey(p)
  if (!key) return defaults
  const next = { ...migrateLegacyKeys(defaults, projects) }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}
