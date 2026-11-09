// Codex "Open in: Terminal / Codex app": the session's resolved choice.

import { resolveOpenIn, type CodexAppPreview, type OpenIn } from '@shared/codex-app'
import { projectDefaultKey } from '@shared/project-key'
import type { SessionSummary } from '@shared/types'
import { useApp } from './store'

/** Where this session opens: its own choice, its project's, Settings, else the terminal. */
export function useOpenIn(session: SessionSummary | undefined): {
  value: OpenIn
  from: 'session' | 'project' | 'global' | 'default'
} {
  const settings = useApp((s) => s.settings)
  const key = projectDefaultKey(session)
  const project = key ? settings.codexProjectOpenIn?.[key] : undefined
  return resolveOpenIn(session?.meta.openIn, project, settings.codexOpenInDefault)
}

/** Can the app be chosen for this launch at all (now, or after the subfolder opt-in)? */
export function appChoosable(app: CodexAppPreview | undefined): boolean {
  return !!app && !app.hidden && (app.available || !!app.inside)
}
