import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Brain,
  ChevronDown,
  Copy,
  GitBranchPlus,
  Image as ImageIcon,
  Layers,
  SquareTerminal,
  Undo2
} from 'lucide-react'
import type { ChatMessage, ContentBlock } from '@shared/types'
import { blockId, blocksMatching, dayLabel, groupTurns, turnTime } from '@/lib/transcript'
import { formatTime } from '@shared/format'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { Markdown } from './Markdown'
import { ErrorBoundary, RenderFailed } from '../ErrorBoundary'
import { Collapsible, OrphanResult, ToolCall } from './ToolCall'
import { BranchMarks, type BranchMark } from './Branches'
import { ClaudeMark } from '../brand'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Tooltip } from '../ui/tooltip'

export type OnBranch = (messageId: string, mode: 'include' | 'before') => void

// ---------------------------------------------------------------------------
// Branch from here: a hover button and a right-click menu on each message.

function messageText(msgs: ChatMessage[]): string {
  return msgs
    .flatMap((m) => m.blocks)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

function BranchButton({ onClick, side }: { onClick: () => void; side: 'left' | 'right' }) {
  return (
    <Tooltip content="Branch from here: continue in a new session from this message">
      <button
        type="button"
        aria-label="Branch from here"
        onClick={onClick}
        className={cn(
          'absolute -top-3 z-10 inline-flex h-6 items-center gap-1 rounded-full border border-border bg-popover px-2 text-2xs font-medium text-muted-foreground opacity-0 shadow-sm transition-opacity duration-100 group-hover/msg:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring',
          side === 'left' ? 'left-3' : 'right-3'
        )}
      >
        <GitBranchPlus className="size-3" /> Branch
      </button>
    </Tooltip>
  )
}

function MessageMenu({
  id,
  msgs,
  onBranch,
  canBranchBefore,
  children
}: {
  id: string
  msgs: ChatMessage[]
  onBranch?: OnBranch
  canBranchBefore?: boolean
  children: ReactElement
}) {
  if (!onBranch) return children
  const copy = (): void => {
    const selected = window.getSelection()?.toString()
    void api.copyText(selected || messageText(msgs))
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onBranch(id, 'include')}>
          <GitBranchPlus /> Branch from here
        </ContextMenuItem>
        {canBranchBefore && (
          <ContextMenuItem onSelect={() => onBranch(id, 'before')}>
            <Undo2 /> Branch from before this message
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={copy}>
          <Copy /> Copy
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ---------------------------------------------------------------------------

function Thinking({
  text,
  redacted,
  forceOpen
}: {
  text: string
  redacted?: boolean
  forceOpen?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (redacted) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted-foreground">
        <Brain className="size-3.5" /> Thinking (redacted)
      </div>
    )
  }
  const preview = text.replace(/\s+/g, ' ').slice(0, 140)
  return (
    <Collapsible
      open={open || !!forceOpen}
      onToggle={() => setOpen((v) => !v)}
      header={
        <>
          <Brain className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Thinking</span>
          {!open && !forceOpen && (
            <span className="min-w-0 truncate text-muted-foreground italic">{preview}</span>
          )}
        </>
      }
    >
      <div className="border-l-2 border-border pl-3 text-muted-foreground">
        <Markdown text={text} className="text-[13px]" />
      </div>
    </Collapsible>
  )
}

function UserBubble({ msg, onBranch }: { msg: ChatMessage; onBranch?: OnBranch }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 4)
  }, [msg])
  return (
    <div className="flex flex-col items-end">
      <div className="mb-1 flex items-center gap-2 pr-1 text-2xs text-subtle-foreground">
        <span className="font-medium text-muted-foreground">You</span>
        {msg.timestamp && <span>{formatTime(msg.timestamp)}</span>}
      </div>
      <MessageMenu id={msg.id} msgs={[msg]} onBranch={onBranch} canBranchBefore>
        <div className="group/msg relative max-w-[82%] rounded-2xl rounded-tr-md border border-user-bubble-border bg-user-bubble px-4 py-2.5 shadow-xs">
          {onBranch && <BranchButton side="left" onClick={() => onBranch(msg.id, 'include')} />}
          <div ref={ref} className={cn(!expanded && 'max-h-[340px] overflow-hidden')}>
            {msg.blocks.map((b, i) =>
              b.type === 'text' ? (
                <Markdown key={i} text={b.text} breaks />
              ) : b.type === 'image' ? (
                <div
                  key={i}
                  className="my-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-xs text-muted-foreground"
                >
                  <ImageIcon className="size-3.5" /> Image
                  {b.mediaType ? ` (${b.mediaType.replace('image/', '')})` : ''}
                </div>
              ) : b.type === 'tool_result' ? (
                <OrphanResult key={i} result={b.result} />
              ) : null
            )}
          </div>
          {overflows && !expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-2xl bg-gradient-to-t from-user-bubble to-transparent" />
          )}
          {(overflows || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="relative mt-1 inline-flex items-center gap-1 rounded px-1 text-2xs font-medium text-primary hover:bg-hover"
            >
              <ChevronDown
                className={cn('size-3 transition-transform', expanded && 'rotate-180')}
              />
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      </MessageMenu>
    </div>
  )
}

function AssistantTurn({
  msgs,
  cwd,
  open,
  findQuery,
  onBranch
}: {
  msgs: ChatMessage[]
  cwd?: string
  open: Set<string>
  findQuery?: string
  onBranch?: OnBranch
}) {
  const first = msgs[0]
  const model = msgs.find((m) => m.model)?.model
  // Flatten blocks so consecutive tool calls form one group.
  const items: { m: ChatMessage; b: ContentBlock; i: number }[] = []
  for (const m of msgs) m.blocks.forEach((b, i) => items.push({ m, b, i }))
  const groups: (typeof items)[] = []
  for (const it of items) {
    const isTool = it.b.type !== 'text'
    const last = groups[groups.length - 1]
    if (isTool && last && last[0].b.type !== 'text') last.push(it)
    else groups.push([it])
  }
  return (
    <div className="flex gap-3">
      <ClaudeMark className="mt-0.5 size-6 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-2xs text-subtle-foreground">
          <span className="font-medium text-muted-foreground">Claude</span>
          {first.timestamp && <span>{formatTime(first.timestamp)}</span>}
          {model && (
            <span className="truncate">{model.replace(/^claude-/, '').replace(/-\d{8}$/, '')}</span>
          )}
        </div>
        <div className="space-y-2">
          {groups.map((g) => {
            const head = g[0]
            // Branching at a group means: up to the last message in it.
            const at = g[g.length - 1].m
            const groupMsgs = [...new Set(g.map((x) => x.m))]
            if (head.b.type === 'text') {
              return (
                <MessageMenu
                  key={`${head.m.id}:${head.i}`}
                  id={at.id}
                  msgs={groupMsgs}
                  onBranch={onBranch}
                >
                  <div className="group/msg relative w-fit max-w-full rounded-2xl rounded-tl-md border border-assistant-bubble-border bg-assistant-bubble px-4 py-2.5 shadow-xs">
                    {onBranch && (
                      <BranchButton side="right" onClick={() => onBranch(at.id, 'include')} />
                    )}
                    <Markdown text={head.b.text} />
                  </div>
                </MessageMenu>
              )
            }
            return (
              <MessageMenu
                key={`${head.m.id}:${head.i}`}
                id={at.id}
                msgs={groupMsgs}
                onBranch={onBranch}
              >
                <div className="max-w-full overflow-hidden rounded-xl border border-border bg-background/50 p-1">
                  {g.map(({ m, b, i }) => {
                    const id = blockId(m, b, i)
                    if (b.type === 'tool_use')
                      return (
                        <ToolCall
                          key={id}
                          tool={b}
                          cwd={cwd}
                          forceOpen={open.has(id)}
                          findQuery={findQuery}
                        />
                      )
                    if (b.type === 'thinking')
                      return (
                        <Thinking
                          key={id}
                          text={b.text}
                          redacted={b.redacted}
                          forceOpen={open.has(id)}
                        />
                      )
                    if (b.type === 'tool_result')
                      return (
                        <OrphanResult
                          key={id}
                          result={b.result}
                          findQuery={findQuery}
                          forceOpen={open.has(id)}
                        />
                      )
                    if (b.type === 'image')
                      return (
                        <div
                          key={id}
                          className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted-foreground"
                        >
                          <ImageIcon className="size-3.5" /> Image
                        </div>
                      )
                    return null
                  })}
                </div>
              </MessageMenu>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function EventRow({ msg, forceOpen }: { msg: ChatMessage; forceOpen?: boolean }) {
  const [open, setOpen] = useState(false)
  const text = msg.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
  if (msg.kind === 'command') {
    return (
      <div className="flex justify-end">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 font-mono text-[11.5px] text-foreground">
          <SquareTerminal className="size-3.5 text-muted-foreground" />
          <span className="selectable">{text}</span>
          {msg.timestamp && (
            <span className="ml-1 font-sans text-2xs text-subtle-foreground">
              {formatTime(msg.timestamp)}
            </span>
          )}
        </div>
      </div>
    )
  }
  if (msg.kind === 'command-output') {
    return (
      <div className="flex justify-end">
        <pre className="selectable max-w-[82%] overflow-x-auto rounded-lg border border-code-border bg-code-bg px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
          {text}
        </pre>
      </div>
    )
  }
  const isCompact = msg.kind === 'compact'
  return (
    <div>
      <div className="flex items-center gap-3 text-2xs text-subtle-foreground">
        <div className="h-px flex-1 bg-border" />
        {isCompact ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium hover:bg-hover hover:text-foreground"
          >
            <Layers className="size-3" />
            Compaction summary
            <ChevronDown
              className={cn('size-3 transition-transform', (open || forceOpen) && 'rotate-180')}
            />
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Layers className="size-3" />
            {text}
          </span>
        )}
        <div className="h-px flex-1 bg-border" />
      </div>
      {isCompact && (open || forceOpen) && (
        <div className="mx-auto mt-2 max-w-[90%] rounded-lg border border-dashed border-border px-4 py-2.5 text-muted-foreground">
          <Markdown text={text} className="text-[12.5px]" />
        </div>
      )}
    </div>
  )
}

export const Transcript = memo(function Transcript({
  messages,
  cwd,
  findQuery,
  onBranch,
  marks,
  className
}: {
  messages: ChatMessage[]
  cwd?: string
  findQuery: string
  onBranch?: OnBranch
  /** Branch markers, keyed by the message they follow. */
  marks?: Map<string, BranchMark[]>
  /** Overrides for the outer padding (narrower on a phone). */
  className?: string
}) {
  const turns = useMemo(() => groupTurns(messages), [messages])
  // Markers go after the turn that holds their message.
  const marksByTurn = useMemo(() => {
    const out = new Map<string, BranchMark[]>()
    if (!marks?.size) return out
    for (const t of turns) {
      const ids = t.kind === 'assistant' ? t.msgs.map((m) => m.id) : [t.msg.id]
      const found = ids.flatMap((id) => marks.get(id) ?? [])
      if (found.length) out.set(t.id, found)
    }
    return out
  }, [turns, marks])
  const open = useMemo(() => blocksMatching(messages, findQuery), [messages, findQuery])
  // Show a date separator before the first turn of each day.
  const dayStarts = useMemo(() => {
    const out = new Set<string>()
    let last = ''
    for (const t of turns) {
      const ts = turnTime(t)
      const day = ts ? new Date(ts).toDateString() : ''
      if (day && day !== last) out.add(t.id)
      if (day) last = day
    }
    return out
  }, [turns])
  if (!messages.length) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        This session has no messages yet.
      </div>
    )
  }
  return (
    <div className={cn('mx-auto max-w-[860px] space-y-5 px-8 pt-6 pb-24', className)}>
      {turns.map((t) => {
        const ts = turnTime(t)
        const showDay = dayStarts.has(t.id) && ts
        return (
          <ErrorBoundary key={t.id} fallback={<RenderFailed what="This part of the session" />}>
            <div className="turn">
              {showDay && (
                <div className="mb-5 flex items-center gap-3 text-2xs font-medium text-subtle-foreground">
                  <div className="h-px flex-1 bg-border" />
                  {dayLabel(ts!)}
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}
              {t.kind === 'user' && (
                <UserBubble msg={t.msg} onBranch={t.msg.kind === 'prompt' ? onBranch : undefined} />
              )}
              {t.kind === 'assistant' && (
                <AssistantTurn
                  msgs={t.msgs}
                  cwd={cwd}
                  open={open}
                  findQuery={findQuery}
                  onBranch={onBranch}
                />
              )}
              {t.kind === 'event' && <EventRow msg={t.msg} forceOpen={open.has(t.msg.id)} />}
              {marksByTurn.has(t.id) && <BranchMarks marks={marksByTurn.get(t.id)!} />}
            </div>
          </ErrorBoundary>
        )
      })}
    </div>
  )
})
