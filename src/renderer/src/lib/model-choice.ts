// The model and effort a session launches with, for badges and buttons.

import { useMemo } from 'react'
import { resolveModelChoice, type ResolvedModel } from '@shared/model-choice'
import type { SessionSummary } from '@shared/types'
import { useApp } from './store'

/** The model and effort a session launches with (session → project → Settings). */
export function useModelChoice(s: Pick<SessionSummary, 'meta' | 'cwd'> | undefined): ResolvedModel {
  const settings = useApp((st) => st.settings)
  return useMemo(() => resolveModelChoice(s?.meta, s?.cwd, settings), [s?.meta, s?.cwd, settings])
}
