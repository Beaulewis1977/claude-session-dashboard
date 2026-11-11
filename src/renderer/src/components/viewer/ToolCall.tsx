import { memo, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  Bot,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  Plug,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import type { ContentBlock, ToolResult } from '@shared/types'
import { editItems, relativeTo, splitToolLabel, todoItems } from '@shared/tools'
import { cn } from '@/lib/utils'
import { truncateText } from '@/lib/transcript'
import { useOpenState } from '@/lib/open-state'
import { toolInputText, toolOutputText } from '@/lib/copy'
import { api } from '@/lib/api'
import { CUT, cutInput, holdsPast, INPUT_MATCH, OUTPUT_MATCH } from '@shared/transcript-cut'
import { ErrorBoundary, RenderFailed } from '../ErrorBoundary'
import { TranscriptContext } from './transcript-context'
import { SpriteIcon } from '../ui/sprite-icon'
import { CodeBlock, CopyButton } from './Markdown'

type ToolUse = Extract<ContentBlock, { type: 'tool_use' }>

/** Codex's shell tools (its file names differ between versions). */
const CODEX_SHELL = new Set([
  'shell',
  'shell_command',
  'exec_command',
  'local_shell',
  'container.exec'
])

/** A Codex shell call's command, as text (`["bash", "-lc", "npm test"]` → `npm test`). */
function codexCommand(i: Record<string, unknown>): string {
  const c = i.command ?? i.cmd
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  const parts = c.filter((x): x is string => typeof x === 'string')
  if (parts.length === 3 && /^(ba)?sh$|powershell|pwsh|cmd/i.test(parts[0])) return parts[2]
  return parts.join(' ')
}

function toolIcon(name: string): [typeof Wrench, string] {
  if (name === 'Bash' || name === 'PowerShell' || CODEX_SHELL.has(name))
    return [SquareTerminal, 'terminal']
  if (name === 'apply_patch') return [FilePen, 'file-pen']
  if (name === 'web_search') return [Globe, 'globe']
  if (name === 'update_plan') return [ListChecks, 'list-checks']
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return [FilePen, 'file-pen']
  if (name === 'Read' || name === 'NotebookRead') return [FileText, 'file-text']
  if (name === 'Grep') return [Search, 'search']
  if (name === 'Glob' || name === 'LS') return [FolderSearch, 'folder-search']
  if (name === 'WebFetch' || name === 'WebSearch') return [Globe, 'globe']
  if (name === 'Task' || name === 'Agent') return [Bot, 'bot']
  if (name === 'TodoWrite') return [ListChecks, 'list-checks']
  if (name.startsWith('mcp__')) return [Plug, 'plug']
  return [Wrench, 'wrench']
}

/** A tool's icon (from the sprite: a long session has hundreds). */
function ToolIcon({ name, className }: { name: string; className?: string }) {
  const [icon, id] = toolIcon(name)
  return <SpriteIcon icon={icon} name={id} className={className} />
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function Diff({ oldText, newText, path }: { oldText: string; newText: string; path?: string }) {
  const lines = [
    ...oldText.split('\n').map((l) => ({ t: '-', l })),
    ...newText.split('\n').map((l) => ({ t: '+', l }))
  ]
  return (
    <div className="overflow-hidden rounded-lg border border-code-border bg-code-bg">
      {path && (
        <div className="flex h-7 items-center border-b border-code-border/70 px-3 font-mono text-2xs text-subtle-foreground">
          {path}
        </div>
      )}
      <pre className="selectable overflow-x-auto py-1.5 font-mono text-[12px] leading-[1.6]">
        {lines.map((x, i) => (
          <div
            key={i}
            className={cn(
              'px-3',
              x.t === '-'
                ? 'bg-[var(--hl-deletion-bg)] text-[var(--hl-deletion)]'
                : 'bg-[var(--hl-addition-bg)] text-[var(--hl-addition)]'
            )}
          >
            <span className="mr-3 inline-block w-2 select-none opacity-60">{x.t}</span>
            {x.l || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

function Todos({ todos }: { todos: { content: string; status: string }[] }) {
  return (
    <ul className="space-y-1 rounded-lg border border-code-border bg-code-bg px-3 py-2 text-[12.5px]">
      {todos.map((t, i) => (
        <li key={i} className="flex items-start gap-2">
          <span
            className={cn(
              'mt-[3px] inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border',
              t.status === 'completed' && 'border-success bg-success/15',
              t.status === 'in_progress' && 'border-primary bg-accent-soft',
              t.status !== 'completed' && t.status !== 'in_progress' && 'border-border-strong'
            )}
          >
            {t.status === 'completed' && <span className="size-1.5 rounded-full bg-success" />}
            {t.status === 'in_progress' && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
          <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** What a tool call's input view shows at first: whether it holds back part of the text, and how much there is. */
function inputPreview(tool: ToolUse): { truncated: boolean; lines: number; chars: number } {
  const i = (tool.input ?? {}) as Record<string, unknown>
  const of = (text: string, lines: number, chars: number) => {
    const t = truncateText(text, lines, chars)
    return { truncated: t.truncated, lines: t.totalLines, chars: text.length }
  }
  const none = { truncated: false, lines: 0, chars: 0 }
  if (CODEX_SHELL.has(tool.name) && codexCommand(i)) return none
  switch (tool.name) {
    case 'Bash':
    case 'PowerShell':
    case 'Edit':
    case 'MultiEdit':
    case 'TodoWrite':
      return none
    case 'Write':
      return of(s(i.content), WRITE_LINES, WRITE_CHARS)
    case 'apply_patch': {
      const patch = typeof tool.input === 'string' ? tool.input : s(i.input) || s(i.patch)
      if (patch) return of(patch, JSON_LINES, JSON_CHARS)
      break
    }
    case 'Task':
    case 'Agent':
      if (s(i.prompt)) return none
      break
  }
  return of(JSON.stringify(tool.input, null, 2) ?? '', JSON_LINES, JSON_CHARS)
}

/** A file being written shows this much until "Show full". */
const WRITE_LINES = 60
const WRITE_CHARS = 6000
/** A patch or a JSON input shows this much until "Show full". */
const JSON_LINES = 200
const JSON_CHARS = 20000

function ToolInput({ tool, cwd, full }: { tool: ToolUse; cwd?: string; full?: boolean }) {
  const i = (tool.input ?? {}) as Record<string, unknown>
  const preview = (text: string, lines: number, chars: number): string =>
    full ? text : truncateText(text, lines, chars).text
  const path = s(i.file_path) || s(i.notebook_path)
  if (CODEX_SHELL.has(tool.name) && codexCommand(i))
    return (
      <CodeBlock language="bash">
        <code>{codexCommand(i)}</code>
      </CodeBlock>
    )
  switch (tool.name) {
    case 'Bash':
    case 'PowerShell':
      return (
        <CodeBlock language={tool.name === 'Bash' ? 'bash' : 'powershell'}>
          <code>{s(i.command)}</code>
        </CodeBlock>
      )
    case 'Edit':
      return (
        <Diff
          oldText={s(i.old_string)}
          newText={s(i.new_string)}
          path={path ? relativeTo(path, cwd) : undefined}
        />
      )
    case 'MultiEdit':
      return (
        <div className="space-y-2">
          {editItems(i).map((e, n) => (
            <Diff
              key={n}
              oldText={e.oldText}
              newText={e.newText}
              path={n === 0 && path ? relativeTo(path, cwd) : undefined}
            />
          ))}
        </div>
      )
    case 'Write':
      return (
        <CodeBlock language={path ? relativeTo(path, cwd) : 'file'}>
          <code>{preview(s(i.content), WRITE_LINES, WRITE_CHARS)}</code>
        </CodeBlock>
      )
    case 'TodoWrite':
      return <Todos todos={todoItems(i)} />
    case 'apply_patch': {
      // Codex's patch: its input is the patch text itself.
      const patch = typeof tool.input === 'string' ? tool.input : s(i.input) || s(i.patch)
      if (patch)
        return (
          <CodeBlock language="diff">
            <code>{preview(patch, JSON_LINES, JSON_CHARS)}</code>
          </CodeBlock>
        )
      break
    }
    case 'Task':
    case 'Agent':
      if (s(i.prompt))
        return (
          <div className="selectable rounded-lg border border-code-border bg-code-bg px-3 py-2 text-[12.5px] whitespace-pre-wrap">
            {s(i.prompt)}
          </div>
        )
      break
  }
  return (
    <CodeBlock language="json">
      <code>{preview(JSON.stringify(tool.input, null, 2) ?? '', JSON_LINES, JSON_CHARS)}</code>
    </CodeBlock>
  )
}

/** A tool call in full: its input as it is, or asked for when it was sent cut. */
async function fullInputTool(tool: ToolUse, sessionKey: string | undefined): Promise<ToolUse> {
  if (!tool.inputCut || !sessionKey) return tool
  const r = await api.getToolInput(sessionKey, tool.id).catch(() => null)
  if (!r) return tool
  const { inputCut: _cut, inputLazy: _lazy, ...rest } = tool
  return { ...rest, input: r.input }
}

/**
 * A tool call's input: a preview (a long file, edit or patch sent cut, or
 * held back by the view), with "Show full" for the rest, loaded when it was
 * sent cut. A find match in the hidden part shows it in full.
 */
function InputView(props: { tool: ToolUse; cwd?: string; findQuery?: string }) {
  const { sessionKey } = useContext(TranscriptContext)
  const { tool } = props
  // A very long transcript's placeholders: the input, cut as any other's, then shown as usual.
  const shown = useLazy(
    tool,
    !!tool.inputLazy && !!sessionKey,
    async () => {
      const full = await fullInputTool(tool, sessionKey)
      if (full === tool) return undefined
      const c = cutInput(full.input, CUT)
      return c ? { ...full, input: c.input, inputCut: c.cuts } : full
    },
    props.findQuery
  )
  if (!shown) return <Loading />
  return <InputBody {...props} tool={shown} />
}

function InputBody({ tool, cwd, findQuery }: { tool: ToolUse; cwd?: string; findQuery?: string }) {
  const { sessionKey, cutMatches, onMatchLoaded } = useContext(TranscriptContext)
  const [showFull, setShowFull] = useState(false)
  const [loaded, setLoaded] = useState<ToolUse>()
  const cut = tool.inputCut
  const view = inputPreview(tool)
  const q = findQuery?.trim().toLowerCase()
  // Cut, and the main process found the query past the cut (a later one too).
  const hiddenMatch = !!q && !!cut && cutMatches.has(tool.id + INPUT_MATCH)
  const full = showFull || hiddenMatch
  useEffect(() => {
    if (!full || !cut || loaded) return
    let gone = false
    void fullInputTool(tool, sessionKey).then((t) => {
      if (gone) return
      setLoaded(t)
      if (hiddenMatch) requestAnimationFrame(() => onMatchLoaded?.())
    })
    return () => {
      gone = true
    }
  }, [full, cut, loaded, tool, sessionKey, hiddenMatch, onMatchLoaded])
  const more = !!cut || view.truncated
  // The size of what's held back: the cut strings' full sizes, else the previewed text.
  const lines = cut ? cut.reduce((a, c) => a + c.lines, 0) : view.lines
  const chars = cut ? cut.reduce((a, c) => a + c.chars, 0) : view.chars
  const shown = full ? (loaded ?? tool) : tool
  return (
    <div>
      <ToolInput tool={shown} cwd={cwd} full={full} />
      {more && (
        <div data-find-skip className="px-1 pt-1">
          <button
            type="button"
            onClick={() => setShowFull((v) => !v)}
            className="rounded px-1.5 py-0.5 text-2xs font-medium text-primary hover:bg-hover"
          >
            {full
              ? 'Show less'
              : `Show full (${lines.toLocaleString()} line${lines === 1 ? '' : 's'}, ${chars.toLocaleString()} chars)`}
          </button>
        </div>
      )}
    </div>
  )
}

/** A tool output in full: as it is, or asked for when it was sent cut. */
async function fullOutput(
  result: ToolResult,
  sessionKey: string | undefined,
  id: string | undefined
): Promise<string> {
  if (!result.cut || !sessionKey || !id) return toolOutputText(result)
  const r = await api.getToolResult(sessionKey, id).catch(() => null)
  return r?.text ?? toolOutputText(result)
}

/** Loaded when shown: a lazy output (a placeholder, see transcript-cut.ts), else the value as it is. */
function useLazy<T>(
  value: T,
  lazy: boolean,
  load: () => Promise<T | undefined>,
  findQuery?: string
): T | undefined {
  const { onMatchLoaded } = useContext(TranscriptContext)
  const [loaded, setLoaded] = useState<{ from: T; value: T }>()
  useEffect(() => {
    if (!lazy || loaded?.from === value) return
    let gone = false
    void load().then((v) => {
      if (gone || v === undefined) return
      setLoaded({ from: value, value: v })
      // Find counts again once what it may match is there.
      if (findQuery?.trim()) requestAnimationFrame(() => onMatchLoaded?.())
    })
    return () => {
      gone = true
    }
    // load is made each render; value and lazy say when to load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, lazy])
  if (!lazy) return value
  return loaded?.from === value ? loaded.value : undefined
}

/** A placeholder line while a lazy output or input loads. */
function Loading() {
  return <div className="px-1 text-xs text-subtle-foreground italic">Loading…</div>
}

export function ResultView(props: {
  result: ToolResult
  findQuery?: string
  /** Its block's id: a cut output is asked for in full by it. */
  blockId?: string
}) {
  const { sessionKey } = useContext(TranscriptContext)
  const { result, blockId } = props
  // A very long transcript's placeholder: the whole output, then shown as usual.
  const shown = useLazy(
    result,
    !!result.cut?.lazy && !!sessionKey && !!blockId,
    async () => {
      const r = await api.getToolResult(sessionKey!, blockId!).catch(() => null)
      return r ?? undefined
    },
    props.findQuery
  )
  if (!shown) return <Loading />
  return <ResultBody {...props} result={shown} />
}

function ResultBody({
  result,
  findQuery,
  blockId
}: {
  result: ToolResult
  findQuery?: string
  blockId?: string
}) {
  const { sessionKey, cutMatches, onMatchLoaded } = useContext(TranscriptContext)
  const [showAll, setShowAll] = useState(false)
  const [fullText, setFullText] = useState<string>()
  const t = truncateText(result.text)
  const cut = result.cut
  const truncated = t.truncated || !!cut
  const totalLines = cut?.lines ?? t.totalLines
  const totalChars = cut?.chars ?? result.text.length
  // Expand automatically when a find match sits in the hidden part (past the cut too).
  // A match past what's shown: also when the preview holds one too (a later one is hidden).
  const q = findQuery?.trim().toLowerCase()
  const hiddenMatch =
    !!q &&
    truncated &&
    ((!!blockId && cutMatches.has(blockId + OUTPUT_MATCH)) ||
      holdsPast(result.text, t.text.length, q))
  const full = showAll || hiddenMatch
  // A cut output's full text, once it's to be shown.
  useEffect(() => {
    if (!full || !cut || fullText !== undefined) return
    let gone = false
    void fullOutput(result, sessionKey, blockId).then((x) => {
      if (gone) return
      setFullText(x)
      // Opened for a find match: find counts what's shown now.
      if (hiddenMatch) requestAnimationFrame(() => onMatchLoaded?.())
    })
    return () => {
      gone = true
    }
  }, [full, cut, fullText, result, sessionKey, blockId, hiddenMatch, onMatchLoaded])
  if (!result.text && !result.images) {
    return <div className="px-1 text-xs text-subtle-foreground italic">No output</div>
  }
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        result.isError ? 'border-destructive/30 bg-destructive/5' : 'border-code-border bg-code-bg'
      )}
    >
      <div className="flex h-7 items-center justify-between border-b border-inherit px-3 text-2xs text-subtle-foreground">
        <span className={cn('font-medium', result.isError && 'text-destructive')}>
          {result.isError ? 'Error' : 'Result'}
        </span>
        <span>
          {totalLines.toLocaleString()} line{totalLines === 1 ? '' : 's'}
          {result.images ? ` · ${result.images} image${result.images > 1 ? 's' : ''}` : ''}
        </span>
      </div>
      <pre
        className={cn(
          'selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap',
          result.isError && 'text-destructive'
        )}
      >
        {full ? (fullText ?? result.text) : t.text}
      </pre>
      {truncated && (
        <div className="border-t border-inherit px-2 py-1">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="rounded px-1.5 py-0.5 text-2xs font-medium text-primary hover:bg-hover"
          >
            {full
              ? 'Show less'
              : `Show all (${totalLines.toLocaleString()} lines, ${totalChars.toLocaleString()} chars)`}
          </button>
        </div>
      )}
    </div>
  )
}

// On touch devices: 40px buttons, and the row sticks to the top of the screen
// while the tool's output is in view, so Copy output is reachable in long output.
const touchCopy =
  'touch:h-10 touch:min-w-10 touch:whitespace-nowrap touch:rounded-lg touch:px-2.5 touch:text-[13px] touch:text-foreground touch:active:bg-hover [&_svg]:touch:size-4'

/** Copy input / Copy output for an expanded tool call (always the full text, never the preview). */
function CopyRow({
  input,
  output,
  blockId
}: {
  input?: () => string | Promise<string>
  output?: ToolResult
  blockId?: string
}) {
  const { sessionKey } = useContext(TranscriptContext)
  const hasOutput = !!output?.text
  if (!input && !hasOutput) return null
  return (
    <div
      data-find-skip
      className="-mt-0.5 flex justify-end gap-1 touch:sticky touch:top-[var(--tool-copy-top,0px)] touch:z-[4] touch:mt-0 touch:-mr-1 touch:-ml-[22px] touch:flex-wrap touch:gap-x-1 touch:gap-y-0 touch:bg-background touch:py-1"
    >
      {input && <CopyButton label="Copy input" getText={input} className={touchCopy} />}
      {hasOutput && (
        <CopyButton
          label="Copy output"
          getText={() => fullOutput(output!, sessionKey, blockId)}
          className={touchCopy}
        />
      )}
    </div>
  )
}

export function Collapsible({
  open,
  onToggle,
  header,
  children,
  className
}: {
  open: boolean
  onToggle: () => void
  header: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group/row flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover"
      >
        <SpriteIcon
          icon={ChevronRight}
          name="chevron-right"
          className={cn(
            'size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150',
            open && 'rotate-90'
          )}
        />
        {header}
      </button>
      {open && (
        <div className="space-y-2 px-2 pt-1 pb-2.5 pl-[30px] animate-in fade-in-0 duration-150">
          {children}
        </div>
      )}
    </div>
  )
}

export const ToolCall = memo(function ToolCall({
  tool,
  cwd,
  forceOpen,
  openSignal,
  findQuery
}: {
  tool: ToolUse
  cwd?: string
  forceOpen?: boolean
  /** A new value opens it (an Ask citation); see useOpenState. */
  openSignal?: number
  findQuery?: string
}) {
  const [open, setOpen] = useOpenState(openSignal)
  const { sessionKey } = useContext(TranscriptContext)
  const isError = tool.result?.isError
  const [verb, rest] = splitToolLabel(tool.label)
  return (
    <Collapsible
      open={open || !!forceOpen}
      onToggle={() => setOpen((v) => !v)}
      header={
        <>
          <ToolIcon
            name={tool.name}
            className={cn(
              'size-3.5 shrink-0',
              isError ? 'text-destructive' : 'text-muted-foreground'
            )}
          />
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">{verb}</span>
            {rest !== undefined && (
              <span className="ml-1.5 font-mono text-[11.5px] text-muted-foreground">{rest}</span>
            )}
          </span>
          {isError && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-2xs font-medium text-destructive">
              <CircleAlert className="size-3" /> Failed
            </span>
          )}
          {!tool.result && (
            <span className="ml-auto shrink-0 text-2xs text-subtle-foreground">No result</span>
          )}
        </>
      }
    >
      <ErrorBoundary fallback={<RenderFailed what="This tool call" />}>
        <CopyRow
          input={() => fullInputTool(tool, sessionKey).then(toolInputText)}
          output={tool.result}
          blockId={tool.id}
        />
        <InputView tool={tool} cwd={cwd} findQuery={findQuery} />
        {tool.result && <ResultView result={tool.result} findQuery={findQuery} blockId={tool.id} />}
      </ErrorBoundary>
    </Collapsible>
  )
})

export const OrphanResult = memo(function OrphanResult({
  result,
  findQuery,
  forceOpen,
  openSignal,
  blockId
}: {
  result: ToolResult
  /** Its block's id (a cut output is asked for in full by it). */
  blockId?: string
  findQuery?: string
  forceOpen?: boolean
  openSignal?: number
}) {
  const [open, setOpen] = useOpenState(openSignal)
  return (
    <Collapsible
      open={open || !!forceOpen}
      onToggle={() => setOpen((v) => !v)}
      header={
        <>
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Tool result</span>
        </>
      }
    >
      <CopyRow output={result} blockId={blockId} />
      <ResultView result={result} findQuery={findQuery} blockId={blockId} />
    </Collapsible>
  )
})
