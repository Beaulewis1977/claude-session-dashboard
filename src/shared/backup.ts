// Backups of the app's own data (Settings → Backup): shared types.
//
// A backup set lives in one folder the user picks (OneDrive, an external drive,
// a NAS share). The app only writes inside that set's own subfolder and makes
// no network calls; any cloud app syncs the folder by itself.

export type BackupSchedule = 'off' | 'daily' | 'weekly'

export const BACKUP_SCHEDULES: BackupSchedule[] = ['off', 'daily', 'weekly']
export const DEFAULT_KEEP = 14
export const MAX_KEEP = 365
export const MIN_PASSWORD = 8

/** The subfolder created inside the folder the user picks. */
export const BACKUP_SET_DIR = 'ClaudeSessionDashboard Backup'

export type BackupReason = 'scheduled' | 'manual'

export interface BackupRunSummary {
  at: string
  ok: boolean
  reason: BackupReason
  snapshotId?: string
  error?: string
  /** Files in the snapshot. */
  files: number
  /** Their total size (uncompressed). */
  bytes: number
  /** Files whose content wasn't in the backup folder yet (so were copied). */
  added: number
  /** What those took up in the backup folder (compressed, encrypted). */
  addedBytes: number
  durationMs: number
  /** Old snapshots removed by "Keep the last N". */
  pruned?: number
  encrypted?: boolean
}

export interface BackupStatus {
  /** The folder the user picked (the set itself is `setDir`). */
  destination?: string
  setDir?: string
  /** The set can be read and written right now (the drive is there). */
  available: boolean
  unavailableReason?: string
  schedule: BackupSchedule
  keep: number
  /** New snapshots are encrypted with a password. */
  encrypted: boolean
  /** Encrypted, and the password is needed (not entered since the app started, not remembered). */
  locked: boolean
  /**
   * The set was encrypted and now says it isn't, without this app doing it:
   * backups are paused until a password is set again or "no password" is chosen.
   */
  downgraded?: boolean
  /** The password is remembered on this PC (Electron safeStorage). */
  remembered: boolean
  /** safeStorage can protect a remembered password here. */
  canRemember: boolean
  running: boolean
  progress?: { done: number; total: number }
  last?: BackupRunSummary
  lastSuccessAt?: string
  /** When the next scheduled backup is due (it runs while the app is open). */
  nextDueAt?: string
  snapshotCount: number
  /** Snapshots that couldn't be read (still being synced, or damaged). */
  damagedCount: number
  setBytes?: number
  lastRestore?: RestoreRecord
}

export interface SnapshotInfo {
  id: string
  createdAt: string
  reason: BackupReason
  appVersion?: string
  files: number
  bytes: number
  encrypted: boolean
  /** Encrypted with a password other than the current one. */
  olderPassword: boolean
  /** The app can decrypt it right now (plain, or the password is known). */
  unlocked: boolean
}

/** A folder the user picked: what's in it already. */
export interface BackupFolderCandidate {
  folder: string
  setDir: string
  /** An existing backup set was found there. */
  existing?: { snapshots: number; encrypted: boolean; createdAt?: string }
  error?: string
}

export type RestoreAction = 'add' | 'replace' | 'merge' | 'keep' | 'same'

export interface RestoreGroup {
  key: string
  label: string
  /** Counts per action. */
  add: number
  replace: number
  merge: number
  keep: number
  same: number
  /** A few examples of the files that change. */
  examples: { path: string; action: RestoreAction; note?: string }[]
}

export interface RestorePreview {
  token: string
  snapshotId: string
  createdAt: string
  groups: RestoreGroup[]
  /** Files that will be written (add + replace + merge). */
  changes: number
  /** The current versions of those files are moved here first (inside the app's data folder). */
  safetyDir: string
  notes: string[]
}

export interface RestoreRecord {
  at: string
  snapshotId: string
  snapshotCreatedAt: string
  written: number
  safetyDir: string
  error?: string
}

export type BackupError = { error: string; needsPassword?: boolean }

export const isBackupError = (v: unknown): v is BackupError =>
  !!v && typeof v === 'object' && typeof (v as BackupError).error === 'string'
