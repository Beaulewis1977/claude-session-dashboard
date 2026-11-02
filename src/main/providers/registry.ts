// The providers the app knows, and which one a session, source or archive
// record belongs to. A record without a provider field is Claude Code's (all
// data written before providers existed).

import { providerOf, type ProviderId } from '@shared/provider'
import { claudeProvider } from './claude'
import type { BaseSummary, SessionProvider } from './types'

type HasProvider = { provider?: ProviderId } | undefined | null

export class ProviderRegistry {
  private readonly byId = new Map<ProviderId, SessionProvider>()

  constructor(providers: readonly SessionProvider[]) {
    for (const p of providers) {
      if (this.byId.has(p.id)) throw new Error(`Provider ${p.id} is registered twice`)
      this.byId.set(p.id, p)
    }
    if (!this.byId.size) throw new Error('At least one provider is needed')
  }

  all(): SessionProvider[] {
    return [...this.byId.values()]
  }

  get(id: ProviderId): SessionProvider | undefined {
    return this.byId.get(id)
  }

  /** The provider of a session, source or archive record, if this app has it. */
  find(x: HasProvider): SessionProvider | undefined {
    return this.byId.get(providerOf(x))
  }

  /** Like find(), for things the app itself found (their provider is always known). */
  of(x: HasProvider): SessionProvider {
    const p = this.find(x)
    if (!p) throw new Error(`Unknown provider: ${providerOf(x)}`)
    return p
  }
}

/** Claude Code only: the app as it is today. */
export function defaultProviders(): ProviderRegistry {
  return new ProviderRegistry([claudeProvider])
}

let fallback: ProviderRegistry | undefined

/**
 * The providers of a catalogue. Stand-ins for the catalogue (in tests) that
 * have none get the default: Claude Code only.
 */
export function catalogueProviders(sessions: { providers?: ProviderRegistry }): ProviderRegistry {
  return sessions.providers ?? (fallback ??= defaultProviders())
}

/** A session's provider, from the catalogue (or its own field, for stand-ins). */
export function sessionProvider(
  sessions: {
    providers?: ProviderRegistry
    providerOf?: (base: Pick<BaseSummary, 'key' | 'sourceId'>) => SessionProvider
  },
  s: Pick<BaseSummary, 'key' | 'sourceId'> & { provider?: ProviderId }
): SessionProvider {
  return typeof sessions.providerOf === 'function'
    ? sessions.providerOf(s)
    : catalogueProviders(sessions).of(s)
}
