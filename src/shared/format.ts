import { now as appNow } from './clock'

const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

/** Local date/time, e.g. "Oct 22, 2026 2:47 PM". */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const parts: Record<string, string> = {}
  for (const p of dateTimeFmt.formatToParts(d)) parts[p.type] = p.value
  return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`
}

/** Compact relative time, e.g. "5m", "3h", "2d", "Oct 2". */
export function formatRelative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, now - t)
  const min = 60_000
  if (diff < min) return 'now'
  if (diff < 60 * min) return `${Math.floor(diff / min)}m`
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}h`
  if (diff < 7 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))}d`
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Last path segment of a Windows or POSIX path. */
export function baseName(p: string | undefined): string {
  if (!p) return ''
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Compact token count: 950, 12.4K, 1.2M, 3.4B. */
export function formatTokens(n: number): string {
  const a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ]
  for (const [v, u] of units) {
    if (a >= v) {
      const x = n / v
      return `${Math.abs(x) >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${u}`
    }
  }
  return String(n)
}

/** Full number with separators: 1,234,567. */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** "$4.81", "$0.42", "$1,234", "<$0.01". */
export function formatUsd(n: number, opts: { cents?: boolean } = {}): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  if (Math.abs(n) >= 1000 && !opts.cents) return `$${Math.round(n).toLocaleString('en-US')}`
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "2h 14m", "45m", "3d 4h", "<1m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return '<1m'
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const min = m % 60
  if (d) return h ? `${d}d ${h}h` : `${d}d`
  if (h) return min ? `${h}h ${min}m` : `${h}h`
  return `${min}m`
}

/** "+18%", "−7%". */
export function formatPct(n: number, digits = 0): string {
  const s = Math.abs(n).toFixed(digits)
  return `${n >= 0 ? '+' : '−'}${s}%`
}

/** "just now", "5 min ago", "3h ago", "2 days ago". Uses the app clock. */
export function ago(ts: number, nowMs = appNow()): string {
  const d = Math.max(0, nowMs - ts)
  const m = Math.floor(d / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}
