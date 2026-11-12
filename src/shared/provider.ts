// Which coding agent a session belongs to: Claude Code or OpenAI Codex
// (docs/ROADMAP.md, feature 5). Data written before providers existed has no
// provider field and means Claude Code.

export type ProviderId = 'claude' | 'codex'

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex']

/** What a missing provider field means (everything stored before providers). */
export const DEFAULT_PROVIDER: ProviderId = 'claude'

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

/** Short names for badges and the view switch. */
export const PROVIDER_SHORT: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v)
}

/** The provider of a session, source or archive record (absent: Claude Code). */
export function providerOf(x: { provider?: ProviderId } | undefined | null): ProviderId {
  return x?.provider ?? DEFAULT_PROVIDER
}

/**
 * The key of a session's entry in `metadata.json` (names, tags, summaries…).
 * Claude Code sessions keep their bare session id, exactly as before
 * providers existed. Every other provider's ids get a `<provider>:` prefix.
 * A Claude Code session id never contains ":" (its file name allows only
 * letters, digits, "_" and "-"), so the two can never collide.
 */
export function metaKey(provider: ProviderId | undefined, sessionId: string): string {
  const p = provider ?? DEFAULT_PROVIDER
  return p === DEFAULT_PROVIDER ? sessionId : `${p}:${sessionId}`
}

/** A session's metadata key (see metaKey). */
export function metaKeyOf(s: { provider?: ProviderId; sessionId: string }): string {
  return metaKey(s.provider, s.sessionId)
}

/** The view switch: every provider, or just one. */
export type ProviderView = 'all' | ProviderId

export function isProviderView(v: unknown): v is ProviderView {
  return v === 'all' || isProviderId(v)
}

/** Does a session show in this view? */
export function inProviderView(view: ProviderView, s: { provider?: ProviderId }): boolean {
  return view === 'all' || providerOf(s) === view
}

/** Which providers are turned on (Settings → Providers). Both by default. */
export type ProviderToggles = Record<ProviderId, boolean>

/** Cleans stored toggles: unknown values are on, and at least one stays on. */
export function sanitizeProviderToggles(v: unknown): ProviderToggles {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: ProviderToggles = { claude: o.claude !== false, codex: o.codex !== false }
  if (!out.claude && !out.codex) out.claude = true
  return out
}

/** The view to use when some providers are off: a view of a provider that's off becomes "all". */
export function effectiveView(view: ProviderView, enabled: ProviderToggles): ProviderView {
  if (view !== 'all' && !enabled[view]) return 'all'
  return view
}

/**
 * Codex launches' default for --dangerously-bypass-approvals-and-sandbox. It
 * used to follow skipPermissionsDefault (one shared toggle), so a settings file
 * from before it has its own value keeps that one: nothing changes until the
 * Codex toggle is changed.
 */
export function codexBypassDefaultOf(s: {
  skipPermissionsDefault?: boolean
  codexBypassDefault?: boolean
}): boolean {
  if (typeof s.codexBypassDefault === 'boolean') return s.codexBypassDefault
  return s.skipPermissionsDefault !== false
}

/** The bypass / skip-permissions default for a launch of this provider's session. */
export function skipDefaultFor(
  s: { skipPermissionsDefault?: boolean; codexBypassDefault?: boolean },
  provider: ProviderId
): boolean {
  return provider === 'codex' ? codexBypassDefaultOf(s) : s.skipPermissionsDefault !== false
}

/** Providers that are on, in their usual order. */
export function enabledProviders(enabled: ProviderToggles): ProviderId[] {
  return PROVIDER_IDS.filter((p) => enabled[p])
}

/** What a provider's sessions can do. Unsupported actions are hidden in the app and refused in the main process. */
export interface ProviderCapabilities {
  fork: boolean
  branch: boolean
  continueFresh: boolean
  remoteControl: boolean
  /** Launch on an API account's key instead of the subscription. */
  apiBilling: boolean
  /** "New session in this folder". */
  newSession: boolean
  /** Session summaries (written with `claude -p`). */
  summaries: boolean
  /** Token usage and plan limits are read from its files. */
  usage: boolean
  /**
   * A missing session file may be copied back from the archive before a
   * launch (an allowed exception for `.claude` only; never for other agents' folders).
   */
  restore: boolean
  /** Running now and session alerts. */
  live: boolean
}

export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  claude: {
    fork: true,
    branch: true,
    continueFresh: true,
    remoteControl: true,
    apiBilling: true,
    newSession: true,
    summaries: true,
    usage: true,
    restore: true,
    live: true
  },
  // Codex (Phase B): `codex resume` and `codex fork`; no Branch from here (it would
  // write into ~/.codex). Phase C: usage and limits. Phase D2: summaries (written by
  // Claude, as for Claude Code sessions) and Continue fresh (a new `codex` session).
  codex: {
    fork: true,
    branch: false,
    continueFresh: true,
    remoteControl: false,
    apiBilling: false,
    newSession: false,
    summaries: true,
    usage: true,
    restore: false,
    // Phase D1: Running now and alerts, from thread locks and rollouts (+ the opt-in hook).
    live: true
  }
}

export function capsOf(x: { provider?: ProviderId } | undefined | null): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[providerOf(x)]
}

/** The agent's command, for "Copy codex command only". */
export const PROVIDER_BIN: Record<ProviderId, string> = { claude: 'claude', codex: 'codex' }
