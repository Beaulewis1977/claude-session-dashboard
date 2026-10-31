import type { ReactNode } from 'react'
import {
  Eye,
  EyeOff,
  GitFork,
  Hash,
  Pencil,
  Pin,
  PinOff,
  Play,
  SquareTerminal,
  TextCursorInput,
  X
} from 'lucide-react'
import type { SessionSummary } from '@shared/types'
import { canUseClaudeName } from '@shared/title'
import {
  applyClaudeNames,
  copyResumeCommand,
  copySessionId,
  openResume,
  toggleHidden,
  togglePinned
} from '@/lib/actions'
import { useApp } from '@/lib/store'
import { MOD } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

/** Right-click menu for a row: the session's actions, or bulk actions for a multi-selection. */
export function RowMenu({
  session,
  picked,
  children
}: {
  session: SessionSummary
  /** The multi-selection this row is part of (empty if it isn't). */
  picked: SessionSummary[]
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        {picked.length > 1 ? <BulkItems picked={picked} /> : <SingleItems session={session} />}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function SingleItems({ session: s }: { session: SessionSummary }) {
  const viewOnly = s.availability === 'imported'
  const rename = (): void => {
    const st = useApp.getState()
    st.select(s.key)
    // After the menu closes and gives focus back.
    setTimeout(() => useApp.getState().requestFocus('name'), 60)
  }
  return (
    <>
      <ContextMenuItem disabled={viewOnly} onSelect={() => openResume(s.key, false)}>
        <Play /> Resume
      </ContextMenuItem>
      <ContextMenuItem disabled={viewOnly} onSelect={() => openResume(s.key, true)}>
        <GitFork /> Fork
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={rename} shortcut="F2">
        <Pencil /> Rename…
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canUseClaudeName(s)}
        onSelect={() => void applyClaudeNames([s.key])}
      >
        <TextCursorInput /> Use name from Claude Code
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={viewOnly}
        onSelect={() => void copyResumeCommand(s.key)}
        shortcut={`${MOD}+Shift+C`}
      >
        <SquareTerminal /> Copy resume command
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void copySessionId(s.sessionId)}>
        <Hash /> Copy session ID
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void togglePinned(s.key)}>
        {s.meta.pinned ? <PinOff /> : <Pin />}
        {s.meta.pinned ? 'Unpin' : 'Pin to top'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void toggleHidden(s.key)}>
        {s.meta.hidden ? <Eye /> : <EyeOff />}
        {s.meta.hidden ? 'Unhide session' : 'Hide session'}
      </ContextMenuItem>
    </>
  )
}

function BulkItems({ picked }: { picked: SessionSummary[] }) {
  const named = picked.filter(canUseClaudeName)
  return (
    <>
      <div className="px-2 py-1.5 text-2xs font-medium text-subtle-foreground">
        {picked.length} sessions selected
      </div>
      <ContextMenuItem
        disabled={!named.length}
        onSelect={() => void applyClaudeNames(named.map((s) => s.key))}
      >
        <TextCursorInput /> Use Claude Code names
        {named.length > 0 && named.length < picked.length && ` (${named.length})`}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => useApp.getState().set({ checked: [] })}>
        <X /> Clear selection
      </ContextMenuItem>
    </>
  )
}
