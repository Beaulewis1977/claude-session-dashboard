// Settings → Summaries: the model, the size limit, the limits guard and
// opt-in auto-summarize (with what it would use).

import { useEffect, useState } from 'react'
import { Gauge, Sparkles } from 'lucide-react'
import {
  MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
  SUMMARY_MODEL_LABEL,
  type SummaryEstimate,
  type SummaryModel,
  type SummarySettings
} from '@shared/summary'
import { formatInt } from '@shared/format'
import type { AppSettings } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Row, Section } from '../SettingsView'
import { SummaryNotice } from '../summary/SummarizeDialog'
import { estimateText } from '@/lib/summary-format'

function NumberField({
  value,
  min,
  max,
  suffix,
  onCommit,
  label
}: {
  value: number
  min: number
  max: number
  suffix?: string
  onCommit: (v: number) => void
  label: string
}) {
  const [text, setText] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setText(String(value))
  }
  const commit = (): void => {
    const n = Number(text)
    if (!Number.isFinite(n)) return setText(String(value))
    const v = Math.min(max, Math.max(min, Math.round(n)))
    setText(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Input
        type="number"
        min={min}
        max={max}
        value={text}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="h-7 w-24 text-right tabular-nums"
      />
      {suffix}
    </span>
  )
}

export function SummariesSettings({
  update
}: {
  update: (patch: Partial<AppSettings>) => Promise<void>
}) {
  const sum = useApp((s) => s.settings.summaries)
  const sessions = useApp((s) => s.sessions)
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [auto, setAuto] = useState<{ count: number; estimate: SummaryEstimate } | null>(null)
  const set = (patch: Partial<SummarySettings>): Promise<void> =>
    update({ summaries: { ...sum, ...patch } })

  // What auto-summarize would pick up now (it follows the threshold and the list).
  useEffect(() => {
    if (!sum.autoEnabled) return
    let cancelled = false
    const t = setTimeout(() => {
      void api
        .summaryAutoPreview()
        .then((r) => !cancelled && setAuto(r))
        .catch(() => undefined)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [sum.autoEnabled, sum.autoMinMessages, sum.model, sum.maxChars, sessions.length])

  const summarized = sessions.filter((s) => s.meta.aiSummary).length

  return (
    <Section
      id="summaries"
      title="Summaries"
      description={
        <>
          A short summary per session (what was done, files, decisions, open to-dos, where to pick
          up), written by Claude through your own Claude Code on your subscription, only when you
          ask. &ldquo;Continue fresh&rdquo; starts a new session from one.{' '}
          {summarized > 0 &&
            `${formatInt(summarized)} session${summarized === 1 ? ' has' : 's have'} one.`}
        </>
      }
    >
      <Row
        label="Model"
        hint="Sonnet is a good balance. Haiku uses the least of your limits; Opus writes the most careful summaries."
      >
        <Segmented<SummaryModel>
          ariaLabel="Summary model"
          value={sum.model}
          onChange={(model) => void set({ model })}
          options={(['sonnet', 'haiku', 'opus', 'default'] as const).map((m) => ({
            value: m,
            label: m === 'default' ? 'Default' : SUMMARY_MODEL_LABEL[m]
          }))}
        />
      </Row>
      <Row
        label="Most text sent per session"
        hint="Longer sessions keep their start and their end. More text gives a better summary of long sessions and uses more of your limits."
      >
        <NumberField
          label="Most characters sent per session"
          value={sum.maxChars}
          min={MIN_SUMMARY_CHARS}
          max={MAX_SUMMARY_CHARS}
          suffix="characters"
          onCommit={(maxChars) => void set({ maxChars })}
        />
      </Row>
      <Row
        label="Pause above"
        hint="Summarize selected pauses (with a Resume button), and auto-summarize skips, while the live 5-hour limit is above this."
      >
        <NumberField
          label="Pause above this 5-hour %"
          value={sum.pauseAbovePct}
          min={1}
          max={100}
          suffix="% of the 5-hour limit"
          onCommit={(pauseAbovePct) => void set({ pauseAbovePct })}
        />
      </Row>
      <Row
        label="Auto-summarize big sessions"
        hint={
          <>
            Summarizes sessions with at least this many messages once they have been idle for 30
            minutes, and again when they have grown a lot (never one you edited). At most six an
            hour, and never above the pause line.
          </>
        }
      >
        <Switch
          checked={sum.autoEnabled}
          onCheckedChange={(on) => {
            if (on && !sum.noticeAccepted) setConfirmAuto(true)
            else void set({ autoEnabled: on })
          }}
          aria-label="Auto-summarize big sessions"
        />
      </Row>
      {confirmAuto && !sum.autoEnabled && (
        <div className="rounded-lg border border-info/25 bg-info/5 p-3">
          <SummaryNotice maxChars={sum.maxChars} />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmAuto(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirmAuto(false)
                void set({ autoEnabled: true, noticeAccepted: true })
              }}
            >
              <Sparkles /> I understand, turn it on
            </Button>
          </div>
        </div>
      )}
      {sum.autoEnabled && (
        <div className="space-y-2 rounded-lg border border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-4 text-[13px]">
            <span>Sessions with at least</span>
            <NumberField
              label="Messages before a session is summarized automatically"
              value={sum.autoMinMessages}
              min={10}
              max={100_000}
              suffix="messages"
              onCommit={(autoMinMessages) => void set({ autoMinMessages })}
            />
          </div>
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Gauge className="mt-px size-3.5 shrink-0" />
            {auto
              ? auto.count
                ? `${formatInt(auto.count)} session${auto.count === 1 ? '' : 's'} would be summarized now, up to six an hour: ${estimateText(auto.estimate)} in all (an estimate).`
                : 'No session needs a summary right now.'
              : 'Working out what it would use…'}
          </div>
        </div>
      )}
      <Row
        label="What is sent"
        hint={
          sum.noticeAccepted
            ? 'You have read what a summary sends to Claude. Show the notice again before the next one?'
            : 'The first Summarize shows exactly what is sent to Claude, and asks before sending.'
        }
      >
        {sum.noticeAccepted ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void set({ noticeAccepted: false, autoEnabled: false })}
          >
            Show again
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Not yet</span>
        )}
      </Row>
    </Section>
  )
}
