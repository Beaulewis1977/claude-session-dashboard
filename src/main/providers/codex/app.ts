// "Open in Codex app" (Windows): what the Codex desktop app can open, read
// without changing anything.
//
// Read-only, from the Windows Codex home (`%USERPROFILE%\.codex`, the one the
// app uses):
// - `.codex-global-state.json`: only `local-projects` (id, name, root folders),
//   `project-order` and `thread-project-assignments` are used. The file is the
//   app's own and is never written, copied or archived.
// - `config.toml` (parsed as TOML): only whether `windows.runCodexInWindowsSubsystemForLinux`
//   is on (then the app runs Codex in WSL, which isn't supported here).
// Never auth.json. Whether the app is installed: the `codex:` link handler in
// the registry (`reg query`, read-only).

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { systemExe } from '../../core/which'
import { PROJECT_ID_RE, type CodexAppProject, type CodexAppState } from '@shared/codex-app'

export const APP_STATE_FILE = '.codex-global-state.json'
/** The sessions source of the Codex home the app uses (`%USERPROFILE%.codex`). */
export const CODEX_APP_SOURCE_ID = 'codex-windows'
/** The state file is a few MB; anything far bigger isn't read. */
const MAX_STATE_BYTES = 64 * 1024 * 1024

/** The parts of the app's state file the dashboard uses, or undefined if it doesn't look right. */
export function parseCodexAppState(text: string): CodexAppState | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const o = j as Record<string, unknown>
  const local = o['local-projects']
  if (!local || typeof local !== 'object' || Array.isArray(local)) return undefined
  const all: CodexAppProject[] = []
  for (const [key, v] of Object.entries(local as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const p = v as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id : key
    // The app looks a project up by its key in local-projects.
    if (id !== key || !PROJECT_ID_RE.test(id)) continue
    const roots = Array.isArray(p.rootPaths) ? p.rootPaths : []
    const root = typeof roots[0] === 'string' ? roots[0].trim() : ''
    if (!root) continue
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : root
    all.push({ id, name: name.slice(0, 200), root })
  }
  // Sidebar order first (project-order), then the rest as listed.
  const order = Array.isArray(o['project-order'])
    ? (o['project-order'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const rank = new Map(order.map((id, i) => [id, i]))
  const projects = all
    .map((p, i) => ({ p, r: rank.get(p.id) ?? order.length + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.p)
  const assignments: Record<string, string> = {}
  const asg = o['thread-project-assignments']
  if (asg && typeof asg === 'object' && !Array.isArray(asg))
    for (const [thread, v] of Object.entries(asg as Record<string, unknown>)) {
      const a = v as Record<string, unknown> | null
      if (a && a.projectKind === 'local' && typeof a.projectId === 'string')
        assignments[thread.toLowerCase()] = a.projectId
    }
  return { projects, assignments }
}

/**
 * Is the app set to run Codex in WSL? `windows.runCodexInWindowsSubsystemForLinux`
 * in config.toml, in any TOML form (a table, dotted keys, an inline table).
 * A file that isn't valid TOML gives `{ error }`: the setting is then unknown,
 * never taken as off.
 */
export function wslModeOf(toml: string): { on: boolean } | { error: string } {
  let doc: Record<string, unknown>
  try {
    doc = parseToml(toml) as Record<string, unknown>
  } catch (err) {
    return { error: `config.toml isn't valid TOML: ${(err as Error).message.split('\n')[0]}` }
  }
  const windows = doc.windows
  const v =
    windows && typeof windows === 'object' && !Array.isArray(windows)
      ? (windows as Record<string, unknown>).runCodexInWindowsSubsystemForLinux
      : undefined
  return { on: v === true }
}

export interface CodexAppDeps {
  /** The Codex home the app uses (the Windows `.codex`), undefined off Windows. */
  home(): string | undefined
  /** Windows and not fixtures. */
  supported: boolean
  /** Is the `codex:` link handler registered? */
  protocolRegistered(): Promise<boolean>
  readText?(path: string): Promise<string>
  statFile?(path: string): Promise<{ size: number; mtimeMs: number }>
}

/** `reg query HKCR\codex /v "URL Protocol"`: exit code 0 when the app registered its links. */
export function codexProtocolRegistered(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) =>
    execFile(
      systemExe('reg.exe'),
      ['query', 'HKCR\\codex', '/v', 'URL Protocol'],
      { windowsHide: true, timeout: 8000 },
      (err) => resolve(!err)
    )
  )
}

export interface CodexAppSnapshot {
  installed: boolean
  /** Undefined: config.toml couldn't be read or parsed (see configError). */
  wslMode?: boolean
  configError?: string
  state?: CodexAppState
  stateError?: string
}

export class CodexAppService {
  private registered?: { value: boolean; at: number }
  private cached?: { key: string; state?: CodexAppState; error?: string }

  constructor(private readonly deps: CodexAppDeps) {}

  get supported(): boolean {
    return this.deps.supported
  }

  /** The home's folder, for comparing with a session's source. */
  home(): string | undefined {
    return this.deps.home()
  }

  private async installed(): Promise<boolean> {
    const now = Date.now()
    if (this.registered && now - this.registered.at < 60_000) return this.registered.value
    const value = await this.deps.protocolRegistered().catch(() => false)
    this.registered = { value, at: now }
    return value
  }

  private read(path: string): Promise<string> {
    return (this.deps.readText ?? ((p) => readFile(p, 'utf8')))(path)
  }

  private async stat(path: string): Promise<{ size: number; mtimeMs: number }> {
    if (this.deps.statFile) return this.deps.statFile(path)
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  }

  /**
   * The WSL setting: off when there's no config.toml (Codex's default); unknown,
   * with the reason, when it can't be read or parsed.
   */
  private async wslMode(path: string): Promise<{ wslMode?: boolean; configError?: string }> {
    let text: string
    try {
      text = await this.read(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { wslMode: false }
      return { configError: `couldn't read config.toml: ${(err as Error).message}` }
    }
    const r = wslModeOf(text)
    return 'on' in r ? { wslMode: r.on } : { configError: r.error }
  }

  /** Everything the availability rules need, read now (the state file only when it changed). */
  async snapshot(): Promise<CodexAppSnapshot> {
    const home = this.deps.home()
    if (!this.deps.supported || !home) return { installed: false, wslMode: false }
    if (!(await this.installed())) return { installed: false, wslMode: false }
    const config = await this.wslMode(join(home, 'config.toml'))
    const path = join(home, APP_STATE_FILE)
    let st: { size: number; mtimeMs: number }
    try {
      st = await this.stat(path)
    } catch {
      return { installed: true, ...config, stateError: 'the Codex app has no project list yet' }
    }
    if (st.size > MAX_STATE_BYTES)
      return { installed: true, ...config, stateError: 'its state file is unexpectedly large' }
    const key = `${st.size}:${st.mtimeMs}`
    if (this.cached?.key !== key) {
      let state: CodexAppState | undefined
      let error: string | undefined
      try {
        state = parseCodexAppState(await this.read(path))
        if (!state) error = "its state file isn't in a format this version understands"
      } catch (err) {
        error = (err as Error).message
      }
      this.cached = { key, state, error }
    }
    return {
      installed: true,
      ...config,
      ...(this.cached.state ? { state: this.cached.state } : {}),
      ...(this.cached.error ? { stateError: this.cached.error } : {})
    }
  }
}
