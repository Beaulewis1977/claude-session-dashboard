// Model and effort pickers for launches (Resume, Fork, Branch, New session),
// and the small badge that shows the choice. The choice is saved per session
// in the app's metadata; "Default" falls back to the project's default, then
// Settings, then Claude Code's own default (no flag).

import { useMemo, useState } from 'react'
import { Check, ChevronDown, FolderCog, Gauge, Sparkles, X } from 'lucide-react'
import {
  choiceLabel,
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
  resolveModelChoice,
  type ChoiceFrom,
  type EffortChoice,
  type ResolvedModel
} from '@shared/model-choice'
import type { SessionMeta, SessionSummary } from '@shared/types'
import { api } from '@/lib/api'
import { updateMeta } from '@/lib/actions'
import { useApp } from '@/lib/store'
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
function useInherited(cwd: string | undefined): ResolvedModel {
  const settings = useApp((st) => st.settings)
  return useMemo(() => resolveModelChoice(undefined, cwd, settings), [cwd, settings])
}

const fromShort = (from: ChoiceFrom): string =>
  from === 'project' ? 'project' : from === 'settings' ? 'Settings' : ''

function inheritedModelText(r: ResolvedModel): string {
  return r.model ? `${modelLabel(r.model)} · ${fromShort(r.modelFrom)}` : "Claude Code's"
}

function inheritedEffortText(r: ResolvedModel): string {
  return r.effort ? `${effortLabel(r.effort)} · ${fromShort(r.effortFrom)}` : "Claude Code's"
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
  className
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
}) {
  const sessions = useApp((s) => s.sessions)
  const seen = useMemo(() => modelsSeen(sessions).slice(0, SEEN_MAX), [sessions])
  const [custom, setCustom] = useState<string | null>(null)
  const known = new Set<string>([...MODEL_ALIASES, ...seen])
  const radio = value === undefined ? '' : value
  const label =
    value === undefined
      ? `Default (${defaultText})`
      : value === DEFAULT_CHOICE
        ? "Claude Code's default"
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
            placeholder="opus, sonnet[1m], claude-…"
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
              <span className="min-w-0 flex-1 truncate">Claude Code&apos;s default</span>
              <span className="text-[11px] text-subtle-foreground">no flag</span>
            </DropdownMenuRadioItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Aliases (latest model)</DropdownMenuLabel>
          {MODEL_ALIASES.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              <span className="min-w-0 flex-1">{modelLabel(m)}</span>
              <span className="font-mono text-[10.5px] text-subtle-foreground">{m}</span>
            </DropdownMenuRadioItem>
          ))}
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
  className
}: {
  value: EffortChoice | undefined
  onChange: (v: EffortChoice | undefined) => void
  defaultText: string
  explicitDefault?: boolean
  align?: 'start' | 'end'
  disabled?: boolean
  className?: string
}) {
  const label =
    value === undefined
      ? `Default (${defaultText})`
      : value === DEFAULT_CHOICE
        ? "Claude Code's default"
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
              v === '' ? undefined : v === DEFAULT_CHOICE || isEffortLevel(v) ? v : undefined
            )
          }
        >
          <DropdownMenuRadioItem value="">
            <span className="min-w-0 flex-1 truncate">Default</span>
            <span className="truncate text-[11px] text-subtle-foreground">{defaultText}</span>
          </DropdownMenuRadioItem>
          {explicitDefault && (
            <DropdownMenuRadioItem value={DEFAULT_CHOICE}>
              <span className="min-w-0 flex-1 truncate">Claude Code&apos;s default</span>
              <span className="text-[11px] text-subtle-foreground">no flag</span>
            </DropdownMenuRadioItem>
          )}
          <DropdownMenuSeparator />
          {EFFORT_LEVELS.map((e) => (
            <DropdownMenuRadioItem key={e} value={e}>
              <span className="min-w-0 flex-1">{EFFORT_LABEL[e]}</span>
              <span className="font-mono text-[10.5px] text-subtle-foreground">{e}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <div className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-subtle-foreground">
          Not every model supports every level; Claude Code steps down to the highest one it
          supports.
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
  const inherited = useInherited(session.cwd)
  const meta = session.meta
  const model = meta.model
  const effort = meta.effort
  const save = (patch: Partial<SessionMeta>): void => write(() => updateMeta(session.key, patch))
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <ModelPicker
        value={model}
        onChange={(v) => save(v === undefined ? { model: clearChoice.model } : { model: v })}
        defaultText={inheritedModelText(inherited)}
        explicitDefault={!!inherited.model}
        disabled={disabled}
      />
      <EffortPicker
        value={effort}
        onChange={(v) => save(v === undefined ? { effort: clearChoice.effort } : { effort: v })}
        defaultText={inheritedEffortText(inherited)}
        explicitDefault={!!inherited.effort}
        disabled={disabled}
      />
      {!api.remote && session.cwd && <ProjectDefaultMenu session={session} />}
    </div>
  )
}

/** Make the session's choice the default for every session in its folder, or clear it. */
function ProjectDefaultMenu({ session }: { session: SessionSummary }) {
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const key = projectModelKey(session.cwd)
  const current = settings.projectModels[key]
  const own = { model: session.meta.model, effort: session.meta.effort }
  const hasOwn = own.model !== undefined || own.effort !== undefined
  const currentLabel = current
    ? choiceLabel({
        model: current.model !== DEFAULT_CHOICE ? current.model : undefined,
        effort: isEffortLevel(current.effort) ? current.effort : undefined
      }) || "Claude Code's default"
    : undefined
  const saveProject = (next: (typeof settings)['projectModels']): void =>
    void api.updateSettings({ projectModels: next }).then((st) => set({ settings: st }))
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
          onSelect={() => {
            saveProject({
              ...settings.projectModels,
              [key]: {
                ...(own.model !== undefined ? { model: own.model } : {}),
                ...(own.effort !== undefined ? { effort: own.effort } : {})
              }
            })
            // The session now follows the project default.
            void updateMeta(session.key, clearChoice)
          }}
        >
          <FolderCog /> Use this session&apos;s choice for the whole project
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!current}
          onSelect={() => {
            const next = { ...settings.projectModels }
            delete next[key]
            saveProject(next)
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
  onEffort
}: {
  model: string
  effort: EffortChoice
  onModel: (v: string) => void
  onEffort: (v: EffortChoice) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ModelPicker
        align="end"
        value={model === DEFAULT_CHOICE ? undefined : model}
        onChange={(v) => onModel(v ?? DEFAULT_CHOICE)}
        defaultText="Claude Code's"
      />
      <EffortPicker
        align="end"
        value={effort === DEFAULT_CHOICE ? undefined : effort}
        onChange={(v) => onEffort(v ?? DEFAULT_CHOICE)}
        defaultText="Claude Code's"
      />
    </div>
  )
}
