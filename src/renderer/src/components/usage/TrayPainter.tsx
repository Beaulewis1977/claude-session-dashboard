import { useEffect } from 'react'
import { formatDuration } from '@shared/format'
import { now } from '@shared/clock'
import type { LimitsState } from '@shared/usage/limits'
import { api } from '@/lib/api'
import { levelOf } from '@/lib/meter-hooks'
import { useApp } from '@/lib/store'

const COLORS = { calm: '#4f7fd1', warn: '#e8a210', crit: '#d03b3b' }
const resetFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
})

/** A 32×32 ring with the 5-hour % in the middle, as a PNG data URL. */
function drawIcon(pct: number | undefined, dark: boolean): string {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 32
  const g = c.getContext('2d')!
  const cx = 16
  const r = 13
  g.lineWidth = 4
  g.strokeStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)'
  g.beginPath()
  g.arc(cx, cx, r, 0, Math.PI * 2)
  g.stroke()
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
  return c.toDataURL('image/png')
}

function tooltip(l: LimitsState | null): string {
  if (!l?.fiveHour && !l?.sevenDay) return 'Claude usage · live limits not enabled'
  const t = now()
  const line = (label: string, g: LimitsState['fiveHour']): string =>
    g
      ? `${label}: ${Math.round(g.pct)}%${g.resetsAt && !g.expired ? ` · resets ${resetFmt.format(g.resetsAt)} (in ${formatDuration(g.resetsAt - t)})` : ''}`
      : `${label}: no data`
  return [line('5-hour', l.fiveHour), line('Week', l.sevenDay)].join('\n')
}

/** Keeps the tray icon and tooltip in sync with the live limits. */
export function TrayPainter({ dark }: { dark: boolean }) {
  const limits = useApp((s) => s.limits)
  useEffect(() => {
    if (!limits) return
    const pct =
      limits.fiveHour && !limits.fiveHour.expired
        ? limits.fiveHour.pct
        : limits.fiveHour
          ? 0
          : undefined
    void api.setTrayImage(drawIcon(pct, dark), tooltip(limits))
  }, [limits, dark])
  return null
}
