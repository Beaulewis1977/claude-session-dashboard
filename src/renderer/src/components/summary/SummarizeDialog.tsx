// The Summarize dialog: the one-time notice about what is sent, an estimate
// of what it would use (tokens and roughly how much of the 5-hour window),
// and the exact text sent, before anything goes to Claude.

import { useEffect, useState } from 'react'
import {
  EyeOff,
  FileText,
  Gauge,
  Info,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import { formatBytes, formatInt } from '@shared/format'
import { SUMMARY_MODEL_LABEL, type SummaryEstimate } from '@shared/summary'
import type { SummaryBatchEstimate, SummaryPreview } from '@shared/summary-queue'
import { api } from '@/lib/api'
import { queue } from '@/lib/summaries'
import { estimateText } from '@/lib/summary-format'
import { useApp } from '@/lib/store'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'

function Point({ icon: Icon, children }: { icon: typeof Info; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </li>
  )
}

export function EstimateCard({
  estimate,
  pauseAbove,
  sessions
}: {
  estimate: SummaryBatchEstimate | (SummaryEstimate & { fiveHourPct?: number }) | null
  pauseAbove: number
  sessions: number
}) {
  if (!estimate)
    return (
      <div className="h-[74px] animate-pulse rounded-lg border border-border bg-secondary/60" />
    )
  const live = estimate.fiveHourPct
  const above = live !== undefined && live > pauseAbove
  const skipped = 'skipped' in estimate ? estimate.skipped : 0
  return (
    <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Gauge className="size-4 text-muted-foreground" />
        {estimateText(estimate)}
      </div>
      <div className="mt-1 space-y-0.5 pl-6 text-muted-foreground">
        <div>
          {sessions > 1 ? `${formatInt(estimate.sessions)} sessions · ` : ''}
          {formatInt(estimate.chars)} characters sent
          {skipped ? ` · ${skipped} can't be read and will be skipped` : ''}
        </div>
        <div>
          {estimate.pct5h === undefined
            ? 'The % of the 5-hour window shows once limit health has a baseline (Settings → Limit health).'
            : 'An estimate from your limit-health baseline: it varies with the model and what else runs.'}
        </div>
        {live !== undefined && (
          <div className={above ? 'font-medium text-warning' : undefined}>
            5-hour limit now: {Math.round(live)}%
            {above
              ? ` · above your ${pauseAbove}% pause line: the queue pauses before it starts, and you can resume anyway.`
              : ` · the queue pauses if it goes above ${pauseAbove}%, these summaries included.`}
          </div>
        )}
      </div>
    </div>
  )
}

export function SummaryNotice({ maxChars }: { maxChars: number }) {
  return (
    <ul className="space-y-2.5 text-[13px] leading-relaxed text-foreground/85">
      <Point icon={FileText}>
        <strong className="font-semibold">What is sent:</strong> the conversation&apos;s text (your
        messages and Claude&apos;s replies) and one line per tool call (its name and file path or
        command). Never tool output, thinking or images. Up to {formatInt(maxChars)} characters per
        session; for longer ones the start and the end are kept.
      </Point>
      <Point icon={KeyRound}>
        Common secrets (API keys, tokens, passwords, private keys) are masked before anything is
        sent.
      </Point>
      <Point icon={Sparkles}>
        It goes to Claude through <strong className="font-semibold">your own Claude Code</strong> (
        <span className="font-mono text-[12px]">claude -p</span>) on your Claude subscription, with
        no tools and none of your settings, and leaves no session file. It counts toward your limits
        like any other use, and shows in Usage as &ldquo;Summaries (dashboard)&rdquo;.
      </Point>
      <Point icon={ShieldCheck}>
        The summary is kept in this app&apos;s data only, never in Claude&apos;s files. You can
        edit, regenerate or remove it.
      </Point>
    </ul>
  )
}

export function SummarizeDialog() {
  const req = useApp((s) => s.summarize)
  if (!req) return null
  return <SummarizeDialogBody key={req.keys.join('|')} />
}

function SummarizeDialogBody() {
  const req = useApp((s) => s.summarize)!
  const settings = useApp((s) => s.settings)
  const sessions = useApp((s) => s.sessions)
  const set = useApp((s) => s.set)
  const sum = settings.summaries
  const [agreed, setAgreed] = useState(sum.noticeAccepted)
  const [estimate, setEstimate] = useState<SummaryBatchEstimate | null>(null)
  const [estimateError, setEstimateError] = useState<string>()
  /** Go ahead without the estimate (only offered when it couldn't be worked out). */
  const [noEstimateOk, setNoEstimateOk] = useState(false)
  const [showPrompt, setShowPrompt] = useState(req.preview === true)
  const [preview, setPreview] = useState<SummaryPreview | null>(null)
  const [previewError, setPreviewError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const many = req.keys.length > 1
  const first = sessions.find((s) => s.key === req.keys[0])

  useEffect(() => {
    let cancelled = false
    void api
      .summaryEstimate(req.keys)
      .then((e) => !cancelled && setEstimate(e))
      .catch((err: Error) => !cancelled && setEstimateError(err.message))
    return () => {
      cancelled = true
    }
  }, [req.keys])

  useEffect(() => {
    if (!showPrompt || preview) return
    let cancelled = false
    void api
      .summaryPreview(req.keys[0])
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) => !cancelled && setPreviewError(err.message))
    return () => {
      cancelled = true
    }
  }, [showPrompt, preview, req.keys])

  const close = (): void => set({ summarize: null })
  // The estimate comes first: no sending before it's shown (or explicitly skipped).
  const ready = agreed && !busy && (!!estimate || (!!estimateError && noEstimateOk))
  const go = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    if (!sum.noticeAccepted) {
      const st = await api.updateSettings({ summaries: { ...sum, noticeAccepted: true } })
      set({ settings: st })
    }
    // A preview that was shown is what gets sent for that session.
    const previewId = showPrompt && preview ? preview.id : undefined
    const n = await queue(req.keys, req.origin, previewId)
    setBusy(false)
    if (n !== undefined) close()
    // The session changed or the preview expired: show the current text again.
    else if (previewId) setPreview(null)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-[580px] flex-col">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <Sparkles className="size-4" />
            </div>
          }
          title={many ? `Summarize ${req.keys.length} sessions` : 'Summarize session'}
          description={
            many ? (
              'One at a time, in the background. Each summary replaces the one before it.'
            ) : (
              <span className="line-clamp-1 text-foreground/80" title={first?.title}>
                {first?.title}
              </span>
            )
          }
        />
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-3 pb-5">
          {!sum.noticeAccepted && (
            <div className="rounded-lg border border-info/25 bg-info/5 p-3">
              <SummaryNotice maxChars={sum.maxChars} />
              <label className="mt-3 flex cursor-pointer items-center gap-2 pl-[26px] text-[13px] font-medium">
                <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />I
                understand, send it
              </label>
            </div>
          )}

          {estimateError && !estimate && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
                <span>Couldn&apos;t work out what this would use: {estimateError}</span>
              </div>
              <label className="mt-2 flex cursor-pointer items-center gap-2 pl-[22px] font-medium">
                <Checkbox
                  checked={noEstimateOk}
                  onCheckedChange={(v) => setNoEstimateOk(v === true)}
                />
                Summarize anyway, without an estimate
              </label>
            </div>
          )}
          {!estimateError && (
            <EstimateCard
              estimate={estimate}
              pauseAbove={sum.pauseAbovePct}
              sessions={req.keys.length}
            />
          )}

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            Written with {SUMMARY_MODEL_LABEL[sum.model]}. Change the model, the size limit and the
            pause line in Settings → Summaries.
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              {showPrompt ? <EyeOff className="size-3.5" /> : <FileText className="size-3.5" />}
              {showPrompt
                ? 'Hide what is sent'
                : many
                  ? 'Show exactly what is sent (first session)'
                  : 'Show exactly what is sent'}
            </button>
            {showPrompt && (
              <div className="mt-2">
                {previewError ? (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
                    <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
                    {previewError}
                  </div>
                ) : preview ? (
                  <>
                    <div className="mb-1 text-2xs text-subtle-foreground">
                      {formatBytes(preview.bytes)} · {preview.kept} of {preview.total} messages
                      {preview.kept < preview.total ? ' (start and end kept)' : ''}
                    </div>
                    <pre className="selectable max-h-64 overflow-auto rounded-lg border border-code-border bg-code-bg px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                      {preview.prompt}
                    </pre>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Preparing…
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void go()} disabled={!ready} autoFocus>
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {many ? `Summarize ${req.keys.length}` : 'Summarize'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
