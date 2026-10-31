import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Archive,
  ArrowDownToLine,
  ChevronLeft,
  ClipboardCopy,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  FileDown,
  FolderOpen,
  GitBranch,
  GitFork,
  MessageSquare,
  Pin,
  PinOff,
  Play,
  Search,
  Smartphone,
  SquareTerminal,
  TextCursorInput
} from 'lucide-react'
import type { SessionDetail, SessionSummary } from '@shared/types'
import { formatDateTime } from '@shared/format'
import { api } from '@/lib/api'
import {
  applyClaudeNames,
  copyConversation,
  copySessionId,
  exportMarkdown,
  toggleHidden,
  togglePinned,
  updateMeta
} from '@/lib/actions'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EnvBadge } from '@/components/EnvBadge'
import { RemoteBadge } from '@/components/RemoteBadge'
import {
  DescriptionEditor,
  EditableTitle,
  TagEditor,
  TitleSourceLine
} from '@/components/viewer/MetaEditors'
import { canUseClaudeName } from '@shared/title'
import { FindBar } from '@/components/viewer/FindBar'
import { SessionUsageStrip } from '@/components/viewer/SessionUsage'
import { Transcript, type OnBranch } from '@/components/viewer/Transcript'
import { useFind } from '@/components/viewer/useFind'
import { LaunchSheet, type LaunchTarget } from './LaunchSheet'
import { TerminalSheet } from './TerminalSheet'
import { canOpenTerminal } from '@shared/terminal'
import { useMobile } from './state'

/** True while the user has text selected (e.g. dragging a selection handle). */
const selecting = (): boolean => {
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed
}

/**
 * Swipe right from the left edge to go back (like iOS). It never calls
 * preventDefault, and steps aside while text is selected, so dragging a
 * selection handle near the edge doesn't turn into a swipe.
 */
function useEdgeSwipeBack(onBack: () => void): {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  offset: number
} {
  const [offset, setOffset] = useState(0)
  const start = useRef<{ x: number; y: number } | null>(null)
  return {
    offset,
    onTouchStart: (e) => {
      const t = e.touches[0]
      start.current = t.clientX < 28 && !selecting() ? { x: t.clientX, y: t.clientY } : null
    },
    onTouchMove: (e) => {
      const st = start.current
      if (!st) return
      const t = e.touches[0]
      if (Math.abs(t.clientY - st.y) > Math.abs(t.clientX - st.x) || selecting()) {
        start.current = null
        setOffset(0)
        return
      }
      setOffset(Math.max(0, t.clientX - st.x))
    },
    onTouchEnd: () => {
      if (offset > 90) onBack()
      start.current = null
      setOffset(0)
    }
  }
}

