// Settings → Backup: where backups go, how often, how many to keep, the
// optional password, "Back up now", and Restore.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  ArchiveRestore,
  CircleCheck,
  DatabaseBackup,
  FolderOpen,
  FolderSync,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  RefreshCw,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  DEFAULT_KEEP,
  isBackupError,
  MAX_KEEP,
  MIN_PASSWORD,
  type BackupFolderCandidate,
  type BackupStatus,
  type RestoreAction,
  type RestorePreview,
  type SnapshotInfo
} from '@shared/backup'
import { formatBytes, formatDateTime } from '@shared/format'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Row, Section } from '../SettingsView'

const LOST_PASSWORD =
  'If you lose this password, these backups can’t be read. Nobody can recover it, not even with the app.'

function Warning({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start gap-1.5 text-xs font-medium text-warning', className)}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function ErrorLine({ error }: { error?: string }) {
  if (!error) return null
  return (
    <div className="flex items-start gap-2 text-xs text-destructive">
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      {error}
    </div>
  )
}

function DialogIcon({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
      {children}
    </div>
  )
}

/** Password + confirm + "remember on this PC", with the lost-password warning. */
function NewPassword({
  password,
  confirm,
  remember,
  canRemember,
  onChange
}: {
  password: string
  confirm: string
  remember: boolean
  canRemember: boolean
  onChange: (p: { password?: string; confirm?: string; remember?: boolean }) => void
}) {
  const short = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = confirm.length > 0 && confirm !== password
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Password</span>
        <Input
          type="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={(e) => onChange({ password: e.target.value })}
        />
        {short && (
          <span className="mt-1 block text-xs text-muted-foreground">
            At least {MIN_PASSWORD} characters. A few unrelated words make a strong one.
          </span>
        )}
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Type it again</span>
        <Input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => onChange({ confirm: e.target.value })}
        />
        {mismatch && (
          <span className="mt-1 block text-xs text-destructive">The passwords don’t match.</span>
        )}
      </label>
      <RememberBox
        remember={remember}
        canRemember={canRemember}
        onChange={(r) => onChange({ remember: r })}
      />
      <Warning>{LOST_PASSWORD}</Warning>
    </div>
  )
}

const newPasswordOk = (p: string, c: string): boolean => p.length >= MIN_PASSWORD && p === c

function RememberBox({
  remember,
  canRemember,
  onChange
}: {
  remember: boolean
  canRemember: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-border p-3',
        canRemember ? 'cursor-pointer' : 'opacity-60'
      )}
    >
      <Checkbox
        checked={remember && canRemember}
        disabled={!canRemember}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">Remember on this PC</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {canRemember
            ? 'Saved protected by your Windows account (DPAPI), so scheduled backups run without asking. Otherwise you enter it once each time the app starts.'
            : 'This PC can’t protect a saved password, so you enter it once each time the app starts.'}
        </span>
      </span>
    </label>
  )
}

