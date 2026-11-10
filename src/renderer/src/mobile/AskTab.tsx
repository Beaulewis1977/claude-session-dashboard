// Ask on the phone: past answers (with their citations), local questions
// answered at once on the PC (nothing sent anywhere), and content questions
// sent to the PC for approval: nothing goes to Claude until I review the
// snippets there and click Send.

import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { toast } from 'sonner'
import {
  ArrowUp,
  ChevronLeft,
  LoaderCircle,
  MonitorSmartphone,
  Sparkles,
  HardDrive
} from 'lucide-react'
import type { AskPhoneRequest, AskSessionsItem } from '@shared/ask-sessions/types'
import { SUGGESTED_ASK } from '@shared/ask-sessions/local'
import { ago } from '@shared/format'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AskItemView, type OpenTarget } from '@/components/ask/AskAnswer'
import { useMobile } from './state'

interface PhoneAsk {
  items: AskSessionsItem[]
  enabled: boolean | null
  /** What's shown: a past answer, this phone's local answer, or its question waiting on the PC. */
  shown: AskSessionsItem | null
  waiting: AskPhoneRequest | null
  /** A question that would go to Claude (offered: send to the PC for approval). */
  offer: string | null
}

const usePhoneAsk = create<PhoneAsk>(() => ({
  items: [],
  enabled: null,
  shown: null,
  waiting: null,
  offer: null
}))

async function reload(): Promise<void> {
  const [items, status] = await Promise.all([
    api.askSessionsHistory().catch(() => usePhoneAsk.getState().items),
    api.askSessionsStatus().catch(() => null)
  ])
  usePhoneAsk.setState({ items, ...(status ? { enabled: status.enabled } : {}) })
  const w = usePhoneAsk.getState().waiting
  if (w?.status === 'pending') {
    const now = await api.askSessionsRequestStatus(w.id).catch(() => null)
    if (now) {
      const item = now.itemId ? items.find((i) => i.id === now.itemId) : undefined
      usePhoneAsk.setState({ waiting: now, ...(item ? { shown: item } : {}) })
    }
  }
}

/** A citation on the phone: the session screen opens over the tab, at that message. */
function openOnPhone(c: OpenTarget): void {
  const st = useApp.getState()
  if (!st.sessions.some((s) => s.key === c.key)) {
    toast.error("That session isn't on your PC any more.")
    return
  }
  st.set({
    focusMessage: {
      key: c.key,
      ids: c.messageId ? [c.messageId, ...(c.msgIds ?? []).filter((i) => i !== c.messageId)] : [],
      ...(c.sha ? { sha: c.sha } : {}),
      nonce: Date.now()
    }
  })
  st.select(c.key)
}

