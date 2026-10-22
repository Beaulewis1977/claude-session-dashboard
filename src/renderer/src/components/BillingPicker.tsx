import { ChevronDown, CreditCard, KeyRound } from 'lucide-react'
import { PLAN_LABEL } from '@shared/usage/limits'
import { launchAccounts } from '@/lib/billing'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

export function BillingPicker({
  value,
  onChange,
  className,
  align = 'start'
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  align?: 'start' | 'end'
}) {
  const plan = useApp((s) => s.settings.plan)
  const accounts = launchAccounts(useApp((s) => s.credits?.accounts))
  const current = accounts.find((a) => a.id === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-8 min-w-[220px] items-center gap-2 rounded-md border border-border-strong bg-background px-2.5 text-left text-[13px] shadow-xs transition-colors hover:bg-hover',
            className
          )}
        >
          {current ? (
            <KeyRound className="size-3.5 text-primary" />
          ) : (
            <CreditCard className="size-3.5 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {current ? `API key: ${current.nickname}` : `Subscription (${PLAN_LABEL[plan]})`}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-72">
        <DropdownMenuRadioGroup value={current ? value : 'subscription'} onValueChange={onChange}>
          <DropdownMenuLabel>Claude account</DropdownMenuLabel>
          <DropdownMenuRadioItem value="subscription">
            <CreditCard /> Subscription ({PLAN_LABEL[plan]})
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>API credits</DropdownMenuLabel>
          {accounts.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id}>
              <KeyRound />
              <span className="min-w-0 flex-1 truncate">{a.nickname}</span>
              <span className="font-mono text-[10.5px] text-subtle-foreground">
                {a.masked.slice(-4)}
              </span>
            </DropdownMenuRadioItem>
          ))}
          {accounts.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Add an API key in Settings → Accounts to run sessions on API credits.
            </div>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Small "Max" / "API · nickname" badge for session rows and headers. */
export function BillingBadge({
  billing,
  compact
}: {
  billing: { mode: string; accountId?: string; source?: string } | undefined
  compact?: boolean
}) {
  const plan = useApp((s) => s.settings.plan)
  const accounts = useApp((s) => s.credits?.accounts) ?? []
  if (!billing || billing.mode === 'unknown') {
    return compact ? null : (
      <Badge
        variant="muted"
        title="Not launched from this app, and the status line bridge hasn't seen it"
      >
        Billing unknown
      </Badge>
    )
  }
  const inferred = billing.source === 'bridge' ? ' (from the status line)' : ''
  if (billing.mode === 'subscription') {
    const label = plan === 'max5' || plan === 'max20' ? 'Max' : PLAN_LABEL[plan]
    return compact ? (
      <span
        className="rounded bg-secondary px-1 text-[10px] font-medium text-muted-foreground"
        title={`Billed to your ${PLAN_LABEL[plan]} subscription${inferred}`}
      >
        {label}
      </span>
    ) : (
      <Badge variant="muted" title={`Billed to your subscription${inferred}`}>
        <CreditCard /> {PLAN_LABEL[plan]}
      </Badge>
    )
  }
  const a = accounts.find((x) => x.id === billing.accountId)
  const label = a ? `API · ${a.nickname}` : 'API'
  return compact ? (
    <span
      className="inline-flex max-w-[140px] items-center gap-1 truncate rounded bg-accent-soft px-1 text-[10px] font-medium text-primary"
      title={`Billed to API credits${inferred}`}
    >
      <KeyRound className="size-2.5 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  ) : (
    <Badge variant="accent" title={`Billed to API credits${inferred}`}>
      <KeyRound /> {label}
    </Badge>
  )
}
