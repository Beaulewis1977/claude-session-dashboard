import type { ComponentProps, ReactNode } from 'react'
import { Dialog as D } from 'radix-ui'
import { cn } from '@/lib/utils'

export const Sheet = D.Root

/** A bottom sheet (phone layouts): slides up, rounded top, respects the home indicator. */
export function SheetContent({
  className,
  children,
  title,
  description,
  ...props
}: ComponentProps<typeof D.Content> & { title: ReactNode; description?: ReactNode }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <D.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-border bg-popover text-popover-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom',
          className
        )}
        {...props}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" aria-hidden />
        <div className="shrink-0 px-5 pt-3 pb-2">
          <D.Title className="text-[16px] font-semibold tracking-[-0.01em]">{title}</D.Title>
          {description ? (
            <D.Description className="mt-0.5 text-[13px] text-muted-foreground">
              {description}
            </D.Description>
          ) : (
            <D.Description className="sr-only">{title}</D.Description>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </D.Content>
    </D.Portal>
  )
}
