import { useEffect } from 'react'
import { formatDuration } from '@shared/format'
import { now } from '@shared/clock'
import { freshnessOf, gaugeSummary, type Freshness, type LimitsState } from '@shared/usage/limits'
import { api } from '@/lib/api'
import { levelOf, useNow } from '@/lib/meter-hooks'
import { useApp } from '@/lib/store'
import type { CodexLimitsState } from '@shared/usage/codex'
import { codexGaugeLine, codexMainGauge } from '@/lib/codex-meter'

const COLORS = { calm: '#4f7fd1', warn: '#e8a210', crit: '#d03b3b' }
const resetFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
})

/**
 * A 32×32 ring with the 5-hour % in the middle, as a PNG data URL. An old
 * reading gets an amber dot; one from before the window reset shows "–" on a
 * dashed amber ring instead of a % that no longer means anything.
 */
function drawIcon(pct: number | undefined, dark: boolean, freshness?: Freshness): string {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 32
  const g = c.getContext('2d')!
  const cx = 16
  const r = 13
  g.lineWidth = 4
  g.strokeStyle =
    freshness === 'stale' ? COLORS.warn : dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)'
  if (freshness === 'stale') g.setLineDash([4, 3])
  g.beginPath()
  g.arc(cx, cx, r, 0, Math.PI * 2)
  g.stroke()
  g.setLineDash([])
  if (pct !== undefined) {
    g.strokeStyle = COLORS[levelOf(pct)]
    g.lineCap = 'round'
    g.beginPath()
    g.arc(cx, cx, r, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, pct) / 100) * Math.PI * 2)
    g.stroke()
  }
  g.fillStyle = dark ? '#f4f4f5' : '#18181b'
  g.font = `600 ${pct !== undefined && pct >= 100 ? 10 : 13}px "Segoe UI", system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(pct === undefined ? '–' : String(Math.min(999, Math.round(pct))), cx, cx + 1)
  if (freshness === 'aging') {
    g.fillStyle = COLORS.warn
    g.beginPath()
    g.arc(27, 5, 4.5, 0, Math.PI * 2)
    g.fill()
  }
  return c.toDataURL('image/png')
}

/**
 * Both providers: Claude Code's 5-hour % on the outer ring, Codex's main
 * window on the inner one, and the higher of the two in the middle.
 */
function drawBoth(
  claude: number | undefined,
  codex: number | undefined,
  dark: boolean,
  freshness?: Freshness
): string {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 32
  const g = c.getContext('2d')!
  const ring = (r: number, w: number, pct: number | undefined): void => {
    g.lineWidth = w
    g.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)'
    g.beginPath()
    g.arc(16, 16, r, 0, Math.PI * 2)
    g.stroke()
    if (pct === undefined) return
    g.strokeStyle = COLORS[levelOf(pct)]
    g.lineCap = 'round'
    g.beginPath()
    g.arc(16, 16, r, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, pct) / 100) * Math.PI * 2)
    g.stroke()
  }
  ring(14, 3, claude)
  ring(9.5, 3, codex)
  const top = [claude, codex].filter((x): x is number => x !== undefined)
  g.fillStyle = dark ? '#f4f4f5' : '#18181b'
  g.font = '600 9px "Segoe UI", system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(top.length ? String(Math.min(999, Math.round(Math.max(...top)))) : '–', 16, 16.5)
  if (freshness === 'aging') {
    g.fillStyle = COLORS.warn
    g.beginPath()
    g.arc(27, 5, 4.5, 0, Math.PI * 2)
    g.fill()
  }
  return c.toDataURL('image/png')
}

function codexTooltip(c: CodexLimitsState | null): string[] {
  if (!c?.hasData) return ['Codex: no plan limits in its logs yet']
  const t = now()
  const line = (label: string, g: CodexLimitsState['fiveHour']): string =>
    `${codexGaugeLine(label, g, t)}${g?.resetsAt && !g.expired ? ` · resets ${resetFmt.format(g.resetsAt)} (in ${formatDuration(g.resetsAt - t)})` : ''}`
  return [
    ...(c.fiveHourRecent ? [line('Codex 5-hour', c.fiveHour)] : []),
    line('Codex week', c.sevenDay)
  ]
}

function tooltip(l: LimitsState | null): string {
  if (!l?.fiveHour && !l?.sevenDay) return 'Claude usage · live limits not enabled'
  const t = now()
  const line = (label: string, g: LimitsState['fiveHour']): string =>
    `${gaugeSummary(label, g, t)}${g?.resetsAt && !g.expired ? ` · resets ${resetFmt.format(g.resetsAt)} (in ${formatDuration(g.resetsAt - t)})` : ''}`
  return [line('5-hour', l.fiveHour), line('Week', l.sevenDay)].join('\n')
}

/** Keeps the tray icon and tooltip in sync with the live limits. */
export function TrayPainter({ dark }: { dark: boolean }) {
  const limits = useApp((s) => s.limits)
  const codex = useApp((s) => s.codexLimits)
  const mp = useApp((s) => s.settings.meterProvider ?? 'claude')
  // Re-drawn every minute too, so the icon turns amber as a reading ages.
  const t = useNow(60_000)
  useEffect(() => {
    if (mp === 'claude') {
      if (!limits) return
      const g = limits.fiveHour
      const freshness = g && freshnessOf(g, t)
      const pct = g && freshness !== 'stale' ? g.pct : undefined
      void api.setTrayImage(drawIcon(pct, dark, freshness), tooltip(limits))
      return
    }
    const main = codexMainGauge(codex, t)
    const cf = main && freshnessOf(main.g, t)
    const cpct = main && cf !== 'stale' ? main.g.pct : undefined
    if (mp === 'codex') {
      void api.setTrayImage(drawIcon(cpct, dark, cf), codexTooltip(codex).join('\n'))
      return
    }
    const g = limits?.fiveHour
    const f = g && freshnessOf(g, t)
    const pct = g && f !== 'stale' ? g.pct : undefined
    const aging = f === 'aging' || cf === 'aging' ? 'aging' : undefined
    void api.setTrayImage(
      drawBoth(pct, cpct, dark, aging),
      [tooltip(limits), ...codexTooltip(codex)].join('\n')
    )
  }, [limits, codex, mp, dark, t])
  return null
}
