import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex max-w-full items-center gap-1 rounded-[5px] border px-1.5 text-2xs font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'h-5 border-border bg-background text-muted-foreground',
        muted: 'h-5 border-transparent bg-secondary text-muted-foreground',
        windows: 'h-5 border-env-windows/25 bg-env-windows/8 text-env-windows',
        wsl: 'h-5 border-env-wsl/25 bg-env-wsl/8 text-env-wsl',
        warning: 'h-5 border-warning/25 bg-warning-soft text-warning',
        accent: 'h-5 border-primary/25 bg-accent-soft text-primary',
        tag: 'h-5 border-transparent bg-secondary text-foreground/80'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
