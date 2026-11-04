// Context size: the S/M/L/XL badge, the viewer's stats strip, and the
// large-session warning before Resume (desktop and phone).

import { useEffect, useState } from 'react'
import { Flame, Gauge, GitFork, Info, Sparkles, TriangleAlert, Zap } from 'lucide-react'
import { sizeBand, type ResumeEstimate, type SessionContext, type SizeBand } from '@shared/context'
import { formatTime, formatTokens } from '@shared/format'
import { api } from '@/lib/api'
import { useWarmExpiry } from '@/lib/use-warm-expiry'
import {
  compactionNote,
  contextTitle,
  costShort,
  estimateExplainer,
  pctText,
  resumeSentence,
  windowLabel,
  windowSource
} from '@/lib/context'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip } from '@/components/ui/tooltip'

const BAND_CLASS: Record<SizeBand, string> = {
  S: 'bg-secondary text-muted-foreground',
  M: 'bg-secondary text-foreground/75',
  L: 'bg-info/10 text-info',
  XL: 'bg-warning-soft text-warning'
}

/** S / M / L / XL, with the exact size on hover. Nothing when the size isn't known. */
export function ContextBadge({
  context,
  className
}: {
  context: SessionContext | undefined
  className?: string
}) {
  if (!context) return null
  const band = sizeBand(context.tokens)
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1 text-[10px] font-semibold tabular-nums',
        BAND_CLASS[band],
        className
      )}
      title={contextTitle(context)}
      aria-label={`Context size ${band}: ${contextTitle(context)}`}
    >
      {band}
    </span>
  )
}

/** The "estimate ⓘ" label with how it's worked out. */
export function EstimateInfo({ estimate }: { estimate: ResumeEstimate }) {
  const text = estimateExplainer(estimate)
  return (
    <Tooltip content={<span className="block max-w-80 leading-relaxed">{text}</span>}>
      <span
        className="inline-flex cursor-help items-center gap-0.5 text-muted-foreground"
        tabIndex={0}
        aria-label={text}
      >
        estimate <Info className="size-3" />
      </span>
    </Tooltip>
  )
}

/** "Resume ≈ 12% · Continue fresh ≈ 1%" (or "summarize first"). */
export function ResumeComparison({
  estimate,
  noSummaryText = 'summarize first'
}: {
  estimate: ResumeEstimate
  noSummaryText?: string
}) {
  // Highlight Continue fresh only when it's the cheaper one (a warm cache can make Resume cheaper).
  // Unpriced (no model chosen): both in tokens, so the comparison is like for like.
  const fresh = estimate.fresh
  const freshCheaper =
    !!fresh &&
    (fresh.unpriced
      ? fresh.tokens < estimate.resume.tokens && !estimate.warmUntil
      : fresh.costUsd < estimate.resume.costUsd)
  return (
    <span className="tabular-nums">
      <b className="font-semibold">
        Resume{' '}
        {estimate.fresh?.unpriced
          ? `≈ ${formatTokens(estimate.resume.tokens)} tokens${
              costShort(estimate.resume, estimate.billing).endsWith('tokens')
                ? ''
                : ` (${costShort(estimate.resume, estimate.billing)})`
            }`
          : costShort(estimate.resume, estimate.billing)}
      </b>
      <span className="text-muted-foreground"> · </span>
      {estimate.fresh ? (
        <b className={cn('font-semibold', freshCheaper && 'text-success')}>
          Continue fresh {costShort(estimate.fresh, estimate.billing)}
        </b>
      ) : (
        <span className="text-muted-foreground">Continue fresh: {noSummaryText}</span>
      )}
    </span>
  )
}

function WarmNote({ estimate }: { estimate: ResumeEstimate }) {
  if (!estimate.warmUntil || !estimate.cold) return null
  return (
    <div className="flex items-start gap-1.5 text-success">
      <Flame className="mt-px size-3.5 shrink-0" />
      <span>
        Cache may still be warm, cheaper if you resume now (until{' '}
        {formatTime(new Date(estimate.warmUntil).toISOString())}):{' '}
        {costShort(estimate.resume, estimate.billing)} instead of{' '}
        {costShort(estimate.cold, estimate.billing)}.
      </span>
    </div>
  )
}

/** One line for dialogs that don't warn (Fork, a smaller Resume). */
export function ContextLine({ estimate }: { estimate: ResumeEstimate }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <div className="flex items-start gap-1.5">
        <Gauge className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 leading-relaxed">
          Context ≈ {formatTokens(estimate.tokens)} tokens (
          <span title={windowSource(estimate)}>
            {pctText(estimate.windowPct)} of {windowLabel(estimate)}
          </span>
          ). {resumeSentence(estimate).replace(/^Resuming/, 'Reloading it')}.{' '}
          <EstimateInfo estimate={estimate} />
        </span>
      </div>
      <WarmNote estimate={estimate} />
    </div>
  )
}

/**
 * The warning above the threshold. Never blocks: the launch button (Resume
 * anyway) stays one click away.
 */
