import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { PLAN_MULT, planLabel, toYmd, type PlanChange, type PlanName } from '@shared/usage/health'
import { now } from '@shared/clock'
import { useApp } from '@/lib/store'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Row, Section } from '../SettingsView'

function Num({
  value,
  min,
  max,
  step = 1,
  suffix,
  label,
  onCommit
}: {
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  label: string
  onCommit: (v: number) => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        key={value}
        className="h-7 w-20 px-1.5 text-right text-xs tabular-nums"
        onBlur={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n)
        }}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </span>
  )
}

const PLAN_OPTIONS: PlanName[] = ['pro', 'max5', 'max20', 'team', 'custom']

function PlanHistory({ update }: { update: (p: Partial<AppSettings>) => Promise<void> }) {
  const settings = useApp((s) => s.settings)
  const [draft, setDraft] = useState<PlanChange>(() => ({
    from: toYmd(now()),
    plan: 'max5',
    mult: 5
  }))
  const list = settings.planHistory
  return (
    <div>
      <div className="text-[13px] font-medium">Plan history</div>
      <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
        Each window is compared with the baseline × the multiplier of the plan it ran on, so an
        upgrade or downgrade doesn&apos;t read as a cut. With no history, your current plan applies
        to every window. Changing the plan above records a change automatically.
      </div>
      <div className="mt-2 space-y-1">
        {list.map((p) => (
          <div
            key={p.from}
            className="flex items-center gap-3 rounded-md px-2 py-1 text-xs hover:bg-hover"
          >
            <span className="w-24 tabular-nums">{p.from === '2000-01-01' ? 'Before' : p.from}</span>
            <span className="flex-1 font-medium">{planLabel(p)}</span>
            <button
              type="button"
              aria-label={`Remove ${p.from}`}
              className="rounded p-0.5 text-subtle-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => void update({ planHistory: list.filter((x) => x.from !== p.from) })}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {!list.length && (
          <div className="px-2 py-1 text-xs text-subtle-foreground">No changes recorded.</div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label>
          <span className="mb-1 block text-2xs text-muted-foreground">From</span>
          <Input
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            className="h-7 w-[140px] px-1.5 text-xs"
          />
        </label>
        <label>
          <span className="mb-1 block text-2xs text-muted-foreground">Plan</span>
          <select
            value={draft.plan}
            onChange={(e) => {
              const plan = e.target.value as PlanName
              setDraft({ ...draft, plan, mult: plan === 'custom' ? draft.mult : PLAN_MULT[plan] })
            }}
            className="h-7 rounded-md border border-border-strong bg-background px-1.5 text-xs"
          >
            {PLAN_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p === 'custom' ? 'Custom…' : planLabel({ plan: p, mult: PLAN_MULT[p] })}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="mb-1 block text-2xs text-muted-foreground">Multiplier</span>
          <Input
            type="number"
            min={0.1}
            step="any"
            value={draft.mult}
            onChange={(e) => setDraft({ ...draft, mult: Number(e.target.value) })}
            className="h-7 w-20 px-1.5 text-right text-xs"
          />
        </label>
        {draft.plan === 'custom' && (
          <label>
            <span className="mb-1 block text-2xs text-muted-foreground">Name</span>
            <Input
              value={draft.label ?? ''}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              className="h-7 w-28 px-1.5 text-xs"
            />
          </label>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={!draft.from || !(draft.mult > 0)}
          onClick={() =>
            void update({ planHistory: [...list.filter((x) => x.from !== draft.from), draft] })
          }
        >
          <Plus /> Add change
        </Button>
      </div>
    </div>
  )
}

export function HealthSettings({ update }: { update: (p: Partial<AppSettings>) => Promise<void> }) {
  const settings = useApp((s) => s.settings)
  const h = settings.health
  const setH = (p: Partial<AppSettings['health']>): void => void update({ health: { ...h, ...p } })
  return (
    <>
      <Section
        title="Limit health"
        description="Scores each 5-hour and weekly window as API-equivalent $ per 1% of the limit and compares it with the median of your normal dates (pick them on the Limit health card)."
      >
        <Row
          label="Flag threshold"
          hint={`A window is low when it buys less than 1/${h.threshold} of the baseline (${Math.round(100 / h.threshold)}%).`}
        >
          <Num
            label="Threshold"
            value={h.threshold}
            min={1.05}
            max={10}
            step={0.05}
            suffix="×"
            onCommit={(threshold) => setH({ threshold })}
          />
        </Row>
        <Row
          label="Low windows in a row"
          hint="How many finished windows in a row must be low before a possible reduction is flagged."
        >
          <Num
            label="Streak"
            value={h.streak}
            min={1}
            max={20}
            onCommit={(streak) => setH({ streak })}
          />
        </Row>
        <Row label="Skip windows under" hint="Low percentages are too coarse to score.">
          <Num
            label="Minimum %"
            value={h.minPct}
            min={1}
            max={90}
            suffix="%"
            onCommit={(minPct) => setH({ minPct })}
          />
        </Row>
        <Row
          label="Leave out windows used elsewhere"
          hint={`Skip windows where at least ${h.untrackedLimit}% of the usage rose while nothing ran on this computer (claude.ai, mobile, cloud).`}
        >
          <span className="inline-flex items-center gap-3">
            <Num
              label="Untracked share"
              value={h.untrackedLimit}
              min={1}
              max={100}
              suffix="%"
              onCommit={(untrackedLimit) => setH({ untrackedLimit })}
            />
            <Switch
              checked={h.excludeUntracked}
              onCheckedChange={(v) => setH({ excludeUntracked: v === true })}
              aria-label="Leave out windows used elsewhere"
            />
          </span>
        </Row>
        <Row
          label="One price per model family"
          hint="Price every Opus (or Sonnet, Haiku) model at the newest one's rates, so a cheaper new model doesn't look like a smaller limit."
        >
          <Switch
            checked={h.familyPricing}
            onCheckedChange={(v) => setH({ familyPricing: v === true })}
            aria-label="One price per model family"
          />
        </Row>
        <PlanHistory update={update} />
      </Section>
      <Section
        title="Pacing"
        description="The gauges show where your usage should be by now to end each window at the cap."
      >
        <Row label="Cap" hint="Target ceiling for both windows.">
          <Num
            label="Cap"
            value={settings.pace.cap}
            min={10}
            max={100}
            suffix="%"
            onCommit={(cap) => void update({ pace: { ...settings.pace, cap } })}
          />
        </Row>
        <Row
          label="On-pace tolerance"
          hint="Within this many points of the target counts as on pace."
        >
          <Num
            label="Tolerance"
            value={settings.pace.tolerance}
            min={0}
            max={50}
            suffix="points"
            onCommit={(tolerance) => void update({ pace: { ...settings.pace, tolerance } })}
          />
        </Row>
      </Section>
      <Section
        title="Ask Claude"
        description="Questions run through claude -p on your subscription with no tools, and send only aggregated numbers."
      >
        <Row
          label="Show what will be sent first"
          hint="A preview of the exact text before each question."
        >
          <Switch
            checked={!settings.askSkipPreview}
            onCheckedChange={(v) => void update({ askSkipPreview: v !== true })}
            aria-label="Show preview"
          />
        </Row>
        <Row label="Timeout">
          <Num
            label="Timeout"
            value={settings.askTimeoutSec}
            min={15}
            max={1800}
            suffix="seconds"
            onCommit={(askTimeoutSec) => void update({ askTimeoutSec })}
          />
        </Row>
      </Section>
    </>
  )
}
