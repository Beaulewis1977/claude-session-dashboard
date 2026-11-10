// What a content question would send: "N snippets from M sessions will be
// sent", each snippet (secrets already masked) with a checkbox, a session at a
// time or one by one, the exact text, the estimate for the model I pick, and
// Send. Nothing leaves the PC before Send.

import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Eye,
  Gauge,
  LoaderCircle,
  Smartphone,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  ASK_EFFORT_LABEL,
  ASK_EFFORTS,
  ASK_MODEL_LABEL,
  ASK_MODELS,
  type AskEffort,
  type AskEstimate,
  type AskModel,
  type AskPreview,
  type AskSnippet
} from '@shared/ask-sessions/types'
import { formatInt, formatTokens, formatUsd } from '@shared/format'
import { modelLabel } from '@shared/usage/pricing'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogHeader } from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export function ModelEffortPicker({
  model,
  effort,
  onChange,
  disabled
}: {
  model: AskModel
  effort: AskEffort
  onChange: (model: AskModel, effort: AskEffort) => void
  disabled?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="outline" size="sm" aria-label="Model and effort for this answer">
          {ASK_MODEL_LABEL[model]}
          {effort !== 'default' && (
            <span className="text-muted-foreground">· {ASK_EFFORT_LABEL[effort]}</span>
          )}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={model}
          onValueChange={(v) => onChange(v as AskModel, effort)}
        >
          {ASK_MODELS.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {ASK_MODEL_LABEL[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={effort}
          onValueChange={(v) => onChange(model, v as AskEffort)}
        >
          {ASK_EFFORTS.map((e) => (
            <DropdownMenuRadioItem key={e} value={e}>
              {e === 'default' ? "Claude Code's default" : ASK_EFFORT_LABEL[e]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SnippetRow({
  s,
  checked,
  onToggle
}: {
  s: AskSnippet
  checked: boolean
  onToggle: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const long = s.text.length > 320
  return (
    <li className="flex items-start gap-2 py-2">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onToggle(v === true)}
        aria-label={`Send snippet ${s.sid}`}
        className="mt-0.5"
      />
      <div className={cn('min-w-0 flex-1', !checked && 'opacity-50')}>
        <div className="flex items-center gap-2 text-[11px] text-subtle-foreground">
          <span className="font-mono font-medium text-primary">{s.sid}</span>
          <span>{s.kind === 'turn' ? 'conversation' : s.kind}</span>
          {s.date && <span>{s.date}</span>}
          {s.sha && <span className="font-mono">{s.sha.slice(0, 7)}</span>}
        </div>
        <pre
          className={cn(
            'selectable mt-1 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85',
            !open && long && 'line-clamp-5'
          )}
        >
          {s.text}
        </pre>
        {long && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
    </li>
  )
}

export function AskPreviewCard({
  preview,
  running,
  onSend,
  onCancel,
  onClose
}: {
  preview: AskPreview
  running: boolean
  onSend: (keep: string[], model: AskModel, effort: AskEffort) => void
  onCancel: () => void
  onClose: () => void
}) {
  const [kept, setKept] = useState<Set<string>>(() => new Set(preview.snippets.map((s) => s.sid)))
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState<AskModel>(preview.model)
  const [effort, setEffort] = useState<AskEffort>(preview.effort)
  const [estimate, setEstimate] = useState<AskEstimate | null>(null)
  const [exact, setExact] = useState<string | null>(null)
  const keep = useMemo(
    () => preview.snippets.filter((s) => kept.has(s.sid)).map((s) => s.sid),
    [preview, kept]
  )
  const groups = useMemo(() => {
    const m = new Map<string, AskSnippet[]>()
    for (const s of preview.snippets) m.set(s.key, [...(m.get(s.key) ?? []), s])
    return [...m.entries()]
  }, [preview])
  const sessions = new Set(preview.snippets.filter((s) => kept.has(s.sid)).map((s) => s.key)).size

  useEffect(() => {
    if (!keep.length) return
    let gone = false
    const t = window.setTimeout(() => {
      void api
        .askSessionsEstimate(preview.id, keep, model)
        .then((e) => !gone && setEstimate(e))
        .catch(() => !gone && setEstimate(null))
    }, 150)
    return () => {
      gone = true
      window.clearTimeout(t)
    }
  }, [preview.id, keep, model])

  const toggle = (sids: string[], on: boolean): void =>
    setKept((k) => {
      const n = new Set(k)
      for (const s of sids) {
        if (on) n.add(s)
        else n.delete(s)
      }
      return n
    })

  // Nothing kept: nothing to estimate (the last estimate isn't shown).
  const est = keep.length ? estimate : null
  const g = preview.guard
  return (
    <section
      className="rounded-xl border border-border bg-card shadow-card"
      aria-label="What will be sent"
    >
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{preview.question}</div>
          <div className="mt-0.5 text-[11px] text-subtle-foreground">
            Searched {formatInt(preview.index.passages)} passages of{' '}
            {formatInt(preview.index.sessions)} sessions · {preview.scopeText}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          disabled={running}
          aria-label="Close the preview"
        >
          <X />
        </Button>
      </div>
      {preview.phone && (
        <div className="flex items-start gap-2 border-b border-border bg-accent-soft px-4 py-2 text-xs">
          <Smartphone className="mt-0.5 size-3.5 shrink-0 text-primary" />
          Asked from “{preview.phone.device}”. Nothing is sent until you click Send here.
        </div>
      )}
      <div className="space-y-2 px-4 py-3">
        {preview.snippets.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">
            Nothing in your sessions matches these words
            {preview.scopeText !== 'all my sessions' ? ` (${preview.scopeText})` : ''}. Try other
            words, or widen the scope. Nothing was sent.
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="flex w-full items-center gap-1.5 text-left text-[13px] font-medium"
            >
              <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
              {keep.length} snippet{keep.length === 1 ? '' : 's'} from {sessions} session
              {sessions === 1 ? '' : 's'} will be sent
              <span className="font-normal text-muted-foreground">
                {est
                  ? ` · ~${formatTokens(est.tokens)} tokens${est.pct5h !== undefined ? ` · ≈${est.pct5h < 1 ? est.pct5h.toFixed(1) : Math.round(est.pct5h)}% of your 5-hour window` : ''} · priced as ${modelLabel(est.priceModel)} (${formatUsd(est.costUsd)} at API prices)`
                  : ''}
              </span>
            </button>
            {preview.cut > 0 && (
              <div className="pl-6 text-xs text-muted-foreground">
                {preview.cut} more matching passage{preview.cut === 1 ? '' : 's'} left out by the
                size limits (Settings → Ask).
              </div>
            )}
            {open && (
              <div className="max-h-[48vh] space-y-3 overflow-y-auto pl-1">
                {groups.map(([key, list]) => {
                  const on = list.filter((s) => kept.has(s.sid)).length
                  return (
                    <div key={key} className="rounded-lg border border-border px-3">
                      <div className="flex items-center gap-2 border-b border-border py-2">
                        <Checkbox
                          checked={on === list.length ? true : on === 0 ? false : 'indeterminate'}
                          onCheckedChange={(v) =>
                            toggle(
                              list.map((s) => s.sid),
                              v === true
                            )
                          }
                          aria-label={`Send the snippets of ${list[0].title}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] font-medium">{list[0].title}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {[list[0].project, list[0].agent, list[0].where].join(' · ')}
                          </div>
                        </div>
                      </div>
                      <ul className="divide-y divide-border">
                        {list.map((s) => (
                          <SnippetRow
                            key={s.sid}
                            s={s}
                            checked={kept.has(s.sid)}
                            onToggle={(v) => toggle([s.sid], v)}
                          />
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
        {preview.index.skipped > 0 && (
          <div className="text-xs text-muted-foreground">
            The index leaves out {formatInt(preview.index.skipped)} older session
            {preview.index.skipped === 1 ? '' : 's'} to stay within its size limit (Settings → Ask).
          </div>
        )}
        {g?.above && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            Your 5-hour limit is at about {Math.round(g.pct ?? 0)}%, above the pause line of{' '}
            {g.limit}% (Settings → Summaries). Sending still uses your plan&apos;s usage.
          </div>
        )}
        {g?.unknown && !g.above && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Gauge className="mt-0.5 size-3.5 shrink-0" />
            The 5-hour reading doesn&apos;t include the app&apos;s own recent runs (no baseline
            yet).
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <p className="mr-auto max-w-[460px] text-[11px] leading-relaxed text-muted-foreground">
          Goes to your own <span className="font-mono">claude -p</span> on your Claude subscription:
          no tools, none of your settings, nothing saved by Claude Code. Every claim must cite a
          snippet.
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={!keep.length}
          onClick={() =>
            void api
              .askSessionsPrompt(preview.id, keep)
              .then((p) => setExact(p.prompt))
              .catch(() => setExact(null))
          }
        >
          <Eye /> Exact text
        </Button>
        <ModelEffortPicker
          model={model}
          effort={effort}
          disabled={running}
          onChange={(m, e) => {
            setModel(m)
            setEffort(e)
          }}
        />
        {running ? (
          <Button variant="outline" size="sm" onClick={onCancel}>
            <LoaderCircle className="animate-spin" /> Cancel
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!keep.length}
            onClick={() => onSend(keep, model, effort)}
          >
            <ArrowUp /> Send
          </Button>
        )}
      </div>
      {exact !== null && (
        <Dialog open onOpenChange={(o) => !o && setExact(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader
              icon={<Eye className="size-4 text-primary" />}
              title="Exactly what Send sends"
              description={`This text goes to claude -p on stdin (${formatInt(exact.length)} characters), with the snippets you kept. Nothing else is added: Claude Code runs with no tools and none of your settings, CLAUDE.md files, memory or hooks.`}
            />
            <div className="px-5 pt-3 pb-5">
              <pre className="selectable max-h-[60vh] overflow-auto rounded-lg border border-border bg-secondary/50 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                {exact}
              </pre>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
