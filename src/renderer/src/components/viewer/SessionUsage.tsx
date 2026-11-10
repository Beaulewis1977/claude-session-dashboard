import { useEffect, useState } from 'react'
import { BarChart3, Gauge, Zap } from 'lucide-react'
import type { SessionUsage } from '@shared/usage/types'
import { CLAUDE_TTFT_CAVEAT, SPEED_CAVEAT, ttftCoverageText } from '@shared/usage/speed'
import { formatTps, formatTtft } from '@/lib/usage-format'
import { formatInt, formatTokens, formatUsd } from '@shared/format'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { modelColor, modelLabel, TOKEN_META, TOKEN_ORDER } from '@/lib/usage-colors'
import { Tooltip } from '@/components/ui/tooltip'

/** Per-session token usage in the viewer header. */
export function SessionUsageStrip({
  sessionKey,
  version
}: {
  sessionKey: string
  version: number
}) {
  const [u, setU] = useState<SessionUsage | null>(null)
  const set = useApp((s) => s.set)
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void api.getSessionUsage(sessionKey).then((r) => !cancelled && setU(r))
    }
    load()
    const off = api.onUsageChanged(load)
    return () => {
      cancelled = true
      off()
    }
  }, [sessionKey, version])

  if (!u || u.responses === 0) return null
  const models = u.byModel.map((m) => m.key)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
      <Tooltip content={`${formatInt(u.total)} tokens in ${formatInt(u.responses)} responses`}>
        <div className="flex items-baseline gap-1.5">
          <BarChart3 className="size-3.5 self-center text-subtle-foreground" />
          <span className="text-[13px] font-semibold tabular-nums">{formatTokens(u.total)}</span>
          <span className="text-xs text-muted-foreground">tokens</span>
        </div>
      </Tooltip>
      <div className="flex min-w-[160px] flex-1 items-center gap-2">
        <div className="flex h-1.5 min-w-0 flex-1 gap-[2px] overflow-hidden rounded-full">
          {TOKEN_ORDER.map((t) =>
            u[t] > 0 ? (
              <Tooltip key={t} content={`${TOKEN_META[t].label}: ${formatInt(u[t])}`}>
                <span
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{
                    flexGrow: u[t],
                    flexBasis: 0,
                    minWidth: 3,
                    background: TOKEN_META[t].color
                  }}
                />
              </Tooltip>
            ) : null
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatTokens(u.output)} out
        </span>
      </div>
      <Tooltip content="Estimated at API prices from the price table in Settings">
        <span className="text-xs text-muted-foreground tabular-nums">≈ {formatUsd(u.cost)}</span>
      </Tooltip>
      <SpeedChip u={u} />
      <div className="flex flex-wrap items-center gap-2.5">
        {u.byModel.slice(0, 3).map((m) => (
          <span
            key={m.key}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              className="size-2 rounded-full"
              style={{ background: modelColor(m.key, models) }}
            />
            {modelLabel(m.key)}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="ml-auto text-xs font-medium text-primary hover:underline"
        onClick={() => set({ view: 'usage' })}
      >
        Usage →
      </button>
    </div>
  )
}

/** The session's median output speed and time to first token, and a "Fast" badge. */
export function SpeedChip({ u }: { u: SessionUsage }) {
  const sp = u.speed
  if (!sp || (sp.tps === undefined && !sp.fast)) return null
  const coverage = ttftCoverageText(sp.ttftCoverage)
  const ttft =
    sp.ttftMs === undefined ? 'n/a' : `${formatTtft(sp.ttftMs)}${sp.ttftEstimated ? ' est.' : ''}`
  return (
    <Tooltip
      content={
        <span className="block max-w-[300px] space-y-1 leading-relaxed">
          <span className="block">
            Output speed: {formatTps(sp.tps)}
            {sp.samples
              ? ` (median of ${formatInt(sp.samples)} responses${sp.fast ? ', normal mode' : ''})`
              : ''}
          </span>
          {sp.fast && (
            <span className="block">
              Fast mode: {formatTps(sp.fastTps)}
              {sp.fastSamples ? ` (${formatInt(sp.fastSamples)} responses)` : ''}
            </span>
          )}
          <span className="block">
            Time to first token: {ttft}
            {sp.ttftEstimated
              ? coverage
                ? ` (${coverage})`
                : ''
              : sp.ttftSamples
                ? ` (Codex's own, ${formatInt(sp.ttftSamples)} turns)`
                : ''}
          </span>
          <span className="block text-muted-foreground">
            {SPEED_CAVEAT}
            {sp.ttftEstimated ? ` ${CLAUDE_TTFT_CAVEAT}` : ''}
          </span>
        </span>
      }
    >
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        <Gauge className="size-3.5 text-subtle-foreground" />
        {sp.tps !== undefined && <span>{formatTps(sp.tps)}</span>}
        {sp.tps !== undefined && sp.ttftMs !== undefined && (
          <span className="text-subtle-foreground">· TTFT {ttft}</span>
        )}
        {sp.fast && (
          <span className="inline-flex items-center gap-0.5 rounded bg-primary/12 px-1 text-[10px] font-medium text-primary">
            <Zap className="size-2.5" /> Fast
          </span>
        )}
      </span>
    </Tooltip>
  )
}
