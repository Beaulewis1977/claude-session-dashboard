// What a paired phone may call: an allow-list of the desktop app's own IPC
// handlers, with their arguments narrowed further. Everything not listed here
// (dialogs, folders, API keys, the status line bridge, Ask Claude, writing
// summaries, archive import, the mobile server's own settings…) is
// unreachable from a phone.

import type {
  AppInfo,
  AppSettings,
  SessionDetail,
  SessionMeta,
  SessionsPayload,
  SessionSummary,
  SourceInfo
} from '@shared/types'
import type { LimitsState } from '@shared/usage/limits'
import type { CreditsState } from '@shared/usage/credits'
import { MOBILE_SAFE_SETTINGS } from '@shared/mobile'
import type { LiveSnapshot } from '@shared/live'
import type { SessionGitView } from '@shared/git/types'

export type RpcKind = 'read' | 'write'

export interface RpcMethod {
  channel: string
  /** Writes are refused in read-only mode, rate-limited and logged. */
  kind: RpcKind
  args(raw: unknown[]): unknown[]
  result?(r: unknown): unknown
}

const str = (v: unknown, max = 1000): string => {
  if (typeof v !== 'string') throw new Error('Expected a string')
  return v.slice(0, max)
}

/** The fields a phone may edit: name, description, tags, pinned, hidden, alert mute, the large-context warning, launch model, effort and fast mode. */
export function phoneMetaPatch(v: unknown): Partial<SessionMeta> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Partial<SessionMeta> = {}
  if ('name' in o) out.name = typeof o.name === 'string' ? o.name : undefined
  if ('description' in o)
    out.description = typeof o.description === 'string' ? o.description : undefined
  if ('tags' in o && Array.isArray(o.tags))
    out.tags = o.tags.filter((t): t is string => typeof t === 'string').slice(0, 50)
  if ('pinned' in o) out.pinned = o.pinned === true
  if ('hidden' in o) out.hidden = o.hidden === true
  if ('muteAlerts' in o) out.muteAlerts = o.muteAlerts === true
  if ('noContextWarning' in o) out.noContextWarning = o.noContextWarning === true
  // Validated (or cleared) by cleanMetaPatch like the desktop's own edits.
  if ('model' in o) out.model = typeof o.model === 'string' ? o.model.slice(0, 200) : undefined
  if ('effort' in o)
    out.effort = typeof o.effort === 'string' ? (o.effort as SessionMeta['effort']) : undefined
  if ('fast' in o)
    out.fast = typeof o.fast === 'string' ? (o.fast as SessionMeta['fast']) : undefined
  return out
}

/** A summary edited on a phone: its text fields only (cleaned again on the PC). */
export function phoneSummaryPatch(v: unknown): Record<string, unknown> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const list = (x: unknown): string[] | undefined =>
    Array.isArray(x)
      ? x
          .filter((t): t is string => typeof t === 'string')
          .slice(0, 40)
          .map((t) => t.slice(0, 600))
      : undefined
  if (typeof o.title === 'string') out.title = o.title.slice(0, 200)
  if (typeof o.pickUp === 'string') out.pickUp = o.pickUp.slice(0, 2000)
  for (const k of ['done', 'files', 'decisions', 'todos'] as const) {
    const l = list(o[k])
    if (l) out[k] = l
  }
  return out
}

/** Only the settings on MOBILE_SAFE_SETTINGS; the main handler validates their values. */
export function phoneSettingsPatch(v: unknown): Partial<AppSettings> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of MOBILE_SAFE_SETTINGS) if (k in o) out[k] = o[k]
  return out as Partial<AppSettings>
}

const none = (): unknown[] => []

// What a phone gets back: the session's own project folder (cwd), which it
// shows, but not where the PC keeps files (session files, the archive,
// Claude's settings, extra scan folders) or how the status line is installed.

export function phoneSession(s: SessionSummary): SessionSummary {
  return { ...s, filePath: '', originalPath: '', archivePath: undefined }
}

function phoneSource(s: SourceInfo): SourceInfo {
  return { ...s, projectsDir: '', claudeSettingsPath: undefined }
}

/** A session's git links as a phone sees them: no remote URL (it may name a private server). */
export function phoneGitView(v: SessionGitView): SessionGitView {
  return { ...v, ...(v.repo ? { repo: { ...v.repo, remote: undefined } } : {}) }
}

export function phoneSessions(p: SessionsPayload): SessionsPayload {
  return { ...p, sessions: p.sessions.map(phoneSession), sources: p.sources.map(phoneSource) }
}

export function phoneSettings(s: AppSettings): AppSettings {
  return { ...s, extraFolders: [], projectBilling: {} }
}

export function phoneLimits(l: LimitsState): LimitsState {
  return {
    ...l,
    envs: l.envs.map((e) => ({ ...e, settingsPath: '', bridgeDir: '', chained: undefined }))
  }
}

/** Running now, without where settings.json lives on the PC. */
export function phoneLive(s: LiveSnapshot): LiveSnapshot {
  return { ...s, hooks: s.hooks.map((h) => ({ ...h, settingsPath: '' })) }
}

