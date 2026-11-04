// Where Codex keeps its sessions, and the names it gives them.
//
// Each Codex home (`%USERPROFILE%\.codex`, and `~/.codex` of every WSL user)
// has:
//   sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl   (or .jsonl.zst once compressed)
//   archived_sessions/rollout-….jsonl[.zst]            (archived with `codex archive`)
//   session_index.jsonl                                 ({id, thread_name, updated_at} per line)
// Read-only. Only these paths are ever opened: never auth.json, the SQLite
// databases or anything else in the home.

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isInfrastructureDistro, isValidDistroName, parseWslUnc } from '../../core/wsl'
import type { Platform } from '../../platform'
import type { DetectOptions, ResolvedSource } from '../../services/sources'
import type { SessionFile } from '../types'
import { rolloutIdOf } from './parse'

export const SESSIONS_DIR = 'sessions'
export const ARCHIVED_DIR = 'archived_sessions'
export const NAME_INDEX = 'session_index.jsonl'

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

async function canList(p: string): Promise<boolean> {
  try {
    await readdir(p)
    return true
  } catch {
    return false
  }
}

/** The Codex home of a source (its `projectsDir` is the home's `sessions` folder). */
export function codexHomeOf(src: Pick<ResolvedSource, 'projectsDir'>): string {
  return dirname(src.projectsDir)
}

async function homeSource(
  base: Pick<ResolvedSource, 'id' | 'label' | 'env' | 'distro' | 'user' | 'kind'>,
  home: string
): Promise<ResolvedSource> {
  const ok = (await isDir(join(home, SESSIONS_DIR))) || (await isDir(join(home, ARCHIVED_DIR)))
  return {
    ...base,
    provider: 'codex',
    projectsDir: join(home, SESSIONS_DIR),
    status: ok ? 'ok' : 'missing',
    statusMessage: ok ? undefined : 'No Codex sessions found here yet',
    sessionCount: 0
  }
}

/**
 * Is this folder a Codex home, by what's in it (any name: a custom CODEX_HOME
 * such as `~/.codex2`)? A `sessions` folder alone isn't enough (Claude Code's
 * `~/.claude` has one too): also Codex's name index, its config, an
 * `archived_sessions` folder, or the `sessions/YYYY` folders rollouts go in.
 */
async function isCodexHome(folder: string): Promise<boolean> {
  if (basename(folder).toLowerCase() === '.claude') return false
  const sessions = await isDir(join(folder, SESSIONS_DIR))
  if (await isDir(join(folder, ARCHIVED_DIR))) return true
  if (!sessions) return false
  if ((await isFile(join(folder, NAME_INDEX))) || (await isFile(join(folder, 'config.toml'))))
    return true
  const years = await readdir(join(folder, SESSIONS_DIR)).catch(() => [] as string[])
  return years.some((n) => /^\d{4}$/.test(n))
}

/** A user-added folder: a Codex home (by name or contents), its sessions folder, or a folder with a `.codex` home in it. */
export async function codexHomeIn(folder: string): Promise<string | undefined> {
  if (basename(folder).toLowerCase() === SESSIONS_DIR && (await isDir(folder))) {
    const home = dirname(folder)
    if (await isDir(join(home, SESSIONS_DIR))) return home
  }
  if (basename(folder).toLowerCase() === '.codex' && (await isDir(folder))) return folder
  if (await isCodexHome(folder)) return folder
  if (await isDir(join(folder, '.codex', SESSIONS_DIR))) return join(folder, '.codex')
  return undefined
}

export function codexCustomSourceId(folder: string): string {
  return `codex-custom-${createHash('sha1').update(folder.toLowerCase()).digest('hex').slice(0, 8)}`
}

/** Every Codex home: Windows, every WSL user (and root), and Codex folders added in Settings. */
export async function detectCodexSources(
  platform: Platform,
  opts: DetectOptions
): Promise<ResolvedSource[]> {
  const sources: ResolvedSource[] = []
  sources.push(
    await homeSource(
      { id: 'codex-windows', label: 'Windows', env: 'windows', kind: 'auto' },
      join(platform.windowsHome, '.codex')
    )
  )

  const distros = await platform.listDistros()
  if (distros) {
    const running = await platform.listRunningDistros()
    for (const distro of distros) {
      if (isInfrastructureDistro(distro) || !isValidDistroName(distro)) continue
      const label = `WSL: ${distro}`
      const placeholder = (
        status: ResolvedSource['status'],
        statusMessage: string,
        distroRoot?: string
      ): ResolvedSource => ({
        id: `codex-wsl-${distro}`,
        provider: 'codex',
        label,
        env: 'wsl',
        distro,
        kind: 'auto',
        projectsDir: join(platform.distroRoots(distro)[0], '.codex-unavailable'),
        status,
        statusMessage,
        sessionCount: 0,
        ...(distroRoot ? { distroRoot } : {})
      })
      if (running && !running.includes(distro) && !opts.scanStoppedDistros) {
        sources.push(
          placeholder(
            'not-running',
            `${distro} isn't running. Start it (or enable "Scan stopped distros") to include its Codex sessions.`
          )
        )
        continue
      }
      let root: string | undefined
      for (const candidate of platform.distroRoots(distro)) {
        if (await canList(join(candidate, 'home'))) {
          root = candidate
          break
        }
      }
      if (!root) {
        sources.push(placeholder('unreadable', `Couldn't read ${distro}'s file system.`))
        continue
      }
      const homes: { user: string; dir: string }[] = []
      try {
        for (const e of await readdir(join(root, 'home'), { withFileTypes: true }))
          if (e.isDirectory()) homes.push({ user: e.name, dir: join(root, 'home', e.name) })
      } catch {
        // handled by the empty list below
      }
      if (await canList(join(root, 'root'))) homes.push({ user: 'root', dir: join(root, 'root') })
      let found = 0
      for (const h of homes) {
        if (!(await isDir(join(h.dir, '.codex')))) continue
        found++
        const src = await homeSource(
          {
            id: `codex-wsl-${distro}-${h.user}`,
            label,
            env: 'wsl',
            distro,
            user: h.user,
            kind: 'auto'
          },
          join(h.dir, '.codex')
        )
        sources.push({ ...src, distroRoot: root })
      }
      if (!found) sources.push(placeholder('missing', `No Codex data found in ${distro}.`, root))
    }
  }

  for (const folder of opts.extraFolders) {
    const home = await codexHomeIn(folder)
    if (!home) continue
    const wsl = parseWslUnc(folder)
    const src = await homeSource(
      {
        id: codexCustomSourceId(folder),
        label: wsl ? `WSL: ${wsl.distro}` : 'Windows',
        env: wsl ? 'wsl' : 'windows',
        distro: wsl?.distro,
        kind: 'custom'
      },
      home
    )
    sources.push({ ...src, ...(wsl ? { distroRoot: wsl.root } : {}) })
  }
  return sources
}

