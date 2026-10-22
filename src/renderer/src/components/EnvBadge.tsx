import { Monitor, SquareTerminal } from 'lucide-react'
import type { EnvKind } from '@shared/types'
import { Badge } from './ui/badge'

export function EnvBadge({
  env,
  distro,
  className
}: {
  env: EnvKind
  distro?: string
  className?: string
}) {
  return env === 'wsl' ? (
    <Badge variant="wsl" className={className}>
      <SquareTerminal /> WSL: {distro}
    </Badge>
  ) : (
    <Badge variant="windows" className={className}>
      <Monitor /> Windows
    </Badge>
  )
}

export function EnvDot({ env }: { env: EnvKind }) {
  return (
    <span
      className={
        env === 'wsl'
          ? 'size-1.5 shrink-0 rounded-full bg-env-wsl'
          : 'size-1.5 shrink-0 rounded-full bg-env-windows'
      }
    />
  )
}