export const RPC: Record<string, RpcMethod> = {
  getInfo: {
    channel: 'app:info',
    kind: 'read',
    args: none,
    // Folder locations on the PC aren't the phone's business.
    result: (r) => ({ ...(r as AppInfo), dataDir: '', archiveDir: '' })
  },
  getSessions: {
    channel: 'sessions:list',
    kind: 'read',
    args: none,
    result: (r) => phoneSessions(r as SessionsPayload)
  },
  getSession: {
    channel: 'sessions:get',
    kind: 'read',
    args: ([k]) => [str(k, 300)],
    result: (r) => {
      const d = r as SessionDetail | null
      return d ? { ...d, summary: phoneSession(d.summary) } : null
    }
  },
  search: { channel: 'sessions:search', kind: 'read', args: ([q]) => [str(q, 500)] },
  // Git links: commits, files and PR links (read-only; diffs, unlinking and the gh setting are PC-only).
  getGitLinks: {
    channel: 'git:session',
    kind: 'read',
    args: ([k]) => [str(k, 300)],
    result: (r) => (r ? phoneGitView(r as SessionGitView) : r)
  },
  updateMeta: {
    channel: 'sessions:updateMeta',
    kind: 'write',
    args: ([k, p]) => [str(k, 300), phoneMetaPatch(p)],
    result: (r) => (r ? phoneSession(r as SessionSummary) : r)
  },
  // Edit a session's summary (text only). Writing or removing one is PC-only.
  saveSummary: {
    channel: 'summaries:save',
    kind: 'write',
    args: ([k, p]) => [str(k, 300), phoneSummaryPatch(p)],
    result: (r) => (r ? phoneSession(r as SessionSummary) : r)
  },
  getSettings: {
    channel: 'settings:get',
    kind: 'read',
    args: none,
    result: (r) => phoneSettings(r as AppSettings)
  },
  updateSettings: {
    channel: 'settings:update',
    kind: 'write',
    args: ([p]) => [phoneSettingsPatch(p)],
    result: (r) => phoneSettings(r as AppSettings)
  },
  // Which Codex models offer fast mode (model names only), for the Fast picker.
  getFastModels: { channel: 'launch:fastModels', kind: 'read', args: none },
  getUsageReport: { channel: 'usage:report', kind: 'read', args: ([q]) => [q] },
  getSessionUsage: { channel: 'usage:session', kind: 'read', args: ([k]) => [str(k, 300)] },
  // Priced as the phone launches: always on the subscription.
  getContextEstimate: {
    channel: 'context:estimate',
    kind: 'read',
    args: ([k]) => [str(k, 300), { phone: true }]
  },
  getUsageStatus: { channel: 'usage:status', kind: 'read', args: none },
  getTrends: { channel: 'usage:trends', kind: 'read', args: ([g]) => [g] },
  compareTrends: { channel: 'usage:compare', kind: 'read', args: ([a, b]) => [a, b] },
  getCodexTrends: { channel: 'usage:codexTrends', kind: 'read', args: ([g]) => [g] },
  compareCodexTrends: {
    channel: 'usage:codexCompare',
    kind: 'read',
    args: ([a, b]) => [a, b]
  },
  getSpeedTrends: { channel: 'usage:speedTrends', kind: 'read', args: none },
  getSpeedSignal: { channel: 'usage:speedSignal', kind: 'read', args: ([v]) => [str(v, 10)] },
  getLimits: {
    channel: 'limits:state',
    kind: 'read',
    args: none,
    result: (r) => phoneLimits(r as LimitsState)
  },
  compareHealth: {
    channel: 'limits:compareHealth',
    kind: 'read',
    args: ([k, a, b]) => [k, a, b]
  },
  // Codex's limits come from its logs: nothing about the PC's files in them.
  getCodexLimits: { channel: 'codexLimits:state', kind: 'read', args: none },
  compareCodexHealth: {
    channel: 'codexLimits:compareHealth',
    kind: 'read',
    args: ([k, a, b]) => [k, a, b]
  },
  // Terminal access: where the phone's SSH app connects (host, user, port,
  // shell), and whether it's set up. Never the setup itself.
  getTerminalAccess: { channel: 'terminal:phoneInfo', kind: 'read', args: none },
  // Running now: the same list as the desktop's (no settings.json locations).
  // Never the hook setup. (A tapped push alert is resolved by /api/live/resolve.)
  getLive: {
    channel: 'live:state',
    kind: 'read',
    args: none,
    result: (r) => phoneLive(r as LiveSnapshot)
  },
  // Ask across sessions: past answers, local answers (worked out on the PC,
  // nothing sent), and how this phone's own question is doing. A content
  // question goes to /api/ask (a write), and waits for my OK on the PC.
  askHistory: { channel: 'askSessions:history', kind: 'read', args: none },
  askLocal: { channel: 'askSessions:phoneLocal', kind: 'read', args: ([q]) => [str(q, 1000)] },
  askStatus: {
    channel: 'askSessions:status',
    kind: 'read',
    args: none,
    // Whether content questions are on, and how big the index is: nothing about the PC's folders.
    result: (r) => {
      const s = r as { enabled: boolean; phase: string; sessions: number; passages: number }
      return { enabled: s.enabled, phase: s.phase, sessions: s.sessions, passages: s.passages }
    }
  },
  askRequestStatus: {
    channel: 'askSessions:phoneStatus',
    kind: 'read',
    args: ([i]) => [str(i, 64)]
  },
  getCredits: {
    channel: 'credits:state',
    kind: 'read',
    // Not even the last characters of an API key leave the PC.
    result: (r) => {
      const c = r as CreditsState
      return { ...c, accounts: c.accounts.map((a) => ({ ...a, masked: '' })) }
    },
    args: none
  }
}

export function rpcMethod(name: unknown): RpcMethod | undefined {
  return typeof name === 'string' && Object.hasOwn(RPC, name) ? RPC[name] : undefined
}
