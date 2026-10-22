import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Calculator, Info, RefreshCw, RotateCcw, Scale } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import type { CcusageComparison, UsageStatus } from '@shared/usage/types'
import { DEFAULT_PRICES, PRICES_FILLED_IN, type ModelPrice } from '@shared/usage/pricing'
import { DEFAULT_WEIGHTS, type CapacityWeights } from '@shared/usage/limits'
import { formatInt, formatTokens } from '@shared/format'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Tooltip } from '../ui/tooltip'
import { Row, Section } from '../SettingsView'

const PRICE_COLS: { key: keyof Omit<ModelPrice, 'model' | 'label'>; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite5m', label: 'Cache write 5m' },
  { key: 'cacheWrite1h', label: 'Cache write 1h' },
  { key: 'cacheRead', label: 'Cache read' }
]

const WEIGHT_COLS: { key: keyof CapacityWeights; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'cacheRead', label: 'Cache read' }
]

function NumberCell({
  value,
  onCommit,
  label,
  className
}: {
  value: number
  onCommit: (v: number) => void
  label: string
  className?: string
}) {
  return (
    <Input
      type="number"
      min={0}
      step="any"
      aria-label={label}
      defaultValue={value}
      key={value}
      className={cn('h-7 px-1.5 text-right text-xs tabular-nums', className)}
      onBlur={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n) && n >= 0 && n !== value) onCommit(n)
      }}
    />
  )
}

export function UsageSettings({ update }: { update: (p: Partial<AppSettings>) => Promise<void> }) {
  const settings = useApp((s) => s.settings)
  const [status, setStatus] = useState<UsageStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [cc, setCc] = useState<CcusageComparison | null>(null)
  const [ccBusy, setCcBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    const load = (): void => void api.getUsageStatus().then(setStatus)
    load()
    return api.onUsageChanged(load)
  }, [])

  const setPrice = (i: number, key: keyof ModelPrice, v: number): void => {
    const prices = settings.prices.map((p, j) => (j === i ? { ...p, [key]: v } : p))
    void update({ prices })
  }
  const prices = showAll ? settings.prices : settings.prices.slice(0, 8)

  return (
    <Section
      title="Usage"
      description="Token usage is read from every session log (and the archive), counted once per API response, and kept forever in the app's data folder."
    >
      <Row label="Weeks start on">
        <Segmented
          ariaLabel="Week start"
          value={settings.weekStart}
          onChange={(weekStart) => void update({ weekStart })}
          options={[
            { value: 'monday', label: 'Monday' },
            { value: 'sunday', label: 'Sunday' }
          ]}
        />
      </Row>
      <Row
        label="Recalculate usage"
        hint={
          status
            ? `${formatInt(status.records)} responses from ${formatInt(status.files)} sessions${status.parsing ? ' · reading…' : ''}`
            : '…'
        }
      >
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={ccBusy}
            onClick={() => {
              setCcBusy(true)
              void api.verifyCcusage().then((r) => {
                setCc(r)
                setCcBusy(false)
              })
            }}
          >
            <Scale /> Verify against ccusage
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void api.recalculateUsage().then((s) => {
                setStatus(s)
                setBusy(false)
                toast.success('Usage recalculated', {
                  description: `${formatInt(s.records)} responses`
                })
              })
            }}
          >
            <RefreshCw className={cn(busy && 'animate-spin')} /> Recalculate
          </Button>
        </div>
      </Row>
      {cc && (
        <div className="rounded-lg border border-border text-xs">
          {cc.error ? (
            <div className="flex items-start gap-2 px-3 py-2.5 text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" /> {cc.error}
            </div>
          ) : (
            <>
              <div className="px-3 pt-2.5 pb-1 text-muted-foreground">
                ccusage reads the Windows profile only, so this compares Windows sessions. Small
                differences are normal while sessions are running.
              </div>
              <div className="max-h-56 overflow-auto px-3 pb-2">
                <table className="w-full tabular-nums">
                  <thead className="text-subtle-foreground">
                    <tr>
                      <th className="py-1 text-left font-medium">Day</th>
                      <th className="py-1 text-right font-medium">This app</th>
                      <th className="py-1 text-right font-medium">ccusage</th>
                      <th className="py-1 text-right font-medium">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cc.rows.slice(0, 60).map((r) => (
                      <tr key={r.date} className="border-t border-border">
                        <td className="py-1">{r.date}</td>
                        <td className="py-1 text-right">{formatTokens(r.ours)}</td>
                        <td className="py-1 text-right">{formatTokens(r.theirs)}</td>
                        <td
                          className={cn(
                            'py-1 text-right',
                            r.diff !== 0 && 'font-medium text-foreground'
                          )}
                        >
                          {r.diff === 0
                            ? 'same'
                            : `${r.diff > 0 ? '+' : '−'}${formatTokens(Math.abs(r.diff))}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
          Capacity weights
          <Tooltip
            content="How much each token type counts toward the implied-capacity estimate. Defaults follow API price ratios: output and cache writes cost more than input and cache reads."
            side="right"
          >
            <Info className="size-3.5 text-subtle-foreground" aria-label="About capacity weights" />
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {WEIGHT_COLS.map((c) => (
            <label key={c.key} className="w-24">
              <span className="mb-1 block text-2xs text-muted-foreground">{c.label}</span>
              <NumberCell
                label={`${c.label} weight`}
                value={settings.capacityWeights[c.key]}
                onCommit={(v) =>
                  void update({ capacityWeights: { ...settings.capacityWeights, [c.key]: v } })
                }
              />
            </label>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void update({ capacityWeights: { ...DEFAULT_WEIGHTS } })}
          >
            <RotateCcw /> Defaults
          </Button>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <Calculator className="size-3.5 text-muted-foreground" /> Prices for cost estimates
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void update({ prices: DEFAULT_PRICES.map((p) => ({ ...p })) })}
          >
            <RotateCcw /> Reset to published prices
          </Button>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          USD per million tokens. Filled in from Anthropic&apos;s published API prices on{' '}
          {new Date(`${PRICES_FILLED_IN}T12:00:00`).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
          })}
          . Edit any value; models match by id prefix.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[620px] text-xs">
            <thead className="bg-secondary/60 text-subtle-foreground">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-medium">Model</th>
                {PRICE_COLS.map((c) => (
                  <th key={c.key} className="px-1.5 py-1.5 text-right font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prices.map((p, i) => (
                <tr key={p.model} className="border-t border-border">
                  <td className="px-2.5 py-1">
                    <div className="font-medium">{p.label}</div>
                    <div className="font-mono text-[10.5px] text-subtle-foreground">{p.model}</div>
                  </td>
                  {PRICE_COLS.map((c) => (
                    <td key={c.key} className="w-[92px] px-1 py-1">
                      <NumberCell
                        label={`${p.label} ${c.label}`}
                        value={p[c.key]}
                        onCommit={(v) => setPrice(i, c.key, v)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {settings.prices.length > 8 && (
          <Button variant="ghost" size="xs" className="mt-1" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${settings.prices.length} models`}
          </Button>
        )}
      </div>
    </Section>
  )
}