export function SessionScreen({ session }: { session: SessionSummary }) {
  const select = useApp((s) => s.select)
  const sessions = useApp((s) => s.sessions)
  const me = useMobile((s) => s.me)
  const readOnly = me?.readOnly ?? false
  // Shown only once terminal access (SSH over Tailscale) is set up on the PC.
  const terminal = useMobile((s) => s.terminal)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const showTerminal = canOpenTerminal(terminal, session)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findNonce, setFindNonce] = useState(0)
  const [launch, setLaunch] = useState<LaunchTarget | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const back = useCallback(() => select(null), [select])
  const swipe = useEdgeSwipeBack(back)
  const allTags = useMemo(
    () => [...new Set(sessions.flatMap((s) => s.meta.tags ?? []))].sort(),
    [sessions]
  )

  // Load the transcript, and reload it when the session changes on the PC.
  const version = `${session.sizeBytes}|${session.lastActivityAt}|${session.availability}`
  useEffect(() => {
    let cancelled = false
    void api
      .getSession(session.key)
      .then((d) => {
        if (cancelled) return
        setError(!d)
        setDetail(d)
      })
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [session.key, version])

  // The phone's back button / gesture closes the session instead of leaving the app.
  useEffect(() => {
    history.pushState({ session: session.key }, '')
    const onPop = (): void => back()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [session.key, back])

  const messages = useMemo(() => detail?.messages ?? [], [detail])
  const find = useFind(contentRef, scrollRef, findOpen ? findQuery : '', detail)
  const viewOnly = session.availability === 'imported'
  const onBranch = useCallback<OnBranch>(
    (id, mode) => setLaunch({ kind: 'branch', at: id, mode }),
    []
  )

  const write = (fn: () => Promise<void>): void => {
    if (readOnly) {
      toast('Read-only mode is on', { description: 'Change it on your PC.' })
      return
    }
    void fn().catch((err: Error) => toast.error("Couldn't save", { description: err.message }))
  }

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-background animate-in slide-in-from-right-8 fade-in-0 duration-200"
      style={swipe.offset ? { transform: `translateX(${swipe.offset}px)` } : undefined}
      onTouchStart={swipe.onTouchStart}
      onTouchMove={swipe.onTouchMove}
      onTouchEnd={swipe.onTouchEnd}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-border bg-chrome/95 px-1.5 pt-[env(safe-area-inset-top)] backdrop-blur">
        <Button
          variant="ghost"
          className="h-11 gap-0.5 px-2 text-[15px] text-primary"
          onClick={() => history.back()}
        >
          <ChevronLeft className="size-6" /> Sessions
        </Button>
        <div className="flex-1" />
        {showTerminal && (
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="Open terminal here"
            onClick={() => setTerminalOpen(true)}
          >
            <SquareTerminal className="size-5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label="Find in session"
          onClick={() => {
            setFindOpen(true)
            setFindNonce((n) => n + 1)
          }}
        >
          <Search className="size-5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11" aria-label="More actions">
              <Ellipsis className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {showTerminal && (
              <>
                <DropdownMenuItem onSelect={() => setTerminalOpen(true)}>
                  <SquareTerminal /> Open terminal here
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              disabled={!canUseClaudeName(session)}
              onSelect={() => write(() => applyClaudeNames([session.key]))}
            >
              <TextCursorInput /> Use name from Claude Code
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => write(() => togglePinned(session.key))}>
              {session.meta.pinned ? <PinOff /> : <Pin />}
              {session.meta.pinned ? 'Unpin' : 'Pin to top'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => write(() => toggleHidden(session.key))}>
              {session.meta.hidden ? <Eye /> : <EyeOff />}
              {session.meta.hidden ? 'Unhide session' : 'Hide session'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!detail}
              onSelect={() => detail && copyConversation(detail, session)}
            >
              <ClipboardCopy /> Copy whole conversation
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportMarkdown(session.key)}>
              <FileDown /> Export to Markdown
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copySessionId(session.sessionId)}>
              <Copy /> Copy session ID
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div
        ref={scrollRef}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain',
          findOpen && '[--tool-copy-top:3.5rem]'
        )}
      >
        <div className="border-b border-border px-4 pt-4 pb-4">
          <EditableTitle
            key={`${session.titleSource}:${session.title}`}
            session={session}
            onSave={(name) => write(() => updateMeta(session.key, { name }))}
            focusNonce={0}
          />
          <TitleSourceLine
            session={session}
            onUseClaudeName={() => write(() => applyClaudeNames([session.key]))}
          />
          <div className="mt-1.5">
            <DescriptionEditor
              key={session.meta.description ?? ''}
              session={session}
              onSave={(description) => write(() => updateMeta(session.key, { description }))}
              focusNonce={0}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {!viewOnly && <EnvBadge env={session.env} distro={session.distro} />}
            <RemoteBadge session={session} />
            {session.meta.pinned && (
              <Badge variant="accent">
                <Pin /> Pinned
              </Badge>
            )}
            {session.availability === 'archived-only' && (
              <Badge variant="warning">
                <Archive /> Archived only
              </Badge>
            )}
            {session.meta.hidden && (
              <Badge variant="muted">
                <EyeOff /> Hidden
              </Badge>
            )}
          </div>
          <div className="mt-2.5 space-y-1 text-[12.5px] text-muted-foreground">
            <div className="flex min-w-0 items-center gap-1.5">
              <FolderOpen className="size-3.5 shrink-0 text-subtle-foreground" />
              <span className="truncate font-mono text-[11.5px]">
                {session.cwd ?? session.projectDir}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {session.gitBranch && (
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3.5 text-subtle-foreground" />
                  <span className="font-mono text-[11.5px]">{session.gitBranch}</span>
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="size-3.5 text-subtle-foreground" />
                {session.messageCount} messages
              </span>
            </div>
            <div>
              {formatDateTime(session.startedAt)} → {formatDateTime(session.lastActivityAt)}
            </div>
          </div>
          <SessionUsageStrip sessionKey={session.key} version={session.sizeBytes} />
          <div className="mt-3">
            <TagEditor
              tags={session.meta.tags ?? []}
              allTags={allTags}
              onChange={(tags) => write(() => updateMeta(session.key, { tags }))}
              focusNonce={0}
            />
          </div>
        </div>
        {findOpen && (
          <div className="sticky top-0 z-20 h-0">
            <FindBar
              query={findQuery}
              onQuery={setFindQuery}
              count={find.count}
              index={find.index}
              onNext={find.next}
              onPrev={find.prev}
              onClose={() => setFindOpen(false)}
              focusNonce={findNonce}
            />
          </div>
        )}
        <div ref={contentRef}>
          {detail ? (
            <Transcript
              messages={messages}
              cwd={session.cwd}
              findQuery={findOpen ? findQuery : ''}
              onBranch={viewOnly || readOnly ? undefined : onBranch}
              className="px-3 pt-4 pb-28"
            />
          ) : error ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              This session's file can't be read right now.
            </div>
          ) : (
            <div className="space-y-4 px-4 pt-5">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn(
                    'h-16 animate-pulse rounded-2xl bg-secondary',
                    i % 2 ? 'mr-10' : 'ml-10'
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Above the footer and the sticky Copy · ⋯ row a message can pin to the bottom. */}
      {detail && messages.length > 6 && (
        <Button
          variant="outline"
          size="icon"
          className="absolute right-4 bottom-[calc(env(safe-area-inset-bottom)+156px)] z-10 size-10 rounded-full bg-popover/90 shadow-md backdrop-blur"
          aria-label="Jump to latest"
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
        >
          <ArrowDownToLine />
        </Button>
      )}

      {!viewOnly && (
        <footer className="shrink-0 border-t border-border bg-chrome/95 px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="h-11 flex-1 text-[15px]"
              disabled={readOnly}
              onClick={() => setLaunch({ kind: 'resume' })}
            >
              <Play className="fill-current" /> Resume on PC
            </Button>
            <Button
              variant="outline"
              className="h-11 flex-1 text-[15px]"
              disabled={readOnly}
              onClick={() => setLaunch({ kind: 'fork' })}
            >
              <GitFork /> Fork
            </Button>
          </div>
          <div className="mt-1.5 flex items-center justify-center gap-1 text-[11.5px] text-muted-foreground">
            <Smartphone className="size-3" />
            {readOnly
              ? 'Read-only mode is on (change it on your PC)'
              : 'Opens on your PC with Remote Control'}
          </div>
        </footer>
      )}

      {terminalOpen && canOpenTerminal(terminal, session) && (
        <TerminalSheet
          info={terminal}
          target={session}
          title={session.title}
          onClose={() => setTerminalOpen(false)}
        />
      )}
      {launch && <LaunchSheet session={session} target={launch} onClose={() => setLaunch(null)} />}
    </div>
  )
}
