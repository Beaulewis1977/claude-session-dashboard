// Which Codex product ran a session, from its rollout's `session_meta`:
// `originator` (seen: "codex_cli_rs", "codex-tui", "codex_vscode",
// "codex_exec", "Codex Desktop", "codex_work_desktop", "Claude Code") and
// `source` ("cli", "vscode", "exec", or {subagent: …}). The desktop app
// records `source: "vscode"`, so the originator is checked first.

import type { DetectedSource } from '@shared/source-label'
import type { BaseSummary } from '../types'

export function detectCodexSource(base: Pick<BaseSummary, 'origin' | 'subagent'>): DetectedSource {
  const o = base.origin ?? {}
  const orig = o.originator ?? ''
  const src = o.source ?? ''
  if (base.subagent || src === 'subagent' || o.threadSource === 'subagent')
    return { label: 'codex-subagent', reason: 'Started by another Codex thread (a subagent)' }
  if (/^claude[ _-]?code$/i.test(orig))
    return {
      label: 'codex-claude-code',
      reason: `originator "${orig}" (Claude Code's Codex plugin)`
    }
  if (/desktop/i.test(orig)) return { label: 'codex-desktop', reason: `originator "${orig}"` }
  if (/vscode/i.test(orig) || src === 'vscode')
    return { label: 'codex-vscode', reason: orig ? `originator "${orig}"` : 'source "vscode"' }
  if (/exec/i.test(orig) || src === 'exec')
    return { label: 'codex-exec', reason: orig ? `originator "${orig}"` : 'source "exec"' }
  if (/cli|tui/i.test(orig) || src === 'cli')
    return { label: 'codex-cli', reason: orig ? `originator "${orig}"` : 'source "cli"' }
  return {
    label: 'codex-unknown',
    reason: orig ? `Unrecognised originator "${orig}"` : 'No originator recorded'
  }
}
