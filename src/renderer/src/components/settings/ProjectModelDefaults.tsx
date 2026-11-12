// The per-project model / effort / fast-mode defaults (Claude Code's or
// Codex's), set from a session's launch options and removable here.

import { Trash2 } from 'lucide-react'
import { choiceLabel, DEFAULT_CHOICE, isEffortLevel, projectKeyLabel } from '@shared/model-choice'
import type { AppSettings } from '@shared/types'
import { useApp } from '@/lib/store'
import { Button } from '../ui/button'

type Update = (patch: Partial<AppSettings>) => Promise<void>

export function ProjectModelDefaults({
  field,
  update
}: {
  field: 'projectModels' | 'codexProjectModels'
  update: Update
}) {
  const map = useApp((s) => s.settings[field]) ?? {}
  const entries = Object.entries(map)
  return (
    <div className="rounded-lg border border-border px-3 py-2 text-xs">
      <div className="mb-1 text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
        Project defaults
      </div>
      {entries.length === 0 && (
        <div className="py-0.5 text-muted-foreground">
          None yet. Set one from a session&apos;s launch options (“Project default”).
        </div>
      )}
      {entries.map(([project, d]) => (
        <div key={project} className="flex items-center gap-2 py-0.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {projectKeyLabel(project)}
          </span>
          <span>
            {choiceLabel({
              model: d.model !== DEFAULT_CHOICE ? d.model : undefined,
              effort: isEffortLevel(d.effort) ? d.effort : undefined,
              fast: d.fast === 'on'
            }) || 'The agent’s own default'}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove the project default for ${projectKeyLabel(project)}`}
            onClick={() => {
              const next = { ...map }
              delete next[project]
              void update({ [field]: next } as Partial<AppSettings>)
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  )
}
