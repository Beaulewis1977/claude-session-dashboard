import type { ComponentProps, ReactNode } from 'react'
import { DropdownMenu as M } from 'radix-ui'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Shortcut } from './kbd'

export const DropdownMenu = M.Root
export const DropdownMenuTrigger = M.Trigger
export const DropdownMenuRadioGroup = M.RadioGroup

export function DropdownMenuContent({
  className,
  align = 'end',
  ...props
}: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className
        )}
        {...props}
      />
    </M.Portal>
  )
}

const itemClass =
  'relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

export function DropdownMenuItem({
  className,
  shortcut,
  children,
  destructive,
  ...props
}: ComponentProps<typeof M.Item> & { shortcut?: string; destructive?: boolean }) {
  return (
    <M.Item
      className={cn(
        itemClass,
        destructive && 'text-destructive [&_svg]:text-destructive',
        className
      )}
      {...props}
    >
      {children}
      {shortcut && <Shortcut keys={shortcut} className="ml-auto pl-4" />}
    </M.Item>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(itemClass, 'pr-8', className)} {...props}>
      {children}
      <M.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="text-foreground!" />
      </M.ItemIndicator>
    </M.RadioItem>
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem className={cn(itemClass, 'pr-8', className)} {...props}>
      {children}
      <M.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="text-foreground!" />
      </M.ItemIndicator>
    </M.CheckboxItem>
  )
}

export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return (
    <M.Label className="px-2 pt-1.5 pb-1 text-2xs font-medium text-subtle-foreground uppercase tracking-wide">
      {children}
    </M.Label>
  )
}

export function DropdownMenuSeparator() {
  return <M.Separator className="-mx-1 my-1 h-px bg-border" />
}
