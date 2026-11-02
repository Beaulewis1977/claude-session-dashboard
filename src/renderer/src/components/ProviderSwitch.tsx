// The All / Claude / Codex switch and the small provider badge. Generic
// icons only (no product logos).

import { Layers } from 'lucide-react'
import {
  PROVIDER_LABEL,
  PROVIDER_SHORT,
  providerOf,
  type ProviderId,
  type ProviderView
} from '@shared/provider'
import { PROVIDER_ICON } from '@/lib/provider-icons'
import { cn } from '@/lib/utils'
import { Segmented } from './ui/segmented'

/** All / Claude / Codex. Only the providers that are on are offered. */
export function ProviderSwitch({
  value,
  onChange,
  enabled,
  className
}: {
  value: ProviderView
  onChange: (v: ProviderView) => void
  enabled: ProviderId[]
  className?: string
}) {
  if (enabled.length < 2) return null
  return (
    <Segmented<ProviderView>
      ariaLabel="Show sessions of"
      value={value}
      onChange={onChange}
      className={cn('flex w-full [&>*]:flex-1 [&>*]:justify-center [&>*]:px-1.5', className)}
      options={[
        { value: 'all', label: 'All', icon: <Layers /> },
        ...enabled.map((p) => {
          const Icon = PROVIDER_ICON[p]
          return { value: p, label: PROVIDER_SHORT[p], icon: <Icon /> }
        })
      ]}
    />
  )
}

/** "Claude" / "Codex" next to a session (shown in the All view). */
export function ProviderBadge({
  provider,
  className
}: {
  provider: ProviderId | undefined
  className?: string
}) {
  const p = providerOf({ provider })
  const Icon = PROVIDER_ICON[p]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border border-border px-1 text-[10px] font-medium text-foreground/70',
        className
      )}
      title={PROVIDER_LABEL[p]}
    >
      <Icon className="size-2.5" />
      {PROVIDER_SHORT[p]}
    </span>
  )
}
