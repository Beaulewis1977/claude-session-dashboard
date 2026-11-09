// Where a session's git lives: which git runs (Windows, or a WSL distro's
// own) and in which folder.
// - A Windows folder: Windows git.
// - A WSL folder (`/home/…`, or `\\wsl.localhost\<distro>\…`): that distro's
//   git through wsl.exe, as the home's user.
// - A Linux path on a Windows drive (`/mnt/c/…`): mapped by the distro itself
//   (`wslpath -w`, so its own automount root counts), then Windows git, which
//   reads it much faster than WSL over its drive mount.
// A stopped distro is never started for this (unless Settings scans stopped
// distros anyway).

import type { Platform } from '../platform'
import { isWindowsPath, parseWslUnc } from '../core/wsl'
import type { GitInput } from '../services/sessions'
import type { GitEnv } from './runner'

export type Placement =
  | { ok: true; env: GitEnv; dir: string }
  | { ok: false; status: 'no-folder' | 'distro-stopped' | 'error'; message: string }

export interface PlaceContext {
  platform: Pick<Platform, 'wslWindowsPath'>
  /** Running distros (undefined: unknown). */
  running?: string[]
  defaultDistro?: string
  scanStopped: boolean
}

export function placeKey(s: Pick<GitInput, 'env' | 'distro' | 'cwd' | 'sourceUser'>): string {
  return `${s.env}|${s.distro ?? ''}|${s.sourceUser ?? ''}|${s.cwd ?? ''}`
}

function isRunning(distro: string, ctx: PlaceContext): boolean {
  if (ctx.scanStopped || !ctx.running) return true
  return ctx.running.some((d) => d.toLowerCase() === distro.toLowerCase())
}

export async function placeSession(
  s: Pick<GitInput, 'env' | 'distro' | 'cwd' | 'sourceUser'>,
  ctx: PlaceContext
): Promise<Placement> {
  const cwd = s.cwd
  if (!cwd) return { ok: false, status: 'no-folder', message: "The session doesn't record its folder." }
  const unc = parseWslUnc(cwd)
  if (unc) {
    if (!isRunning(unc.distro, ctx))
      return { ok: false, status: 'distro-stopped', message: `${unc.distro} isn't running.` }
    const user = s.env === 'wsl' && s.distro === unc.distro ? s.sourceUser : undefined
    return { ok: true, env: { kind: 'wsl', distro: unc.distro, ...(user ? { user } : {}) }, dir: unc.linuxPath }
  }
  if (isWindowsPath(cwd)) return { ok: true, env: { kind: 'windows' }, dir: cwd }
  if (!cwd.startsWith('/'))
    return { ok: false, status: 'error', message: "The session's folder isn't a full path." }
  const distro = s.env === 'wsl' ? s.distro : ctx.defaultDistro
  if (!distro) return { ok: false, status: 'error', message: 'No WSL distro to look in.' }
  if (!isRunning(distro, ctx))
    return { ok: false, status: 'distro-stopped', message: `${distro} isn't running, so its git isn't asked.` }
  if (/^\/mnt\/[a-zA-Z](?:\/|$)/.test(cwd)) {
    const win = await ctx.platform.wslWindowsPath?.(distro, cwd)
    if (win && /^[A-Za-z]:\\/.test(win)) return { ok: true, env: { kind: 'windows' }, dir: win }
  }
  const user = s.env === 'wsl' ? s.sourceUser : undefined
  return { ok: true, env: { kind: 'wsl', distro, ...(user ? { user } : {}) }, dir: cwd }
}
