// The model and effort a session launches with, for badges and buttons.

import { useMemo } from 'react'
import {
  CODEX_EFFORT_LEVELS,
  codexModelSettings,
  resolveModelChoice,
  type ResolvedModel
} from '@shared/model-choice'
import { providerOf } from '@shared/provider'
import type { AppSettings, SessionSummary } from '@shared/types'
import { useApp } from './store'

type Subject = Pick<SessionSummary, 'meta' | 'cwd' | 'env' | 'distro'> & {
  provider?: SessionSummary['provider']
}

/** Session → project → Settings, with the session's provider's own defaults and levels. */
export function modelChoiceOf(s: Subject | undefined, settings: AppSettings): ResolvedModel {
  if (providerOf(s) === 'codex')
    return resolveModelChoice(s?.meta, s, codexModelSettings(settings), CODEX_EFFORT_LEVELS)
  return resolveModelChoice(s?.meta, s, settings)
}

/** The model and effort a session launches with (session → project → Settings). */
export function useModelChoice(s: Subject | undefined): ResolvedModel {
  const settings = useApp((st) => st.settings)
  return useMemo(
    () => modelChoiceOf(s, settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s?.meta, s?.cwd, s?.env, s?.distro, s?.provider, settings]
  )
}
