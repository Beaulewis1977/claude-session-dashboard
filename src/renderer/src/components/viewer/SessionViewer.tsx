import { SourcePicker } from '../SourceBadge'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArrowDownToLine,
  ArrowUpToLine,
  CalendarClock,
  ClipboardCopy,
  Clock,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  FileDown,
  FolderOpen,
  GitBranch,
  GitFork,
  Hash,
  Info,
  MessageSquare,
  MessagesSquare,
  Pin,
  PinOff,
  Play,
  Plus,
  Search,
  SquareTerminal,
  Terminal,
  TextCursorInput,
  WifiOff
} from 'lucide-react'
import type { SessionDetail, SessionSummary } from '@shared/types'
import { formatBytes, formatDateTime } from '@shared/format'
import { messagePreview } from '@shared/branch'
import { canUseClaudeName } from '@shared/title'
import { api } from '@/lib/api'
import {
  applyClaudeNames,
  copyConversation,
  copyResumeCommand,
  copySessionId,
  exportMarkdown,
  openBranch,
  openNewSession,
  openResume,
  openTerminalHere,
  showFile,
  toggleHidden,
  togglePinned,
  updateMeta
} from '@/lib/actions'
import { useApp } from '@/lib/store'
import { useHotkeys } from '@/lib/hotkeys'
import { cn, MOD } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { EnvBadge } from '../EnvBadge'
import { BillingBadge } from '../BillingPicker'
import { RemoteBadge } from '../RemoteBadge'
import { SessionModelControls } from '../ModelPicker'
import { useModelChoice } from '@/lib/model-choice'
import { choiceLabel } from '@shared/model-choice'
import { SessionUsageStrip } from './SessionUsage'
import { DescriptionEditor, EditableTitle, TagEditor, TitleSourceLine } from './MetaEditors'
import { FindBar } from './FindBar'
import { BranchesPanel, type BranchMark } from './Branches'
import { Transcript, type OnBranch } from './Transcript'
import { useFind } from './useFind'

function Fact({
  icon: Icon,
  children,
  title
}: {
  icon: typeof Clock
  children: React.ReactNode
  title?: string
}) {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={title}
    >
      <Icon className="size-3.5 shrink-0 text-subtle-foreground" />
      <span className="truncate">{children}</span>
    </span>
  )
}

function Notice({
  tone,
  icon: Icon,
  children
}: {
  tone: 'info' | 'warning'
  icon: typeof Info
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
        tone === 'info'
          ? 'border-info/25 bg-info/5 text-foreground/85'
          : 'border-warning/25 bg-warning-soft text-foreground/85'
      )}
    >
      <Icon
        className={cn('mt-px size-3.5 shrink-0', tone === 'info' ? 'text-info' : 'text-warning')}
      />
      <div>{children}</div>
    </div>
  )
}

