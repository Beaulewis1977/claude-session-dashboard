// The Ask screen (Ctrl+Shift+K): questions about my whole history. Local
// questions are answered on this PC; content questions show what would be
// sent first, and go to Claude only after Send. History on the right.

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowUp,
  Check,
  HardDrive,
  LoaderCircle,
  MessagesSquare,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { findDateRange } from '@shared/ask-sessions/dates'
import { scopeChips, SUGGESTED_ASK } from '@shared/ask-sessions/local'
import {
  ASK_NOTICE_VERSION,
  sanitizeAskSessions,
  type AskEffort,
  type AskModel,
  type AskPreview,
  type AskScope,
  type AskSessionsItem
} from '@shared/ask-sessions/types'
import { ago, formatBytes, formatDateTime, formatDuration, formatInt } from '@shared/format'
import { PROVIDER_LABEL, type ProviderId } from '@shared/provider'
import { localTimeZone } from '@shared/usage/time'
import { api } from '@/lib/api'
import { openCitation, useAsk } from '@/lib/ask-sessions'
import { useEnabledProviders } from '@/lib/scope'
import { useApp } from '@/lib/store'
import { cn, MOD } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { AskItemView } from './AskAnswer'
import { AskPreviewCard } from './AskPreviewCard'

const DATE_PRESETS = ['any', 'the last 7 days', 'the last 30 days', 'this month', 'last month', 'this year'] as const

/** The one-time notice about what content questions send, and the switch. */
export function AskNotice({ onEnabled }: { onEnabled?: () => void }) {
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const [busy, setBusy] = useState(false)
  const turnOn = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await api.updateSettings({
        askSessions: {
          ...sanitizeAskSessions(settings.askSessions),
          enabled: true,
          noticeAccepted: true,
          noticeVersion: ASK_NOTICE_VERSION
        }
      })
      set({ settings: next })
      onEnabled?.()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-card">
      <div className="flex items-center gap-2 text-[13.5px] font-medium">
        <ShieldCheck className="size-4 text-primary" /> Questions about what&apos;s in your sessions
      </div>
      <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
        <p>
          Questions about counts, dates, models, usage, limits, commits, PRs, files and plans are
          answered on this PC. Nothing is sent.
        </p>
        <p>
          For questions about what was said or decided, the app first builds a local search index of
          your sessions (Claude Code, Codex, and Claude desktop when that source is on): your prompts,
          the agents&apos; answers, messages between agents, tool names and file paths, summaries,
          names, descriptions, tags and commit messages. Never tool output or thinking. The index
          stays in the app&apos;s cache folder.
        </p>
        <p>
          Then, for each question, snippets of your conversations go to Claude through your own{' '}
          <span className="font-mono">claude -p</span>, on your Claude subscription. You always see
          “N snippets from M sessions will be sent” and can look at every snippet, leave any out, or
          not send at all. Common secret shapes are masked first.
        </p>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void turnOn()}>
          <Check /> Turn on content questions
        </Button>
        <span className="text-[11px] text-subtle-foreground">You can turn this off in Settings → Ask.</span>
      </div>
    </div>
  )
}

function IndexLine() {
  const st = useAsk((s) => s.status)
  if (!st) return null
  let text: string
  if (!st.enabled) text = 'Local questions only · content questions are off'
  else if (st.phase === 'error') text = st.error ?? 'The index stopped.'
  else if (st.phase === 'loading') text = 'Loading the index…'
  else if (st.phase === 'building')
    text = `Indexing: ${formatInt(st.done)} of ${formatInt(st.total)} sessions read · ${formatInt(st.passages)} passages so far`
  else
    text = `${formatInt(st.sessions)} sessions · ${formatInt(st.passages)} passages indexed (${formatBytes(st.bytes)})${st.updatedAt ? ` · updated ${ago(st.updatedAt)}` : ''}${st.buildMs !== undefined ? ` · built in ${formatDuration(st.buildMs).replace('<1m', `${Math.max(1, Math.round(st.buildMs / 1000))}s`)}` : ''}`
  return (
    <div className={cn('text-xs text-muted-foreground', st.phase === 'error' && 'text-destructive')}>
      {st.phase === 'building' && <LoaderCircle className="mr-1 inline size-3 animate-spin" />}
      {text}
      {st.skipped > 0 && st.since && ` · older than ${formatDateTime(new Date(st.since).toISOString())} left out (size limit)`}
    </div>
  )
}

