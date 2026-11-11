// The model and effort level a session is launched with (Resume, Fork,
// Branch, New session), and where that choice comes from.
//
// Claude Code takes them as `--model <alias|id>` and `--effort <level>`
// (checked with `claude --help`, v2.1.316, on Windows and WSL). "Default"
// means no flag at all: Claude Code then uses its own choice (for a resumed
// session, the model saved in the transcript).
//
// Fast mode (`fast`: on / off) is resolved the same way. Neither agent has a
// flag of its own (claude 2.1.322, codex-cli 0.166): Claude Code takes it as
// `--settings <file>` naming the app's own file that holds only
// {"fastMode": true}; Codex as `-c service_tier=fast`. "Off" passes nothing,
// so the agent's own setting applies.
//
// Order: the session's own choice → the project's default → Settings.

import type { SessionSummary } from './types'
import { modelLabel as pricedModelLabel } from './usage/pricing'
import {
  normalizeProjectKey,
  projectDefaultKey,
  projectKeyLabel,
  type ProjectRef
} from './project-key'

/** The levels `claude --effort` accepts (v2.1.316). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/**
 * The levels Codex offers for `model_reasoning_effort` (the
 * `supported_reasoning_levels` of the models in Codex 0.164's model list on
 * this PC). Passed as `-c model_reasoning_effort=<level>`.
 */
export const CODEX_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ClaudeEffortLevel = (typeof EFFORT_LEVELS)[number]
export type CodexEffortLevel = (typeof CODEX_EFFORT_LEVELS)[number]
/** Any provider's level (each provider checks against its own list). */
export type EffortLevel = ClaudeEffortLevel | CodexEffortLevel
/** "default" = no `--effort` flag. */
export type EffortChoice = EffortLevel | 'default'
/** A provider's list of effort levels. */
export type EffortLevels = readonly EffortLevel[]

/** "default" = no `--model` flag. */
export const DEFAULT_CHOICE = 'default'

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

/** Short labels for badges ("Opus · XHigh"). */
const EFFORT_SHORT: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra'
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

export function isEffortLevel(v: unknown, levels: EffortLevels = EFFORT_LEVELS): v is EffortLevel {
  return typeof v === 'string' && (levels as readonly string[]).includes(v)
}

/** A stored model choice: a valid model, "default", or undefined (not set / invalid). */
export function cleanModelChoice(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (s.toLowerCase() === DEFAULT_CHOICE) return DEFAULT_CHOICE
  return isValidModel(s) ? s : undefined
}

export function cleanEffortChoice(
  v: unknown,
  levels: EffortLevels = EFFORT_LEVELS
): EffortChoice | undefined {
  if (v === DEFAULT_CHOICE) return DEFAULT_CHOICE
  return isEffortLevel(v, levels) ? v : undefined
}

/** Fast mode for launches: "on" passes the agent's flag, "off" passes nothing. */
export type FastChoice = 'on' | 'off'

export function cleanFastChoice(v: unknown): FastChoice | undefined {
  return v === 'on' || v === 'off' ? v : undefined
}

export interface ProjectModelDefault {
  model?: string
  effort?: EffortChoice
  fast?: FastChoice
}

export interface ModelSettings {
  /** "default" = Claude Code's own default. */
  defaultModel: string
  defaultEffort: EffortChoice
  /** Per-project defaults, keyed by projectModelKey(). */
  projectModels: Record<string, ProjectModelDefault>
  /** Fast mode unless a session or project has its own (absent: off). */
  defaultFast?: FastChoice
}

/** Codex's launch defaults in the app's settings (kept apart from Claude Code's). */
export interface CodexModelSettings {
  codexDefaultModel?: string
  codexDefaultEffort?: EffortChoice
  codexProjectModels?: Record<string, ProjectModelDefault>
  codexDefaultFast?: FastChoice
}