function Header({
  session,
  allTags,
  onFind,
  onCopyConversation,
  branchPointPreview
}: {
  session: SessionSummary
  allTags: string[]
  onFind: () => void
  /** Unset until the transcript has loaded. */
  onCopyConversation?: () => void
  branchPointPreview?: string
}) {
  const focus = useApp((s) => s.focus)
  const nonce = (f: string): number => (focus.field === f ? focus.nonce : 0)
  const sameDay =
    session.startedAt &&
    session.lastActivityAt &&
    new Date(session.startedAt).toDateString() === new Date(session.lastActivityAt).toDateString()
  const useClaude = canUseClaudeName(session)
  const choice = choiceLabel(useModelChoice(session))

  return (
    <div className="border-b border-border px-8 pt-5 pb-4">
      <div className="mx-auto max-w-[860px]">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <EditableTitle
              key={session.key}
              session={session}
              onSave={(name) => void updateMeta(session.key, { name })}
              focusNonce={nonce('name')}
            />
            <TitleSourceLine session={session} shortcutHint />
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            {session.availability === 'imported' ? (
              <Badge variant="muted" className="h-8 px-2.5 text-xs">
                <MessagesSquare /> View only · imported from claude.ai
              </Badge>
            ) : (
              <>
                <Tooltip
                  content={choice ? `Resume in a terminal with ${choice}` : 'Resume in a terminal'}
                  shortcut={`${MOD}+Enter`}
                >
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => openResume(session.key, false)}
                  >
                    <Play className="fill-current" /> Resume
                    {choice && <span className="font-normal opacity-85">· {choice}</span>}
                  </Button>
                </Tooltip>
                <Tooltip
                  content="Fork into a new session (original stays untouched)"
                  shortcut={`${MOD}+Shift+Enter`}
                >
                  <Button variant="outline" size="md" onClick={() => openResume(session.key, true)}>
                    <GitFork /> Fork
                  </Button>
                </Tooltip>
              </>
            )}
            <Tooltip content="Find in session" shortcut={`${MOD}+F`}>
              <Button variant="ghost" size="icon" onClick={onFind} aria-label="Find in session">
                <Search />
              </Button>
            </Tooltip>
            <DropdownMenu>
              <Tooltip content="More actions">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent className="w-64">
                <DropdownMenuItem onSelect={() => openNewSession(session.key)}>
                  <Plus /> New session in this folder…
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={session.availability === 'imported' || !session.cwd}
                  onSelect={() => void openTerminalHere(session.key)}
                >
                  <Terminal /> Open terminal here
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => void copyResumeCommand(session.key)}
                  shortcut={`${MOD}+Shift+C`}
                >
                  <SquareTerminal /> Copy resume command
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copyResumeCommand(session.key, 'claude')}>
                  <Copy /> Copy claude command only
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copySessionId(session.sessionId)}>
                  <Hash /> Copy session ID
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!onCopyConversation}
                  onSelect={() => onCopyConversation?.()}
                >
                  <ClipboardCopy /> Copy whole conversation
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void exportMarkdown(session.key)}
                  shortcut={`${MOD}+E`}
                >
                  <FileDown /> Export to Markdown…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => showFile(session.key)}>
                  <FolderOpen /> Show file in folder
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!useClaude}
                  onSelect={() => void applyClaudeNames([session.key])}
                >
                  <TextCursorInput /> Use name from Claude Code
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void togglePinned(session.key)}>
                  {session.meta.pinned ? <PinOff /> : <Pin />}
                  {session.meta.pinned ? 'Unpin' : 'Pin to top'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void toggleHidden(session.key)} shortcut="H">
                  {session.meta.hidden ? <Eye /> : <EyeOff />}
                  {session.meta.hidden ? 'Unhide session' : 'Hide session'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="mt-2">
          <DescriptionEditor
            key={session.key}
            session={session}
            onSave={(description) => void updateMeta(session.key, { description })}
            focusNonce={nonce('description')}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {session.availability !== 'imported' && (
            <EnvBadge env={session.env} distro={session.distro} />
          )}
          <SourcePicker
            source={session.source}
            reason={session.sourceReason}
            manual={session.meta.source?.by === 'manual'}
            onPick={(label) =>
              void updateMeta(session.key, {
                // null resets to the detected label.
                source: label ? { label, by: 'manual' } : (null as unknown as undefined)
              })
            }
          />
          <BillingBadge billing={session.billing} />
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
          {session.availability === 'source-offline' && (
            <Badge variant="muted">
              <WifiOff /> Source offline
            </Badge>
          )}
          {session.meta.hidden && (
            <Badge variant="muted">
              <EyeOff /> Hidden
            </Badge>
          )}
          <Fact icon={FolderOpen} title={session.cwd}>
            <span className="selectable font-mono text-[11.5px]">
              {session.cwd ?? session.projectDir}
            </span>
          </Fact>
          {session.gitBranch && (
            <Fact icon={GitBranch}>
              <span className="font-mono text-[11.5px]">{session.gitBranch}</span>
            </Fact>
          )}
          <Fact icon={MessageSquare}>
            {session.messageCount} messages
            {session.toolCallCount ? ` · ${session.toolCallCount} tool calls` : ''}
          </Fact>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <Fact icon={CalendarClock}>Started {formatDateTime(session.startedAt)}</Fact>
          <Fact icon={Clock}>
            Last activity{' '}
            {sameDay
              ? formatDateTime(session.lastActivityAt).replace(/^.*?\d{4} /, '')
              : formatDateTime(session.lastActivityAt)}
          </Fact>
          <span className="text-xs text-subtle-foreground">
            {formatBytes(session.sizeBytes)}
            {session.version ? ` · Claude Code ${session.version}` : ''}
          </span>
        </div>

        {session.availability !== 'imported' && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Launch with</span>
            <SessionModelControls session={session} />
          </div>
        )}

        <SessionUsageStrip sessionKey={session.key} version={session.sizeBytes} />

        <div className="mt-3">
          <TagEditor
            tags={session.meta.tags ?? []}
            allTags={allTags}
            onChange={(tags) => void updateMeta(session.key, { tags })}
            focusNonce={nonce('tags')}
          />
        </div>

        <BranchesPanel session={session} atPreview={branchPointPreview} />

        {(session.availability !== 'live' || session.malformedLines > 0) && (
          <div className="mt-3 space-y-2">
            {session.availability === 'imported' && (
              <Notice tone="info" icon={MessagesSquare}>
                Imported from a claude.ai data export into the app&apos;s archive. You can read,
                search and export it; it has no token stats and can&apos;t be resumed.
              </Notice>
            )}
            {session.availability === 'archived-only' && (
              <Notice tone="warning" icon={Archive}>
                The original file is gone from <span className="font-mono">.claude/projects</span>{' '}
                (Claude Code cleans up old sessions). You're viewing the app's archived copy. Resume
                or Fork restores it to its original path first.
              </Notice>
            )}
            {session.availability === 'source-offline' && (
              <Notice tone="info" icon={WifiOff}>
                {session.sourceLabel} can't be read right now (for example, the distro isn't
                running). Showing the archived copy.
              </Notice>
            )}
            {session.malformedLines > 0 && (
              <Notice tone="info" icon={Info}>
                {session.malformedLines} line{session.malformedLines === 1 ? '' : 's'} in this file
                couldn't be read and
                {session.malformedLines === 1 ? ' was' : ' were'} skipped.
              </Notice>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function SessionViewer({
  session,
  allTags
}: {
  session: SessionSummary
  allTags: string[]
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findNonce, setFindNonce] = useState(0)
  const [atBottom, setAtBottom] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const focus = useApp((s) => s.focus)

  // Load the transcript, and reload it when the file changes (live updates).
  // The component is keyed by session, so switching sessions remounts it.
  const version = `${session.sizeBytes}|${session.lastActivityAt}|${session.availability}`
  useEffect(() => {
    let cancelled = false
    void api.getSession(session.key).then((d) => {
      if (cancelled) return
      setError(!d)
      setDetail(d)
    })
    return () => {
      cancelled = true
    }
  }, [session.key, version])

  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindNonce((n) => n + 1)
  }, [])
  // Open the find bar when requested from the palette (adjusting state during render).
  const [seenFocus, setSeenFocus] = useState(focus.nonce)
  if (focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce)
    if (focus.field === 'find') {
      setFindOpen(true)
      setFindNonce((n) => n + 1)
    }
  }

  const effectiveQuery = findOpen ? findQuery : ''
  const find = useFind(contentRef, scrollRef, effectiveQuery, detail)

  useHotkeys([
    { combo: 'mod+f', allowInInput: true, handler: openFind },
    { combo: 'f3', allowInInput: true, handler: () => (findOpen ? find.next() : openFind()) },
    { combo: 'shift+f3', allowInInput: true, handler: () => find.prev(), when: () => findOpen },
    {
      combo: 'escape',
      handler: () => setFindOpen(false),
      when: () => findOpen
    }
  ])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (el) setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 80)
  }

  const messages = useMemo(() => detail?.messages ?? [], [detail])

  const atId = session.lineage?.atMessageId
  const branchPointPreview = useMemo(() => {
    const m = atId ? messages.find((x) => x.id === atId) : undefined
    return m ? messagePreview(m, 90) : undefined
  }, [messages, atId])

  const onBranch = useCallback<OnBranch>(
    (id, mode) => openBranch(session.key, id, mode),
    [session.key]
  )
  // Where this session split from its parent, and where its branches split off.
  const sessions = useApp((s) => s.sessions)
  const markSig = useMemo(() => {
    const out: [string, BranchMark][] = []
    const l = session.lineage
    if (l?.atMessageId) {
      const parent = l.parentKey ? sessions.find((s) => s.key === l.parentKey) : undefined
      out.push([
        l.atMessageId,
        { kind: 'start', key: parent?.key, title: parent?.title ?? 'the original session' }
      ])
    }
    for (const c of sessions) {
      if (c.lineage?.parentKey !== session.key || !c.lineage.atMessageId) continue
      out.push([
        c.lineage.atMessageId,
        { kind: 'child', key: c.key, title: c.title, time: c.meta.branch?.createdAt }
      ])
    }
    return JSON.stringify(out)
  }, [sessions, session.key, session.lineage])
  const marks = useMemo(() => {
    const m = new Map<string, BranchMark[]>()
    for (const [id, mark] of JSON.parse(markSig) as [string, BranchMark][])
      m.set(id, [...(m.get(id) ?? []), mark])
    return m
  }, [markSig])

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-background">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn('min-h-0 flex-1 overflow-y-auto', findOpen && '[--tool-copy-top:3.5rem]')}
        tabIndex={-1}
      >
        <Header
          session={session}
          allTags={allTags}
          onFind={openFind}
          onCopyConversation={detail ? () => copyConversation(detail, session) : undefined}
          branchPointPreview={branchPointPreview}
        />
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
              findQuery={effectiveQuery}
              // Imported claude.ai conversations are view only: no branching.
              onBranch={session.availability === 'imported' ? undefined : onBranch}
              marks={marks}
            />
          ) : error ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              This session's file can't be read right now.
            </div>
          ) : (
            <TranscriptSkeleton />
          )}
        </div>
      </div>

      {detail && messages.length > 6 && (
        <div className="absolute right-5 bottom-5 z-10">
          <Tooltip content={atBottom ? 'Back to top' : 'Jump to latest'} side="left">
            <Button
              variant="outline"
              size="icon"
              className="rounded-full bg-popover/90 shadow-md backdrop-blur"
              aria-label={atBottom ? 'Back to top' : 'Jump to latest'}
              onClick={() => {
                const el = scrollRef.current
                if (el) el.scrollTo({ top: atBottom ? 0 : el.scrollHeight, behavior: 'smooth' })
              }}
            >
              {atBottom ? <ArrowUpToLine /> : <ArrowDownToLine />}
            </Button>
          </Tooltip>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {findOpen && findQuery ? `${find.count} matches` : ''}
      </span>
    </div>
  )
}

function TranscriptSkeleton() {
  return (
    <div className="mx-auto max-w-[860px] space-y-6 px-8 pt-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3">
          <div className="ml-auto h-12 w-2/3 animate-pulse rounded-2xl bg-secondary" />
          <div className="flex gap-3">
            <div className="size-6 animate-pulse rounded-md bg-secondary" />
            <div className="h-24 flex-1 animate-pulse rounded-2xl bg-secondary" />
          </div>
        </div>
      ))}
    </div>
  )
}
