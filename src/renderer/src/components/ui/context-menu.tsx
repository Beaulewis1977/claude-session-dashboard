import type { ComponentProps } from 'react'
import { ContextMenu as M } from 'radix-ui'
import { cn } from '@/lib/utils'
import { Shortcut } from './kbd'

export const ContextMenu = M.Root
export const ContextMenuTrigger = M.Trigger

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        collisionPadding={8}
        className={cn(
          'z-50 min-w-[220px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className
        )}
        {...props}
      />
    </M.Portal>
  )
}

export function ContextMenuItem({
  className,
  shortcut,
  children,
  ...props
}: ComponentProps<typeof M.Item> & { shortcut?: string }) {
  return (
    <M.Item
      className={cn(
        'relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        className
      )}
      {...props}
    >
      {children}
      {shortcut && <Shortcut keys={shortcut} className="ml-auto pl-4" />}
    </M.Item>
  )
}

export function ContextMenuSeparator() {
  return <M.Separator className="-mx-1 my-1 h-px bg-border" />
}
