// The model and effort level a session is launched with (Resume, Fork,
// Branch, New session), and where that choice comes from.
//
// Claude Code takes them as `--model <alias|id>` and `--effort <level>`
// (checked with `claude --help`, v2.1.316, on Windows and WSL). "Default"
// means no flag at all: Claude Code then uses its own choice (for a resumed
// session, the model saved in the transcript).
//
// Order: the session's own choice → the project's default → Settings.

import type { SessionSummary } from './types'
import { modelLabel as pricedModelLabel } from './usage/pricing'

/** The levels `claude --effort` accepts (v2.1.316). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
/** "default" = no `--effort` flag. */
export type EffortChoice = EffortLevel | 'default'

/** "default" = no `--model` flag. */
export const DEFAULT_CHOICE = 'default'

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** Short labels for badges ("Opus · XHigh"). */
const EFFORT_SHORT: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

/** Aliases Claude Code documents for `--model`, for the picker. */
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const

/**
 * A model ID or alias that is safe on every command line it passes through
 * (cmd, PowerShell, Windows Terminal, wsl.exe and bash): letters, digits and
 * `. _ - : @ / [ ]` only (enough for `sonnet[1m]`, dated IDs, Vertex
 * `model@version` and Bedrock ARNs), never starting with "-".
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/

export function isValidModel(v: unknown): v is string {
  return typeof v === 'string' && MODEL_RE.test(v)
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
}

/** A stored model choice: a valid model, "default", or undefined (not set / invalid). */
export function cleanModelChoice(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s.toLowerCase() === DEFAULT_CHOICE) return DEFAULT_CHOICE
  return isValidModel(s) ? s : undefined
}

export function cleanEffortChoice(v: unknown): EffortChoice | undefined {
  if (v === DEFAULT_CHOICE) return DEFAULT_CHOICE
  return isEffortLevel(v) ? v : undefined
}

export interface ProjectModelDefault {
  model?: string
  effort?: EffortChoice
}

export interface ModelSettings {
  /** "default" = Claude Code's own default. */
  defaultModel: string
  defaultEffort: EffortChoice
  /** Per-project defaults, keyed by projectModelKey(). */
  projectModels: Record<string, ProjectModelDefault>
}

/** Which project a session belongs to: its folder, in its environment. */
export interface ProjectRef {
  env?: 'windows' | 'wsl'
  distro?: string
  cwd?: string
}

const WSL_KEY = /^wsl:([^:]+):(\/.*)$/

/**
 * Key for a project's defaults. Windows folders are lower-cased (Windows
 * ignores case in paths). WSL folders are "wsl:<distro>:<path>" with the case
 * kept: Linux paths are case-sensitive, and each distro has its own files, so
 * /home/me/App and /home/me/app, or the same path in two distros, are
 * different projects. Undefined when the session has no folder (or a WSL
 * session no distro).
 */
export function projectModelKey(p: ProjectRef | undefined): string | undefined {
  if (!p?.cwd) return undefined
  if (p.env === 'wsl') return p.distro ? `wsl:${p.distro}:${p.cwd}` : undefined
  return p.cwd.toLowerCase()
}

/** A stored key in its current form, or undefined for one that can't be placed. */
function normalizeProjectKey(k: string): string | undefined {
  if (k.startsWith('wsl:')) return WSL_KEY.test(k) ? k : undefined
  // A bare Linux path (the first form of these keys, never released) doesn't
  // say which distro it meant: dropped rather than applied to all of them.
  if (k.startsWith('/')) return undefined
  return k.toLowerCase()
}

/** "WSL: Ubuntu · /home/me/app", or the Windows folder, for Settings. */
export function projectKeyLabel(k: string): string {
  const m = WSL_KEY.exec(k)
  return m ? `WSL: ${m[1]} · ${m[2]}` : k
}

/** Validate per-project defaults from a settings file or the renderer. */
export function sanitizeProjectModels(v: unknown): Record<string, ProjectModelDefault> {
  const out: Record<string, ProjectModelDefault> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, raw] of Object.entries(v).slice(0, 500)) {
    if (!k || k.length >= 1000 || !raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const model = cleanModelChoice(r.model)
    const effort = cleanEffortChoice(r.effort)
    const key = normalizeProjectKey(k)
    if (!key || (model === undefined && effort === undefined)) continue
    out[key] = {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {})
    }
  }
  return out
}

export type ChoiceFrom = 'session' | 'project' | 'settings' | 'none'

export interface ResolvedModel {
  /** Undefined = no `--model` flag. */
  model?: string
  /** Undefined = no `--effort` flag. */
  effort?: EffortLevel
  modelFrom: ChoiceFrom
  effortFrom: ChoiceFrom
}

