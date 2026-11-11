// The model, effort and fast mode a session launches with, for badges and buttons.

import { useMemo } from 'react'
import {
  CODEX_EFFORT_LEVELS,
  codexModelSettings,
  fastSupport,
  launchModel,
  resolveModelChoice,
  withFastSupport,
  type FastSupport,
  type ResolvedModel
} from '@shared/model-choice'
import { providerOf } from '@shared/provider'
import type { AppSettings, SessionSummary } from '@shared/types'
import { useApp } from './store'

type Subject = Pick<SessionSummary, 'meta' | 'cwd' | 'env' | 'distro'> & {
  provider?: SessionSummary['provider']
  models?: readonly string[]
  lastModel?: string
}

/**
 * Session → project → Settings, with the session's provider's own defaults
 * and levels. Fast mode is dropped on a model known not to have it (the
 * launch passes no flag then either).
 */
export function modelChoiceOf(
  s: Subject | undefined,
  settings: AppSettings,
  codexFastModels: readonly string[] | null = null
): ResolvedModel {
  const codex = providerOf(s) === 'codex'
  const r = codex
    ? resolveModelChoice(s?.meta, s, codexModelSettings(settings), CODEX_EFFORT_LEVELS)
    : resolveModelChoice(s?.meta, s, settings)
  return withFastSupport(r, fastSupportOf(s, r, codexFastModels))
}

/** Whether the model this launch runs on has fast mode (see launchModel). */
export function fastSupportOf(
  s: Subject | undefined,
  r: Pick<ResolvedModel, 'model'>,
  codexFastModels: readonly string[] | null,
  newSession = false
): FastSupport {
  const codex = providerOf(s) === 'codex'
  return fastSupport(codex ? 'codex' : 'claude', launchModel(r, s, newSession), codexFastModels)
}

/** The model, effort and fast mode a session launches with (session → project → Settings). */
export function useModelChoice(s: Subject | undefined): ResolvedModel {
  const settings = useApp((st) => st.settings)
  const fast = useApp((st) => st.codexFastModels)
  return useMemo(
    () => modelChoiceOf(s, settings, fast),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s?.meta, s?.cwd, s?.env, s?.distro, s?.provider, s?.models, s?.lastModel, settings, fast]
  )
}
