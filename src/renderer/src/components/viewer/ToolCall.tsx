import { memo, useState, type ReactNode } from 'react'
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
import { toolInputText, toolOutputText } from '@/lib/copy'
import { ErrorBoundary, RenderFailed } from '../ErrorBoundary'
import { CodeBlock, CopyButton } from './Markdown'

type ToolUse = Extract<ContentBlock, { type: 'tool_use' }>

function ToolIcon({ name, className }: { name: string; className?: string }) {
  if (name === 'Bash' || name === 'PowerShell') return <SquareTerminal className={className} />
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name))
    return <FilePen className={className} />
  if (name === 'Read' || name === 'NotebookRead') return <FileText className={className} />
  if (name === 'Grep') return <Search className={className} />
  if (name === 'Glob' || name === 'LS') return <FolderSearch className={className} />
  if (name === 'WebFetch' || name === 'WebSearch') return <Globe className={className} />
  if (name === 'Task' || name === 'Agent') return <Bot className={className} />
  if (name === 'TodoWrite') return <ListChecks className={className} />
  if (name.startsWith('mcp__')) return <Plug className={className} />
  return <Wrench className={className} />
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

function ToolInput({ tool, cwd }: { tool: ToolUse; cwd?: string }) {
  const i = (tool.input ?? {}) as Record<string, unknown>
  const path = s(i.file_path) || s(i.notebook_path)
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
          <code>{truncateText(s(i.content), 60, 6000).text}</code>
        </CodeBlock>
      )
    case 'TodoWrite':
      return <Todos todos={todoItems(i)} />
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
      <code>{truncateText(JSON.stringify(tool.input, null, 2) ?? '', 200, 20000).text}</code>
    </CodeBlock>
  )
}

export function ResultView({ result, findQuery }: { result: ToolResult; findQuery?: string }) {
  const [showAll, setShowAll] = useState(false)
  const t = truncateText(result.text)
  // Expand automatically when a find match sits in the hidden part.
  const hiddenMatch =
    !!findQuery &&
    t.truncated &&
    result.text.toLowerCase().includes(findQuery.toLowerCase()) &&
    !t.text.toLowerCase().includes(findQuery.toLowerCase())
  const full = showAll || hiddenMatch
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
          {t.totalLines.toLocaleString()} line{t.totalLines === 1 ? '' : 's'}
          {result.images ? ` · ${result.images} image${result.images > 1 ? 's' : ''}` : ''}
        </span>
      </div>
      <pre
        className={cn(
          'selectable overflow-x-auto px-3 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap',
          result.isError && 'text-destructive'
        )}
      >
        {full ? result.text : t.text}
      </pre>
      {t.truncated && (
        <div className="border-t border-inherit px-2 py-1">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="rounded px-1.5 py-0.5 text-2xs font-medium text-primary hover:bg-hover"
          >
            {full
              ? 'Show less'
              : `Show all (${t.totalLines.toLocaleString()} lines, ${result.text.length.toLocaleString()} chars)`}
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
function CopyRow({ input, output }: { input?: () => string; output?: ToolResult }) {
  const hasOutput = !!output?.text
  if (!input && !hasOutput) return null
  return (
    <div className="-mt-0.5 flex justify-end gap-1 touch:sticky touch:top-0 touch:z-[4] touch:mt-0 touch:-mr-1 touch:-ml-[22px] touch:flex-wrap touch:gap-x-1 touch:gap-y-0 touch:bg-background touch:py-1">
      {input && <CopyButton label="Copy input" getText={input} className={touchCopy} />}
      {hasOutput && (
        <CopyButton
          label="Copy output"
          getText={() => toolOutputText(output!)}
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
        <ChevronRight
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
  findQuery
}: {
  tool: ToolUse
  cwd?: string
  forceOpen?: boolean
  findQuery?: string
}) {
  const [open, setOpen] = useState(false)
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
        <CopyRow input={() => toolInputText(tool)} output={tool.result} />
        <ToolInput tool={tool} cwd={cwd} />
        {tool.result && <ResultView result={tool.result} findQuery={findQuery} />}
      </ErrorBoundary>
    </Collapsible>
  )
})

export const OrphanResult = memo(function OrphanResult({
  result,
  findQuery,
  forceOpen
}: {
  result: ToolResult
  findQuery?: string
  forceOpen?: boolean
}) {
  const [open, setOpen] = useState(false)
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
      <CopyRow output={result} />
      <ResultView result={result} findQuery={findQuery} />
    </Collapsible>
  )
})
