import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  FileCode,
  GitBranchPlus,
  Hexagon,
  Image as ImageIcon,
  Layers,
  SquareTerminal,
  Type,
  Undo2
} from 'lucide-react'
import type { ChatMessage, ContentBlock } from '@shared/types'
import { blockIdOf } from '@shared/transcript-cut'
import {
  blockId,
  blocksMatching,
  blocksOfMessages,
  dayLabel,
  groupTurns,
  searchText,
  turnTime,
  type Turn
} from '@/lib/transcript'
import { formatTime } from '@shared/format'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/actions'
import { blocksToMarkdown, blocksToPlainText } from '@/lib/copy'
import { Markdown } from './Markdown'
import { ErrorBoundary, RenderFailed } from '../ErrorBoundary'
import { Collapsible, OrphanResult, ToolCall } from './ToolCall'
import { useOpenState } from '@/lib/open-state'
import type { CitedMessages } from '@/lib/focus-message'
import { BranchMarks, type BranchMark } from './Branches'
import { ClaudeMark } from '../brand'
import { PROVIDER_SHORT, type ProviderId } from '@shared/provider'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip } from '../ui/tooltip'
import { SpriteIcon } from '../ui/sprite-icon'

export type OnBranch = (messageId: string, mode: 'include' | 'before') => void

// ---------------------------------------------------------------------------
// Message actions: Copy and a ⋯ menu on each message (shown on hover on a
// desktop, always on a phone), plus a right-click menu for the mouse.

/** No hover on this device (a phone or tablet): hover-only controls stay visible. */
const noHover = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(hover: none)').matches

/**
 * Copy · Branch · ⋯ for one message or tool group, in one of three layouts:
 * - `pill` (desktop): floats on the bubble's top edge, shown on hover.
 * - `inline` (desktop): a small row at the top of a tool group.
 * - `row` (touch): a full-width row at the bottom with 40px buttons. It sticks to
 *   the bottom of the screen while the message runs past it, so Copy is always
 *   in reach, even in the middle of a long message.
 * Pill and row are one element (CSS switches it on touch devices); `inline`
 * groups render a separate `row` for touch.
 */
