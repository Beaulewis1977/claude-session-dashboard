// Git signals in a Claude Code session file (see signals.ts).

import { remoteSessionUrl, type RawEvent } from '../jsonl'
import { GitSignalBuilder } from './signals'
import type { SessionGitSignals } from './types'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** A tool result's text: its content, else the richer copy some versions keep in `toolUseResult`. */
function resultText(block: Record<string, unknown>, e: RawEvent): string {
  const c = block.content
  let text = ''
  if (typeof c === 'string') text = c
  else if (Array.isArray(c))
    text = c
      .map((x) => {
        const o = obj(x)
        return o?.type === 'text' && typeof o.text === 'string' ? o.text : ''
      })
      .filter(Boolean)
      .join('\n')
  if (!text) {
    const tur = e.toolUseResult
    if (typeof tur === 'string') text = tur
    else {
      const o = obj(tur)
      if (typeof o?.stdout === 'string') text = o.stdout
    }
  }
  return text.length > 200_000 ? text.slice(0, 200_000) : text
}

/**
 * Lines copied from another session are left out: a branch's copy of its
 * parent (`forkedFrom`), and an older-style copy whose entries carry the
 * other session's id. Their commits are the other session's. A
 * `--fork-session` copy has neither mark but keeps the parent's times; the
 * git links service leaves out what it holds from before the split.
 */
export function claudeGitSignals(events: RawEvent[], fileSessionId?: string): SessionGitSignals {
  const b = new GitSignalBuilder()
  for (const e of events) {
    if (e.forkedFrom) continue
    const sid = typeof e.sessionId === 'string' ? e.sessionId : undefined
    if (fileSessionId && sid && sid !== fileSessionId) continue
    const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    const at = Number.isFinite(t) ? t : undefined
    b.time(at)
    b.branch(e.gitBranch)
    if (e.type === 'system' && e.subtype === 'bridge_status')
      b.sessionUrl(remoteSessionUrl(e.url), at)
    const content = obj(e.message)?.content
    if (!Array.isArray(content)) continue
    for (const raw of content) {
      const blk = obj(raw)
      if (!blk) continue
      if (blk.type === 'tool_use') {
        const name = typeof blk.name === 'string' ? blk.name : ''
        const input = obj(blk.input) ?? {}
        const id = typeof blk.id === 'string' ? blk.id : undefined
        if (EDIT_TOOLS.has(name)) b.file(input.file_path ?? input.notebook_path, at)
        else if (SHELL_TOOLS.has(name) && typeof input.command === 'string')
          b.command(id, input.command, at)
      } else if (blk.type === 'tool_result') {
        const id = typeof blk.tool_use_id === 'string' ? blk.tool_use_id : undefined
        b.result(id, resultText(blk, e), at)
      }
    }
  }
  return b.build()
}
