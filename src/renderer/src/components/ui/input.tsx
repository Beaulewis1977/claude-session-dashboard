import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        spellCheck={false}
        className={cn(
          'h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-subtle-foreground focus:border-ring focus:ring-3 focus:ring-ring/20 disabled:opacity-50',
          className
        )}
        {...props}
      />
    )
  }
)

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-subtle-foreground focus:border-ring focus:ring-3 focus:ring-ring/20',
        className
      )}
      {...props}
    />
  )
})
