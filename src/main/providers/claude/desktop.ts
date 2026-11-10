// The Claude desktop app's local sessions, read only.
//
// - Code tab: its sessions are ordinary Claude Code transcripts in
//   `~/.claude/projects` (the Windows source). The desktop app keeps its own
//   list of them in `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_<id>.json`,
//   whose `cliSessionId` names the transcript. Only that one field of those
//   files is read, to label the sessions "Claude desktop" (the desktop app can
//   run them through the SDK, so their entrypoint can say "sdk-cli").
// - Cowork (the optional "Claude desktop (Cowork)" source, off by default):
//   each Cowork task runs in its own Claude home under
//   `%APPDATA%\Claude\local-agent-mode-sessions\<account>\<org>\[agent\]local_*\.claude\`.
//   Only `.claude\projects\<project>\<session>.jsonl` there is ever listed or
//   read. Those homes also hold sign-in files (`.credentials.json`) and the
//   task's uploads and outputs: none of it is opened, copied, archived or
//   backed up (nothing outside `projects` is even listed).

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid } from '@shared/jsonl'
import type { Platform } from '../../platform'
import type { SessionFile } from '../types'
import { listSessionFiles } from './sessions'

export const COWORK_SOURCE_ID = 'claude-desktop-cowork'
export const COWORK_SOURCE_LABEL = 'Claude desktop (Cowork)'

/** `%APPDATA%\Claude`, the desktop app's data folder (as Windows sees it). */
export function claudeDesktopDir(platform: Pick<Platform, 'windowsHome' | 'fixtures'>): string {
  const appData =
    !platform.fixtures && process.platform === 'win32' && process.env.APPDATA
      ? process.env.APPDATA
      : join(platform.windowsHome, 'AppData', 'Roaming')
  return join(appData, 'Claude')
}

export function coworkRoot(desktopDir: string): string {
  return join(desktopDir, 'local-agent-mode-sessions')
}

/** A folder name the desktop app makes (ids), never `..` or anything odd. */
const ID_DIR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const INDEX_FILE = /^local_[0-9a-f-]{36}\.json$/i
const COWORK_HOME = /^local_[A-Za-z0-9_-]{1,128}$/
const MAX_INDEX_FILE = 1024 * 1024

async function dirs(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && ID_DIR.test(e.name))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Session ids the desktop app's Code tab lists (its `cliSessionId`s). Empty
 * when the desktop app isn't installed or has no local Code sessions.
 */
export async function readDesktopIndex(desktopDir: string): Promise<Set<string>> {
  const out = new Set<string>()
  const root = join(desktopDir, 'claude-code-sessions')
  for (const account of await dirs(root))
    for (const org of await dirs(join(root, account))) {
      let names: string[]
      try {
        names = (await readdir(join(root, account, org))).filter((n) => INDEX_FILE.test(n))
      } catch {
        continue
      }
      for (const n of names) {
        const path = join(root, account, org, n)
        try {
          const st = await stat(path)
          if (!st.isFile() || st.size > MAX_INDEX_FILE) continue
          const o = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
          const id = o?.cliSessionId
          if (isUuid(id)) out.add(id.toLowerCase())
        } catch {
          // Being written right now, or not what we expect: skipped.
        }
      }
    }
  return out
}

/** The Cowork task homes' `projects` folders (each `…\local_*\.claude\projects`). */
export async function coworkProjectDirs(root: string): Promise<string[]> {
  const out: string[] = []
  for (const account of await dirs(root))
    for (const org of await dirs(join(root, account))) {
      const base = join(root, account, org)
      const homes = (await dirs(base)).filter((n) => COWORK_HOME.test(n)).map((n) => join(base, n))
      // The desktop's own agent runs keep theirs one level down, in `agent\`.
      for (const n of (await dirs(join(base, 'agent'))).filter((x) => COWORK_HOME.test(x)))
        homes.push(join(base, 'agent', n))
      out.push(...homes.map((h) => join(h, '.claude', 'projects')))
    }
  return out
}

/** Every Cowork session file: only `<home>\.claude\projects\<project>\<id>.jsonl`. */
export async function listCoworkFiles(root: string): Promise<SessionFile[] | undefined> {
  try {
    if (!(await stat(root)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const out: SessionFile[] = []
  for (const projects of await coworkProjectDirs(root))
    out.push(...((await listSessionFiles(projects)) ?? []))
  return out
}

/** A path the watcher saw: is it a Cowork session file (inside a home's `.claude\projects`)? */
export function isCoworkSessionFile(path: string): boolean {
  return /[\\/]local_[A-Za-z0-9_-]+[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/][0-9a-f-]{36}\.jsonl$/i.test(
    path
  )
}
