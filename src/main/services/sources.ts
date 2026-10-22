// Detecting where Claude Code sessions live: the Windows home, every WSL
// distro (each user under /home plus /root) and extra folders from Settings.

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SourceInfo } from '@shared/types'
import { isInfrastructureDistro, isValidDistroName, parseWslUnc } from '../core/wsl'
import type { Platform } from '../platform'

export interface ResolvedSource extends SourceInfo {
  /** Host path of the distro root that worked (WSL only). */
  distroRoot?: string
}

export interface DetectOptions {
  extraFolders: string[]
  scanStoppedDistros: boolean
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
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

/** `cleanupPeriodDays` from Claude's settings. null = not set, undefined = unreadable. */
export async function readCleanupPeriodDays(
  settingsPath: string
): Promise<number | null | undefined> {
  try {
    const json: unknown = JSON.parse(await readFile(settingsPath, 'utf8'))
    const v = (json as Record<string, unknown>)?.cleanupPeriodDays
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
}

async function homeSource(
  base: Omit<ResolvedSource, 'status' | 'sessionCount' | 'projectsDir' | 'claudeSettingsPath'>,
  claudeDir: string
): Promise<ResolvedSource> {
  const projectsDir = join(claudeDir, 'projects')
  const settingsPath = join(claudeDir, 'settings.json')
  const ok = await isDir(projectsDir)
  return {
    ...base,
    projectsDir,
    claudeSettingsPath: settingsPath,
    cleanupPeriodDays: ok ? await readCleanupPeriodDays(settingsPath) : undefined,
    status: ok ? 'ok' : 'missing',
    statusMessage: ok ? undefined : 'No Claude Code sessions found here yet',
    sessionCount: 0
  }
}

export function customSourceId(folder: string): string {
  return `custom-${createHash('sha1').update(folder.toLowerCase()).digest('hex').slice(0, 8)}`
}

/** Resolve a user-added folder to a `projects` directory. */
async function resolveCustomFolder(folder: string): Promise<string> {
  if (basename(folder).toLowerCase() === 'projects') return folder
  if (await isDir(join(folder, 'projects'))) return join(folder, 'projects')
  if (await isDir(join(folder, '.claude', 'projects'))) return join(folder, '.claude', 'projects')
  return folder
}

export async function detectSources(
  platform: Platform,
  opts: DetectOptions
): Promise<ResolvedSource[]> {
  const sources: ResolvedSource[] = []

  // Windows
  sources.push(
    await homeSource(
      { id: 'windows', label: 'Windows', env: 'windows', kind: 'auto' },
      join(platform.windowsHome, '.claude')
    )
  )

  // WSL
  const distros = await platform.listDistros()
  if (distros) {
    const running = await platform.listRunningDistros()
    for (const distro of distros) {
      if (isInfrastructureDistro(distro) || !isValidDistroName(distro)) continue
      const label = `WSL: ${distro}`
      const placeholder = (
        status: ResolvedSource['status'],
        statusMessage: string
      ): ResolvedSource => ({
        id: `wsl-${distro}`,
        label,
        env: 'wsl',
        distro,
        kind: 'auto',
        projectsDir: platform.distroRoots(distro)[0],
        status,
        statusMessage,
        sessionCount: 0
      })
      if (running && !running.includes(distro) && !opts.scanStoppedDistros) {
        sources.push(
          placeholder(
            'not-running',
            `${distro} isn't running. Start it (or enable "Scan stopped distros") to include its sessions.`
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
        for (const e of await readdir(join(root, 'home'), { withFileTypes: true })) {
          if (e.isDirectory()) homes.push({ user: e.name, dir: join(root, 'home', e.name) })
        }
      } catch {
        // handled by the empty list below
      }
      if (await canList(join(root, 'root'))) homes.push({ user: 'root', dir: join(root, 'root') })
      let found = 0
      for (const h of homes) {
        if (!(await isDir(join(h.dir, '.claude')))) continue
        found++
        const src = await homeSource(
          { id: `wsl-${distro}-${h.user}`, label, env: 'wsl', distro, user: h.user, kind: 'auto' },
          join(h.dir, '.claude')
        )
        sources.push({ ...src, distroRoot: root })
      }
      if (!found)
        sources.push({
          ...placeholder('missing', `No Claude Code data found in ${distro}.`),
          distroRoot: root
        })
    }
  }

  // Extra folders
  for (const folder of opts.extraFolders) {
    const wsl = parseWslUnc(folder)
    const projectsDir = await resolveCustomFolder(folder)
    const ok = await canList(projectsDir)
    sources.push({
      id: customSourceId(folder),
      label: wsl ? `WSL: ${wsl.distro}` : 'Windows',
      env: wsl ? 'wsl' : 'windows',
      distro: wsl?.distro,
      distroRoot: wsl?.root,
      kind: 'custom',
      projectsDir,
      status: ok ? 'ok' : 'unreadable',
      statusMessage: ok ? undefined : "Folder can't be read",
      sessionCount: 0
    })
  }
  return sources
}
