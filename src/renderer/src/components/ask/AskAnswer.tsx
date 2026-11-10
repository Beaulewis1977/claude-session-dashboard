// One Ask answer (desktop and phone): a local answer with how it was worked
// out, or Claude's answer with its citations. A citation opens the session at
// the cited message (or its Changes tab at the cited commit).

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronRight,
  CircleAlert,
  Copy,
  GitCommitHorizontal,
  HardDrive,
  MessageSquareQuote,
  SearchX,
  Smartphone,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { AskCitation, AskSessionsItem, LocalAnswer } from '@shared/ask-sessions/types'
import { answerForCopy, itemModelLabel, linkCitations } from '@shared/ask-sessions/format'
import { formatDateTime } from '@shared/format'
import { copyText } from '@/lib/actions'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Tooltip } from '../ui/tooltip'
import { Markdown } from '../viewer/Markdown'

export type OpenTarget = Pick<AskCitation, 'key' | 'messageId' | 'msgIds' | 'sha'>

function CiteChip({
  sid,
  c,
  onOpen
}: {
  sid: string
  c?: AskCitation
  onOpen: (c: OpenTarget) => void
}) {
  if (!c) return <span className="text-subtle-foreground">[{sid}]</span>
  return (
    <Tooltip
      content={
        <span className="block max-w-[320px] text-left">
          <span className="block font-medium">{c.title}</span>
          <span className="block text-muted-foreground">
            {[
              c.date,
              c.sha ? `commit ${c.sha.slice(0, 7)}` : c.kind === 'turn' ? 'message' : c.kind
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="mt-1 block text-muted-foreground">{c.preview}</span>
        </span>
      }
      side="top"
    >
      <button
        type="button"
        onClick={() => onOpen(c)}
        aria-label={`Source ${sid}: ${c.title}`}
        className="mx-0.5 inline-flex h-[18px] -translate-y-px items-center gap-0.5 rounded-[5px] border border-primary/25 bg-accent-soft px-1 align-middle font-mono text-[10.5px] font-medium text-primary hover:bg-primary hover:text-primary-foreground"
      >
        {c.sha ? <GitCommitHorizontal className="size-3" /> : null}
        {sid}
      </button>
    </Tooltip>
  )
}

function LocalView({ a, onOpen }: { a: LocalAnswer; onOpen: (c: OpenTarget) => void }) {
  const [how, setHow] = useState(false)
  return (
    <div className="space-y-3">
      <Markdown text={a.headline} className="text-[14px]" />
      {a.table && a.table.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[12.5px] tabular-nums">
            <thead className="bg-secondary/60 text-left text-muted-foreground">
              <tr>
                {a.table.columns.map((c, i) => (
                  <th
                    key={c}
                    className={cn(
                      'px-3 py-1.5 font-medium',
                      a.table!.align?.[i] === 'right' && 'text-right'
                    )}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.table.rows.map((r, n) => (
                <tr key={n} className="border-t border-border">
                  {r.map((cell, i) => (
                    <td
                      key={i}
                      className={cn(
                        'px-3 py-1.5',
                        a.table!.align?.[i] === 'right' && 'text-right',
                        n === a.table!.rows.length - 1 && r[0] === 'Total' && 'font-semibold'
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!a.sessions?.length && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {a.sessions.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => onOpen({ key: s.key })}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-hover"
              >
                <MessageSquareQuote className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{s.title}</span>
                  {s.detail && (
                    <span className="block truncate text-xs text-muted-foreground">{s.detail}</span>
                  )}
                </span>
                <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!a.commits?.length && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {a.commits.map((c) => (
            <li key={`${c.key}:${c.sha}`}>
              <button
                type="button"
                onClick={() => onOpen({ key: c.key, sha: c.sha })}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-hover"
              >
                <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">
                    <span className="font-mono text-xs text-muted-foreground">
                      {c.sha.slice(0, 7)}
                    </span>{' '}
                    {c.subject}
                  </span>
                  {c.detail && (
                    <span className="block truncate text-xs text-muted-foreground">{c.detail}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!a.more && <div className="text-xs text-muted-foreground">…and {a.more} more.</div>}
      <div className="rounded-lg border border-dashed border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setHow(!how)}
          aria-expanded={how}
          className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', how && 'rotate-90')} />
          How this was computed
        </button>
        {how && (
          <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
            <div>
              <span className="font-medium text-foreground/80">Read as: </span>
              {a.interpretation}
            </div>
            <ul className="list-disc space-y-1 pl-4">
              {a.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

/** A Claude answer: how it came about (what was searched, sent, and checked). */
function HowAnswered({ item }: { item: AskSessionsItem }) {
  const [open, setOpen] = useState(false)
  const s = item.sent
  const cited = Object.keys(item.citations ?? {}).length
  return (
    <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        How this was answered
      </button>
      {open && (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>
            Searched the local index on this PC
            {item.searched ? <> for “{item.searched}”</> : ''}
            {item.matched !== undefined ? ` (${item.matched} matching passages)` : ''}, in{' '}
            {item.scopeText || 'all my sessions'}.
          </li>
          {s && (
            <li>
              You reviewed and sent {s.snippets} snippet{s.snippets === 1 ? '' : 's'} from{' '}
              {s.sessions} session{s.sessions === 1 ? '' : 's'} ({s.chars.toLocaleString('en-US')}{' '}
              characters, secrets masked) to your own claude -p
              {itemModelLabel(item) ? `, ${itemModelLabel(item)}` : ''}: no tools, none of your
              settings, nothing saved by Claude Code.
            </li>
          )}
          {!s && !item.ok && <li>Nothing was sent: it stopped before Claude got the question.</li>}
          <li>
            Every statement had to cite a snippet that was sent
            {item.notFound
              ? '; none did, so the answer is “not found”.'
              : `: ${cited} snippet${cited === 1 ? ' is' : 's are'} cited${item.dropped?.length ? `, ${item.dropped.length} statement${item.dropped.length === 1 ? ' was' : 's were'} removed` : ''}.`}
          </li>
        </ul>
      )}
    </div>
  )
}

/** One question and its answer. */
export function AskItemView({
  item,
  onOpen,
  onDelete,
  onAskClaude
}: {
  item: AskSessionsItem
  onOpen: (c: OpenTarget) => void
  onDelete?: () => void
  /** A local answer: ask it as a content question instead. */
  onAskClaude?: () => void
}) {
  const [showDropped, setShowDropped] = useState(false)
  const cite = useCallback(
    (sid: string) => <CiteChip sid={sid} c={item.citations?.[sid]} onOpen={onOpen} />,
    [item.citations, onOpen]
  )
  const local = item.mode === 'local'
  const meta = local
    ? 'Answered on this PC · nothing sent'
    : [
        item.where,
        itemModelLabel(item),
        item.durationMs !== undefined ? `${Math.max(1, Math.round(item.durationMs / 1000))}s` : '',
        item.sent
          ? `sent ${item.sent.snippets} snippet${item.sent.snippets === 1 ? '' : 's'} from ${item.sent.sessions} session${item.sent.sessions === 1 ? '' : 's'}`
          : ''
      ]
        .filter(Boolean)
        .join(' · ')
  return (
    <article
      className="rounded-xl border border-border bg-card px-4 py-3 shadow-card"
      aria-label="Answer"
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{item.question}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-subtle-foreground">
            {local ? <HardDrive className="size-3" /> : <Sparkles className="size-3" />}
            <span>{formatDateTime(new Date(item.at).toISOString())}</span>
            {item.phone && (
              <span className="inline-flex items-center gap-1">
                <Smartphone className="size-3" /> from {item.phone}
              </span>
            )}
            {item.scopeText && item.scopeText !== 'all my sessions' && (
              <span>· {item.scopeText}</span>
            )}
          </div>
        </div>
        {item.ok && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void copyText(answerForCopy(item))
              toast.success('Answer copied')
            }}
          >
            <Copy /> Copy
          </Button>
        )}
        {onDelete && (
          <Tooltip content="Delete this answer">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onDelete}
              aria-label="Delete this answer"
            >
              <Trash2 />
            </Button>
          </Tooltip>
        )}
      </div>
      {!item.ok ? (
        <div className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{item.error ?? 'No answer.'}</span>
        </div>
      ) : local && item.local ? (
        <LocalView a={item.local} onOpen={onOpen} />
      ) : item.notFound ? (
        <div className="flex items-start gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-[13px]">
          <SearchX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="font-medium">Not found in your sessions.</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              The {item.sent?.snippets ?? 0} snippets sent didn&apos;t hold the answer
              {item.scopeText ? ` (${item.scopeText})` : ''}. Try other words, or widen the scope.
            </div>
          </div>
        </div>
      ) : (
        <Markdown text={linkCitations(item.answer ?? '')} className="text-[13.5px]" cite={cite} />
      )}
      {!local && item.ok && <HowAnswered item={item} />}
      {!!item.dropped?.length && (
        <div className="mt-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setShowDropped(!showDropped)}
            aria-expanded={showDropped}
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ChevronRight
              className={cn('size-3 transition-transform', showDropped && 'rotate-90')}
            />
            {item.dropped.length} statement{item.dropped.length === 1 ? '' : 's'} without a valid
            source {item.dropped.length === 1 ? 'was' : 'were'} removed
          </button>
          {showDropped && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 line-through decoration-subtle-foreground/60">
              {item.dropped.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-subtle-foreground">
        <span>{meta}</span>
        {local && onAskClaude && (
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0 text-[11px]"
            onClick={onAskClaude}
          >
            Ask Claude instead
          </Button>
        )}
      </div>
    </article>
  )
}
