// The summary at the top of the session viewer: what was done, files,
// decisions, to-dos and where to pick up. Editable, regenerable, and the
// starting point of Continue fresh.

import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Ellipsis,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  TextCursorInput,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import type { SessionSummary } from '@shared/types'
import { newSinceSummary, summaryMarkdown, type AiSummary } from '@shared/summary'
import { api } from '@/lib/api'
import { copyText, updateMeta } from '@/lib/actions'
import {
  cancelSummary,
  openContinueFresh,
  previewSummary,
  removeSummary,
  saveSummary,
  summarize
} from '@/lib/summaries'
import { useApp } from '@/lib/store'
import { summaryByline } from '@/lib/summary-format'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input, Textarea } from '../ui/input'
import { Tooltip } from '../ui/tooltip'

function List({ items, mono = false }: { items: string[]; mono?: boolean }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {items.map((x, i) => (
        <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-foreground/85">
          <span className="mt-[9px] size-1 shrink-0 rounded-full bg-subtle-foreground" />
          <span className={cn('min-w-0 break-words', mono && 'font-mono text-[12px]')}>{x}</span>
        </li>
      ))}
    </ul>
  )
}

function Part({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      {children}
    </div>
  )
}

const lines = (xs: string[]): string => xs.join('\n')
const unlines = (t: string): string[] =>
  t
    .split('\n')
    .map((x) => x.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean)

function Editor({
  session,
  summary,
  onDone
}: {
  session: SessionSummary
  summary: AiSummary
  onDone: () => void
}) {
  const [title, setTitle] = useState(summary.title ?? '')
  const [done, setDone] = useState(lines(summary.done))
  const [files, setFiles] = useState(lines(summary.files))
  const [decisions, setDecisions] = useState(lines(summary.decisions))
  const [todos, setTodos] = useState(lines(summary.todos))
  const [pickUp, setPickUp] = useState(summary.pickUp)
  const save = async (): Promise<void> => {
    await saveSummary(session.key, {
      title,
      done: unlines(done),
      files: unlines(files),
      decisions: unlines(decisions),
      todos: unlines(todos),
      pickUp: pickUp.trim()
    })
    onDone()
  }
  const field = (label: string, value: string, set: (v: string) => void, rows = 3) => (
    <label className="block">
      <span className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <Textarea
        value={value}
        rows={rows}
        onChange={(e) => set(e.target.value)}
        className="mt-1 text-[13px]"
      />
    </label>
  )
  return (
    <div
      className="space-y-3 px-3 pt-2 pb-3"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onDone()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void save()
        }
      }}
    >
      <label className="block">
        <span className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
          Suggested title
        </span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
      </label>
      {field('Where to pick up', pickUp, setPickUp, 2)}
      {field('What was done (one per line)', done, setDone, 4)}
      {field('Files changed (one per line)', files, setFiles)}
      {field('Decisions (one per line)', decisions, setDecisions)}
      {field('Open to-dos (one per line)', todos, setTodos)}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  )
}

