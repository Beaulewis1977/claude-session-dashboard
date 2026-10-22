import type { ReactNode } from 'react'
import { Tooltip as T } from 'radix-ui'
import { cn } from '@/lib/utils'
import { Shortcut } from './kbd'

export const TooltipProvider = T.Provider

export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
  className,
  disabled
}: {
  content: ReactNode
  shortcut?: string
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
  disabled?: boolean
}) {
  if (disabled) return <>{children}</>
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 flex max-w-xs items-center gap-2 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
            className
          )}
        >
          <span>{content}</span>
          {shortcut && <Shortcut keys={shortcut} />}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
