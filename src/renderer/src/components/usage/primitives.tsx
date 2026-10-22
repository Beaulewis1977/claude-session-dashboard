// Small building blocks for the Usage view: cards, info tips, sparklines,
// count-up numbers and the ring gauge.

import { useEffect, useId, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { levelOf, LEVEL_COLOR, useCountUp, useReducedMotion } from '@/lib/meter-hooks'
import { cn } from '@/lib/utils'
import { Tooltip } from '../ui/tooltip'

export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  return <>{format(useCountUp(value))}</>
}

export function InfoTip({
  children,
  side = 'top'
}: {
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <Tooltip
      content={<span className="block max-w-[280px] leading-relaxed">{children}</span>}
      side={side}
    >
      <button
        type="button"
        aria-label="More information"
        className="inline-flex size-4 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:text-muted-foreground"
      >
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  )
}

export function Card({
  className,
  children,
  onClick,
  active
}: {
  className?: string
  children: ReactNode
  onClick?: () => void
  active?: boolean
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      className={cn(
        'min-w-0 rounded-xl border border-border bg-card text-left shadow-card transition-[border-color,box-shadow,background-color]',
        onClick && 'cursor-pointer hover:border-border-strong',
        active && 'border-primary/50 ring-3 ring-primary/10',
        className
      )}
    >
      {children}
    </Comp>
  )
}

export function CardHeader({
  title,
  subtitle,
  info,
  right,
  className
}: {
  title: ReactNode
  subtitle?: ReactNode
  info?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13.5px] font-semibold tracking-[-0.01em]">
          {title}
          {info && <InfoTip>{info}</InfoTip>}
        </div>
        {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-secondary', className)} />
}

/** Tiny line + soft area sparkline. */
export function Sparkline({
  values,
  className,
  color = 'var(--muted-foreground)',
  height = 28
}: {
  values: number[]
  className?: string
  color?: string
  height?: number
}) {
  const id = useId()
  const w = 100
  const max = Math.max(...values, 0)
  if (values.length < 2 || max <= 0) {
    return <div className={cn('h-7', className)} style={{ height }} />
  }
  const pts = values.map(
    (v, i) => [(i / (values.length - 1)) * w, height - 2 - (v / max) * (height - 4)] as const
  )
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${w},${height} L0,${height} Z`
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={cn('w-full overflow-visible', className)}
      style={{ height }}
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lx} cy={ly} r={2.2} fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** A ring gauge that fills on load (respects reduced motion). */
export function RingGauge({
  pct,
  size = 148,
  stroke = 11,
  dim,
  children
}: {
  pct: number | undefined
  size?: number
  stroke?: number
  /** Show a dashed, muted ring (no live data). */
  dim?: boolean
  children?: ReactNode
}) {
  const reduced = useReducedMotion()
  const [mounted, setMounted] = useState(reduced)
  useEffect(() => {
    const t = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(t)
  }, [])
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const value = Math.max(0, Math.min(100, pct ?? 0))
  const offset = c * (1 - (mounted ? value : 0) / 100)
  const color = LEVEL_COLOR[levelOf(value)]
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--gauge-track)"
          strokeWidth={stroke}
          strokeDasharray={dim ? '2 6' : undefined}
        />
        {!dim && pct !== undefined && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{
              transition: reduced
                ? 'none'
                : 'stroke-dashoffset 380ms cubic-bezier(0.22, 1, 0.36, 1), stroke 200ms'
            }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {children}
      </div>
    </div>
  )
}
