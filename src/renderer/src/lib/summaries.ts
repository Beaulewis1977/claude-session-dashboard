// Summarize and Continue fresh, shared by buttons, menus, the palette and the bulk bar.

import { toast } from 'sonner'
import type { AiSummary } from '@shared/summary'
import { api } from './api'
import { useApp } from './store'

const get = () => useApp.getState()

/**
 * Summarize sessions. The first time (and for several sessions, every time)
 * the Summarize dialog shows what is sent and what it would use; after the
 * notice was accepted, one session is summarized right away.
 */
export function summarize(keys: string[], origin: 'manual' | 'bulk' = 'manual'): void {
  const st = get()
  const list = keys.filter((k) => st.sessions.some((s) => s.key === k))
  if (!list.length) return
  if (origin === 'manual' && list.length === 1 && st.settings.summaries.noticeAccepted) {
    void queue(list, origin)
    return
  }
  st.set({ summarize: { keys: list, origin } })
}

/** "What is sent": the Summarize dialog opened on the preview. */
export function previewSummary(key: string): void {
  get().set({ summarize: { keys: [key], origin: 'manual', preview: true } })
}

export async function queue(
  keys: string[],
  origin: 'manual' | 'bulk',
  /** Send exactly this previewed text (for the previewed session). */
  previewId?: string
): Promise<number | undefined> {
  try {
    const n = await api.summarize(keys, origin, previewId)
    if (!n)
      toast('Nothing to summarize', {
        description: 'Already being summarized, or there is no conversation yet.'
      })
    else if (keys.length > 1)
      toast(`Summarizing ${n} session${n === 1 ? '' : 's'}`, {
        description: 'One at a time, in the background. Progress is in the corner.'
      })
    return n
  } catch (err) {
    toast.error('Could not summarize', { description: (err as Error).message })
    return undefined
  }
}

export async function cancelSummary(key?: string): Promise<void> {
  await api.summaryCancel(key)
}

/** Save a summary edited by hand. */
export async function saveSummary(
  key: string,
  patch: Partial<Pick<AiSummary, 'title' | 'done' | 'files' | 'decisions' | 'todos' | 'pickUp'>>
): Promise<void> {
  try {
    const s = await api.saveSummary(key, patch)
    if (s) get().patchSession(s)
  } catch (err) {
    toast.error('Could not save the summary', { description: (err as Error).message })
  }
}

export async function removeSummary(key: string): Promise<void> {
  const before = get().sessions.find((s) => s.key === key)?.meta.aiSummary
  const s = await api.removeSummary(key)
  if (s) get().patchSession(s)
  toast('Summary removed', {
    description: before ? 'Regenerate it any time.' : undefined
  })
}

/** Continue fresh: a new session in the same folder, started from the summary. */
export function openContinueFresh(key: string): void {
  const s = get().sessions.find((x) => x.key === key)
  if (!s) return
  if (s.availability === 'imported') {
    toast('This conversation was imported from claude.ai', {
      description: 'It can be read, searched and summarized, but not continued in Claude Code.'
    })
    return
  }
  if (!s.meta.aiSummary) {
    toast('Summarize this session first', {
      description: 'Continue fresh starts the new session from its summary.',
      action: { label: 'Summarize', onClick: () => summarize([key]) }
    })
    return
  }
  get().set({ resume: { key, fork: false, continueFresh: true } })
}
