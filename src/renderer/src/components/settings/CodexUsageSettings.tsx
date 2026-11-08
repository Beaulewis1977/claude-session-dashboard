// Settings → Codex usage & limits: its plan (detected from the logs, with the
// raw code shown, or chosen), multipliers, limit-health threshold, its own
// price table and what the tray / mini meter / status bar show. Never shared
// with Claude Code's plan, baseline or prices.

import { useState } from 'react'
import { Calculator, Plus, RotateCcw } from 'lucide-react'
import type { AppSettings, MeterProvider } from '@shared/types'
import {
  CODEX_PLAN_LABEL,
  CODEX_PLANS,
  codeLabel,
  DEFAULT_CODEX_MULT,
  type CodexPlan,
  type CodexPlanSetting
} from '@shared/usage/codex'
import { DEFAULT_HEALTH } from '@shared/usage/health'
import {
  CODEX_PRICES_FILLED_IN,
  DEFAULT_CODEX_PRICES,
  unpricedModels,
  type ModelPrice,
  type PriceTier
} from '@shared/usage/pricing'
import { toYmd } from '@shared/usage/health'
import { now } from '@shared/clock'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Row, Section } from '../SettingsView'

const dayFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})

/** Codex's token types, as Codex names them (uncached input is billed at the input price). */
const COLS: { key: keyof PriceTier; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'cacheRead', label: 'Cached input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite5m', label: 'Cache write' }
]

function Num({
  value,
  label,
  onCommit,
  className,
  min = 0
}: {
  value: number
  label: string
  onCommit: (v: number) => void
  className?: string
  min?: number
}) {
  return (
    <Input
      type="number"
      min={min}
      step="any"
      aria-label={label}
      defaultValue={value}
      key={value}
      className={cn('h-7 px-1.5 text-right text-xs tabular-nums', className)}
      onBlur={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n) && n >= min && n !== value) onCommit(n)
      }}
    />
  )
}

