// Model and effort pickers for launches (Resume, Fork, Branch, New session),
// and the small badge that shows the choice. The choice is saved per session
// in the app's metadata; "Default" falls back to the project's default, then
// Settings, then Claude Code's own default (no flag).

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, FolderCog, Gauge, Sparkles, X } from 'lucide-react'
import {
  choiceLabel,
  CODEX_EFFORT_LEVELS,
  DEFAULT_CHOICE,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  effortLabel,
  FROM_LABEL,
  isEffortLevel,
  isValidModel,
  MODEL_ALIASES,
  modelLabel,
  modelsSeen,
  projectModelKey,
  promoteToProject,
  type ChoiceFrom,
  type EffortChoice,
  type ResolvedModel
} from '@shared/model-choice'
import type { SessionMeta, SessionSummary } from '@shared/types'
import { api } from '@/lib/api'
import { updateMeta } from '@/lib/actions'
import { useApp } from '@/lib/store'
import { modelChoiceOf } from '@/lib/model-choice'
import { PROVIDER_LABEL, providerOf, type ProviderId } from '@shared/provider'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { Input } from './ui/input'

const SEEN_MAX = 8

/**
 * Back to Default. Sent as "" (the main process stores it as unset): an
 * undefined value could be dropped on the way.
 */
const clearChoice = { model: '', effort: '' } as unknown as Pick<SessionMeta, 'model' | 'effort'>

/** What "Default" means for a session: its project's default, else Settings. */
function useInherited(s: SessionSummary): ResolvedModel {
  const settings = useApp((st) => st.settings)
  const { cwd, env, distro, provider } = s
  return useMemo(
    () => modelChoiceOf({ meta: {}, cwd, env, distro, provider }, settings),
    [cwd, env, distro, provider, settings]
  )
}

/** "Claude Code's" / "Codex's": whose own default applies when nothing is set. */
const ownDefault = (agent: ProviderId): string => PROVIDER_LABEL[agent] + "'s"

const fromShort = (from: ChoiceFrom): string =>
  from === 'project' ? 'project' : from === 'settings' ? 'Settings' : ''

function inheritedModelText(r: ResolvedModel, agent: ProviderId = 'claude'): string {
  return r.model ? `${modelLabel(r.model)} · ${fromShort(r.modelFrom)}` : ownDefault(agent)
}

function inheritedEffortText(r: ResolvedModel, agent: ProviderId = 'claude'): string {
  return r.effort ? `${effortLabel(r.effort)} · ${fromShort(r.effortFrom)}` : ownDefault(agent)
}

