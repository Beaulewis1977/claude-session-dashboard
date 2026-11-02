// The providers the app knows, and which one a session, source or archive
// record belongs to. A record without a provider field is Claude Code's (all
// data written before providers existed).
//
// Providers can be turned off (Settings → Providers). A provider that's off
// is left out of all(), get() and find(): its sources aren't scanned or
// watched and its sessions aren't shown, but nothing of its data is removed
// (metadata and archive copies stay, and come back when it's turned on).

import { providerOf, type ProviderId } from '@shared/provider'
import { claudeProvider } from './claude'
import type { BaseSummary, SessionProvider } from './types'

type HasProvider = { provider?: ProviderId } | undefined | null

export class ProviderRegistry {
  private readonly byId = new Map<ProviderId, SessionProvider>()
  private off = new Set<ProviderId>()

  constructor(providers: readonly SessionProvider[]) {
    for (const p of providers) {
      if (this.byId.has(p.id)) throw new Error(`Provider ${p.id} is registered twice`)
      this.byId.set(p.id, p)
    }
    if (!this.byId.size) throw new Error('At least one provider is needed')
  }

  /** The providers that are on. */
  all(): SessionProvider[] {
    return [...this.byId.values()].filter((p) => !this.off.has(p.id))
  }

  /** Every registered provider, on or off. */
  registered(): SessionProvider[] {
    return [...this.byId.values()]
  }

  get(id: ProviderId): SessionProvider | undefined {
    return this.off.has(id) ? undefined : this.byId.get(id)
  }

  isOn(id: ProviderId): boolean {
    return this.byId.has(id) && !this.off.has(id)
  }

  /**
   * Turn providers on or off. At least one registered provider stays on.
   * Returns true if anything changed.
   */
  setEnabled(enabled: Partial<Record<ProviderId, boolean>>): boolean {
    const next = new Set<ProviderId>()
    for (const id of this.byId.keys()) if (enabled[id] === false) next.add(id)
    if (next.size >= this.byId.size) return false
    const same = next.size === this.off.size && [...next].every((id) => this.off.has(id))
    this.off = next
    return !same
  }

  /** The provider of a session, source or archive record, if this app has it (and it's on). */
  find(x: HasProvider): SessionProvider | undefined {
    return this.get(providerOf(x))
  }

  /** Like find(), for things the app itself found (their provider is always known and on). */
  of(x: HasProvider): SessionProvider {
    const p = this.find(x)
    if (!p) throw new Error(`Unknown provider: ${providerOf(x)}`)
    return p
  }
}

/** Claude Code only: the app as it was before Codex (tests and the parity snapshot). */
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
