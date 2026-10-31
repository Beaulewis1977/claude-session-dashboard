import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { LaunchTools } from '../src/main/core/launch'

export const FIXTURES = join(__dirname, '..', 'fixtures')

/** Where a launch's programs would be found (spaces included, to test quoting). */
export const TOOLS: LaunchTools = {
  wt: 'C:\\Users\\Beau Lewis\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  cmd: 'C:\\Windows\\System32\\cmd.exe',
  wsl: 'C:\\Windows\\System32\\wsl.exe',
  claude: 'C:\\Users\\Beau Lewis\\.local\\bin\\claude.exe'
}
export const WIN_PROJECTS = join(FIXTURES, 'windows', 'Users', 'beau', '.claude', 'projects')
export const UBUNTU_PROJECTS = join(
  FIXTURES,
  'wsl',
  'Ubuntu',
  'home',
  'beau',
  '.claude',
  'projects'
)

export const SESSIONS = {
  safari: join(
    WIN_PROJECTS,
    'C--Users-beau-code-acme-web',
    '7f3c9a12-4b8e-4d21-9c6a-1e2f3a4b5c6d.jsonl'
  ),
  moment: join(
    WIN_PROJECTS,
    'C--Users-beau-code-acme-web',
    '2b6d8e4f-1a3c-4e5f-8a7b-9c0d1e2f3a4b.jsonl'
  ),
  legacy: join(
    WIN_PROJECTS,
    'C--Users-beau-My-Projects-desktop-app',
    'c41e2d7a-9b0f-4c3e-b5a6-7d8e9f0a1b2c.jsonl'
  ),
  orders: join(
    UBUNTU_PROJECTS,
    '-home-beau-projects-orders-api',
    'e9a1b2c3-d4e5-4f60-8172-839405a6b7c8.jsonl'
  ),
  dotfiles: join(
    UBUNTU_PROJECTS,
    '-home-beau-dotfiles',
    '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a.jsonl'
  )
}

export function read(path: string): string {
  return readFileSync(path, 'utf8')
}

export function line(obj: unknown): string {
  return JSON.stringify(obj)
}

/**
 * A local POSIX shell for the script tests, or undefined (the test is then
 * skipped). On Windows `sh` usually isn't on PATH, and `bash` there is often
 * System32\bash.exe, the WSL launcher, which runs the command inside a distro
 * instead. So Git for Windows' own shell is used; elsewhere, the one on PATH.
 */
export function localShell(name: 'sh' | 'bash'): string | undefined {
  if (process.platform !== 'win32') {
    return spawnSync(name, ['-c', 'true']).status === 0 ? name : undefined
  }
  const roots = [
    process.env.ProgramFiles ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')
  ].filter((r): r is string => !!r)
  const gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH
  const candidates = [
    // usr\bin first: bin\*.exe are wrappers that add MSYSTEM and friends.
    ...(gitBash ? [join(gitBash, '..', '..', 'usr', 'bin', `${name}.exe`)] : []),
    ...roots.flatMap((r) => [
      join(r, 'Git', 'usr', 'bin', `${name}.exe`),
      join(r, 'Git', 'bin', `${name}.exe`)
    ])
  ]
  return candidates.find((c) => existsSync(c))
}

/** PATH for running a script with `shell`: its own folder first (MSYS needs it for cat, mv, env). */
export function shellPath(shell: string): string {
  return process.platform === 'win32'
    ? `${dirname(shell)}${delimiter}${process.env.PATH ?? ''}`
    : (process.env.PATH ?? '')
}