function ScopeBar({ scope, onChange, disabled }: { scope: AskScope | null; onChange: (s: AskScope | null) => void; disabled?: boolean }) {
  const sessions = useApp((s) => s.sessions)
  const weekStart = useApp((s) => s.settings.weekStart)
  const providers = useEnabledProviders()
  const s = scope ?? {}
  const projects = useMemo(() => {
    const n = new Map<string, number>()
    for (const x of sessions) if (x.source !== 'ask-claude') n.set(x.projectName, (n.get(x.projectName) ?? 0) + 1)
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([p]) => p)
  }, [sessions])
  const hasDesktop = sessions.some((x) => x.source === 'desktop')
  const hasCowork = sessions.some((x) => x.source === 'cowork')
  const hasSubagents = sessions.some((x) => !!x.subagent)
  const patch = (p: Partial<AskScope>): void => {
    const next: AskScope = { ...s, ...p }
    for (const k of Object.keys(next) as (keyof AskScope)[]) {
      const v = next[k]
      if (v === undefined || (Array.isArray(v) && !v.length) || v === false) delete next[k]
    }
    onChange(next)
  }
  const flip = <T,>(list: T[] | undefined, v: T): T[] =>
    list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]
  const preset = (p: (typeof DATE_PRESETS)[number]): void => {
    if (p === 'any') return patch({ from: undefined, to: undefined, dateLabel: undefined })
    const r = findDateRange(p, Date.now(), localTimeZone(), weekStart)
    if (r) patch({ from: r.from, to: r.to, dateLabel: r.label })
  }
  const chips = scope ? scopeChips(scope) : []
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Content scope:</span>
      {!scope ? (
        <span className="rounded-md bg-secondary px-2 py-0.5 text-muted-foreground">From the question</span>
      ) : chips.length ? (
        chips.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-primary">
            {c}
          </span>
        ))
      ) : (
        <span className="rounded-md bg-secondary px-2 py-0.5 text-muted-foreground">All my sessions</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button variant="ghost" size="xs" aria-label="Edit the scope">
            <SlidersHorizontal /> Edit
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] overflow-y-auto">
          {providers.length > 1 && (
            <>
              <DropdownMenuLabel>Agents</DropdownMenuLabel>
              {providers.map((p: ProviderId) => (
                <DropdownMenuCheckboxItem
                  key={p}
                  checked={!s.providers || s.providers.includes(p)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => {
                    const cur = s.providers ?? providers
                    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]
                    patch({ providers: next.length === providers.length ? undefined : next })
                  }}
                >
                  {PROVIDER_LABEL[p]}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}
          {(hasDesktop || hasCowork) && (
            <>
              <DropdownMenuLabel>Only from</DropdownMenuLabel>
              {hasDesktop && (
                <DropdownMenuCheckboxItem
                  checked={!!s.sources?.includes('desktop')}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => patch({ sources: flip(s.sources, 'desktop') })}
                >
                  Claude desktop
                </DropdownMenuCheckboxItem>
              )}
              {hasCowork && (
                <DropdownMenuCheckboxItem
                  checked={!!s.sources?.includes('cowork')}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => patch({ sources: flip(s.sources, 'cowork') })}
                >
                  Claude desktop (Cowork)
                </DropdownMenuCheckboxItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Environment</DropdownMenuLabel>
          {(['windows', 'wsl'] as const).map((e) => (
            <DropdownMenuCheckboxItem
              key={e}
              checked={!s.envs || s.envs.includes(e)}
              onSelect={(ev) => ev.preventDefault()}
              onCheckedChange={() => {
                const cur = s.envs ?? ['windows', 'wsl']
                const next = cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]
                patch({ envs: next.length === 2 ? undefined : next })
              }}
            >
              {e === 'wsl' ? 'WSL' : 'Windows'}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Dates</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={DATE_PRESETS.find((p) => s.dateLabel?.startsWith(p)) ?? (s.from !== undefined ? '' : 'any')}
            onValueChange={(v) => preset(v as (typeof DATE_PRESETS)[number])}
          >
            {DATE_PRESETS.map((p) => (
              <DropdownMenuRadioItem key={p} value={p}>
                {p === 'any' ? 'Any time' : p[0].toUpperCase() + p.slice(1)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          {projects.map((p) => (
            <DropdownMenuCheckboxItem
              key={p}
              checked={!!s.projects?.includes(p)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => patch({ projects: flip(s.projects, p) })}
            >
              {p}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          {hasSubagents && (
            <DropdownMenuCheckboxItem
              checked={!!s.subagents}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) => patch({ subagents: v === true })}
            >
              Codex subagent threads
            </DropdownMenuCheckboxItem>
          )}
          <DropdownMenuCheckboxItem
            checked={!!s.hidden}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => patch({ hidden: v === true })}
          >
            Hidden sessions
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {scope && (
        <Button variant="ghost" size="xs" onClick={() => onChange(null)} disabled={disabled}>
          <X /> Reset
        </Button>
      )}
    </div>
  )
}

function HistoryList({ onPick }: { onPick: (i: AskSessionsItem) => void }) {
  const items = useAsk((s) => s.items)
  const askItem = useApp((s) => s.askItem)
  const [filter, setFilter] = useState('')
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return items
    return items.filter(
      (i) =>
        i.question.toLowerCase().includes(f) ||
        (i.answer ?? '').toLowerCase().includes(f) ||
        (i.local?.headline ?? '').toLowerCase().includes(f)
    )
  }, [items, filter])
  const remove = async (i: AskSessionsItem): Promise<void> => {
    await api.askSessionsDelete(i.id)
    useAsk.setState((s) => ({ items: s.items.filter((x) => x.id !== i.id) }))
    if (useApp.getState().askItem === i.id) useApp.getState().set({ askItem: null })
  }
  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label="Past questions">
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search past answers"
            aria-label="Search past answers"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" data-nav-scroll="ask-history">
        {!shown.length && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
            {items.length ? 'No past answer matches.' : 'Past questions and answers show here.'}
          </li>
        )}
        {shown.map((i) => (
          <li key={i.id} className="group relative">
            <button
              type="button"
              onClick={() => onPick(i)}
              aria-current={askItem === i.id ? 'true' : undefined}
              className={cn(
                'flex w-full items-start gap-2 rounded-md px-2.5 py-2 pr-8 text-left hover:bg-hover',
                askItem === i.id && 'bg-selected'
              )}
            >
              {i.mode === 'local' ? (
                <HardDrive className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
              ) : (
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
              )}
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-[12.5px]">{i.question}</span>
                <span className="mt-0.5 flex items-center gap-1 text-[11px] text-subtle-foreground">
                  {ago(i.at)}
                  {i.phone && <Smartphone className="size-3" />}
                  {!i.ok && <span className="text-destructive">· failed</span>}
                  {i.notFound && <span>· not found</span>}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => void remove(i)}
              aria-label={`Delete “${i.question}”`}
              className="absolute top-2 right-1.5 rounded p-1 text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}

export function AskView() {
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const askItem = useApp((s) => s.askItem)
  const items = useAsk((s) => s.items)
  const pending = useAsk((s) => s.pending)
  const ask = sanitizeAskSessions(settings.askSessions)
  const [question, setQuestion] = useState('')
  const [scope, setScope] = useState<AskScope | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<AskPreview | null>(null)
  const [running, setRunning] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const shown = items.find((i) => i.id === askItem)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (
    q: string,
    opts: { content?: boolean; phoneRequest?: string; scope?: AskScope | null } = {}
  ): Promise<void> => {
    const text = q.trim()
    if (!text || busy || running) return
    setBusy(true)
    setBlocked(null)
    try {
      const sc = opts.scope !== undefined ? opts.scope : scope
      const r = await api.askSessions(text, {
        ...(sc ? { scope: sc } : {}),
        ...(opts.content ? { content: true } : {}),
        ...(opts.phoneRequest ? { phoneRequest: opts.phoneRequest } : {})
      })
      if (r.mode === 'local') {
        useAsk.setState((s) => ({ items: [r.item, ...s.items.filter((x) => x.id !== r.item.id)] }))
        setPreview(null)
        set({ askItem: r.item.id })
      } else if (r.blocked) {
        setPreview(null)
        setBlocked(r.blocked)
      } else if (r.preview) {
        setPreview(r.preview)
        // Its scope as chips: change them to search again.
        if (sc || Object.keys(r.preview.scope).length) setScope(r.preview.scope)
      }
    } catch (err) {
      toast.error("Couldn't ask", { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const send = async (keep: string[], model: AskModel, effort: AskEffort): Promise<void> => {
    if (!preview) return
    setRunning(true)
    try {
      const item = await api.askSessionsSend(preview.id, { keep, model, effort })
      useAsk.setState((s) => ({ items: [item, ...s.items.filter((x) => x.id !== item.id)] }))
      set({
        askItem: item.id,
        settings: { ...settings, askSessions: { ...ask, lastModel: model, lastEffort: effort } }
      })
      setPreview(null)
      if (item.ok && !preview.phone) setQuestion('')
    } catch (err) {
      toast.error("Couldn't ask Claude", { description: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }

  const decline = async (id: string): Promise<void> => {
    await api.askSessionsDecline(id)
    useAsk.setState((s) => ({ pending: s.pending.filter((p) => p.id !== id) }))
    if (preview?.phone?.requestId === id) setPreview(null)
  }

  return (
    <div className="flex h-full min-w-0 bg-background">
      <div className="min-w-0 flex-1 overflow-y-auto" data-nav-scroll="main">
        <div className="mx-auto max-w-[780px] space-y-4 px-8 pt-8 pb-16">
          <div>
            <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-[-0.015em]">
              <MessagesSquare className="size-5 text-primary" /> Ask
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Ask about your whole history. Facts the app already has are answered here; questions
              about what was said go to Claude with the snippets you approve, and every answer cites
              its sources.
            </p>
            <div className="mt-1.5">
              <IndexLine />
            </div>
          </div>

          {pending.map((p) => (
            <div
              key={p.id}
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-accent-soft px-4 py-2.5 text-[13px]"
            >
              <Smartphone className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">“{p.device}” asked:</span> {p.question}
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={busy || running}
                onClick={() => {
                  setQuestion(p.question)
                  setScope(Object.keys(p.scope).length ? p.scope : null)
                  void submit(p.question, { phoneRequest: p.id, scope: p.scope })
                }}
              >
                Review what would be sent
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void decline(p.id)}>
                Decline
              </Button>
            </div>
          ))}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submit(question)
            }}
            className="rounded-xl border border-border-strong bg-card shadow-card focus-within:border-primary/60"
          >
            <textarea
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit(question)
                }
              }}
              maxLength={1000}
              rows={2}
              placeholder="How many sessions used Opus last week? Where did I fix the WSL path bug?"
              aria-label="Your question"
              className="block w-full resize-none bg-transparent px-4 pt-3 text-[14px] outline-none placeholder:text-subtle-foreground"
            />
            <div className="flex items-center gap-2 px-3 pt-1 pb-2.5">
              <ScopeBar scope={scope} onChange={setScope} disabled={busy || running} />
              <span className="ml-auto text-[11px] text-subtle-foreground">Enter to ask</span>
              <Button type="submit" variant="primary" size="sm" disabled={!question.trim() || busy || running}>
                {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />} Ask
              </Button>
            </div>
          </form>

          {!ask.enabled && <AskNotice />}

          {blocked && (
            <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-[13px] text-muted-foreground">
              {blocked}
            </div>
          )}

          {preview ? (
            <AskPreviewCard
              key={preview.id}
              preview={preview}
              running={running}
              onSend={(keep, m, e) => void send(keep, m, e)}
              onCancel={() => void api.askSessionsCancel(preview.id)}
              onClose={() => setPreview(null)}
            />
          ) : shown ? (
            <AskItemView
              key={shown.id}
              item={shown}
              onOpen={openCitation}
              onDelete={() => {
                void api.askSessionsDelete(shown.id).then(() => {
                  useAsk.setState((s) => ({ items: s.items.filter((x) => x.id !== shown.id) }))
                  set({ askItem: null })
                })
              }}
              onAskClaude={
                shown.mode === 'local'
                  ? () => {
                      setQuestion(shown.question)
                      void submit(shown.question, { content: true })
                    }
                  : undefined
              }
            />
          ) : (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Try</div>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_ASK.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => {
                      setQuestion(q)
                      void submit(q)
                    }}
                    className="rounded-full border border-border bg-card px-3 py-1 text-xs hover:bg-hover"
                  >
                    {q}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-subtle-foreground">
                {MOD}+Shift+K opens Ask from anywhere.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="w-[300px] shrink-0 border-l border-border bg-chrome">
        <HistoryList
          onPick={(i) => {
            setPreview(null)
            set({ askItem: i.id })
          }}
        />
      </div>
    </div>
  )
}
