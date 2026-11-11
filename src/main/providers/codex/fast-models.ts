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

/** A Codex source (its id) and the home whose model list it uses. */
export interface CodexHomeRef {
  sourceId: string
  home: string
}

/**
 * Per Codex source, the Fast models of its own home's list. Null for a home
 * whose list can't be read: then the app can't tell for that home's sessions
 * and shows Fast with a note instead of hiding it. Another home's list is
 * never used in its place (homes can run different Codex versions or accounts).
 */
export type CodexFastBySource = Record<string, string[] | null>

export class CodexFastModels {
  private cache = new Map<string, Cached>()
  private last: CodexFastBySource | null = null

  constructor(private readonly homes: () => CodexHomeRef[]) {}

  /** The last answer, without reading anything (null: not read yet). */
  latest(): CodexFastBySource | null {
    return this.last
  }

  async get(): Promise<CodexFastBySource> {
    const out: CodexFastBySource = {}
    for (const { sourceId, home } of this.homes())
      out[sourceId] = (await this.read(join(home, MODELS_CACHE))) ?? null
    this.last = out
    return out
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