function pick<T extends string>(
  levels: [Exclude<ChoiceFrom, 'none'>, T | undefined][]
): { value?: T; from: ChoiceFrom } {
  for (const [from, v] of levels) {
    if (v === undefined) continue
    // An explicit "default" stops the search: no flag, whatever comes after.
    if (v === DEFAULT_CHOICE) return { from: from === 'settings' ? 'none' : from }
    return { value: v, from }
  }
  return { from: 'none' }
}

/** Session → project → Settings. Invalid stored values are skipped. */
export function resolveModelChoice(
  meta: { model?: string; effort?: string } | undefined,
  project: ProjectRef | undefined,
  settings: Partial<ModelSettings>
): ResolvedModel {
  const key = projectModelKey(project)
  const projectDefault =
    key && settings.projectModels && Object.hasOwn(settings.projectModels, key)
      ? settings.projectModels[key]
      : undefined
  const m = pick<string>([
    ['session', cleanModelChoice(meta?.model)],
    ['project', cleanModelChoice(projectDefault?.model)],
    ['settings', cleanModelChoice(settings.defaultModel)]
  ])
  const e = pick<EffortChoice>([
    ['session', cleanEffortChoice(meta?.effort)],
    ['project', cleanEffortChoice(projectDefault?.effort)],
    ['settings', cleanEffortChoice(settings.defaultEffort)]
  ])
  return {
    model: m.value,
    effort: e.value as EffortLevel | undefined,
    modelFrom: m.from,
    effortFrom: e.from
  }
}

/** The `claude` flags for a choice. Nothing for "default". */
export function modelArgs(model?: string, effort?: string): string[] {
  const out: string[] = []
  if (model !== undefined && model !== DEFAULT_CHOICE) {
    if (!isValidModel(model)) throw new Error(`Invalid model: ${model}`)
    out.push('--model', model)
  }
  if (effort !== undefined && effort !== DEFAULT_CHOICE) {
    if (!isEffortLevel(effort)) throw new Error(`Invalid effort level: ${effort}`)
    out.push('--effort', effort)
  }
  return out
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** "opus" → "Opus", "sonnet[1m]" → "Sonnet 1M", "claude-opus-4-5-20251101" → "Opus 4.5". */
export function modelLabel(model: string): string {
  const ctx = /\[(\d+)m\]$/i.exec(model)
  const base = ctx ? model.slice(0, ctx.index) : model
  const suffix = ctx ? ` ${ctx[1]}M` : ''
  if (base === 'opusplan') return `Opus Plan${suffix}`
  if (/^[a-z]+$/i.test(base)) return cap(base.toLowerCase()) + suffix
  const priced = pricedModelLabel(base)
  return (priced === base && base.length > 28 ? `${base.slice(0, 26)}…` : priced) + suffix
}

export function effortLabel(effort: EffortLevel, short = false): string {
  return (short ? EFFORT_SHORT : EFFORT_LABEL)[effort]
}

/** "Opus · High", "Opus", "High effort", or "" when both are default. */
export function choiceLabel(r: Pick<ResolvedModel, 'model' | 'effort'>, short = true): string {
  const parts: string[] = []
  if (r.model) parts.push(modelLabel(r.model))
  if (r.effort)
    parts.push(r.model ? effortLabel(r.effort, short) : `${effortLabel(r.effort, short)} effort`)
  return parts.join(' · ')
}

export const FROM_LABEL: Record<ChoiceFrom, string> = {
  session: 'this session',
  project: 'the project default',
  settings: 'the default in Settings',
  none: "Claude Code's default"
}

/**
 * Models seen in the session logs, most recently used first ("<synthetic>"
 * is already left out when the files are read).
 */
export function modelsSeen(
  sessions: Pick<SessionSummary, 'models' | 'lastActivityAt' | 'startedAt'>[]
): string[] {
  const last = new Map<string, number>()
  for (const s of sessions) {
    const at = Date.parse(s.lastActivityAt ?? s.startedAt ?? '') || 0
    for (const m of s.models) {
      if (!isValidModel(m)) continue
      if ((last.get(m) ?? -1) < at) last.set(m, at)
    }
  }
  return [...last.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m)
}

/**
 * "Use this session's choice for the whole project": the session's own
 * fields replace the project's; the fields it doesn't set stay as they were.
 */
export function promoteToProject(
  current: ProjectModelDefault | undefined,
  own: { model?: string; effort?: EffortChoice }
): ProjectModelDefault {
  return {
    ...(current ?? {}),
    ...(own.model !== undefined ? { model: own.model } : {}),
    ...(own.effort !== undefined ? { effort: own.effort } : {})
  }
}
