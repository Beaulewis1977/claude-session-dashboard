import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border-strong/70 border-b-2 bg-kbd px-1 font-sans text-[10.5px] font-medium text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

/** Renders a shortcut like "Ctrl+Shift+K" as separate keys. */
export function Shortcut({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.split('+').map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  )
}