export function CodexUsageSettings({
  update
}: {
  update: (p: Partial<AppSettings>) => Promise<void>
}) {
  const settings = useApp((s) => s.settings)
  const codex = useApp((s) => s.codexLimits)
  const [showAll, setShowAll] = useState(false)
  const plan = settings.codexPlan ?? 'auto'
  const mults = settings.codexPlanMults ?? {}
  const prices = settings.codexPrices ?? DEFAULT_CODEX_PRICES
  const health = settings.codexHealth ?? DEFAULT_HEALTH
  const detected = codex?.plan.detectedCode
  const since = codex?.plan.detectedSince
  const seen = [...new Set((codex?.plan.changes ?? []).map((c) => c.code))]

  const setPrice = (i: number, key: keyof PriceTier, v: number): void => {
    const next = prices.map((p, j) => {
      if (j !== i) return p
      // One cache-write price: Codex logs report no separate lifetimes.
      return key === 'cacheWrite5m'
        ? { ...p, cacheWrite5m: v, cacheWrite1h: v }
        : { ...p, [key]: v }
    })
    void update({ codexPrices: next })
  }
  const shown = showAll ? prices : prices.slice(0, 8)

  return (
    <Section
      id="codex-usage"
      title="Codex usage & limits"
      description="Codex writes its token counts and your plan limits into its own session logs, so they show here with no setup. Its plan, multipliers, normal dates and prices are its own: never mixed with Claude Code's."
    >
      <Row
        label="Plan"
        hint={
          detected
            ? `Your logs say ${codeLabel(detected)}${since ? `, since ${dayFmt.format(since)}` : ''}${seen.length > 1 ? ` (seen before: ${seen.slice(0, -1).map(codeLabel).join(', ')})` : ''}. "prolite" is taken to be Pro $100.`
            : 'No plan_type in your Codex logs yet (it appears with a ChatGPT sign-in).'
        }
      >
        <select
          aria-label="Codex plan"
          value={plan}
          onChange={(e) => void update({ codexPlan: e.target.value as CodexPlanSetting })}
          className="h-8 rounded-md border border-border-strong bg-background px-2 text-xs"
        >
          <option value="auto">
            {detected ? `Detected: ${codeLabel(detected)}` : 'Detect from the logs'}
          </option>
          {CODEX_PLANS.map((p) => (
            <option key={p} value={p}>
              {CODEX_PLAN_LABEL[p]}
            </option>
          ))}
        </select>
      </Row>

      <div>
        <div className="text-[13px] font-medium">Plan multipliers</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          The size of each plan&apos;s limits relative to Plus, so a plan change doesn&apos;t read
          as a cut in limit health. OpenAI publishes no multipliers: Business, Enterprise and Edu
          get about Plus-level limits per seat; the Pro values are guesses. Edit them to match what
          you see.
        </div>
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {CODEX_PLANS.map((p: CodexPlan) => (
            <label
              key={p}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover"
            >
              <span className={cn(codex?.plan.plan === p && 'font-medium')}>
                {CODEX_PLAN_LABEL[p]}
              </span>
              <span className="inline-flex items-center gap-1">
                <Num
                  value={mults[p] ?? DEFAULT_CODEX_MULT[p]}
                  min={0.01}
                  label={`${CODEX_PLAN_LABEL[p]} multiplier`}
                  className="w-16"
                  onCommit={(v) => void update({ codexPlanMults: { ...mults, [p]: v } })}
                />
                <span className="text-muted-foreground">x</span>
              </span>
            </label>
          ))}
        </div>
        {Object.keys(mults).length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="mt-1"
            onClick={() => void update({ codexPlanMults: {} })}
          >
            <RotateCcw /> Reset multipliers
          </Button>
        )}
      </div>

      <Row
        label="Normal dates"
        hint={
          health.baselineFrom
            ? `${health.baselineFrom} to ${health.baselineTo ?? health.baselineFrom}. Pick them in the Codex limit health card; dates within your current plan work best.`
            : 'Not picked yet. Dates within your current plan work best (a multiplier guess then cancels out).'
        }
      >
        {since && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void update({
                codexHealth: { ...health, baselineFrom: toYmd(since), baselineTo: toYmd(now()) }
              })
            }
          >
            Use the current plan&apos;s dates
          </Button>
        )}
      </Row>
      <Row
        label="Flag a possible reduction below"
        hint="Baseline ÷ this, for the streak below (Codex's own; Claude Code's is set above)."
      >
        <span className="inline-flex items-center gap-2 text-xs">
          <Num
            value={health.threshold}
            min={1.01}
            label="Codex threshold"
            className="w-16"
            onCommit={(threshold) => void update({ codexHealth: { ...health, threshold } })}
          />
          <span className="text-muted-foreground">for</span>
          <Num
            value={health.streak}
            min={1}
            label="Codex streak"
            className="w-14"
            onCommit={(streak) =>
              void update({ codexHealth: { ...health, streak: Math.round(streak) } })
            }
          />
          <span className="text-muted-foreground">windows in a row</span>
        </span>
      </Row>

      <Row
        label="Different plans in the logs are"
        hint={
          (settings.codexAccounts ?? 'separate') === 'separate'
            ? "Separate sign-ins: each plan_type keeps its own gauges and history (the gauges follow the newest). The logs can't tell a second sign-in from a plan change."
            : 'One account that changed plan: one history, each window scored at the multiplier of its plan, so a Plus baseline carries over to Pro.'
        }
      >
        <Segmented<'separate' | 'one'>
          ariaLabel="Different plans in the logs are"
          value={settings.codexAccounts ?? 'separate'}
          onChange={(v) => void update({ codexAccounts: v })}
          options={[
            { value: 'separate', label: 'Separate sign-ins' },
            { value: 'one', label: 'One account' }
          ]}
        />
      </Row>

      <Row
        label="Tray, mini meter and status bar"
        hint="Whose limits they show. Usage alerts (75% / 90%, set above) work for both."
      >
        <Segmented<MeterProvider>
          ariaLabel="Meters show"
          value={settings.meterProvider ?? 'claude'}
          onChange={(v) => void update({ meterProvider: v })}
          options={[
            { value: 'claude', label: 'Claude' },
            { value: 'codex', label: 'Codex' },
            { value: 'both', label: 'Both' }
          ]}
        />
      </Row>

      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <Calculator className="size-3.5 text-muted-foreground" /> Codex prices
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void update({ codexPrices: DEFAULT_CODEX_PRICES.map((p) => ({ ...p })) })
            }
          >
            <RotateCcw /> Reset to snapshot prices
          </Button>
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          OpenAI API prices, USD per million tokens, for cost estimates and limit health. From a
          bundled snapshot of LiteLLM&apos;s price data, filled in{' '}
          {new Date(`${CODEX_PRICES_FILLED_IN}T12:00:00`).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          })}
          . Prices are never downloaded. A model matches its own row or a dated copy of it.
        </div>
        <UnpricedCodexModels
          prices={prices}
          onAdd={(row) => void update({ codexPrices: [...prices, row] })}
        />
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-secondary/50 text-muted-foreground">
                <th className="px-2 py-1.5 text-left font-medium">Model</th>
                {COLS.map((c) => (
                  <th key={c.key} className="px-2 py-1.5 text-right font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((p, i) => (
                <tr key={p.model} className="border-b border-border last:border-0">
                  <td className="px-2 py-1">
                    <div className="font-medium">{p.label}</div>
                    <div className="text-2xs text-subtle-foreground">{p.model}</div>
                  </td>
                  {COLS.map((c) => (
                    <td key={c.key} className="px-1 py-1">
                      <Num
                        value={p[c.key]}
                        label={`${p.model} ${c.label}`}
                        className="ml-auto w-20"
                        onCommit={(v) => setPrice(i, c.key, v)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {prices.length > 8 && (
          <Button variant="ghost" size="xs" className="mt-1" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${prices.length} models`}
          </Button>
        )}
      </div>
    </Section>
  )
}

/** "New model detected": Codex models in the usage data without a price row. */
function UnpricedCodexModels({
  prices,
  onAdd
}: {
  prices: ModelPrice[]
  onAdd: (row: ModelPrice) => void
}) {
  const models = useApp((s) => s.codexLimits?.models)
  const missing = unpricedModels(models ?? [], prices)
  if (!missing.length) return null
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs">
      <div className="font-medium">New model{missing.length === 1 ? '' : 's'} detected</div>
      <div className="text-muted-foreground">
        These Codex models are in your logs but have no price, so their cost shows as $0. Add a row
        and fill in the prices.
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {missing.map((m) => (
          <Button
            key={m}
            variant="outline"
            size="xs"
            onClick={() =>
              onAdd({
                model: m,
                label: m,
                input: 0,
                output: 0,
                cacheWrite5m: 0,
                cacheWrite1h: 0,
                cacheRead: 0
              })
            }
          >
            <Plus /> {m}
          </Button>
        ))}
      </div>
    </div>
  )
}
