import { useEffect, useRef, useState } from 'react'
import { Dialog as D } from 'radix-ui'
import { toast } from 'sonner'
import {
  ArrowUp,
  ChevronRight,
  CircleAlert,
  Copy,
  History,
  Info,
  LoaderCircle,
  Sparkles,
  X
} from 'lucide-react'
import { SUGGESTED_QUESTIONS, type AskHistoryItem } from '@shared/ask'
import { formatBytes, formatDateTime } from '@shared/format'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogHeader } from '../ui/dialog'
import { Markdown } from '../viewer/Markdown'

interface Preview {
  id: string
  prompt: string
  bytes: number
  question: string
}

function Answer({ item }: { item: AskHistoryItem }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-card">
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1 text-[13px] font-medium">{item.question}</div>
        {item.ok && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void api.copyText(item.answer)
              toast.success('Answer copied')
            }}
          >
            <Copy /> Copy
          </Button>
        )}
      </div>
      {item.ok ? (
        <Markdown text={item.answer} className="text-[13px]" />
      ) : (
        <div className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{item.error ?? 'No answer.'}</span>
        </div>
      )}
      <div className="mt-2 text-[11px] text-subtle-foreground">
        {formatDateTime(new Date(item.at).toISOString())} · {item.where} ·{' '}
        {(item.durationMs / 1000).toFixed(0)}s · sent {formatBytes(item.sentBytes)} of numbers
      </div>
    </div>
  )
}

function PreviewDialog({
  preview,
  onSend,
  onClose
}: {
  preview: Preview
  onSend: (dontShow: boolean) => void
  onClose: () => void
}) {
  const [dontShow, setDontShow] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader
          icon={<Info className="size-4 text-primary" />}
          title="What will be sent to Claude"
          description={
            <>
              Exactly this text goes to <span className="font-mono">claude -p</span> on stdin (
              {formatBytes(preview.bytes)}): aggregated numbers only, no session titles, projects or
              conversation text. Claude Code runs in safe mode with no tools and none of your
              settings, CLAUDE.md files, memory or hooks, so nothing else is added. It only runs
              once Claude Code confirms it will use your Claude subscription (never an API key or
              another provider), and it uses your plan&apos;s usage. Policies set by an organization
              still apply.
            </>
          }
        />
        <div className="px-5 pt-3">
          <pre className="selectable max-h-[46vh] overflow-auto rounded-lg border border-border bg-secondary/50 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
            {preview.prompt}
          </pre>
        </div>
        <div className="flex items-center gap-3 px-5 py-4">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox checked={dontShow} onCheckedChange={(v) => setDontShow(v === true)} />
            Don&apos;t show again
          </label>
          <span className="ml-auto" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSend(dontShow)}>
            <ArrowUp /> Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Side panel: ask Claude about usage and limit trends. */
export function AskClaudePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState<AskHistoryItem[]>([])
  const [status, setStatus] = useState<{ available: boolean; where?: string; simulated: boolean }>()
  const [running, setRunning] = useState<{ id: string; question: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [latest, setLatest] = useState<AskHistoryItem | null>(null)
  const [showPast, setShowPast] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    void api.askStatus().then(setStatus)
    void api.askHistory().then(setHistory)
  }, [open])

  const send = async (p: Preview): Promise<void> => {
    setRunning({ id: p.id, question: p.question })
    setLatest(null)
    try {
      const item = await api.askRun(p.id)
      setLatest(item)
      setHistory((h) => [item, ...h.filter((x) => x.id !== item.id)])
      if (item.ok) setQuestion('')
    } catch (err) {
      toast.error("Couldn't ask Claude", { description: (err as Error).message })
    } finally {
      setRunning(null)
    }
  }

  const ask = async (q: string): Promise<void> => {
    const text = q.trim()
    if (!text || running) return
    try {
      const p = await api.askPreview(text)
      const full = { ...p, question: text }
      if (settings.askSkipPreview) void send(full)
      else setPreview(full)
    } catch (err) {
      toast.error("Couldn't prepare the question", { description: (err as Error).message })
    }
  }

  const past = history.filter((h) => h.id !== latest?.id)

  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()} modal={false}>
      <D.Portal>
        <D.Content
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-[44px] right-0 bottom-0 z-40 flex w-[min(440px,100vw)] flex-col border-l border-border bg-surface shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right-8 data-[state=open]:fade-in-0"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Sparkles className="size-4 text-primary" />
            <D.Title className="text-[14px] font-semibold">Ask Claude</D.Title>
            <span className="ml-auto" />
            <D.Close className="rounded-md p-1 text-muted-foreground hover:bg-hover hover:text-foreground">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ask about your usage and limit trends. The dashboard sends Claude only the aggregated
              numbers (window scores, baseline, plan history, token totals) through{' '}
              <span className="font-mono">claude -p</span>
              {status?.where ? ` (${status.where})` : ''}.
            </p>
            {status && !status.available && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                Claude Code wasn&apos;t found on Windows or in your default WSL distro.
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={!!running}
                  onClick={() => void ask(q)}
                  className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:border-primary/40 hover:bg-accent-soft hover:text-foreground disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
            {running && (
              <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-card">
                <div className="text-[13px] font-medium">{running.question}</div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" /> Claude is thinking…
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ml-auto"
                    onClick={() => void api.askCancel(running.id)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {latest && <Answer item={latest} />}
            {past.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowPast((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  <History className="size-3.5" /> Past answers ({past.length})
                  <ChevronRight
                    className={cn('size-3 transition-transform', showPast && 'rotate-90')}
                  />
                </button>
                {showPast && (
                  <div className="mt-2 space-y-2">
                    {past.slice(0, 30).map((h) => (
                      <Answer key={h.id} item={h} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="border-t border-border px-4 py-3">
            <div className="flex items-end gap-2 rounded-xl border border-border-strong bg-background px-3 py-2 focus-within:border-primary/60">
              <textarea
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void ask(question)
                  }
                }}
                rows={2}
                maxLength={1000}
                placeholder="Ask about your usage…"
                className="min-h-[36px] flex-1 resize-none bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
              />
              <Button
                variant="primary"
                size="icon"
                aria-label="Ask"
                disabled={!question.trim() || !!running}
                onClick={() => void ask(question)}
              >
                <ArrowUp />
              </Button>
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-subtle-foreground">
              <Info className="size-3" /> Uses your plan&apos;s usage, like any Claude Code prompt.
            </div>
          </div>
        </D.Content>
      </D.Portal>
      {preview && (
        <PreviewDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onSend={(dontShow) => {
            const p = preview
            setPreview(null)
            if (dontShow)
              void api.updateSettings({ askSkipPreview: true }).then((s) => set({ settings: s }))
            void send(p)
          }}
        />
      )}
    </D.Root>
  )
}