export function AskTab() {
  const { items, enabled, shown, waiting, offer } = usePhoneAsk()
  const readOnly = useMobile((s) => s.me?.readOnly) ?? false
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void reload()
    const off = api.onAskSessionsChanged(() => void reload())
    // A question waiting on the PC: check now and then too (push events can be missed).
    const t = window.setInterval(() => {
      if (usePhoneAsk.getState().waiting?.status === 'pending') void reload()
    }, 5000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [])

  const ask = async (q: string): Promise<void> => {
    const text = q.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const r = await api.askSessionsLocal(text)
      if (r.mode === 'local') {
        usePhoneAsk.setState({
          offer: null,
          shown: {
            id: `phone-${Date.now()}`,
            at: Date.now(),
            question: text,
            mode: 'local',
            ok: true,
            local: r.answer,
            ...(r.chips.length ? { scopeText: r.chips.join(' · ') } : {})
          }
        })
      } else usePhoneAsk.setState({ offer: text, shown: null, enabled: r.enabled })
    } catch (err) {
      toast.error("Couldn't ask", { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const sendToPc = async (q: string): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.askSessionsRequest(q)
      usePhoneAsk.setState({ waiting: r, offer: null })
    } catch (err) {
      toast.error("Couldn't send it to your PC", { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-border bg-chrome/95 px-4 pt-[calc(env(safe-area-inset-top)+10px)] pb-3 backdrop-blur">
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Ask</h1>
        <p className="text-[13px] text-muted-foreground">Questions about your whole history</p>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 pt-3 pb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void ask(question)
          }}
          className="flex items-end gap-2 rounded-xl border border-border-strong bg-card p-2"
        >
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="How many sessions used Opus last week?"
            aria-label="Your question"
            className="min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-[15px] outline-none placeholder:text-subtle-foreground"
          />
          <Button
            type="submit"
            variant="primary"
            size="icon"
            disabled={!question.trim() || busy}
            aria-label="Ask"
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
          </Button>
        </form>

        {offer && (
          <div className="rounded-xl border border-border bg-card px-3.5 py-3 text-[13px]">
            <div className="font-medium">
              This is a question about what&apos;s in your sessions.
            </div>
            {enabled === false ? (
              <p className="mt-1 text-muted-foreground">
                Ask on your PC: content questions are off there (Settings → Ask). Questions about
                counts, dates, models, usage, limits, commits and plans work here.
              </p>
            ) : readOnly ? (
              <p className="mt-1 text-muted-foreground">
                Read-only mode is on, so it can&apos;t be sent to your PC. Ask on your PC, or turn
                read-only off there.
              </p>
            ) : (
              <>
                <p className="mt-1 text-muted-foreground">
                  Answering it sends snippets of your conversations to Claude. Your PC shows exactly
                  which ones first, and nothing is sent until you click Send there.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  className="mt-2 h-9"
                  disabled={busy}
                  onClick={() => void sendToPc(offer)}
                >
                  <MonitorSmartphone /> Send to my PC for approval
                </Button>
              </>
            )}
          </div>
        )}

        {waiting && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-xl border px-3.5 py-3 text-[13px]',
              waiting.status === 'pending'
                ? 'border-primary/30 bg-accent-soft'
                : 'border-border bg-card'
            )}
          >
            {waiting.status === 'pending' ? (
              <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
            ) : (
              <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-medium">“{waiting.question}”</div>
              <div className="mt-0.5 text-muted-foreground">
                {waiting.status === 'pending'
                  ? 'Waiting for you on your PC: review the snippets there and click Send.'
                  : waiting.status === 'sent'
                    ? 'Answered on your PC.'
                    : waiting.status === 'declined'
                      ? 'Declined on your PC. Nothing was sent.'
                      : 'Not answered on your PC in time. Nothing was sent.'}
              </div>
            </div>
            {waiting.status !== 'pending' && (
              <button
                type="button"
                className="text-xs text-muted-foreground"
                onClick={() => usePhoneAsk.setState({ waiting: null })}
              >
                Dismiss
              </button>
            )}
          </div>
        )}

        {shown ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => usePhoneAsk.setState({ shown: null })}
              className="inline-flex items-center gap-1 text-[13px] text-muted-foreground"
            >
              <ChevronLeft className="size-4" /> All answers
            </button>
            <AskItemView item={shown} onOpen={openOnPhone} />
          </div>
        ) : (
          <>
            {!items.length && !offer && !waiting && (
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_ASK.slice(0, 4).map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => {
                      setQuestion(q)
                      void ask(q)
                    }}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-[13px]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            {items.length > 0 && (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {items.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => usePhoneAsk.setState({ shown: i })}
                      className="flex w-full items-start gap-2.5 px-3.5 py-3 text-left active:bg-hover"
                    >
                      {i.mode === 'local' ? (
                        <HardDrive className="mt-0.5 size-4 shrink-0 text-subtle-foreground" />
                      ) : (
                        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[14px]">{i.question}</span>
                        <span className="text-[12px] text-subtle-foreground">
                          {ago(i.at)}
                          {!i.ok ? ' · failed' : i.notFound ? ' · not found' : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
