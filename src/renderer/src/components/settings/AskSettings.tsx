// Settings → Ask: content questions on or off (after the one-time notice),
// the model and effort answers are written with, what one question may send,
// and the index (its size, a size limit, Rebuild, Delete).

import { useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, Trash2 } from 'lucide-react'
import {
  ASK_LIMITS,
  sanitizeAskSessions,
  type AskSessionsSettings
} from '@shared/ask-sessions/types'
import { ago, formatBytes, formatDuration, formatInt } from '@shared/format'
import { api } from '@/lib/api'
import { useAsk } from '@/lib/ask-sessions'
import { useApp } from '@/lib/store'
import { AskNotice } from '../ask/AskView'
import { ModelEffortPicker } from '../ask/AskPreviewCard'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Row, Section } from '../SettingsView'
import { NumberField } from './SummariesSettings'

export function AskSettings() {
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const status = useAsk((s) => s.status)
  const ask = sanitizeAskSessions(settings.askSessions)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const update = async (patch: Partial<AskSessionsSettings>): Promise<void> => {
    set({ settings: { ...settings, askSessions: { ...ask, ...patch } } })
    set({ settings: await api.updateSettings({ askSessions: { ...ask, ...patch } }) })
  }
  return (
    <Section
      title="Ask"
      id="ask"
      description="Questions about your whole history. Local questions (counts, dates, models, usage, limits, commits, PRs, files, plans) are always answered on this PC. Content questions send snippets you review to Claude through your own claude -p."
    >
      {!ask.noticeAccepted ? (
        <AskNotice />
      ) : (
        <Row
          label="Content questions"
          hint="Builds a local search index of your sessions (in the app's cache folder, never backed up) and lets you send snippets to Claude after a preview."
        >
          <Switch
            checked={ask.enabled}
            onCheckedChange={(v) => void update({ enabled: v === true })}
            aria-label="Content questions"
          />
        </Row>
      )}
      <Row
        label="Model and effort"
        hint="What answers are written with unless you pick something else on the Ask screen (the Ask screen remembers your last choice)."
      >
        <ModelEffortPicker
          model={ask.model}
          effort={ask.effort}
          onChange={(model, effort) => void update({ model, effort })}
        />
      </Row>
      <Row label="Snippets per question" hint="At most this many snippets go with one question.">
        <NumberField
          value={ask.maxSnippets}
          min={ASK_LIMITS.maxSnippets[0]}
          max={ASK_LIMITS.maxSnippets[1]}
          label="Snippets per question"
          onCommit={(v) => void update({ maxSnippets: v })}
        />
      </Row>
      <Row
        label="Characters per question"
        hint="At most this much snippet text goes with one question."
      >
        <NumberField
          value={ask.maxChars}
          min={ASK_LIMITS.maxChars[0]}
          max={ASK_LIMITS.maxChars[1]}
          suffix="chars"
          label="Characters per question"
          onCommit={(v) => void update({ maxChars: v })}
        />
      </Row>
      <Row
        label="Snippets from one session"
        hint="So one long session can't fill a whole question."
      >
        <NumberField
          value={ask.perSession}
          min={ASK_LIMITS.perSession[0]}
          max={ASK_LIMITS.perSession[1]}
          label="Snippets from one session"
          onCommit={(v) => void update({ perSession: v })}
        />
      </Row>
      <Row
        label="Index size limit"
        hint={
          <>
            Past this much text, the oldest sessions are left out.{' '}
            {status && status.phase !== 'off'
              ? `Now: ${formatInt(status.sessions)} sessions, ${formatInt(status.passages)} passages, ${formatBytes(status.chars)} of text, ${formatBytes(status.bytes)} on disk${status.buildMs !== undefined ? `, built in ${formatDuration(status.buildMs).replace('<1m', `${Math.max(1, Math.round(status.buildMs / 1000))}s`)}` : ''}${status.updatedAt ? `, updated ${ago(status.updatedAt)}` : ''}${status.skipped ? `; ${formatInt(status.skipped)} older sessions left out` : ''}.`
              : ''}
            {status?.phase === 'error' && (
              <span className="block text-destructive">{status.error}</span>
            )}
          </>
        }
      >
        <NumberField
          value={ask.indexBudgetMB}
          min={ASK_LIMITS.indexBudgetMB[0]}
          max={ASK_LIMITS.indexBudgetMB[1]}
          suffix="MB"
          label="Index size limit"
          onCommit={(v) => void update({ indexBudgetMB: v })}
        />
      </Row>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!ask.enabled}
          onClick={() =>
            void api.askSessionsRebuild().then(() => toast.success('Rebuilding the index'))
          }
        >
          <RefreshCw /> Rebuild the index
        </Button>
        {!confirmDelete ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete the index
          </Button>
        ) : (
          <span className="inline-flex items-center gap-2 text-xs">
            Delete the saved index? It only holds copies of your sessions&apos; text; it&apos;s
            built again while content questions are on.
            <Button
              variant="destructive"
              size="xs"
              onClick={() =>
                void api.askSessionsDeleteIndex().then(() => {
                  setConfirmDelete(false)
                  toast.success('Index deleted')
                })
              }
            >
              Delete
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </span>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Answers are written by Claude only. Codex isn&apos;t offered as the answerer:{' '}
        <span className="font-mono">codex exec</span> can&apos;t be run without tools, so it could
        read more than the snippets you approve.
      </p>
    </Section>
  )
}
