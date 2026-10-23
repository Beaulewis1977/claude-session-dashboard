import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
