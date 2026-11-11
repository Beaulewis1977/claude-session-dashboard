// The fast-mode notes of a launch (see shared/fast-notes.ts for what they say).

import { AlertTriangle, Zap } from 'lucide-react'
import type { FastNote } from '@shared/fast-notes'
import { cn } from '@/lib/utils'

export function FastModeNotes({ notes, className }: { notes: FastNote[]; className?: string }) {
  if (!notes.length) return null
  return (
    <div className={cn('space-y-1', className)}>
      {notes.map((n) => (
        <div
          key={n.text}
          role={n.tone === 'warn' ? 'alert' : undefined}
          className={cn(
            'flex items-start gap-1.5 text-[11.5px] leading-snug',
            n.tone === 'warn' ? 'text-warning' : 'text-muted-foreground'
          )}
        >
          {n.tone === 'warn' ? (
            <AlertTriangle className="mt-px size-3.5 shrink-0" />
          ) : (
            <Zap className="mt-px size-3.5 shrink-0" />
          )}
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  )
}
