// Settings for Codex support (feature 5, Phase B): which coding agents are
// on, Codex's launch defaults, and which Codex sessions go into the archive.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Archive } from 'lucide-react'
import {
  PROVIDER_IDS,
  PROVIDER_LABEL,
  sanitizeProviderToggles,
  type ProviderId
} from '@shared/provider'
import { formatBytes } from '@shared/format'
import { DEFAULT_CHOICE } from '@shared/model-choice'
import type { OpenIn } from '@shared/codex-app'
import type {
  AppSettings,
  ArchiveTally,
  CodexArchiveEstimate,
  CodexArchiveMode
} from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Segmented } from '../ui/segmented'
import { Row, Section } from '../SettingsView'
import { DefaultModelPickers } from '../ModelPicker'
import { PROVIDER_ICON } from '@/lib/provider-icons'

type Update = (patch: Partial<AppSettings>) => Promise<void>

const PROVIDER_HINT: Record<ProviderId, string> = {
  claude: 'Sessions in ~/.claude/projects (Windows and every WSL distro).',
  codex:
    'Sessions in ~/.codex/sessions and archived_sessions (Windows and every WSL distro), plain or compressed. Read only; ~/.codex/auth.json is never opened.'
}

/** Settings → Providers: turn Claude Code or Codex off (never both). */
export function ProvidersSettings({ update }: { update: Update }) {
  const settings = useApp((s) => s.settings)
  const on = sanitizeProviderToggles(settings.providers)
  const count = PROVIDER_IDS.filter((p) => on[p]).length
  return (
    <Section
      id="providers"
      title="Providers"
      description="Which coding agents the app reads. Turning one off stops scanning, watching and archiving its sessions and removes it from the switch and the phone. Your names, tags, summaries and archive copies are kept, so turning it back on brings everything back. The All / Claude / Codex switch in the sidebar only filters what you see."
    >
      {PROVIDER_IDS.map((p) => {
        const Icon = PROVIDER_ICON[p]
        return (
          <Row
            key={p}
            label={
              <span className="inline-flex items-center gap-1.5">
                <Icon className="size-3.5 text-muted-foreground" /> {PROVIDER_LABEL[p]}
              </span>
            }
            hint={PROVIDER_HINT[p]}
          >
            <Switch
              checked={on[p]}
              // At least one stays on.
              disabled={on[p] && count === 1}
              onCheckedChange={(v) => void update({ providers: { ...on, [p]: v } })}
              aria-label={`${PROVIDER_LABEL[p]} on`}
            />
          </Row>
        )
      })}
    </Section>
  )
}

/** Settings → Resume, for Codex: its own model and effort defaults. */
export function CodexLaunchSettings({ update }: { update: Update }) {
  const settings = useApp((s) => s.settings)
  if (!sanitizeProviderToggles(settings.providers).codex) return null
  const projectOpenIn = Object.keys(settings.codexProjectOpenIn ?? {}).length
  return (
    <>
      <Row
        label="Open Codex sessions in"
        hint={
          <>
            Where Resume, Fork and Continue fresh open a Codex session, unless the session or its
            project has its own choice (set in the launch dialog). The Codex app is offered only
            when it can open that session (Windows, with the Codex desktop app installed); otherwise
            a terminal is used.
            {projectOpenIn > 0 && (
              <>
                {' '}
                {projectOpenIn} project{projectOpenIn === 1 ? ' has' : 's have'} their own choice.{' '}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => void update({ codexProjectOpenIn: {} })}
                >
                  Clear project choices
                </button>
              </>
            )}
          </>
        }
      >
        <Segmented<OpenIn>
          ariaLabel="Open Codex sessions in"
          value={settings.codexOpenInDefault ?? 'terminal'}
          onChange={(codexOpenInDefault) => void update({ codexOpenInDefault })}
          options={[
            { value: 'terminal', label: 'Terminal' },
            { value: 'codex-app', label: 'Codex app' }
          ]}
        />
      </Row>
      <CodexModelRow update={update} />
    </>
  )
}

function CodexModelRow({ update }: { update: Update }) {
  const settings = useApp((s) => s.settings)
  return (
    <Row
      label="Codex model and effort"
      hint={
        <>
          <span className="font-mono">-m</span> and{' '}
          <span className="font-mono">-c model_reasoning_effort</span> for Codex launches, kept
          apart from Claude Code&apos;s. &ldquo;Skip permission prompts&rdquo; above adds{' '}
          <span className="font-mono">--dangerously-bypass-approvals-and-sandbox</span> for Codex
          (never for launches from the phone).
        </>
      }
    >
      <DefaultModelPickers
        agent="codex"
        model={settings.codexDefaultModel ?? DEFAULT_CHOICE}
        effort={settings.codexDefaultEffort ?? DEFAULT_CHOICE}
        onModel={(codexDefaultModel) => void update({ codexDefaultModel })}
        onEffort={(codexDefaultEffort) => void update({ codexDefaultEffort })}
      />
    </Row>
  )
}