export function ContextWarning({
  estimate,
  onContinueFresh,
  onSummarize,
  noSummaryText,
  onFork,
  dontWarn,
  onDontWarn,
  phone
}: {
  estimate: ResumeEstimate
  /** Switch to Continue fresh (only offered when there's a summary). */
  onContinueFresh?: () => void
  /** No summary yet: write one first (desktop only). */
  onSummarize?: () => void
  /** Shown instead when there's no summary and no Summarize button. */
  noSummaryText?: string
  onFork: () => void
  dontWarn: boolean
  onDontWarn: (v: boolean) => void
  phone?: boolean
}) {
  const note = compactionNote(estimate)
  const btn = phone ? 'h-10 flex-1 text-[13.5px]' : ''
  return (
    <div
      role="alert"
      className={cn(
        'space-y-2.5 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5',
        phone ? 'text-[13.5px]' : 'text-xs'
      )}
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-px size-4 shrink-0 text-warning" />
        <div className="min-w-0 space-y-1 leading-relaxed">
          <div className="font-medium text-foreground">
            Large session: about {formatTokens(estimate.tokens)} tokens{' '}
            <span className="font-normal text-muted-foreground" title={windowSource(estimate)}>
              ({pctText(estimate.windowPct)} of the {windowLabel(estimate)} context window)
            </span>
          </div>
          <div>
            {resumeSentence(estimate)}. <EstimateInfo estimate={estimate} />
          </div>
          <div>
            <ResumeComparison
              estimate={estimate}
              noSummaryText={noSummaryText ?? 'summarize first'}
            />
          </div>
          <WarmNote estimate={estimate} />
          {note && <div className="text-muted-foreground">{note}.</div>}
        </div>
      </div>
      <div className={cn('flex flex-wrap gap-2', !phone && 'pl-6')}>
        {estimate.fresh && onContinueFresh ? (
          <Button
            size={phone ? undefined : 'sm'}
            variant="outline"
            className={btn}
            onClick={onContinueFresh}
          >
            <Zap /> Continue fresh
          </Button>
        ) : onSummarize ? (
          <Button
            size={phone ? undefined : 'sm'}
            variant="outline"
            className={btn}
            onClick={onSummarize}
          >
            <Sparkles /> Summarize first
          </Button>
        ) : null}
        <Tooltip content="Keeps the original untouched, but reloads the same history">
          <Button
            size={phone ? undefined : 'sm'}
            variant="outline"
            className={btn}
            onClick={onFork}
          >
            <GitFork /> Fork <span className="font-normal text-muted-foreground">· same size</span>
          </Button>
        </Tooltip>
      </div>
      <label className={cn('flex cursor-pointer items-center gap-2', !phone && 'pl-6')}>
        <Checkbox checked={dontWarn} onCheckedChange={(v) => onDontWarn(v === true)} />
        <span className="text-muted-foreground">Don&apos;t warn for this session</span>
      </label>
    </div>
  )
}

/** Context size in the viewer's stats (desktop and phone). */
export function ContextStrip({
  sessionKey,
  version
}: {
  sessionKey: string
  /** Changes when the estimate may have (file size, summary, launch model). */
  version: string
}) {
  const [e, setE] = useState<ResumeEstimate | null>(null)
  const [expired, setExpired] = useState(0)
  useWarmExpiry(e?.warmUntil, () => setExpired((n) => n + 1))
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void api
        .getContextEstimate(sessionKey)
        .then((r) => !cancelled && setE(r))
        .catch(() => undefined)
    }
    load()
    // Usage and limits (the baseline, the live window) change the %; limits
    // update often while sessions run, so wait for a quiet moment.
    let timer: number | undefined
    const soon = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 1500)
    }
    const offUsage = api.onUsageChanged(soon)
    const offLimits = api.onLimitsChanged(soon)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      offUsage()
      offLimits()
    }
  }, [sessionKey, version, expired])

  if (!e) return null
  const note = compactionNote(e)
  const fill = Math.min(100, e.windowPct)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs">
      <div className="flex items-baseline gap-1.5" title={contextTitle(e)}>
        <Gauge className="size-3.5 self-center text-subtle-foreground" />
        <span className="text-[13px] font-semibold tabular-nums">{formatTokens(e.tokens)}</span>
        <span className="text-muted-foreground">in context</span>
        <ContextBadge context={e} className="self-center" />
      </div>
      {/* At least the label plus a short bar: a long model name wraps the row instead of overlapping. */}
      <div className="flex min-w-fit flex-1 items-center gap-2">
        <div className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-border">
          <div
            className={cn(
              'h-full rounded-full',
              e.band === 'XL' ? 'bg-warning' : e.band === 'L' ? 'bg-info' : 'bg-primary'
            )}
            style={{ width: `${fill}%` }}
          />
        </div>
        <span className="shrink-0 text-muted-foreground tabular-nums" title={windowSource(e)}>
          {pctText(e.windowPct)} of {windowLabel(e)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5">
        <ResumeComparison estimate={e} />
        <EstimateInfo estimate={e} />
      </div>
      {e.warmUntil && (
        <span className="inline-flex items-center gap-1 text-success">
          <Flame className="size-3.5" /> Cache may still be warm
        </span>
      )}
      {note && <span className="text-muted-foreground">{note}</span>}
    </div>
  )
}
