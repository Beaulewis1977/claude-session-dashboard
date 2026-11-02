import { Sparkles, TextCursorInput, X } from 'lucide-react'
import { summarize } from '@/lib/summaries'
import type { SessionSummary } from '@shared/types'
import { canUseClaudeName } from '@shared/title'
import { applyClaudeNames } from '@/lib/actions'
import { useApp } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

/** Shown while several sessions are picked (Ctrl/⌘+click, Shift+click). */
export function BulkBar({ picked }: { picked: SessionSummary[] }) {
  const named = picked.filter(canUseClaudeName)
  return (
    <div
      role="toolbar"
      aria-label="Selected sessions"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-accent-soft/50 px-3 text-xs"
    >
      <span className="font-medium tabular-nums">{picked.length} selected</span>
      <Tooltip
        content={
          named.length
            ? `Clear your dashboard names for ${named.length} session${named.length === 1 ? '' : 's'}, so the names from /rename in Claude Code show`
            : 'None of these has a dashboard name hiding a different Claude Code name'
        }
      >
        <span>
          <Button
            variant="outline"
            size="sm"
            disabled={!named.length}
            onClick={() => void applyClaudeNames(named.map((s) => s.key))}
          >
            <TextCursorInput /> Use Claude Code names
            {named.length > 0 && named.length < picked.length && ` (${named.length})`}
          </Button>
        </span>
      </Tooltip>
      <Tooltip content="Write a summary for each, one at a time (shows what it would use first)">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            summarize(
              picked.map((s) => s.key),
              'bulk'
            )
          }
        >
          <Sparkles /> Summarize selected
        </Button>
      </Tooltip>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto"
        onClick={() => useApp.getState().set({ checked: [] })}
        aria-label="Clear selection"
      >
        <X /> Clear
      </Button>
    </div>
  )
}
