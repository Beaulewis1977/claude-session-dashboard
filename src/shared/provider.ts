// Which coding agent a session belongs to. Claude Code is the only provider
// so far; Codex comes later (docs/ROADMAP.md, feature 5). Data written before
// providers existed has no provider field and means Claude Code.

export type ProviderId = 'claude' | 'codex'

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex']

/** What a missing provider field means (everything stored before providers). */
export const DEFAULT_PROVIDER: ProviderId = 'claude'

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v)
}

/** The provider of a session, source or archive record (absent: Claude Code). */
export function providerOf(x: { provider?: ProviderId } | undefined | null): ProviderId {
  return x?.provider ?? DEFAULT_PROVIDER
}