export function SummaryBlock({
  session,
  readOnly = false,
  onContinue
}: {
  session: SessionSummary
  /** The phone's read-only mode: no edits. */
  readOnly?: boolean
  /** Continue fresh (the phone opens its own launch sheet). */
  onContinue?: () => void
}) {
  const q = useApp((s) => s.summaryQueue)
  // Phones read and edit summaries; they are written on the PC.
  const remote = api.remote === true
  const continueFresh = onContinue ?? (() => openContinueFresh(session.key))
  const showContinue = remote ? !!onContinue && !readOnly : true
  const [editing, setEditing] = useState(false)
  const [more, setMore] = useState(false)
  const summary = session.meta.aiSummary
  const job = q.jobs.find(
    (j) => j.key === session.key && (j.status === 'queued' || j.status === 'running')
  )
  const running = job?.status === 'running'
  const lastFailed = q.jobs.find((j) => j.key === session.key && j.status === 'failed')
  const canContinue = session.availability !== 'imported'

  const progress = job && (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {running ? (
        <Loader2 className="size-3.5 animate-spin text-primary" />
      ) : (
        <Sparkles className="size-3.5" />
      )}
      {running ? 'Summarizing…' : q.paused ? 'Queued (paused: 5-hour limit)' : 'Queued'}
      <button
        type="button"
        className="font-medium text-primary hover:underline"
        onClick={() => void cancelSummary(session.key)}
      >
        Cancel
      </button>
    </span>
  )

  if (!summary) {
    return (
      <section
        aria-label="Summary"
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-dashed border-border px-3 py-2"
      >
        <Sparkles className="size-3.5 text-subtle-foreground" />
        <span className="text-xs text-muted-foreground">
          {remote
            ? 'No summary yet. Summaries are written on your PC (Summarize there).'
            : 'No summary yet. One shows what was done and where to pick up, and lets you continue in a fresh session.'}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {progress ??
            (!remote && (
              <>
                <Button variant="outline" size="xs" onClick={() => summarize([session.key])}>
                  <Sparkles /> Summarize
                </Button>
                <Tooltip content="See exactly what would be sent to Claude">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => previewSummary(session.key)}
                    aria-label="What is sent"
                  >
                    <FileText />
                  </Button>
                </Tooltip>
              </>
            ))}
        </span>
        {lastFailed?.error && !job && (
          <div className="w-full text-xs text-destructive">Last try: {lastFailed.error}</div>
        )}
      </section>
    )
  }

  const behind = newSinceSummary(summary, session.messageCount)
  const details = summary.files.length + summary.decisions.length + summary.todos.length
  return (
    <section
      aria-label="Summary"
      className={cn(
        'mt-3 overflow-hidden rounded-lg border border-border bg-background',
        running && 'opacity-80'
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-secondary/50 px-3 py-1.5">
        <Sparkles className="size-3.5 text-primary" />
        <span className="text-xs font-medium">Summary</span>
        <span className="truncate text-2xs text-subtle-foreground">{summaryByline(summary)}</span>
        {behind > 0 && (
          <Tooltip content="The session has gone on since this summary was written. Regenerate to include the new messages.">
            <span className="rounded bg-warning-soft px-1 text-[10px] font-medium text-warning">
              {behind} new message{behind === 1 ? '' : 's'} since
            </span>
          </Tooltip>
        )}
        <span className="ml-auto flex items-center gap-1">
          {progress}
          {!job && canContinue && showContinue && (
            <Tooltip content="Start a new session in this folder from this summary, instead of reloading the whole history">
              <Button variant="outline" size="xs" onClick={continueFresh}>
                <Zap /> Continue fresh
              </Button>
            </Tooltip>
          )}
          {!job && !remote && (
            <Tooltip content="Write the summary again">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => summarize([session.key])}
                aria-label="Regenerate summary"
              >
                <RefreshCw />
              </Button>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Summary actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-60">
              <DropdownMenuItem disabled={readOnly} onSelect={() => setEditing(true)}>
                <Pencil /> Edit summary
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={readOnly || !summary.title || summary.title === session.meta.name}
                onSelect={() => void updateMeta(session.key, { name: summary.title })}
              >
                <TextCursorInput /> Use suggested title as name
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void copyText(
                    `# ${summary.title || session.title}\n\n${summaryMarkdown(summary)}`,
                    'Summary copied ✓'
                  )
                }
              >
                <ClipboardCopy /> Copy as Markdown
              </DropdownMenuItem>
              {!remote && (
                <DropdownMenuItem onSelect={() => previewSummary(session.key)}>
                  <FileText /> What is sent to Claude
                </DropdownMenuItem>
              )}
              {!remote && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void removeSummary(session.key)}>
                    <Trash2 /> Remove summary
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {editing ? (
        <Editor session={session} summary={summary} onDone={() => setEditing(false)} />
      ) : (
        <div className="space-y-2.5 px-3 pt-2 pb-2.5">
          {summary.title && summary.title !== session.title && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Suggested title: <span className="text-foreground/85">{summary.title}</span>
              {summary.title !== session.meta.name && !readOnly && (
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => void updateMeta(session.key, { name: summary.title })}
                >
                  Use
                </button>
              )}
            </div>
          )}
          {summary.pickUp && (
            <Part label="Where to pick up">
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/90">
                {summary.pickUp}
              </p>
            </Part>
          )}
          {summary.done.length > 0 && (
            <Part label="What was done">
              <List items={summary.done} />
            </Part>
          )}
          {details > 0 && (
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={more}
            >
              {more ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {[
                summary.files.length && `${summary.files.length} files`,
                summary.decisions.length &&
                  `${summary.decisions.length} decision${summary.decisions.length === 1 ? '' : 's'}`,
                summary.todos.length &&
                  `${summary.todos.length} open to-do${summary.todos.length === 1 ? '' : 's'}`
              ]
                .filter(Boolean)
                .join(' · ')}
            </button>
          )}
          {more && (
            <div className="space-y-2.5">
              {summary.files.length > 0 && (
                <Part label="Files changed">
                  <List items={summary.files} mono />
                </Part>
              )}
              {summary.decisions.length > 0 && (
                <Part label="Decisions">
                  <List items={summary.decisions} />
                </Part>
              )}
              {summary.todos.length > 0 && (
                <Part label="Open to-dos">
                  <List items={summary.todos} />
                </Part>
              )}
            </div>
          )}
          {lastFailed?.error && !job && (
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <X className="size-3.5" /> Regenerating failed: {lastFailed.error}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
