import { CircleHelp } from 'lucide-react'
import { MANUAL_LABELS, SOURCE_LABELS, type SourceLabel } from '@shared/source-label'
import { SOURCE_ICON } from '@/lib/source-icons'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

/** Small icon + label for the product that ran a session. */
export function SourceBadge({
  source,
  reason,
  compact,
  className
}: {
  source: SourceLabel
  reason?: string
  compact?: boolean
  className?: string
}) {
  const Icon = SOURCE_ICON[source] ?? CircleHelp
  const label = SOURCE_LABELS[source] ?? source
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded bg-secondary px-1 text-[10px] font-medium text-foreground/70',
        className
      )}
      title={reason ? `${label} — ${reason}` : label}
    >
      <Icon className="size-2.5" />
      {compact ? label.replace(/ \(.*\)$/, '') : label}
    </span>
  )
}

/** The badge in the viewer header: click to set the label by hand. */
export function SourcePicker({
  source,
  reason,
  manual,
  onPick
}: {
  source: SourceLabel
  reason: string
  manual: boolean
  onPick: (label: SourceLabel | null) => void
}) {
  const Icon = SOURCE_ICON[source] ?? CircleHelp
  const fixed = source === 'ask-claude' || source === 'claude-ai'
  const badge = (
    <span className="inline-flex h-[22px] items-center gap-1 rounded-md border border-border bg-secondary/60 px-1.5 text-xs font-medium text-foreground/80 [&_svg]:size-3">
      <Icon /> {SOURCE_LABELS[source]}
      {manual && (
        <span className="text-[10px] font-normal text-subtle-foreground">· set by hand</span>
      )}
    </span>
  )
  if (fixed) return <span title={reason}>{badge}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title={`${reason}. Click to change.`} className="rounded-md">
          {badge}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <div className="px-2 pt-1.5 pb-1 text-2xs leading-snug text-muted-foreground">
          Which product ran this session? Saved in the app&apos;s metadata only.
        </div>
        <DropdownMenuRadioGroup
          value={manual ? source : 'auto'}
          onValueChange={(v) => onPick(v === 'auto' ? null : (v as SourceLabel))}
        >
          <DropdownMenuRadioItem value="auto">Detect automatically</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {MANUAL_LABELS.map((l) => {
            const I = SOURCE_ICON[l]
            return (
              <DropdownMenuRadioItem key={l} value={l}>
                <I /> {SOURCE_LABELS[l]}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