/** "Opus · High" next to a session; nothing when Claude Code's defaults apply. */
export function ModelChoiceBadge({
  choice,
  compact
}: {
  choice: ResolvedModel
  compact?: boolean
}) {
  const label = choiceLabel(choice)
  if (!label) return null
  const own = choice.modelFrom === 'session' || choice.effortFrom === 'session'
  const title = [
    choice.model && `Model ${choice.model} (from ${FROM_LABEL[choice.modelFrom]})`,
    choice.effort && `Effort ${choice.effort} (from ${FROM_LABEL[choice.effortFrom]})`
  ]
    .filter(Boolean)
    .join('\n')
  if (compact)
    return (
      <span
        className={cn(
          'inline-flex max-w-[130px] items-center gap-1 rounded px-1 text-[10px] font-medium',
          own ? 'bg-accent-soft text-primary' : 'bg-secondary text-muted-foreground'
        )}
        title={`Launches with: ${title}`}
      >
        <Sparkles className="size-2.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    )
  return (
    <Badge variant={own ? 'accent' : 'muted'} title={`Launches with: ${title}`}>
      <Sparkles /> {label}
    </Badge>
  )
}

const triggerClass =
  'inline-flex h-8 items-center gap-2 rounded-md border border-border-strong bg-background px-2.5 text-left text-[13px] shadow-xs transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50'

/**
 * Model: Default, the documented aliases, models seen in the logs (most
 * recently used first) and "Custom…" for any model ID or alias.
 * `value` undefined = Default.
 */
export function ModelPicker({
  value,
  onChange,
  defaultText,
  explicitDefault = false,
  align = 'start',
  disabled,
  className,
  agent = 'claude'
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  /** What Default means here, e.g. "Opus · project" or "Claude Code's". */
  defaultText: string
  /** Also offer "Claude Code's default" (no flag, even if a project or Settings default is set). */
  explicitDefault?: boolean
  align?: 'start' | 'end'
  disabled?: boolean
  className?: string
  /** Whose models: Claude Code's aliases and models, or Codex's. */
  agent?: ProviderId
}) {
  const sessions = useApp((s) => s.sessions)
  const seen = useMemo(
    () => modelsSeen(sessions.filter((s) => providerOf(s) === agent)).slice(0, SEEN_MAX),
    [sessions, agent]
  )
  const [custom, setCustom] = useState<string | null>(null)
  // Codex has no documented aliases: its models come from the sessions (or Custom…).
  const aliases: readonly string[] = agent === 'claude' ? MODEL_ALIASES : []
  const known = new Set<string>([...aliases, ...seen])
  const radio = value === undefined ? '' : value
  const label =
    value === undefined
      ? `Default (${defaultText})`
      : value === DEFAULT_CHOICE
        ? `${ownDefault(agent)} default`
        : modelLabel(value)

  if (custom !== null) {
    const ok = isValidModel(custom.trim())
    const save = (): void => {
      if (!ok) return
      onChange(custom.trim())
      setCustom(null)
    }
    return (
      <div className={cn('flex min-w-0 flex-col gap-1', className)}>
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                save()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setCustom(null)
              }
            }}
            placeholder={agent === 'codex' ? 'gpt-5.5-codex, …' : 'opus, sonnet[1m], claude-…'}
            aria-label="Custom model ID or alias"
            aria-invalid={!!custom.trim() && !ok}
            className="h-8 w-[200px] font-mono text-[12px]"
            spellCheck={false}
          />
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Use this model"
            disabled={!ok}
            onClick={save}
          >
            <Check />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel"
            onClick={() => setCustom(null)}
          >
            <X />
          </Button>
        </div>
        {!!custom.trim() && !ok && (
          <span className="text-2xs text-warning">
            Letters, digits and . _ - : @ / [ ] only, not starting with &quot;-&quot;.
          </span>
        )}
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(triggerClass, 'min-w-[180px]', className)}
          aria-label={`Model: ${label}`}
        >
          <Sparkles
            className={cn(
              'size-3.5',
              value === undefined ? 'text-muted-foreground' : 'text-primary'
            )}
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[360px] w-72 overflow-y-auto">
        <DropdownMenuRadioGroup
          value={radio}
          onValueChange={(v) => {
            if (v === '__custom') setCustom(value && value !== DEFAULT_CHOICE ? value : '')
            else onChange(v === '' ? undefined : v)
          }}
        >
          <DropdownMenuRadioItem value="">
            <span className="min-w-0 flex-1 truncate">Default</span>
            <span className="truncate text-[11px] text-subtle-foreground">{defaultText}</span>
          </DropdownMenuRadioItem>
          {explicitDefault && (
            <DropdownMenuRadioItem value={DEFAULT_CHOICE}>
              <span className="min-w-0 flex-1 truncate">{ownDefault(agent)} default</span>
              <span className="text-[11px] text-subtle-foreground">no flag</span>
            </DropdownMenuRadioItem>
          )}
          {aliases.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Aliases (latest model)</DropdownMenuLabel>
              {aliases.map((m) => (
                <DropdownMenuRadioItem key={m} value={m}>
                  <span className="min-w-0 flex-1">{modelLabel(m)}</span>
                  <span className="font-mono text-[10.5px] text-subtle-foreground">{m}</span>
                </DropdownMenuRadioItem>
              ))}
            </>
          )}
          {seen.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Seen in your sessions</DropdownMenuLabel>
              {seen.map((m) => (
                <DropdownMenuRadioItem key={m} value={m}>
                  <span className="min-w-0 flex-1 truncate">{modelLabel(m)}</span>
                  <span className="max-w-[140px] truncate font-mono text-[10.5px] text-subtle-foreground">
                    {m}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </>
          )}
          {value && value !== DEFAULT_CHOICE && !known.has(value) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuRadioItem value={value}>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{value}</span>
              </DropdownMenuRadioItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="__custom">Custom…</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Effort: Default and the levels `claude --effort` accepts. `value` undefined = Default. */
export function EffortPicker({
  value,
  onChange,
  defaultText,
  explicitDefault = false,
  align = 'start',
  disabled,
  className,
  agent = 'claude'
}: {
  value: EffortChoice | undefined
  onChange: (v: EffortChoice | undefined) => void
  defaultText: string
  explicitDefault?: boolean
  align?: 'start' | 'end'
  disabled?: boolean
  className?: string
  /** Whose levels: `claude --effort`, or Codex's model_reasoning_effort. */
  agent?: ProviderId
}) {
  const levels = agent === 'codex' ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS
  const label =
    value === undefined
      ? `Default (${defaultText})`
      : value === DEFAULT_CHOICE
        ? `${ownDefault(agent)} default`
        : EFFORT_LABEL[value]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(triggerClass, 'min-w-[150px]', className)}
          aria-label={`Effort: ${label}`}
        >
          <Gauge
            className={cn(
              'size-3.5',
              value === undefined ? 'text-muted-foreground' : 'text-primary'
            )}
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuRadioGroup
          value={value ?? ''}
          onValueChange={(v) =>
            onChange(
              v === ''
                ? undefined
                : v === DEFAULT_CHOICE || isEffortLevel(v, levels)
                  ? v
                  : undefined
            )
          }
        >
          <DropdownMenuRadioItem value="">
            <span className="min-w-0 flex-1 truncate">Default</span>
            <span className="truncate text-[11px] text-subtle-foreground">{defaultText}</span>
          </DropdownMenuRadioItem>
          {explicitDefault && (
            <DropdownMenuRadioItem value={DEFAULT_CHOICE}>
              <span className="min-w-0 flex-1 truncate">{ownDefault(agent)} default</span>
              <span className="text-[11px] text-subtle-foreground">no flag</span>
            </DropdownMenuRadioItem>
          )}
          <DropdownMenuSeparator />
          {levels.map((e) => (
            <DropdownMenuRadioItem key={e} value={e}>
              <span className="min-w-0 flex-1">{EFFORT_LABEL[e]}</span>
              <span className="font-mono text-[10.5px] text-subtle-foreground">{e}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <div className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-subtle-foreground">
          {agent === 'codex'
            ? 'Not every Codex model supports every level (Ultra is only on some).'
            : 'Not every model supports every level; Claude Code steps down to the highest one it supports.'}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The session's own model and effort, saved in the app's metadata as soon
 * as they change. On the desktop, also a menu to make them the project's
 * default.
 */
export function SessionModelControls({
  session,
  write = (fn) => void fn(),
  disabled,
  className
}: {
  session: SessionSummary
  /** Wraps each save (the phone checks read-only mode). */
  write?: (fn: () => Promise<void>) => void
  disabled?: boolean
  className?: string
}) {
  const inherited = useInherited(session)
  const agent = providerOf(session)
  const meta = session.meta
  const model = meta.model
  const effort = meta.effort
  const save = (patch: Partial<SessionMeta>): void => write(() => updateMeta(session.key, patch))
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <ModelPicker
        value={model}
        onChange={(v) => save(v === undefined ? { model: clearChoice.model } : { model: v })}
        defaultText={inheritedModelText(inherited, agent)}
        explicitDefault={!!inherited.model}
        disabled={disabled}
        agent={agent}
      />
      <EffortPicker
        value={effort}
        onChange={(v) => save(v === undefined ? { effort: clearChoice.effort } : { effort: v })}
        defaultText={inheritedEffortText(inherited, agent)}
        explicitDefault={!!inherited.effort}
        disabled={disabled}
        agent={agent}
      />
      {!api.remote && projectModelKey(session) && <ProjectDefaultMenu session={session} />}
    </div>
  )
}

/** Make the session's choice the default for every session in its folder, or clear it. */
function ProjectDefaultMenu({ session }: { session: SessionSummary }) {
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const key = projectModelKey(session) ?? ''
  // Codex has its own project defaults, apart from Claude Code's.
  const codex = providerOf(session) === 'codex'
  const field = codex ? 'codexProjectModels' : 'projectModels'
  const models = (codex ? settings.codexProjectModels : settings.projectModels) ?? {}
  const current = Object.hasOwn(models, key) ? models[key] : undefined
  const own = { model: session.meta.model, effort: session.meta.effort }
  const hasOwn = own.model !== undefined || own.effort !== undefined
  const currentLabel = current
    ? choiceLabel({
        model: current.model !== DEFAULT_CHOICE ? current.model : undefined,
        effort: isEffortLevel(current.effort, codex ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS)
          ? current.effort
          : undefined
      }) || ownDefault(providerOf(session)) + ' default'
    : undefined
  const saveProject = async (next: (typeof settings)['projectModels']): Promise<boolean> => {
    try {
      set({ settings: await api.updateSettings({ [field]: next }) })
      return true
    } catch (err) {
      toast.error('Could not save the project default', { description: (err as Error).message })
      return false
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-label="Project default for model and effort"
        >
          <FolderCog />
          {currentLabel ? `Project: ${currentLabel}` : 'Project default'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>{session.projectName}</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={!hasOwn}
          onSelect={() =>
            void (async () => {
              // Only the session's own fields change; the project keeps the others.
              const next = { ...models, [key]: promoteToProject(current, own) }
              if (!(await saveProject(next))) return
              // Saved: the session now follows the project default for what it promoted.
              await updateMeta(session.key, {
                ...(own.model !== undefined ? { model: clearChoice.model } : {}),
                ...(own.effort !== undefined ? { effort: clearChoice.effort } : {})
              })
            })()
          }
        >
          <FolderCog /> Use this session&apos;s choice for the whole project
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!current}
          onSelect={() => {
            const next = { ...models }
            delete next[key]
            void saveProject(next)
          }}
        >
          <X /> Clear the project default
        </DropdownMenuItem>
        {!hasOwn && (
          <div className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-subtle-foreground">
            Pick a model or effort for this session first.
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Settings → Resume: the defaults for every session without its own choice. */
export function DefaultModelPickers({
  model,
  effort,
  onModel,
  onEffort,
  agent = 'claude'
}: {
  model: string
  effort: EffortChoice
  onModel: (v: string) => void
  onEffort: (v: EffortChoice) => void
  agent?: ProviderId
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ModelPicker
        align="end"
        value={model === DEFAULT_CHOICE ? undefined : model}
        onChange={(v) => onModel(v ?? DEFAULT_CHOICE)}
        defaultText={ownDefault(agent)}
        agent={agent}
      />
      <EffortPicker
        align="end"
        value={effort === DEFAULT_CHOICE ? undefined : effort}
        onChange={(v) => onEffort(v ?? DEFAULT_CHOICE)}
        defaultText={ownDefault(agent)}
        agent={agent}
      />
    </div>
  )
}