function ConnectDialog({
  candidate,
  canRemember,
  onClose
}: {
  candidate: BackupFolderCandidate
  canRemember: boolean
  onClose: () => void
}) {
  const existing = candidate.existing
  const [encrypt, setEncrypt] = useState(true)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(canRemember)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Joining an encrypted set: the password can also be entered later.
  const valid = existing ? true : !encrypt || newPasswordOk(password, confirm)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const r = await api.backupConnect(candidate.folder, {
      encrypt: !existing && encrypt,
      password: password || undefined,
      remember
    })
    setBusy(false)
    if (isBackupError(r)) {
      setError(r.error)
      return
    }
    toast.success(existing ? 'Using the existing backups in this folder' : 'Backup folder set', {
      description:
        r.schedule === 'off'
          ? 'Use “Back up now” whenever you like.'
          : 'The first backup runs within a few minutes, or use “Back up now”.'
    })
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[540px]">
        <DialogHeader
          icon={
            <DialogIcon>
              <FolderSync className="size-4" />
            </DialogIcon>
          }
          title={existing ? 'Use the backups in this folder?' : 'Back up to this folder?'}
          description={
            <span className="selectable font-mono text-[11.5px] break-all">{candidate.setDir}</span>
          }
        />
        <form
          className="space-y-3 px-5 pt-3 pb-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) void submit()
          }}
        >
          {existing ? (
            <>
              <div className="rounded-lg bg-secondary/70 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                This folder already has {existing.snapshots} snapshot
                {existing.snapshots === 1 ? '' : 's'}
                {existing.createdAt ? `, started ${formatDateTime(existing.createdAt)}` : ''}
                {existing.encrypted ? ', encrypted with a password' : ''}. New backups are added
                next to them, and you can restore any of them.
              </div>
              {existing.encrypted && (
                <>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium">Backup password</span>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      value={password}
                      placeholder="Needed to back up or restore; you can also enter it later"
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                  {password && (
                    <RememberBox
                      remember={remember}
                      canRemember={canRemember}
                      onChange={setRemember}
                    />
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <div className="text-xs leading-relaxed text-muted-foreground">
                The app creates a <span className="font-mono">ClaudeSessionDashboard Backup</span>{' '}
                folder here and writes only inside it. A cloud app (OneDrive, Dropbox…) syncs it by
                itself; the app makes no network calls.
              </div>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3">
                <Checkbox
                  checked={encrypt}
                  onCheckedChange={(v) => setEncrypt(v === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    <Lock className="size-3.5" /> Encrypt with a password
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    AES-256. Recommended for a cloud folder: backups hold your full session
                    transcripts, which can include code, paths and anything you pasted.
                  </span>
                </span>
              </label>
              {encrypt && (
                <NewPassword
                  password={password}
                  confirm={confirm}
                  remember={remember}
                  canRemember={canRemember}
                  onChange={(p) => {
                    if (p.password !== undefined) setPassword(p.password)
                    if (p.confirm !== undefined) setConfirm(p.confirm)
                    if (p.remember !== undefined) setRemember(p.remember)
                  }}
                />
              )}
              {!encrypt && (
                <Warning>
                  Without a password, anyone who can open this folder can read your sessions.
                </Warning>
              )}
            </>
          )}
          <ErrorLine error={error} />
          <button type="submit" hidden />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" />} Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type PasswordMode = 'enable' | 'change' | 'unlock' | 'disable'

function PasswordDialog({
  mode,
  canRemember,
  onClose
}: {
  mode: PasswordMode
  canRemember: boolean
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(canRemember)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const valid =
    mode === 'disable'
      ? true
      : mode === 'unlock'
        ? password.length > 0
        : newPasswordOk(password, confirm)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const r =
      mode === 'unlock'
        ? await api.backupUnlock(password, remember)
        : await api.backupSetPassword(mode === 'disable' ? null : password, remember)
    setBusy(false)
    if (isBackupError(r)) {
      setError(r.error)
      return
    }
    toast.success(
      mode === 'unlock'
        ? 'Backups unlocked'
        : mode === 'disable'
          ? 'New backups won’t be encrypted'
          : mode === 'change'
            ? 'Password changed for new backups'
            : 'New backups are encrypted'
    )
    onClose()
  }
  const title = {
    enable: 'Encrypt backups with a password',
    change: 'Change the backup password',
    unlock: 'Enter the backup password',
    disable: 'Stop encrypting new backups?'
  }[mode]
  const description = {
    enable:
      'Every backup from now on is encrypted (AES-256-GCM, with a key made from your password by scrypt). Earlier snapshots stay as they are until “Keep the last” removes them.',
    change:
      'Backups from now on use the new password. Earlier snapshots still need the password they were made with, until “Keep the last” removes them. The first backup copies everything again.',
    unlock:
      'Scheduled backups of this folder are encrypted and need the password once after the app starts.',
    disable:
      'Backups from now on can be read by anyone who can open the backup folder. Encrypted snapshots stay encrypted.'
  }[mode]
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader
          icon={
            <DialogIcon>
              {mode === 'disable' ? (
                <LockOpen className="size-4" />
              ) : (
                <KeyRound className="size-4" />
              )}
            </DialogIcon>
          }
          title={title}
          description={description}
        />
        <form
          className="space-y-3 px-5 pt-3 pb-5"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) void submit()
          }}
        >
          {mode === 'unlock' && (
            <>
              <Input
                type="password"
                autoComplete="current-password"
                autoFocus
                aria-label="Backup password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <RememberBox remember={remember} canRemember={canRemember} onChange={setRemember} />
            </>
          )}
          {(mode === 'enable' || mode === 'change') && (
            <NewPassword
              password={password}
              confirm={confirm}
              remember={remember}
              canRemember={canRemember}
              onChange={(p) => {
                if (p.password !== undefined) setPassword(p.password)
                if (p.confirm !== undefined) setConfirm(p.confirm)
                if (p.remember !== undefined) setRemember(p.remember)
              }}
            />
          )}
          {mode === 'disable' && (
            <Warning>
              Your session transcripts would be stored readable in the backup folder.
            </Warning>
          )}
          <ErrorLine error={error} />
          <button type="submit" hidden />
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={mode === 'disable' ? 'destructive' : 'primary'}
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="animate-spin" />}
            {mode === 'unlock'
              ? 'Unlock'
              : mode === 'disable'
                ? 'Stop encrypting'
                : 'Save password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ACTION_LABEL: Record<RestoreAction, string> = {
  add: 'Added',
  replace: 'Replaced',
  merge: 'Merged',
  keep: 'Kept (newer here)',
  same: 'Unchanged'
}

function RestoreDialog({ onClose }: { onClose: () => void }) {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null)
  const [selected, setSelected] = useState<string>()
  const [password, setPassword] = useState('')
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<{ relaunch: boolean } | null>(null)

  useEffect(() => {
    void api.backupSnapshots().then((r) => {
      if (isBackupError(r)) setError(r.error)
      else {
        setSnapshots(r)
        setSelected(r[0]?.id)
      }
    })
  }, [])

  const choose = (id: string): void => {
    setSelected(id)
    setPreview(null)
    setPassword('')
    setError(undefined)
  }

  const look = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(undefined)
    const r = await api.backupPreview(selected, password || undefined)
    setBusy(false)
    if (isBackupError(r)) {
      // Asking for the password the first time isn't an error.
      if (!(r.needsPassword && !password)) setError(r.error)
      return
    }
    setPreview(r)
  }

  const restore = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setError(undefined)
    const r = await api.backupRestore(preview.token)
    setBusy(false)
    if (isBackupError(r)) {
      setError(r.error)
      return
    }
    setDone({ relaunch: r.relaunch })
  }

  const snap = snapshots?.find((s) => s.id === selected)

  return (
    <Dialog open onOpenChange={(o) => !o && !done && onClose()}>
      <DialogContent className="max-w-[620px]" hideClose={!!done}>
        <DialogHeader
          icon={
            <DialogIcon>
              <ArchiveRestore className="size-4" />
            </DialogIcon>
          }
          title="Restore from a backup"
          description="Restores into the app’s own data folder only, never into Claude Code’s .claude folders. The files it replaces are kept first."
        />
        <div className="space-y-3 px-5 pt-3 pb-5">
          {done ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-3 text-[13px]">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
              <span>
                {done.relaunch
                  ? 'Ready. The app restarts now to finish the restore.'
                  : 'Ready. The app closes now; start it again to finish the restore.'}
              </span>
            </div>
          ) : !preview ? (
            <>
              <div className="max-h-[260px] divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {snapshots?.map((s) => (
                  <label
                    key={s.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 px-3 py-2',
                      s.id === selected && 'bg-accent-soft/60'
                    )}
                  >
                    <input
                      type="radio"
                      name="snapshot"
                      className="accent-[var(--color-primary)]"
                      checked={s.id === selected}
                      onChange={() => choose(s.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">
                        {formatDateTime(s.createdAt)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {s.files} files · {formatBytes(s.bytes)} ·{' '}
                        {s.reason === 'manual' ? 'Back up now' : 'Scheduled'}
                        {s.appVersion ? ` · app ${s.appVersion}` : ''}
                      </span>
                    </span>
                    {s.encrypted && (
                      <Badge
                        variant="muted"
                        title={s.olderPassword ? 'Made with an older password' : 'Encrypted'}
                      >
                        <Lock /> {s.olderPassword ? 'Older password' : 'Encrypted'}
                      </Badge>
                    )}
                  </label>
                ))}
                {snapshots && snapshots.length === 0 && (
                  <div className="px-3 py-4 text-xs text-muted-foreground">
                    No complete snapshots yet.
                  </div>
                )}
                {!snapshots && !error && (
                  <div className="px-3 py-4 text-xs text-muted-foreground">
                    Reading the backup folder…
                  </div>
                )}
              </div>
              {snap?.encrypted && !snap.unlocked && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium">
                    {snap.olderPassword
                      ? 'The password this snapshot was made with'
                      : 'Backup password'}
                  </span>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void look()
                    }}
                  />
                </label>
              )}
            </>
          ) : (
            <>
              <div className="text-[13px]">
                Snapshot from{' '}
                <span className="font-medium">{formatDateTime(preview.createdAt)}</span>:{' '}
                {preview.changes === 0
                  ? 'everything here already matches it.'
                  : `${preview.changes} file${preview.changes === 1 ? '' : 's'} would change.`}
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {preview.groups.map((g) => {
                  const counts = (['add', 'replace', 'merge', 'keep', 'same'] as const)
                    .filter((a) => g[a] > 0)
                    .map((a) => `${g[a]} ${ACTION_LABEL[a].toLowerCase()}`)
                  return (
                    <div key={g.key} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[13px] font-medium">{g.label}</span>
                        <span className="text-xs text-muted-foreground">{counts.join(' · ')}</span>
                      </div>
                      {g.examples.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {g.examples.map((x) => (
                            <li
                              key={x.path}
                              className="flex gap-2 text-[11px] text-muted-foreground"
                            >
                              <span className="w-[104px] shrink-0">{ACTION_LABEL[x.action]}</span>
                              <span className="selectable truncate font-mono" title={x.path}>
                                {x.path}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </div>
              <ul className="space-y-1 rounded-lg bg-secondary/70 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                {preview.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
                <li>
                  Current versions of the files it changes are copied to{' '}
                  <span className="selectable font-mono">
                    %APPDATA%\ClaudeSessionDashboard\restore-backups\
                  </span>{' '}
                  first.
                </li>
              </ul>
            </>
          )}
          <ErrorLine error={error} />
        </div>
        {!done && (
          <DialogFooter>
            {preview && (
              <Button variant="ghost" className="mr-auto" onClick={() => setPreview(null)}>
                Back
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {!preview ? (
              <Button
                variant="primary"
                disabled={!selected || busy || (!!snap?.encrypted && !snap.unlocked && !password)}
                onClick={() => void look()}
              >
                {busy && <Loader2 className="animate-spin" />} See what would change
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy || preview.changes === 0}
                onClick={() => void restore()}
              >
                {busy && <Loader2 className="animate-spin" />} Restore and restart
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function KeepInput({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  // Remounted (key) when the saved value changes.
  const [text, setText] = useState(String(value))
  const commit = (): void => {
    const n = Math.round(Number(text))
    if (Number.isFinite(n) && n >= 1 && n <= MAX_KEEP) {
      if (n !== value) onSave(n)
    } else setText(String(value))
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={1}
        max={MAX_KEEP}
        className="w-[72px] text-right tabular-nums"
        aria-label="Snapshots to keep"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <span className="text-[13px] text-muted-foreground">snapshots</span>
    </div>
  )
}

/** The scheduler checks every 15 minutes. */
function nextLabel(iso: string): string {
  return Date.parse(iso) - Date.now() < 15 * 60_000 ? 'within a few minutes' : formatDateTime(iso)
}

function LastRun({ status }: { status: BackupStatus }) {
  const last = status.last
  if (status.running)
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Backing up
        {status.progress ? ` · ${status.progress.done} of ${status.progress.total} files` : '…'}
      </div>
    )
  if (!last) return <div className="text-xs text-muted-foreground">No backup yet.</div>
  return (
    <div className="space-y-0.5 text-xs">
      <div
        className={cn(
          'flex items-center gap-1.5',
          last.ok ? 'text-foreground' : 'text-destructive'
        )}
      >
        {last.ok ? (
          <CircleCheck className="size-3.5 text-success" />
        ) : (
          <TriangleAlert className="size-3.5" />
        )}
        <span className="font-medium">
          {last.ok ? 'Last backup' : 'Last backup failed'} · {formatDateTime(last.at)}
        </span>
      </div>
      {last.ok ? (
        <div className="text-muted-foreground">
          {last.files} files · {formatBytes(last.bytes)} ·{' '}
          {last.added
            ? `${last.added} new or changed (${formatBytes(last.addedBytes)} stored)`
            : 'nothing new to copy'}
          {last.pruned
            ? ` · ${last.pruned} old snapshot${last.pruned === 1 ? '' : 's'} removed`
            : ''}
          {last.encrypted ? ' · encrypted' : ''}
        </div>
      ) : null}
      {last.error && (
        <div className={last.ok ? 'text-warning' : 'text-destructive'}>{last.error}</div>
      )}
      {!last.ok && status.lastSuccessAt && (
        <div className="text-muted-foreground">
          Last good backup: {formatDateTime(status.lastSuccessAt)}
        </div>
      )}
    </div>
  )
}

export function BackupSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [candidate, setCandidate] = useState<BackupFolderCandidate | null>(null)
  const [pw, setPw] = useState<PasswordMode | null>(null)
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(() => {
    void api.backupStatus().then(setStatus)
  }, [])
  useEffect(() => {
    load()
    return api.onBackupChanged(load)
  }, [load])

  const pick = async (): Promise<void> => {
    const c = await api.backupPickFolder()
    if (!c) return
    if (c.error) toast.error('Can’t use that folder', { description: c.error })
    else setCandidate(c)
  }

  const runNow = async (): Promise<void> => {
    const r = await api.backupRun()
    if (r.ok)
      toast.success('Backup complete', {
        description: r.added
          ? `${r.added} new or changed file${r.added === 1 ? '' : 's'} copied`
          : 'Nothing had changed since the last backup'
      })
    else toast.error('Backup failed', { description: r.error })
  }

  const s = status
  const set = !!s?.setDir

  return (
    <Section
      id="backup"
      title="Backup"
      description="Copies the archive, your names, descriptions and tags, usage and limit history, and the app’s settings to a folder you choose, such as OneDrive or an external drive. Only new or changed files are copied. API keys are never included, and the app makes no network calls."
    >
      <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
          <DatabaseBackup className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {set
              ? s?.available
                ? `${s.snapshotCount} snapshot${s.snapshotCount === 1 ? '' : 's'}${s.setBytes != null ? ` · ${formatBytes(s.setBytes)}` : ''}`
                : 'Backup folder not available'
              : 'No backup folder yet'}
            {s?.encrypted && (
              <Badge variant="muted">
                <Lock /> Encrypted
              </Badge>
            )}
          </div>
          <div
            className="selectable truncate font-mono text-[11px] text-muted-foreground"
            title={s?.setDir}
          >
            {s?.setDir ?? 'Choose a folder to start backing up.'}
          </div>
          {s && set && !s.available && s.unavailableReason && (
            <div className="mt-0.5 text-xs text-warning">{s.unavailableReason}</div>
          )}
          {s && s.damagedCount > 0 && (
            <div className="mt-0.5 text-xs text-warning">
              {s.damagedCount} snapshot file{s.damagedCount === 1 ? '' : 's'} can’t be read yet
              (still syncing, or damaged). They’re left alone.
            </div>
          )}
        </div>
        {set && (
          <Button
            variant="outline"
            size="sm"
            disabled={!s?.available}
            onClick={() => void api.backupOpenFolder()}
          >
            <FolderOpen /> Open folder
          </Button>
        )}
        <Button variant={set ? 'ghost' : 'outline'} size="sm" onClick={() => void pick()}>
          <FolderSync /> {set ? 'Change…' : 'Choose folder…'}
        </Button>
        {set && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Stop backing up to this folder"
            title="Stop backing up to this folder (nothing in it is deleted)"
            onClick={() => void api.backupDisconnect().then(setStatus)}
          >
            <X />
          </Button>
        )}
      </div>

      {s?.locked && (
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5">
          <Lock className="size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-xs">
            <div className="font-medium text-foreground">Enter the backup password</div>
            <div className="text-muted-foreground">
              Backups to this folder are encrypted. Scheduled backups wait until you enter it.
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setPw('unlock')}>
            <KeyRound /> Enter password…
          </Button>
        </div>
      )}

      <Row
        label="Schedule"
        hint={
          s?.schedule !== 'off' && s?.nextDueAt && set
            ? `Runs while the app is open. Next: ${nextLabel(s.nextDueAt)}.`
            : 'Runs while the app is open.'
        }
      >
        <Segmented
          ariaLabel="Backup schedule"
          value={s?.schedule ?? 'daily'}
          onChange={(schedule) => void api.backupUpdate({ schedule }).then(setStatus)}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'daily', label: 'Daily' },
            { value: 'weekly', label: 'Weekly' }
          ]}
        />
      </Row>
      <Row
        label="Keep the last"
        hint={`Older snapshots are deleted from the backup folder only. Nothing else is ever deleted. Default ${DEFAULT_KEEP}.`}
      >
        <KeepInput
          key={s?.keep ?? DEFAULT_KEEP}
          value={s?.keep ?? DEFAULT_KEEP}
          onSave={(keep) => void api.backupUpdate({ keep }).then(setStatus)}
        />
      </Row>
      <div>
        <Row
          label="Password"
          hint={
            s?.encrypted
              ? s.remembered
                ? 'New backups are encrypted. The password is remembered on this PC.'
                : 'New backups are encrypted. You enter the password once after the app starts.'
              : 'Off: anyone who can open the backup folder can read your sessions.'
          }
        >
          <div className="flex items-center gap-1.5">
            {s?.encrypted ? (
              <>
                {s.remembered && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void api.backupForget().then(setStatus)}
                  >
                    Forget on this PC
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!s.available}
                  onClick={() => setPw('disable')}
                >
                  Turn off
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!s.available}
                  onClick={() => setPw('change')}
                >
                  Change…
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={!s?.available}
                onClick={() => setPw('enable')}
              >
                <Lock /> Set a password…
              </Button>
            )}
          </div>
        </Row>
        {s?.encrypted && <Warning className="mt-2">{LOST_PASSWORD}</Warning>}
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-3">
        <div className="min-w-0 flex-1">{s && <LastRun status={s} />}</div>
        <Button
          variant="outline"
          size="sm"
          disabled={!s?.available || s.running || s.locked}
          onClick={() => void runNow()}
        >
          <RefreshCw className={cn(s?.running && 'animate-spin')} /> Back up now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!s?.available || !s.snapshotCount || s.running}
          onClick={() => setRestoring(true)}
        >
          <ArchiveRestore /> Restore…
        </Button>
      </div>

      {s?.lastRestore && (
        <div className="flex items-center gap-3 rounded-lg bg-secondary/70 px-3 py-2.5 text-xs text-muted-foreground">
          <div className="min-w-0 flex-1">
            {s.lastRestore.error ? (
              <span className="text-warning">{s.lastRestore.error}</span>
            ) : (
              <>
                Restored {s.lastRestore.written} file{s.lastRestore.written === 1 ? '' : 's'} from
                the snapshot of {formatDateTime(s.lastRestore.snapshotCreatedAt)} on{' '}
                {formatDateTime(s.lastRestore.at)}.
              </>
            )}{' '}
            The files it replaced are kept in the app’s data folder.
          </div>
          <Button variant="ghost" size="sm" onClick={() => void api.backupOpenSafety()}>
            <FolderOpen /> Show
          </Button>
        </div>
      )}

      {candidate && s && (
        <ConnectDialog
          candidate={candidate}
          canRemember={s.canRemember}
          onClose={() => setCandidate(null)}
        />
      )}
      {pw && s && (
        <PasswordDialog mode={pw} canRemember={s.canRemember} onClose={() => setPw(null)} />
      )}
      {restoring && <RestoreDialog onClose={() => setRestoring(false)} />}
    </Section>
  )
}