function MessageActions({
  id,
  blocks,
  side,
  layout = 'pill',
  rowClassName,
  onBranch,
  canBranchBefore
}: {
  id: string
  blocks: ContentBlock[]
  side: 'left' | 'right'
  layout?: 'pill' | 'inline' | 'row'
  /** Touch row background, matching what it sits on, so text scrolls under it cleanly. */
  rowClassName?: string
  onBranch?: OnBranch
  canBranchBefore?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const copyMarkdown = (): Promise<boolean> => copyText(blocksToMarkdown(blocks))
  const copyPlain = (): void => void copyText(blocksToPlainText(blocks))
  const btn =
    'inline-flex h-6 items-center justify-center gap-1 rounded-full px-1.5 text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring touch:h-10 touch:min-w-10 touch:rounded-lg touch:px-3 touch:text-[13px] touch:text-foreground touch:active:bg-hover [&_svg]:touch:size-4'
  const touchRow = cn(
    'touch:sticky touch:top-auto touch:right-auto touch:bottom-0 touch:left-auto touch:z-[5] touch:-mx-2 touch:mt-2 touch:-mb-1 touch:flex touch:h-auto touch:w-auto touch:gap-1 touch:rounded-none touch:border-0 touch:border-t touch:border-border/70 touch:px-1 touch:pt-1 touch:opacity-100 touch:shadow-none',
    rowClassName
  )
  return (
    <div
      data-message-actions
      data-find-skip
      className={cn(
        'z-10 flex h-6 w-max items-center rounded-full border border-border bg-popover text-2xs font-medium shadow-sm transition-opacity duration-100',
        layout === 'inline' && 'ml-auto opacity-90 touch:hidden',
        layout === 'pill' &&
          cn(
            'absolute -top-3 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100',
            side === 'left' ? 'left-3' : 'right-3',
            touchRow
          ),
        layout === 'row' && cn('hidden', touchRow),
        menuOpen && 'opacity-100'
      )}
    >
      <button
        type="button"
        aria-label="Copy message"
        className={btn}
        onClick={() =>
          void copyMarkdown().then((ok) => {
            if (!ok) return
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }
      >
        {copied ? (
          <SpriteIcon icon={Check} name="check" className="size-3" />
        ) : (
          <SpriteIcon icon={Copy} name="copy" className="size-3" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {onBranch && (
        <Tooltip content="Branch from here: continue in a new session from this message">
          <button
            type="button"
            aria-label="Branch from here"
            onClick={() => onBranch(id, 'include')}
            className={cn(btn, 'touch:hidden')}
          >
            <SpriteIcon icon={GitBranchPlus} name="git-branch-plus" className="size-3" /> Branch
          </button>
        </Tooltip>
      )}
      <DropdownMenu onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More message actions" className={btn}>
            <SpriteIcon icon={Ellipsis} name="ellipsis" className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={side === 'left' ? 'start' : 'end'} className="w-60">
          <DropdownMenuItem onSelect={copyPlain}>
            <Type /> Copy as plain text
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyMarkdown()}>
            <FileCode /> Copy as Markdown
          </DropdownMenuItem>
          {onBranch && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onBranch(id, 'include')}>
                <GitBranchPlus /> Branch from here
              </DropdownMenuItem>
              {canBranchBefore && (
                <DropdownMenuItem onSelect={() => onBranch(id, 'before')}>
                  <Undo2 /> Branch from before this message
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * Right-click menu for the mouse. Touch and pen never open it: Radix's context
 * menu turns a long-press into its own menu and cancels the native one, which
 * is what stopped long-press text selection on phones. There, the same items
 * live in the ⋯ button.
 */
function MessageMenu({
  id,
  blocks,
  onBranch,
  canBranchBefore,
  children
}: {
  id: string
  blocks: ContentBlock[]
  onBranch?: OnBranch
  canBranchBefore?: boolean
  children: ReactElement
}) {
  const [touch, setTouch] = useState(noHover)
  const copy = (): void => {
    const selected = window.getSelection()?.toString()
    void copyText(selected || blocksToMarkdown(blocks))
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        disabled={touch}
        // Radix sets -webkit-touch-callout: none on the trigger; keep the native callout.
        style={{ WebkitTouchCallout: 'default' }}
        onPointerDown={(e) => setTouch(e.pointerType !== 'mouse')}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={copy}>
          <Copy /> Copy
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyText(blocksToPlainText(blocks))}>
          <Type /> Copy as plain text
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyText(blocksToMarkdown(blocks))}>
          <FileCode /> Copy as Markdown
        </ContextMenuItem>
        {onBranch && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => onBranch(id, 'include')}>
              <GitBranchPlus /> Branch from here
            </ContextMenuItem>
            {canBranchBefore && (
              <ContextMenuItem onSelect={() => onBranch(id, 'before')}>
                <Undo2 /> Branch from before this message
              </ContextMenuItem>
            )}
          </>
        )}
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

/** "/root" is the main agent; others are its subagents ("/root/worker_1"). */
function agentName(path: string): string {
  return path === '/root' ? 'main agent' : path
}

/** A message between agents (Codex): collapsed, with who sent it to whom. */
function AgentMessage({
  author,
  recipient,
  text,
  forceOpen,
  openSignal
}: {
  author: string
  recipient: string
  text: string
  forceOpen?: boolean
  openSignal?: number
}) {
  const [open, setOpen] = useOpenState(openSignal)
  const [copied, setCopied] = useState(false)
  const preview = text.replace(/\s+/g, ' ').slice(0, 140)
  const shown = open || !!forceOpen
  return (
    <Collapsible
      open={shown}
      onToggle={() => setOpen((v) => !v)}
      header={
        <>
          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium whitespace-nowrap">Agent → Agent</span>
          <span className="max-w-[45%] shrink-0 truncate font-mono text-2xs whitespace-nowrap text-muted-foreground">
            <span aria-label="From">{agentName(author)}</span>
            {' → '}
            <span aria-label="To">{agentName(recipient)}</span>
          </span>
          {!shown && (
            <span className="min-w-0 truncate text-muted-foreground italic">{preview}</span>
          )}
        </>
      }
    >
      <div className="border-l-2 border-border pl-3">
        <dl className="mb-1.5 grid grid-cols-[auto_1fr] gap-x-2 text-2xs text-muted-foreground">
          <dt>From</dt>
          <dd className="font-mono">{author}</dd>
          <dt>To</dt>
          <dd className="font-mono">{recipient}</dd>
        </dl>
        <Markdown text={text} className="text-[13px]" />
        <div data-find-skip className="mt-1 flex gap-1">
          <button
            type="button"
            aria-label="Copy agent message"
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring touch:h-10 touch:px-3"
            onClick={() =>
              void copyText(text).then((ok) => {
                if (!ok) return
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              })
            }
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? 'Copied' : 'Copy message'}
          </button>
          <button
            type="button"
            aria-label="Copy sender and recipient"
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring touch:h-10 touch:px-3"
            onClick={() => void copyText(`${author} → ${recipient}`)}
          >
            <Copy className="size-3" /> Copy from → to
          </button>
        </div>
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
      <div className="mb-3 flex items-center gap-2 pr-1 text-2xs text-subtle-foreground">
        <span className="font-medium text-muted-foreground">You</span>
        {msg.timestamp && <span>{formatTime(msg.timestamp)}</span>}
      </div>
      <MessageMenu id={msg.id} blocks={msg.blocks} onBranch={onBranch} canBranchBefore>
        <div className="group/msg relative max-w-[82%] rounded-2xl rounded-tr-md border border-user-bubble-border bg-user-bubble px-4 py-2.5 shadow-xs touch:min-w-40">
          <div className="relative">
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
                  <OrphanResult key={i} result={b.result} blockId={blockIdOf(msg, b, i)} />
                ) : null
              )}
            </div>
            {overflows && !expanded && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-user-bubble to-transparent" />
            )}
          </div>
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
          <MessageActions
            id={msg.id}
            blocks={msg.blocks}
            side="right"
            rowClassName="touch:bg-user-bubble"
            onBranch={onBranch}
            canBranchBefore
          />
        </div>
      </MessageMenu>
    </div>
  )
}

type TurnItem = { m: ChatMessage; b: ContentBlock; i: number }

/** A tool group's blocks split into runs of the same message, in order. */
function runsByMessage(g: TurnItem[]): TurnItem[][] {
  const runs: TurnItem[][] = []
  for (const it of g) {
    const last = runs[runs.length - 1]
    if (last && last[0].m.id === it.m.id) last.push(it)
    else runs.push([it])
  }
  return runs
}

function AssistantTurn({
  msgs,
  cwd,
  open,
  citedOpen,
  citeNonce,
  findQuery,
  onBranch,
  agent = 'claude'
}: {
  msgs: ChatMessage[]
  cwd?: string
  /** Blocks find keeps open. */
  open: Set<string>
  /** Blocks an Ask citation opens once (citeNonce: which citation). */
  citedOpen?: Set<string>
  citeNonce?: number
  findQuery?: string
  onBranch?: OnBranch
  agent?: ProviderId
}) {
  const first = msgs[0]
  const [touch] = useState(noHover)
  const model = msgs.find((m) => m.model)?.model
  // Flatten blocks so consecutive tool calls form one group.
  const items: TurnItem[] = []
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
      {agent === 'claude' ? (
        <ClaudeMark className="mt-0.5 size-6 shrink-0" />
      ) : (
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
          <Hexagon className="size-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center gap-2 text-2xs text-subtle-foreground">
          <span className="font-medium text-muted-foreground">{PROVIDER_SHORT[agent]}</span>
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
            // Copy takes what this bubble shows, not the whole message it came from.
            const groupBlocks = g.map((x) => x.b)
            if (head.b.type === 'text') {
              return (
                <MessageMenu
                  key={`${head.m.id}:${head.i}`}
                  id={at.id}
                  blocks={groupBlocks}
                  onBranch={onBranch}
                >
                  <div
                    // Its message: a citation from Ask scrolls to this bubble, not the whole turn.
                    data-msg-id={head.m.id}
                    className="group/msg relative w-fit max-w-full rounded-2xl rounded-tl-md border border-assistant-bubble-border bg-assistant-bubble px-4 py-2.5 shadow-xs touch:min-w-40"
                  >
                    <Markdown text={head.b.text} />
                    <MessageActions
                      id={at.id}
                      blocks={groupBlocks}
                      side="left"
                      rowClassName="touch:bg-assistant-bubble"
                      onBranch={onBranch}
                    />
                  </div>
                </MessageMenu>
              )
            }
            // A tool group: desktop gets a small action row at the top, touch a
            // sticky one at the bottom. overflow-clip, not hidden: hidden would
            // make this box a scroll container and stop the sticky rows.
            return (
              <MessageMenu
                key={`${head.m.id}:${head.i}`}
                id={at.id}
                blocks={groupBlocks}
                onBranch={onBranch}
              >
                <div className="max-w-full overflow-clip rounded-xl border border-border bg-background/50 p-1">
                  <MessageActions
                    id={at.id}
                    blocks={groupBlocks}
                    side="right"
                    layout="inline"
                    onBranch={onBranch}
                  />
                  {runsByMessage(g).map((run) => (
                    // Each message's own part of the group: a citation scrolls to
                    // it, not to the whole group (which can be screens long).
                    <div key={`${run[0].m.id}:${run[0].i}`} data-msg-id={run[0].m.id}>
                      {run.map(({ m, b, i }) => {
                        const id = blockId(m, b, i)
                        const signal = citedOpen?.has(id) ? citeNonce : undefined
                        if (b.type === 'tool_use')
                          return (
                            <ToolCall
                              key={id}
                              tool={b}
                              cwd={cwd}
                              forceOpen={open.has(id)}
                              openSignal={signal}
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
                        if (b.type === 'agent_message')
                          return (
                            <AgentMessage
                              key={id}
                              author={b.author}
                              recipient={b.recipient}
                              text={b.text}
                              forceOpen={open.has(id)}
                              openSignal={signal}
                            />
                          )
                        if (b.type === 'tool_result')
                          return (
                            <OrphanResult
                              key={id}
                              blockId={id}
                              result={b.result}
                              findQuery={findQuery}
                              forceOpen={open.has(id)}
                              openSignal={signal}
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
                  ))}
                  {/* The touch row: only on a touch device (on a desktop it's never shown). */}
                  {touch && (
                    <MessageActions
                      id={at.id}
                      blocks={groupBlocks}
                      side="right"
                      layout="row"
                      rowClassName="touch:mx-0 touch:-mb-1 touch:bg-background"
                      onBranch={onBranch}
                    />
                  )}
                </div>
              </MessageMenu>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function EventRow({
  msg,
  forceOpen,
  openSignal
}: {
  msg: ChatMessage
  forceOpen?: boolean
  openSignal?: number
}) {
  const [open, setOpen] = useOpenState(openSignal)
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

/** Message ids of a turn. */
const turnIds = (t: Turn): string[] =>
  t.kind === 'assistant' ? t.msgs.map((m) => m.id) : [t.msg.id]

/** A turn's searchable text, lower-cased (what find can match in it). */
function turnText(t: Turn): string {
  const msgs = t.kind === 'assistant' ? t.msgs : [t.msg]
  return msgs
    .flatMap((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : searchText(b))))
    .join('\n')
    .toLowerCase()
}

/** Turns are drawn only near the screen when there are more than this. */
const VIRTUAL_FROM = 40
/** A turn's height before it's drawn (it's measured once it is). */
const TURN_ESTIMATE = 240

export const Transcript = memo(function Transcript({
  messages,
  cwd,
  findQuery,
  onBranch,
  marks,
  className,
  agent = 'claude',
  cited,
  scrollRef,
  pinIds,
  extraOpen
}: {
  messages: ChatMessage[]
  cwd?: string
  findQuery: string
  onBranch?: OnBranch
  /** Whose replies these are (the avatar and name). */
  agent?: ProviderId
  /** Branch markers, keyed by the message they follow. */
  marks?: Map<string, BranchMark[]>
  /** Overrides for the outer padding (narrower on a phone). */
  className?: string
  /** The messages an Ask citation points at: their tool calls and agent messages open (once). */
  cited?: CitedMessages
  /**
   * The scrolling element the transcript is in: with it, a long transcript
   * draws only the turns near the screen (plus those find matches and
   * citations are in). Without it, every turn is drawn.
   */
  scrollRef?: RefObject<HTMLElement | null>
  /** Messages whose turns stay drawn (a citation being scrolled to). */
  pinIds?: readonly string[]
  /** More blocks find keeps open (cut tool outputs that match past the cut). */
  extraOpen?: ReadonlySet<string>
}) {
  const turns = useMemo(() => groupTurns(messages), [messages])
  // Markers go after the turn that holds their message.
  const marksByTurn = useMemo(() => {
    const out = new Map<string, BranchMark[]>()
    if (!marks?.size) return out
    for (const t of turns) {
      const found = turnIds(t).flatMap((id) => marks.get(id) ?? [])
      if (found.length) out.set(t.id, found)
    }
    return out
  }, [turns, marks])
  const open = useMemo(() => {
    const s = blocksMatching(messages, findQuery)
    if (findQuery.trim()) for (const id of extraOpen ?? []) s.add(id)
    return s
  }, [messages, findQuery, extraOpen])
  const citedOpen = useMemo(
    () => (cited ? blocksOfMessages(messages, cited.ids) : undefined),
    [messages, cited]
  )
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

  const virtual = !!scrollRef && turns.length > VIRTUAL_FROM
  // Which turn each message and block is in (to keep find matches and citations drawn).
  const where = useMemo(() => {
    const byMsg = new Map<string, number>()
    const byBlock = new Map<string, number>()
    if (!virtual) return { byMsg, byBlock }
    turns.forEach((t, i) => {
      for (const m of t.kind === 'assistant' ? t.msgs : [t.msg]) {
        byMsg.set(m.id, i)
        m.blocks.forEach((b, j) => byBlock.set(blockIdOf(m, b, j), i))
      }
    })
    return { byMsg, byBlock }
  }, [turns, virtual])
  const texts = useMemo(() => (virtual ? turns.map(turnText) : []), [turns, virtual])
  // Turns drawn whatever is on screen: find matches (so find counts, highlights and
  // goes to every one of them) and the citation being scrolled to.
  const pinned = useMemo(() => {
    const out = new Set<number>()
    if (!virtual) return out
    const q = findQuery.trim().toLowerCase()
    if (q) {
      texts.forEach((x, i) => {
        if (x.includes(q)) out.add(i)
      })
      for (const id of extraOpen ?? []) {
        const i = where.byBlock.get(id)
        if (i !== undefined) out.add(i)
      }
    }
    for (const id of [...(pinIds ?? []), ...(cited?.ids ?? [])]) {
      const i = where.byMsg.get(id)
      if (i !== undefined) out.add(i)
    }
    return out
  }, [virtual, findQuery, texts, extraOpen, pinIds, cited, where])

  const listRef = useRef<HTMLDivElement>(null)
  // Where the list starts in the scrolling element (the header above it can change height).
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    if (!virtual) return
    const measure = (): void => {
      const list = listRef.current
      const scroller = scrollRef?.current
      if (!list || !scroller) return
      const m =
        list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      setMargin((prev) => (Math.abs(prev - m) < 1 ? prev : m))
    }
    measure()
    const scroller = scrollRef?.current
    if (!scroller) return
    // On the next frame: measuring inside the callback would loop the observer.
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    for (const child of Array.from(scroller.children)) ro.observe(child)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [virtual, scrollRef])
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: virtual ? turns.length : 0,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => TURN_ESTIMATE,
    getItemKey: (i) => turns[i].id,
    scrollMargin: margin,
    overscan: 4,
    rangeExtractor: (range) => {
      const base = defaultRangeExtractor(range)
      if (!pinned.size) return base
      return [...new Set([...base, ...pinned])].sort((a, b) => a - b)
    }
  })

  if (!messages.length) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        This session has no messages yet.
      </div>
    )
  }
  const turnView = (t: Turn): ReactElement => {
    const ts = turnTime(t)
    const showDay = dayStarts.has(t.id) && ts
    return (
      <ErrorBoundary key={t.id} fallback={<RenderFailed what="This part of the session" />}>
        <div
          className={virtual ? undefined : 'turn'}
          // The messages it shows: a citation from Ask scrolls to them.
          data-msg-ids={turnIds(t).join(' ')}
        >
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
              citedOpen={citedOpen}
              citeNonce={cited?.nonce}
              findQuery={findQuery}
              onBranch={onBranch}
              agent={agent}
            />
          )}
          {t.kind === 'event' && (
            <EventRow
              msg={t.msg}
              forceOpen={open.has(t.msg.id)}
              openSignal={citedOpen?.has(t.msg.id) ? cited?.nonce : undefined}
            />
          )}
          {marksByTurn.has(t.id) && <BranchMarks marks={marksByTurn.get(t.id)!} />}
        </div>
      </ErrorBoundary>
    )
  }
  if (!virtual)
    return (
      // The whole conversation is selectable, so a selection can start anywhere in
      // it and run across messages; buttons inside stay unselectable (styles.css).
      <div className={cn('selectable mx-auto max-w-[860px] space-y-5 px-8 pt-6 pb-24', className)}>
        {turns.map(turnView)}
      </div>
    )
  const items = v.getVirtualItems()
  return (
    <div className={cn('selectable mx-auto max-w-[860px] px-8 pt-6 pb-24', className)}>
      <div ref={listRef} className="relative" style={{ height: v.getTotalSize() }}>
        {items.map((it) => (
          <div
            key={it.key}
            data-index={it.index}
            ref={v.measureElement}
            className="absolute inset-x-0 top-0 pb-5"
            style={{ transform: `translateY(${it.start - margin}px)` }}
          >
            {turnView(turns[it.index])}
          </div>
        ))}
      </div>
    </div>
  )
})
