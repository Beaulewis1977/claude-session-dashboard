import { GitCommitHorizontal } from 'lucide-react'
import { badgeText } from '@shared/git/prs'
import type { GitBadge as Badge } from '@shared/git/types'
import { cn } from '@/lib/utils'

/** "3 commits · PR #14" on session rows and phone cards (git links). */
export function GitBadge({ git, className }: { git?: Badge; className?: string }) {
  if (!git) return null
  const text = badgeText(git)
  if (!text) return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded bg-success/10 px-1 text-[10px] font-medium text-success tabular-nums',
        className
      )}
      title="Commits and pull requests linked to this session (see its Changes tab)"
    >
      <GitCommitHorizontal className="size-3" />
      {text}
    </span>
  )
}