/** Codex's defaults in the shape resolveModelChoice takes. */
export function codexModelSettings(s: CodexModelSettings): Partial<ModelSettings> {
  return {
    defaultModel: s.codexDefaultModel,
    defaultEffort: s.codexDefaultEffort,
    projectModels: s.codexProjectModels,
    defaultFast: s.codexDefaultFast
  }
}

/** Same keys as the billing defaults (see project-key.ts). */
export const projectModelKey = projectDefaultKey
export { projectKeyLabel, type ProjectRef }

/** Validate per-project defaults from a settings file or the renderer. */
export function sanitizeProjectModels(
  v: unknown,
  levels: EffortLevels = EFFORT_LEVELS
): Record<string, ProjectModelDefault> {
  const out: Record<string, ProjectModelDefault> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, raw] of Object.entries(v).slice(0, 500)) {
    if (!k || k.length >= 1000 || !raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const model = cleanModelChoice(r.model)
    const effort = cleanEffortChoice(r.effort, levels)
    const fast = cleanFastChoice(r.fast)
    const key = normalizeProjectKey(k)
    if (!key || (model === undefined && effort === undefined && fast === undefined)) continue
    out[key] = {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fast !== undefined ? { fast } : {})
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
  /** True: launch in fast mode. Absent: no fast-mode flag. */
  fast?: boolean
  /** Where the fast-mode choice came from (absent: nothing set it). */
  fastFrom?: ChoiceFrom
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
  meta: { model?: string; effort?: string; fast?: string } | undefined,
  project: ProjectRef | undefined,
  settings: Partial<ModelSettings>,
  /** The provider's effort levels (Claude Code's by default). */
  levels: EffortLevels = EFFORT_LEVELS
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
    ['session', cleanEffortChoice(meta?.effort, levels)],
    ['project', cleanEffortChoice(projectDefault?.effort, levels)],
    ['settings', cleanEffortChoice(settings.defaultEffort, levels)]
  ])
  // "off" stops the search like "default": no flag, whatever comes after.
  const off = (v: FastChoice | undefined): 'on' | typeof DEFAULT_CHOICE | undefined =>
    v === 'off' ? DEFAULT_CHOICE : v
  const f = pick<'on' | typeof DEFAULT_CHOICE>([
    ['session', off(cleanFastChoice(meta?.fast))],
    ['project', off(cleanFastChoice(projectDefault?.fast))],
    ['settings', off(cleanFastChoice(settings.defaultFast))]
  ])
  return {
    model: m.value,
    effort: e.value as EffortLevel | undefined,
    modelFrom: m.from,
    effortFrom: e.from,
    ...(f.value === 'on' ? { fast: true } : {}),
    ...(f.from !== 'none' ? { fastFrom: f.from } : {})
  }
}

// --------------------------------------------------------------- fast mode

/**
 * Claude models with fast mode (code.claude.com/docs/en/fast-mode, 2026-11):
 * Fable 5.2, Opus 5.5 and Opus 5 (research preview), with or without the 1M
 * context, and the aliases naming them (`opus` is Opus 5.5 from Claude Code
 * 2.1.280). Opus 4.8's fast mode is deprecated (refused from 2026-11-30), so
 * it's left out; Sonnet, Haiku and `opusplan` have none.
 */
const CLAUDE_FAST_RE =
  /^(?:fable|opus|claude-fable-5-2|claude-opus-5-5|claude-opus-5)(?:-\d{8})?(?:\[1m\])?$/i

/** yes / no, or unknown when the model isn't known (the agent's own default). */
export type FastSupport = 'yes' | 'no' | 'unknown'

/**
 * Does this model have fast mode? Codex: the models whose entry in Codex's
 * own model list (`models_cache.json`) offers the Fast tier; unknown when
 * that list couldn't be read.
 */
export function fastSupport(
  provider: 'claude' | 'codex' | undefined,
  model: string | undefined,
  codexFastModels?: readonly string[] | null
): FastSupport {
  if (!model || model === DEFAULT_CHOICE) return 'unknown'
  if (provider === 'codex') {
    if (!codexFastModels) return 'unknown'
    return codexFastModels.includes(model) ? 'yes' : 'no'
  }
  return CLAUDE_FAST_RE.test(model) ? 'yes' : 'no'
}

