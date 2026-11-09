// "Open in Codex app": the links the Codex desktop app (Windows) handles, and
// which project a session lands in. Pure functions, shared by the main process
// (which decides and opens) and the renderer (which shows the choice).
//
// What the app accepts (its own deep-link parser, Codex desktop 26.1103):
// - `codex://threads/<uuid>`: opens that thread, in its own project.
// - `codex://threads/new?projectId=<id>&prompt=<text>`: a new thread in that
//   project with the prompt typed into the box, NOT sent (the user presses Enter).
//   An unknown projectId creates nothing but opens the currently selected
//   project instead, so the id is always checked against the app's list first.
// - There's no fork link: Fork is only in the app's own menu.
// - `?path=<folder>` is never used: for a folder that isn't a project yet the
//   app creates a new project, which would change the app's own data.
//
// Projects are matched by their first root folder, the way the app compares
// them (exact root, after normalizing): Windows folders ignore case, slash
// direction and a trailing slash; `\\wsl$\<distro>\…` and
// `\\wsl.localhost\<distro>\…` are the same folder (the distro name ignores
// case, the Linux path keeps it).

import { normalizeProjectKey } from './project-key'

/** Where to open a Codex session: a terminal (the CLI) or the Codex desktop app. */
export type OpenIn = 'terminal' | 'codex-app'

export function isOpenIn(v: unknown): v is OpenIn {
  return v === 'terminal' || v === 'codex-app'
}

/** What is being opened. */
export type CodexAppKind = 'resume' | 'fork' | 'continue'

/** A project in the Codex app (its `local-projects`). */
export interface CodexAppProject {
  id: string
  name: string
  /** The project's first root folder: where a new thread runs. */
  root: string
}

/** What the dashboard reads (read-only) from the Codex app's state file. */
export interface CodexAppState {
  /** In the app's sidebar order. */
  projects: CodexAppProject[]
  /** thread id → project id (`thread-project-assignments`, local projects only). */
  assignments: Record<string, string>
}

/** A Codex app project id: `local-<hex>` or a UUID (anything else is refused). */
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The longest link the dashboard opens. Windows passes the link to the app on
 * its command line (32767 characters at most; a longer link fails to open,
 * checked with Codex desktop 26.1103: 32000 arrived whole, 33000 was refused).
 */
export const MAX_APP_LINK = 16_000

export const FORK_IN_APP_NOTE = "Use Fork in the Codex app's menu."

/**
 * A folder in one comparable form, or undefined when it isn't an absolute path:
 * - `win:c:\x\y` (lower-cased, backslashes, no trailing slash but the drive's);
 * - `wsl:<distro>:/x/y` (distro lower-cased, path as it is; `*` = any distro);
 * - `unc:\\server\share\x` (lower-cased).
 * A Linux path needs `distro` (a WSL session's), else it matches any distro.
 * `/mnt/<drive>/…` is taken as that Windows drive (WSL's default mounts).
 */
export function canonicalFolder(path: string, distro?: string): string | undefined {
  const p = path.trim()
  if (!p) return undefined
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p)
  if (drive) return `win:${drive[1].toLowerCase()}:\\${winRest(drive[2] ?? '')}`
  const wsl = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(p)
  if (wsl) return `wsl:${wsl[1].toLowerCase()}:${linuxPath(wsl[2] ?? '')}`
  if (/^[\\/]{2}[^\\/]/.test(p)) {
    const rest = winRest(p.replace(/^[\\/]{2}/, ''))
    return rest ? `unc:\\\\${rest}` : undefined
  }
  if (p.startsWith('/')) {
    const mnt = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(p)
    if (mnt) return `win:${mnt[1].toLowerCase()}:\\${winRest(mnt[2] ?? '')}`
    return `wsl:${distro ? distro.toLowerCase() : '*'}:${linuxPath(p)}`
  }
  return undefined
}

function winRest(rest: string): string {
  return rest
    .split(/[\\/]+/)
    .filter((x) => x && x !== '.')
    .join('\\')
    .toLowerCase()
}

function linuxPath(rest: string): string {
  const parts = rest.split(/[\\/]+/).filter((x) => x && x !== '.')
  return '/' + parts.join('/')
}

/** Same folder? (`wsl:*:` matches the same path in any distro.) */
function sameFolder(a: string, b: string): boolean {
  if (a === b) return true
  const wa = /^wsl:([^:]+):(.*)$/.exec(a)
  const wb = /^wsl:([^:]+):(.*)$/.exec(b)
  return !!wa && !!wb && wa[2] === wb[2] && (wa[1] === '*' || wb[1] === '*')
}

