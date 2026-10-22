import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import type { SessionUsage } from '@shared/usage/types'
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