/**
 * The model a launch runs on, as far as the app knows: the chosen one, else
 * (resuming) the last model the session used; undefined for a new session on
 * the agent's own default.
 */
export function launchModel(
  r: Pick<ResolvedModel, 'model'>,
  s: { models?: readonly string[] } | undefined,
  newSession = false
): string | undefined {
  if (r.model) return r.model
  if (newSession) return undefined
  const m = s?.models
  return m && m.length ? m[m.length - 1] : undefined
}

/** The choice without fast mode when the model is known not to have it (no flag then). */
export function withFastSupport<T extends Pick<ResolvedModel, 'fast'>>(
  r: T,
  support: FastSupport
): T {
  if (!r.fast || support !== 'no') return r
  const out = { ...r }
  delete out.fast
  return out
}

/** Codex's fast mode: the Fast service tier (a bare word, read as a literal string). */
export const CODEX_FAST_ARGS = ['-c', 'service_tier=fast'] as const

/**
 * The whole content of the app's own settings file for Claude Code's
 * `--settings`: fast mode and nothing else, so no other setting of the user's
 * is changed for the session.
 */
export const FAST_MODE_SETTINGS = '{"fastMode": true}\n'

/** File name of that settings file, in the app's data folder (`launch/`). */
export const FAST_MODE_FILE = 'fast-mode.json'

/**
 * Codex's flags for a choice: `-m <model>` and `-c model_reasoning_effort=<level>`
 * (the value is a bare word, which Codex reads as a literal string). Nothing for "default".
 */
export function codexModelArgs(model?: string, effort?: string, fast = false): string[] {
  const out: string[] = []
  if (model !== undefined && model !== DEFAULT_CHOICE) {
    if (!isValidModel(model)) throw new Error(`Invalid model: ${model}`)
    out.push('-m', model)
  }
  if (effort !== undefined && effort !== DEFAULT_CHOICE) {
    if (!isEffortLevel(effort, CODEX_EFFORT_LEVELS))
      throw new Error(`Invalid effort level: ${effort}`)
    out.push('-c', `model_reasoning_effort=${effort}`)
  }
  if (fast) out.push(...CODEX_FAST_ARGS)
  return out
}

/**
 * What the fast-mode settings file's path may hold: it reaches cmd,
 * PowerShell, Windows Terminal and bash (the same characters as Continue
 * fresh's handoff path), never starting with "-".
 */
const SETTINGS_PATH_RE = /^[\p{L}\p{N}_.,@\\/:~][\p{L}\p{N} _.,@\\/:~-]*$/u

/** Claude Code's fast mode: `--settings <the app's fast-mode.json>`. */
export function claudeFastArgs(settingsFile: string | undefined): string[] {
  if (!settingsFile) throw new Error("The fast-mode settings file isn't ready.")
  if (settingsFile.length > 1000 || !SETTINGS_PATH_RE.test(settingsFile))
    throw new Error("The fast-mode settings file's location can't be passed to Claude Code safely.")
  return ['--settings', settingsFile]
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

/** "Opus · High · Fast", "Opus", "High effort", "Fast", or "" when all are default. */
export function choiceLabel(
  r: Pick<ResolvedModel, 'model' | 'effort' | 'fast'>,
  short = true
): string {
  const parts: string[] = []
  if (r.model) parts.push(modelLabel(r.model))
  if (r.effort)
    parts.push(r.model ? effortLabel(r.effort, short) : `${effortLabel(r.effort, short)} effort`)
  if (r.fast) parts.push('Fast')
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
  own: { model?: string; effort?: EffortChoice; fast?: FastChoice }
): ProjectModelDefault {
  return {
    ...(current ?? {}),
    ...(own.model !== undefined ? { model: own.model } : {}),
    ...(own.effort !== undefined ? { effort: own.effort } : {}),
    ...(own.fast !== undefined ? { fast: own.fast } : {})
  }
}
