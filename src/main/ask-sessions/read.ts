// Reading a session for the Ask index (in its worker thread). Only session
// files are ever opened: `*.jsonl` / `*.jsonl.zst` named like a session or a
// rollout, given by the main process from its own session list. Anything that
// looks like a credential (`.credentials.json`, `auth.json`, `*token*`, keys)
// is refused before any file is touched. Nothing is ever written here.

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { buildMessages, parseJsonl } from '@shared/jsonl'
import type { ChatMessage } from '@shared/types'
import { buildCodexMessages } from '../providers/codex/parse'
import { isCredentialPath, readCodexText } from '../providers/codex/read'

/**
 * A session file's name: Claude Code `<uuid>.jsonl`, Codex `rollout-….jsonl[.zst]`, an archive copy.
 * Any case (`.JSONL`), as the session scan accepts it on Windows.
 */
const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.jsonl(?:\.zst)?$/i

export class NotASessionFile extends Error {
  constructor() {
    super('Not a session file')
  }
}

/** Throws unless `path` is a session file the index may open. */
export function assertSessionFile(path: string): void {
  const name = basename(path)
  if (
    typeof path !== 'string' ||
    !path ||
    isCredentialPath(path) ||
    !SESSION_FILE.test(name) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(path) ||
    /credential|auth\.json|token|secret/i.test(name)
  )
    throw new NotASessionFile()
}

export interface ReadTarget {
  path: string
  provider: 'claude' | 'codex'
  /** Claude Code: the session's folder (tool labels are shown relative to it). */
  cwd?: string
}

export interface ReadDeps {
  readText?: (path: string) => Promise<string>
  /** Codex: a rollout's text as the app reads it (decompressed and compacted). */
  readCodex?: (path: string) => Promise<string>
  /** Codex: the scan's kept compact text of a big rollout (read only), if any. */
  cachedCodex?: (path: string) => Promise<string | undefined>
}

/** A session's messages, as the viewer shows them. */
export async function readSessionMessages(
  t: ReadTarget,
  deps: ReadDeps = {}
): Promise<ChatMessage[]> {
  assertSessionFile(t.path)
  if (t.provider === 'codex') {
    const text =
      (await deps.cachedCodex?.(t.path)) ??
      (await (deps.readCodex ?? ((p) => readCodexText(p)))(t.path))
    return buildCodexMessages(text)
  }
  const text = await (deps.readText ?? ((p) => readFile(p, 'utf8')))(t.path)
  return buildMessages(parseJsonl(text).events, t.cwd)
}