const MODE_LABEL: Record<CodexArchiveMode, string> = {
  off: 'Off',
  marked: 'Named, pinned or tagged',
  all: 'All'
}

function tallyText(t: ArchiveTally): string {
  return `${t.sessions} session${t.sessions === 1 ? '' : 's'} · ${formatBytes(t.bytes)} now · ${formatBytes(t.newBytes)} to copy · about ${formatBytes(t.backupBytes)} more in backups`
}

/**
 * Settings → Archive: which Codex sessions are copied. Codex doesn't delete
 * old sessions itself, so this is off by default; turning it on shows what it
 * adds to the archive (and to backups) first.
 */
export function CodexArchiveSettings({ update }: { update: Update }) {
  const settings = useApp((s) => s.settings)
  const sessions = useApp((s) => s.sessions)
  const mode: CodexArchiveMode = settings.codexArchive ?? 'off'
  const [est, setEst] = useState<CodexArchiveEstimate | null>(null)
  const [estFailed, setEstFailed] = useState(false)
  const [pending, setPending] = useState<CodexArchiveMode | null>(null)
  useEffect(() => {
    void api
      .getCodexArchiveEstimate()
      .then((e) => {
        setEst(e)
        setEstFailed(false)
      })
      .catch(() => {
        setEst(null)
        setEstFailed(true)
      })
  }, [sessions, mode])
  if (!sanitizeProviderToggles(settings.providers).codex) return null
  const tally = (m: CodexArchiveMode): ArchiveTally | undefined =>
    m === 'all' ? est?.all : m === 'marked' ? est?.marked : undefined
  const pick = (m: CodexArchiveMode): void => {
    // Off, or less than now: nothing new is copied (nothing is removed either).
    if (m === 'off' || (mode === 'all' && m === 'marked')) {
      setPending(null)
      void update({ codexArchive: m })
      return
    }
    setPending(m)
  }
  const confirm = (): void => {
    if (!pending) return
    const t = tally(pending)
    void update({ codexArchive: pending }).then(() =>
      toast.success('Archiving Codex sessions', {
        description: t ? `${formatBytes(t.newBytes)} to copy in the background.` : undefined
      })
    )
    setPending(null)
  }
  const show = pending ?? mode
  return (
    <div className="mt-2 rounded-lg border border-border px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
          <Archive className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Archive Codex sessions</div>
          <div className="text-xs text-muted-foreground">
            Codex doesn&apos;t delete old sessions itself, and its history can be large, so this is
            off by default. Copies are never removed automatically.
          </div>
        </div>
      </div>
      <div className="mt-2.5">
        <Segmented<CodexArchiveMode>
          ariaLabel="Archive Codex sessions"
          value={show}
          onChange={pick}
          options={(['off', 'marked', 'all'] as const).map((m) => ({
            value: m,
            label: MODE_LABEL[m]
          }))}
        />
      </div>
      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground tabular-nums">
        {est ? (
          <>
            <div>
              <span className="font-medium text-foreground/80">All:</span> {tallyText(est.all)}
            </div>
            <div>
              <span className="font-medium text-foreground/80">Named, pinned or tagged:</span>{' '}
              {tallyText(est.marked)}
            </div>
            <div>
              Already in the archive: {est.archived} Codex session{est.archived === 1 ? '' : 's'} ·{' '}
              {formatBytes(est.archivedBytes)}
            </div>
          </>
        ) : (
          <div>{estFailed ? "The size couldn't be worked out." : 'Working out the size…'}</div>
        )}
      </div>
      {pending && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-2.5 py-2 text-xs">
          <span className="min-w-0 flex-1">
            {tally(pending) ? (
              <>
                {MODE_LABEL[pending]}: copies{' '}
                <span className="font-medium">{formatBytes(tally(pending)!.newBytes)}</span> into
                the archive now (and new sessions as they come). If backups are on, they grow by
                about{' '}
                <span className="font-medium">{formatBytes(tally(pending)!.backupBytes)}</span>.
              </>
            ) : estFailed ? (
              <>
                {MODE_LABEL[pending]}: the size couldn&apos;t be worked out, so it isn&apos;t known
                how much this copies into the archive (and adds to backups).
              </>
            ) : (
              <>Working out how much this copies…</>
            )}
          </span>
          {/* Never on a size that isn't known yet: wait for it, or say it's unknown. */}
          <Button size="sm" variant="primary" onClick={confirm} disabled={!est && !estFailed}>
            {est || !estFailed ? 'Turn on' : 'Turn on without a size'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