/** Is `inner` strictly inside `outer`? */
function insideFolder(inner: string, outer: string): boolean {
  const wi = /^wsl:([^:]+):(.*)$/.exec(inner)
  const wo = /^wsl:([^:]+):(.*)$/.exec(outer)
  if (wi && wo) {
    if (wi[1] !== wo[1] && wi[1] !== '*' && wo[1] !== '*') return false
    return wo[2] === '/' ? wi[2] !== '/' : wi[2].startsWith(wo[2] + '/')
  }
  if (wi || wo) return false
  const sep = outer.endsWith('\\') ? outer : outer + '\\'
  return inner.length > sep.length && inner.startsWith(sep)
}

export type ProjectMatch =
  /** The app itself put this thread in the project. */
  | { kind: 'assigned'; project: CodexAppProject }
  /** The session's folder is the project's root. */
  | { kind: 'exact'; project: CodexAppProject }
  /** The folder is inside the project's root: only with an explicit opt-in. */
  | { kind: 'inside'; project: CodexAppProject }
  | { kind: 'none'; reason?: string }

/**
 * Which Codex app project a session belongs to: the one the app assigned its
 * thread to, else the project whose root is the session's folder, else (to
 * offer, never used without asking) the closest project whose root holds it.
 */
export function matchProject(
  state: CodexAppState,
  session: { sessionId: string; cwd?: string; distro?: string; env?: 'windows' | 'wsl' }
): ProjectMatch {
  const assigned = state.assignments[session.sessionId.toLowerCase()]
  const byId = assigned ? state.projects.find((p) => p.id === assigned) : undefined
  if (byId) return { kind: 'assigned', project: byId }
  if (!session.cwd) return { kind: 'none', reason: 'No working folder is recorded.' }
  const target = canonicalFolder(session.cwd, session.env === 'wsl' ? session.distro : undefined)
  if (!target) return { kind: 'none' }
  const roots = state.projects
    .map((project) => ({ project, root: canonicalFolder(project.root) }))
    .filter((r): r is { project: CodexAppProject; root: string } => !!r.root)
  const exact = roots.filter((r) => sameFolder(target, r.root))
  // A Linux folder with no known distro: only when every match is one distro's.
  if (exact.length && distinctDistros(exact.map((r) => r.root)) > 1)
    return { kind: 'none', reason: 'This folder matches Codex projects in more than one distro.' }
  if (exact.length) return { kind: 'exact', project: exact[0].project }
  const inside = roots
    .filter((r) => insideFolder(target, r.root))
    .sort((a, b) => b.root.length - a.root.length)
  if (inside.length && distinctDistros(inside.map((r) => r.root)) > 1)
    return { kind: 'none', reason: 'This folder matches Codex projects in more than one distro.' }
  if (inside.length) return { kind: 'inside', project: inside[0].project }
  return { kind: 'none' }
}

function distinctDistros(roots: string[]): number {
  return new Set(roots.map((r) => /^wsl:([^:]+):/.exec(r)?.[1] ?? '')).size
}

/** `codex://threads/<uuid>`: open an existing thread. */
export function threadLink(sessionId: string): string {
  if (!UUID_RE.test(sessionId)) throw new Error(`Not a Codex thread id: ${sessionId}`)
  return `codex://threads/${sessionId.toLowerCase()}`
}

/**
 * `codex://threads/new?projectId=…&prompt=…`: a new thread in that project with
 * the prompt typed in (not sent). Never `path`.
 */
export function newThreadLink(projectId: string, prompt: string): string {
  if (!PROJECT_ID_RE.test(projectId)) throw new Error(`Not a Codex project id: ${projectId}`)
  // eslint-disable-next-line no-control-regex
  if (!prompt.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt))
    throw new Error("This prompt can't be passed to the Codex app.")
  const link = `codex://threads/new?projectId=${encodeURIComponent(projectId)}&prompt=${encodeURIComponent(prompt)}`
  if (link.length > MAX_APP_LINK) throw new Error('The link for the Codex app would be too long.')
  return link
}

