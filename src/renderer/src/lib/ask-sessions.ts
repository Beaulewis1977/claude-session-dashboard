// Ask across sessions in the window: its history, the index status, phones'
// questions waiting here, and opening a citation at its exact message.

import { create } from 'zustand'
import { toast } from 'sonner'
import { inProviderView } from '@shared/provider'
import {
  sanitizeAskSessions,
  type AskCitation,
  type AskEffort,
  type AskIndexStatus,
  type AskModel,
  type AskPhoneRequest,
  type AskSessionsItem
} from '@shared/ask-sessions/types'
import { api } from './api'
import { EMPTY_FILTERS, SUBAGENT_SOURCE } from './filters'
import { saveView, scopeOf } from './scope'
import { useApp } from './store'

interface AskState {
  items: AskSessionsItem[]
  status: AskIndexStatus | null
  pending: AskPhoneRequest[]
  loaded: boolean
  /**
   * The question being answered by Claude right now (one at a time). Kept
   * here, not in the Ask screen, so leaving the screen (Settings, a cited
   * session) and coming back still shows it with its Cancel.
   */
  running: { id: string; question: string } | null
}

export const useAsk = create<AskState>(() => ({
  items: [],
  status: null,
  pending: [],
  loaded: false,
  running: null
}))

/**
 * Send a previewed question (what the preview showed is what is sent). The
 * answer is added to the history and the model and effort are remembered,
 * whether or not the Ask screen is still open; it's shown if it is.
 */
export async function sendAsk(
  preview: { id: string; question: string },
  opts: { keep: string[]; model: AskModel; effort: AskEffort }
): Promise<AskSessionsItem> {
  if (useAsk.getState().running) throw new Error('A question is already being answered.')
  useAsk.setState({ running: { id: preview.id, question: preview.question } })
  try {
    const item = await api.askSessionsSend(preview.id, opts)
    useAsk.setState((s) => ({ items: [item, ...s.items.filter((x) => x.id !== item.id)] }))
    const app = useApp.getState()
    app.set({
      ...(app.view === 'ask' ? { askItem: item.id } : {}),
      settings: {
        ...app.settings,
        askSessions: {
          ...sanitizeAskSessions(app.settings.askSessions),
          lastModel: opts.model,
          lastEffort: opts.effort
        }
      }
    })
    return item
  } finally {
    useAsk.setState({ running: null })
  }
}

/** Stop the question being answered (nothing more is sent; see the service). */
export function cancelAsk(): void {
  const r = useAsk.getState().running
  if (r) void api.askSessionsCancel(r.id)
}

export async function loadAsk(): Promise<void> {
  const [items, status, pending] = await Promise.all([
    api.askSessionsHistory().catch(() => [] as AskSessionsItem[]),
    api.askSessionsStatus().catch(() => null),
    api.askSessionsPending().catch(() => [] as AskPhoneRequest[])
  ])
  useAsk.setState({ items, status, pending, loaded: true })
}

/** Keep the Ask state up to date while the window is open (mounted once). */
export function subscribeAsk(): () => void {
  void loadAsk()
  const offs = [
    api.onAskSessionsChanged(() => void loadAsk()),
    api.onAskSessionsStatus((status) => useAsk.setState({ status })),
    // A phone's question: the Ask screen shows it to review.
    api.onAskSessionsPhoneRequest(() => {
      void loadAsk()
      useApp.getState().set({ view: 'ask' })
    })
  ]
  return () => offs.forEach((off) => off())
}

/** A question's title in the history (for Back / Forward). */
export function askTitle(id: string | null | undefined): string | undefined {
  return id ? useAsk.getState().items.find((i) => i.id === id)?.question : undefined
}

/**
 * Open a cited session at the cited message (or its Changes tab at the cited
 * commit). The session list is set so it shows that session: filters cleared,
 * hidden or subagent sessions shown, the provider switch on All if needed.
 */
export function openCitation(c: Pick<AskCitation, 'key' | 'messageId' | 'msgIds' | 'sha'>): void {
  const st = useApp.getState()
  const s = st.sessions.find((x) => x.key === c.key)
  if (!s) {
    toast.error("That session isn't on this PC any more.")
    return
  }
  const scope = scopeOf(st.settings)
  if (!inProviderView(scope.view, s)) saveView('all')
  const filters = {
    ...EMPTY_FILTERS,
    visibility: s.meta.hidden ? ('hidden' as const) : ('visible' as const),
    ...(s.subagent && !scope.subagents ? { source: SUBAGENT_SOURCE } : {})
  }
  const patch: Parameters<typeof st.set>[0] = {
    view: 'sessions',
    filters,
    viewerTab: { key: s.key, tab: c.sha ? 'changes' : 'conversation' },
    focusMessage: {
      key: s.key,
      ids: c.messageId
        ? [c.messageId, ...(c.msgIds ?? []).filter((i) => i !== c.messageId)]
        : (c.msgIds ?? []),
      ...(c.sha ? { sha: c.sha } : {}),
      nonce: Date.now()
    }
  }
  if (st.query.trim())
    Object.assign(patch, { query: '', hits: null, hitsQuery: null, sort: st.sortBeforeSearch })
  st.set(patch)
  st.select(s.key)
  // select() resets the tab only for a different session: keep the cited one.
  st.set({ viewerTab: { key: s.key, tab: c.sha ? 'changes' : 'conversation' } })
}
