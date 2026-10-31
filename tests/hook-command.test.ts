// The Windows hook command, really run by Windows PowerShell 5.1 and
// PowerShell 7 (and once through Git Bash, as Claude Code may run it): the
// script's path is data, so no quote in it (ASCII or typographic, which
// PowerShell also treats as quotes), `$`, `;` or parenthesis can end a string
// or run anything. The "injections" below would only create a marker file.

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { windowsHookCommand } from '../src/main/services/hooks'
import { localShell, shellPath } from './helpers'

const SCRIPT = join(__dirname, '..', 'resources', 'bridge', 'csd-hook.ps1')
const isWindows = process.platform === 'win32'

const has = (exe: string): boolean =>
  isWindows &&
  spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0

const SHELLS = [
  { name: 'Windows PowerShell 5.1', exe: 'powershell.exe' },
  { name: 'PowerShell 7', exe: 'pwsh.exe' }
].filter((s) => has(s.exe))

/** Folder names a profile path might hold, and some that try to break out. */
const NAMES = [
  'O’Brien’s “quoted” folder',
  "it's a test",
  'spaces and ünïcødé ñ 日本',
  join('OneDrive - Contoso Ltd', 'Documents'),
  "x'; New-Item -ItemType File -Path pwned-ascii.txt; 'y",
  'x’; New-Item -ItemType File -Path pwned-smart.txt; ‘y',
  'a$(New-Item -ItemType File -Path pwned-sub.txt)b',
  'c`$(New-Item pwned-tick.txt)'
]

let base: string
let cwd: string
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'csd-hookcmd-'))
  cwd = join(base, 'cwd')
  await mkdir(cwd)
})
afterAll(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5 })
})

/** Install the hook script under `home`, run the command the app writes, return the events saved. */
async function runIn(exe: string, home: string, i: number): Promise<string[]> {
  const bin = join(home, '.claude-session-dashboard', 'bin')
  await mkdir(bin, { recursive: true })
  const script = join(bin, 'csd-hook.ps1')
  await copyFile(SCRIPT, script)
  const args = windowsHookCommand(script).split(' ').slice(1)
  const out = join(base, `out-${i}`)
  execFileSync(exe, args, {
    cwd,
    input: JSON.stringify({ session_id: `s-${i}`, hook_event_name: 'Stop' }),
    env: { ...process.env, CSD_BRIDGE_DIR: out },
    windowsHide: true,
    timeout: 60_000
  })
  return readdir(join(out, 'events')).catch(() => [])
}

describe.runIf(isWindows && SHELLS.length > 0)('the Windows hook command, run for real', () => {
  let n = 0
  for (const shell of SHELLS)
    it(`${shell.name}: runs the script from any path, and nothing in the path runs`, async () => {
      for (const name of NAMES) {
        const i = n++
        const events = await runIn(shell.exe, join(base, `h${i}`, name), i)
        expect(events, `${shell.name} with “${name}”`).toEqual([`s-${i}.Stop.json`])
      }
      expect((await readdir(cwd)).filter((f) => f.startsWith('pwned'))).toEqual([])
    }, 180_000)

  const bash = localShell('bash')
  it.runIf(!!bash)(
    'through Git Bash too (Claude Code may run hooks there)',
    async () => {
      const name = "x’; New-Item -ItemType File -Path pwned-bash.txt; 'y $(echo hi)"
      const bin = join(base, 'hb', name, '.claude-session-dashboard', 'bin')
      await mkdir(bin, { recursive: true })
      const script = join(bin, 'csd-hook.ps1')
      await copyFile(SCRIPT, script)
      const out = join(base, 'out-bash')
      execFileSync(bash!, ['-c', windowsHookCommand(script)], {
        cwd,
        input: JSON.stringify({ session_id: 's-bash', hook_event_name: 'Stop' }),
        env: { ...process.env, PATH: shellPath(bash!), CSD_BRIDGE_DIR: out },
        windowsHide: true,
        timeout: 60_000
      })
      expect(await readdir(join(out, 'events'))).toEqual(['s-bash.Stop.json'])
      expect((await readdir(cwd)).filter((f) => f.startsWith('pwned'))).toEqual([])
    },
    60_000
  )
})