/** A rollout file's session and folder, or undefined if the path isn't one. */
export function codexSessionFileOf(
  path: string
): { sessionId: string; projectDir: string } | undefined {
  const id = rolloutIdOf(basename(path))
  if (!id) return undefined
  return { sessionId: id, projectDir: basename(dirname(path)) }
}

/**
 * The rollouts of a home: `sessions/YYYY/MM/DD/` and `archived_sessions/`.
 * When one session has two files (Codex is compressing it right now, or it
 * was archived while the app looked), the newer one counts.
 */
export async function listCodexFiles(home: string): Promise<SessionFile[] | undefined> {
  const byId = new Map<string, SessionFile>()
  let readable = false
  const walk = async (dir: string, depth: number, label: (d: string) => string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    readable = true
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth > 0) await walk(p, depth - 1, label)
        continue
      }
      if (!e.isFile()) continue
      const sessionId = rolloutIdOf(e.name)
      if (!sessionId) continue
      try {
        const st = await stat(p)
        const f: SessionFile = {
          path: p,
          projectDir: label(dir),
          sessionId,
          size: st.size,
          mtimeMs: st.mtimeMs
        }
        const prev = byId.get(sessionId)
        if (!prev || f.mtimeMs > prev.mtimeMs) byId.set(sessionId, f)
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  await walk(join(home, SESSIONS_DIR), 3, (d) => basename(d))
  await walk(join(home, ARCHIVED_DIR), 0, () => ARCHIVED_DIR)
  return readable ? [...byId.values()] : undefined
}

// ------------------------------------------------------------- thread names

export interface CodexName {
  name: string
  at?: string
}

/**
 * `session_index.jsonl`: one `{id, thread_name, updated_at}` per line, added
 * whenever a thread is named or renamed. Per id the newest line wins (by
 * `updated_at`, else the later line); an empty name means it was cleared.
 */
export function parseNameIndex(text: string): Map<string, CodexName> {
  const latest = new Map<string, { name: string; at?: string; t: number }>()
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    let o: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(s)
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      o = v as Record<string, unknown>
    } catch {
      continue
    }
    const id = typeof o.id === 'string' ? o.id.toLowerCase() : undefined
    if (!id) continue
    const name = typeof o.thread_name === 'string' ? o.thread_name.trim() : ''
    const at = typeof o.updated_at === 'string' ? o.updated_at : undefined
    const t = at ? Date.parse(at) : NaN
    const prev = latest.get(id)
    const tt = Number.isFinite(t) ? t : -Infinity
    if (prev && tt < prev.t) continue
    latest.set(id, { name, at, t: tt })
  }
  const out = new Map<string, CodexName>()
  for (const [id, v] of latest) if (v.name) out.set(id, { name: v.name.slice(0, 300), at: v.at })
  return out
}

/** Thread names per source, re-read only when the index file changes. */
export class CodexNames {
  private bySource = new Map<string, { stamp: string; names: Map<string, CodexName> }>()

  get(sourceId: string, sessionId: string): CodexName | undefined {
    return this.bySource.get(sourceId)?.names.get(sessionId.toLowerCase())
  }

  /** Re-read a home's index if it changed. Returns the ids whose name changed. */
  async refresh(sourceId: string, home: string): Promise<string[]> {
    const path = join(home, NAME_INDEX)
    let stamp = 'none'
    try {
      const st = await stat(path)
      stamp = `${st.size}|${st.mtimeMs}`
    } catch {
      // no index (yet)
    }
    const prev = this.bySource.get(sourceId)
    if (prev?.stamp === stamp) return []
    let names = new Map<string, CodexName>()
    if (stamp !== 'none') {
      try {
        names = parseNameIndex(await readFile(path, 'utf8'))
      } catch {
        return []
      }
    }
    this.bySource.set(sourceId, { stamp, names })
    const before = prev?.names ?? new Map<string, CodexName>()
    const changed: string[] = []
    // The time counts too: the same name given again in Codex is newer than a name
    // given in the dashboard since, so it wins again (newest wins).
    for (const id of new Set([...before.keys(), ...names.keys()])) {
      const a = before.get(id)
      const b = names.get(id)
      if (a?.name !== b?.name || a?.at !== b?.at) changed.push(id)
    }
    return changed
  }
}
