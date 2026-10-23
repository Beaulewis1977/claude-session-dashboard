// The app's own persistent data: user metadata, archive records and settings.

import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ArchiveRecord,
  type SessionMeta
} from '@shared/types'
import { JsonStore } from '../core/json-store'
import { isSourceLabel } from '@shared/source-label'

export interface MetadataFile {
  version: 1
  /** Keyed by session id. */
  sessions: Record<string, SessionMeta>
  /** Keyed by `${sourceId}:${sessionId}`. */
  archive: Record<string, ArchiveRecord>
}

export interface SettingsFile extends AppSettings {
  window?: { width: number; height: number; x?: number; y?: number; maximized?: boolean }
  /** The always-on-top mini meter: open or not, and where. */
  miniMeter?: { open?: boolean; x?: number; y?: number }
}

export interface AppPaths {
  dataDir: string
  archiveDir: string
  metadataFile: string
  settingsFile: string
}

export function appPaths(dataDir: string): AppPaths {
  return {
    dataDir,
    archiveDir: join(dataDir, 'archive'),
    metadataFile: join(dataDir, 'metadata.json'),
    settingsFile: join(dataDir, 'settings.json')
  }
}

export function createMetadataStore(paths: AppPaths): JsonStore<MetadataFile> {
  return new JsonStore<MetadataFile>(paths.metadataFile, paths.dataDir, () => ({
    version: 1,
    sessions: {},
    archive: {}
  }))
}

export function createSettingsStore(paths: AppPaths): JsonStore<SettingsFile> {
  return new JsonStore<SettingsFile>(paths.settingsFile, paths.dataDir, () => ({
    ...DEFAULT_SETTINGS,
    extraFolders: [],
    prices: DEFAULT_SETTINGS.prices.map((p) => ({ ...p }))
  }))
}

/** Normalise a metadata patch from the renderer. */
export function cleanMetaPatch(patch: Partial<SessionMeta>): Partial<SessionMeta> {
  const out: Partial<SessionMeta> = {}
  if ('name' in patch)
    out.name = typeof patch.name === 'string' ? patch.name.trim().slice(0, 300) : undefined
  if ('description' in patch)
    out.description =
      typeof patch.description === 'string'
        ? patch.description.replace(/\s+$/, '').slice(0, 20_000)
        : undefined
  if ('tags' in patch && Array.isArray(patch.tags)) {
    const seen = new Set<string>()
    out.tags = patch.tags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().replace(/\s+/g, '-').toLowerCase().slice(0, 40))
      .filter((t) => t && !seen.has(t) && seen.add(t))
  }
  if ('hidden' in patch) out.hidden = patch.hidden === true
  if ('billing' in patch) {
    const b = patch.billing as Record<string, unknown> | undefined | null
    out.billing =
      b && (b.mode === 'subscription' || b.mode === 'api')
        ? {
            mode: b.mode,
            accountId:
              b.mode === 'api' && typeof b.accountId === 'string' ? b.accountId : undefined,
            source: b.source === 'launch' ? 'launch' : 'manual',
            at: typeof b.at === 'string' ? b.at : new Date().toISOString()
          }
        : undefined
  }
  if ('source' in patch) {
    // A label picked by hand; null/undefined goes back to the detected one.
    const v = patch.source as { label?: unknown } | undefined | null
    out.source =
      v && isSourceLabel(v.label)
        ? { label: v.label, by: 'manual', reason: 'Set by hand' }
        : undefined
  }
  return out
}
