import { useMemo } from 'react'
import QRCode from 'qrcode'
import { cn } from '@/lib/utils'

/** A QR code as SVG: always dark on white with a quiet zone, so phones read it in any theme. */
export function QrCode({
  value,
  size = 180,
  label,
  className
}: {
  value: string
  size?: number
  label: string
  className?: string
}) {
  const { d, n } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' })
    const m = qr.modules
    const q = 4
    let path = ''
    for (let r = 0; r < m.size; r++)
      for (let c = 0; c < m.size; c++) if (m.get(r, c)) path += `M${c + q} ${r + q}h1v1h-1z`
    return { d: path, n: m.size + q * 2 }
  }, [value])
  return (
    <svg
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn('rounded-lg', className)}
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#111" />
    </svg>
  )
}
