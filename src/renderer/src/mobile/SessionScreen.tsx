import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { liveRemoteUrl } from '@/lib/remote'
import { isViewOnly } from '@shared/view-only'
import { toast } from 'sonner'
import {
  MonitorSmartphone,
  AppWindow,
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
  GitCommitHorizontal,
  GitFork,
  MessageSquare,
  Pin,
  PinOff,
  Play,
  Search,
  Smartphone,
  SquareTerminal,
  TextCursorInput,
  TriangleAlert
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
import { capsOf, PROVIDER_LABEL, providerOf } from '@shared/provider'
import { ProviderBadge } from '@/components/ProviderSwitch'
import { ChangesSheet } from './ChangesSheet'
import { useFocusMessage } from '@/lib/focus-message'
import { badgeText } from '@shared/git/prs'
import { FindBar } from '@/components/viewer/FindBar'
import { SessionUsageStrip } from '@/components/viewer/SessionUsage'
import { ContextStrip } from '@/components/context/ContextSize'
import { Transcript, type OnBranch } from '@/components/viewer/Transcript'
import { useFind } from '@/components/viewer/useFind'
import { SummaryBlock } from '@/components/summary/SummaryBlock'
import { LaunchSheet, type LaunchTarget } from './LaunchSheet'
import { SessionModelControls } from '@/components/ModelPicker'
import { useModelChoice } from '@/lib/model-choice'
import { choiceLabel } from '@shared/model-choice'
import { TerminalSheet } from './TerminalSheet'
import { closeSession } from './nav'
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
  const sessions = useApp((s) => s.sessions)
  const me = useMobile((s) => s.me)
  const readOnly = me?.readOnly ?? false
  // Shown only once terminal access (SSH over Tailscale) is set up on the PC.
  const terminal = useMobile((s) => s.terminal)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const showTerminal = canOpenTerminal(terminal, session)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findNonce, setFindNonce] = useState(0)
  const [launch, setLaunch] = useState<LaunchTarget | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Back to the screen the session was opened from (through history, like the phone's own Back).
  const swipe = useEdgeSwipeBack(closeSession)
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

  const messages = useMemo(() => detail?.messages ?? [], [detail])
  const find = useFind(contentRef, scrollRef, findOpen ? findQuery : '', detail)
  // A citation from Ask: its message, or (a commit) the Changes sheet at that commit.
  const focusSha = useApp((s) => (s.focusMessage?.key === session.key ? s.focusMessage.sha : undefined))
  const [seenSha, setSeenSha] = useState<string | undefined>()
  if (focusSha && focusSha !== seenSha) {
    // Adjusting state during render (not in an effect): open the Changes sheet once per citation.
    setSeenSha(focusSha)
    setChangesOpen(true)
  }
  useFocusMessage(session.key, changesOpen || !!detail, changesOpen ? 'changes' : 'conversation')
  const viewOnly = isViewOnly(session)
  // What this session's agent can do (Codex: Resume and Fork, no Remote Control).
  const caps = capsOf(session)
  const product = PROVIDER_LABEL[providerOf(session)]
  // Running on the PC with Remote Control on (also after /rc typed later): straight to it.
  const liveSessions = useApp((st) => st.live?.sessions)
  const rcLink = caps.remoteControl ? liveRemoteUrl(liveSessions, session.key) : undefined
  const choice = choiceLabel(useModelChoice(session))
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
          onClick={closeSession}
        >
          <ChevronLeft className="size-6" /> Sessions
        </Button>
        <div className="flex-1" />
        {session.availability !== 'imported' && (
          <Button
            variant="ghost"
            className="h-11 gap-1 px-2 text-[13px]"
            aria-label="Changes (commits, files and pull requests)"
            onClick={() => setChangesOpen(true)}
          >
            <GitCommitHorizontal className="size-5" />
            {session.git ? (
              <span className="tabular-nums">{badgeText(session.git)}</span>
            ) : (
              'Changes'
            )}
          </Button>
        )}
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
              <TextCursorInput /> Use name from {product}
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
            key={session.key}
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
              key={session.key}
              session={session}
              onSave={(description) => write(() => updateMeta(session.key, { description }))}
              focusNonce={0}
            />
          </div>
          {(caps.summaries || session.meta.aiSummary) && (
            <SummaryBlock
              session={session}
              readOnly={readOnly}
              onContinue={
                viewOnly || !caps.continueFresh ? undefined : () => setLaunch({ kind: 'continue' })
              }
            />
          )}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <ProviderBadge provider={session.provider} />
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
          {!viewOnly && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12.5px] font-medium text-muted-foreground">
                Launch with
              </div>
              <SessionModelControls session={session} write={write} disabled={readOnly} />
            </div>
          )}
          <SessionUsageStrip sessionKey={session.key} version={session.sizeBytes} />
          <ContextStrip
            sessionKey={session.key}
            version={`${session.sizeBytes}:${session.context?.tokens ?? ''}:${session.context?.at ?? ''}:${session.context?.windowSize ?? ''}:${session.billing?.mode ?? ''}:${session.meta.aiSummary?.generatedAt ?? ''}:${session.meta.aiSummary?.editedAt ?? ''}:${session.meta.model ?? ''}`}
          />
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
          {session.historyNote && (
            <div className="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft px-3 py-2.5 text-[13px] leading-snug">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>
                <b>History may be incomplete.</b>{' '}
                {session.historyNote.replace(/^This conversation may be incomplete: /, '')}
              </span>
            </div>
          )}
          {session.searchPartial && (
            <div className="mx-3 mt-3 rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-[13px] leading-snug text-muted-foreground">
              This conversation is very long, so searching sessions covers only its first part.
            </div>
          )}
          {detail ? (
            <Transcript
              messages={messages}
              cwd={session.cwd}
              findQuery={findOpen ? findQuery : ''}
              onBranch={viewOnly || readOnly || !caps.branch ? undefined : onBranch}
              agent={providerOf(session)}
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
          {rcLink && (
            <a
              href={rcLink}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground active:bg-primary-hover"
            >
              <MonitorSmartphone className="size-5" /> Open in Claude app
              <span className="font-normal opacity-85">· running on your PC</span>
            </a>
          )}
          <div className="flex gap-2">
            <Button
              variant={rcLink ? 'outline' : 'primary'}
              className="h-11 flex-1 text-[15px]"
              disabled={readOnly}
              onClick={() => setLaunch({ kind: 'resume' })}
            >
              <Play className="fill-current" /> Resume on PC
              {choice && <span className="truncate font-normal opacity-85">· {choice}</span>}
            </Button>
            {caps.fork && (
              <Button
                variant="outline"
                className="h-11 flex-1 text-[15px]"
                disabled={readOnly}
                onClick={() => setLaunch({ kind: 'fork' })}
              >
                <GitFork /> Fork
              </Button>
            )}
          </div>
          {providerOf(session) === 'codex' && (
            <Button
              variant="outline"
              className="mt-2 h-10 w-full text-[14px]"
              disabled={readOnly}
              onClick={() => setLaunch({ kind: 'codex-app' })}
            >
              <AppWindow /> Open in Codex app on PC
            </Button>
          )}
          {providerOf(session) === 'codex' && (
            <p className="mt-1.5 text-center text-[11.5px] leading-snug text-muted-foreground">
              To continue on your phone, open it in the Codex app on your PC: Codex Remote in the
              ChatGPT app reaches Codex app threads, not terminal sessions.
            </p>
          )}
          <div className="mt-1.5 flex items-center justify-center gap-1 text-[11.5px] text-muted-foreground">
            <Smartphone className="size-3" />
            {readOnly
              ? 'Read-only mode is on (change it on your PC)'
              : caps.remoteControl
                ? 'Opens on your PC with Remote Control'
                : `Opens ${product} on your PC (sandboxed, approval on request, no bypass)`}
          </div>
        </footer>
      )}

      {changesOpen && (
        <ChangesSheet
          session={session}
          onClose={() => setChangesOpen(false)}
          onSearch={() => {
            setChangesOpen(false)
            closeSession()
          }}
        />
      )}
      {terminalOpen && canOpenTerminal(terminal, session) && (
        <TerminalSheet
          info={terminal}
          target={session}
          title={session.title}
          onClose={() => setTerminalOpen(false)}
        />
      )}
      {launch && (
        <LaunchSheet
          key={launch.kind}
          session={session}
          target={launch}
          onSwitch={setLaunch}
          onClose={() => setLaunch(null)}
        />
      )}
    </div>
  )
}