/** Only the two link shapes above (checked again right before opening). */
export function isSafeAppLink(link: string): boolean {
  if (link.length > MAX_APP_LINK) return false
  if (/^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(link)) return UUID_RE.test(link.slice(16))
  const m = /^codex:\/\/threads\/new\?projectId=([A-Za-z0-9_-]{1,128})&prompt=([^&#\s]+)$/.exec(
    link
  )
  return !!m
}

/** What the Codex app can do for one session and kind, and why not. */
export interface CodexAppPreview {
  /** Can be opened in the app now (an `inside` match also needs the opt-in). */
  available: boolean
  /** Why it isn't offered, or what's missing (shown under the choice). */
  reason?: string
  /** Hide the choice entirely (no Codex app here, not Windows): no note either. */
  hidden?: boolean
  /** Continue fresh: the project the new thread opens in. */
  project?: { id: string; name: string; root: string }
  /** Continue fresh: the folder is inside this project; used only when opted in. */
  inside?: { id: string; name: string; root: string }
  /** Shown after opening (Fork). */
  note?: string
}

/** What the decision needs to know (gathered by the main process). */
export interface CodexAppFacts {
  /** Windows, not fixtures, and the `codex:` link handler is registered. */
  installed: boolean
  /** Not Windows (or fixtures): nothing to offer. */
  unsupportedPlatform?: boolean
  /** config.toml `[windows] runCodexInWindowsSubsystemForLinux = true`. */
  wslMode?: boolean
  /** The app's state file, or why it couldn't be read. */
  state?: CodexAppState
  stateError?: string
  /** The session's home is the one the app uses (the Windows `.codex`). */
  appHome: boolean
  /** Its sessions folder label, for the reason ("WSL: Ubuntu"). */
  sourceLabel: string
  /** The session's rollout file is still there. */
  fileExists: boolean
}

/** Can this session open in the Codex app for this kind? (The availability rules.) */
export function codexAppPreview(
  kind: CodexAppKind,
  session: { sessionId: string; cwd?: string; distro?: string; env?: 'windows' | 'wsl' },
  f: CodexAppFacts,
  insideOptIn = false
): CodexAppPreview {
  if (f.unsupportedPlatform)
    return { available: false, hidden: true, reason: 'The Codex app opens on Windows only.' }
  if (!f.installed)
    return { available: false, hidden: true, reason: "The Codex app isn't installed." }
  if (f.wslMode)
    return {
      available: false,
      reason:
        "The Codex app is set to run Codex in WSL. Opening sessions in it from here isn't supported in that mode."
    }
  if (!f.state)
    return {
      available: false,
      reason: `Couldn't read the Codex app's projects${f.stateError ? `: ${f.stateError}` : '.'}`
    }
  if (kind === 'resume' || kind === 'fork') {
    if (!UUID_RE.test(session.sessionId))
      return { available: false, reason: "This session's id isn't a Codex thread id." }
    if (!f.appHome)
      return {
        available: false,
        reason: `The Codex app opens sessions from the Windows .codex folder only. This one is in ${f.sourceLabel}.`
      }
    if (!f.fileExists)
      return {
        available: false,
        reason:
          "This session's file is no longer in Codex's sessions folder, so the Codex app can't open it."
      }
    return { available: true, ...(kind === 'fork' ? { note: FORK_IN_APP_NOTE } : {}) }
  }
  const m = matchProject(f.state, session)
  if (m.kind === 'assigned' || m.kind === 'exact')
    return { available: true, project: { ...m.project } }
  if (m.kind === 'inside') {
    const inside = { ...m.project }
    return insideOptIn
      ? { available: true, project: inside, inside }
      : {
          available: false,
          inside,
          reason: `This folder is inside the Codex project ${m.project.name}.`
        }
  }
  return {
    available: false,
    reason: m.reason
      ? `This folder isn't a project in the Codex app. ${m.reason}`
      : "This folder isn't a project in the Codex app. Add it there first, or open it in a terminal."
  }
}

/**
 * Where to open: the session's own choice, else its project's, else the global
 * default, else the terminal. A choice the app can't do now falls back to the terminal.
 */
export function resolveOpenIn(
  sessionChoice: OpenIn | undefined,
  projectChoice: OpenIn | undefined,
  globalChoice: OpenIn | undefined
): { value: OpenIn; from: 'session' | 'project' | 'global' | 'default' } {
  if (sessionChoice) return { value: sessionChoice, from: 'session' }
  if (projectChoice) return { value: projectChoice, from: 'project' }
  if (globalChoice) return { value: globalChoice, from: 'global' }
  return { value: 'terminal', from: 'default' }
}

/** Per-project "Open in" defaults from a settings file or patch: known values and valid keys only. */
export function sanitizeProjectOpenIn(v: unknown): Record<string, OpenIn> {
  const out: Record<string, OpenIn> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, raw] of Object.entries(v).slice(0, 500)) {
    const key = normalizeProjectKey(k)
    if (key && isOpenIn(raw)) out[key] = raw
  }
  return out
}
