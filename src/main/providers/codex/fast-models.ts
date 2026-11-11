// Which Codex models offer fast mode, from Codex's own model list:
// `<CODEX_HOME>/models_cache.json` (read only, never written; nothing else in
// the home is opened for this). Each model there lists the tiers it offers:
//   "service_tiers": [{ "id": "priority", "name": "Fast", … }]
//   "additional_speed_tiers": ["fast"]
// (codex-cli 0.166). Only homes whose sessions were read in this scan are
// looked at, so a stopped WSL distro is never started for it.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const MODELS_CACHE = 'models_cache.json'
/** Codex's list is ~100 KB; anything far bigger isn't it. */
const MAX_BYTES = 8 * 1024 * 1024

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/

/** The models in a parsed models_cache.json that offer the Fast tier (undefined: not that file's shape). */
export function fastModelsFrom(json: unknown): string[] | undefined {
  const models = (json as { models?: unknown } | null)?.models
  if (!Array.isArray(models)) return undefined
  const out = new Set<string>()
  for (const m of models) {
    if (!m || typeof m !== 'object') continue
    const r = m as Record<string, unknown>
    const slug = typeof r.slug === 'string' ? r.slug : typeof r.id === 'string' ? r.id : undefined
    if (!slug || !SLUG_RE.test(slug)) continue
    const tiers = Array.isArray(r.service_tiers) ? r.service_tiers : []
    const speed = Array.isArray(r.additional_speed_tiers) ? r.additional_speed_tiers : []
    const fast =
      tiers.some((t) => {
        const o = (t ?? {}) as Record<string, unknown>
        return (
          o.id === 'priority' || (typeof o.name === 'string' && o.name.toLowerCase() === 'fast')
        )
      }) || speed.includes('fast')
    if (fast) out.add(slug)
  }
  return [...out].sort()
}

interface Cached {
  sig: string
  models?: string[]
}

/**
 * The Fast models of every Codex home given (one account's homes list the
 * same models; the union is used). Null when no home's list could be read:
 * then the app can't tell, and shows Fast with a note instead of hiding it.
 */
export class CodexFastModels {
  private cache = new Map<string, Cached>()
  private last: string[] | null = null

  constructor(private readonly homes: () => string[]) {}

  /** The last answer, without reading anything. */
  latest(): string[] | null {
    return this.last
  }

  async get(): Promise<string[] | null> {
    const all = new Set<string>()
    let any = false
    for (const home of new Set(this.homes())) {
      const models = await this.read(join(home, MODELS_CACHE))
      if (!models) continue
      any = true
      for (const m of models) all.add(m)
    }
    this.last = any ? [...all].sort() : null
    return this.last
  }

  private async read(path: string): Promise<string[] | undefined> {
    try {
      const st = await stat(path)
      if (!st.isFile() || st.size > MAX_BYTES) return undefined
      const sig = `${st.size}:${st.mtimeMs}`
      const hit = this.cache.get(path)
      if (hit?.sig === sig) return hit.models
      const models = fastModelsFrom(JSON.parse(await readFile(path, 'utf8')))
      this.cache.set(path, { sig, models })
      return models
    } catch {
      return undefined
    }
  }
}
