import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ArchiveRestore,
  Check,
  Copy,
  FolderOpen,
  GitFork,
  Info,
  Loader2,
  Play,
  TriangleAlert
} from 'lucide-react'
import type { LaunchPreview, TerminalPref } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from './ui/dialog'
import { Kbd } from './ui/kbd'
import { Segmented } from './ui/segmented'

export const SKIP_WARNING = 'Claude will not ask before running commands or deleting files.'

const TERMINAL_LABEL: Record<TerminalPref, string> = {
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: 'Command Prompt'
}

export function SkipPermissionsWarning({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-1.5 text-xs font-medium text-warning', className)}>
      <TriangleAlert className="size-3.5 shrink-0" />
      {SKIP_WARNING}
    </div>
  )
}

export function ResumeDialog() {
  const resume = useApp((s) => s.resume)
  if (!resume) return null
  return <ResumeDialogBody key={`${resume.key}:${resume.fork}`} resume={resume} />
}

function ResumeDialogBody({ resume }: { resume: { key: string; fork: boolean } }) {
  const sessions = useApp((s) => s.sessions)
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const set = useApp((s) => s.set)
  const session = sessions.find((s) => s.key === resume.key)

  const [skip, setSkip] = useState(settings.skipPermissionsDefault)
  const [terminal, setTerminal] = useState<TerminalPref>(settings.terminal)
  const [cwdOverride, setCwdOverride] = useState<string | undefined>()
  const [preview, setPreview] = useState<LaunchPreview | null>(null)
  const [launching, setLaunching] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .previewLaunch({
        key: resume.key,
        fork: resume.fork,
        skipPermissions: skip,
        cwdOverride,
        terminal
      })
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) =>
        toast.error('Could not prepare the command', { description: err.message })
      )
    return () => {
      cancelled = true
    }
  }, [resume, skip, cwdOverride, terminal, session?.availability])

  const close = (): void => set({ resume: null })
  if (!session) return null
  const fork = resume.fork
  const blocked = !preview || !preview.cwd || !preview.cwdExists || preview.restoreImpossible

  const launch = async (): Promise<void> => {
    if (blocked || launching) return
    setLaunching(true)
    const res = await api.launch({
      key: resume.key,
      fork,
      skipPermissions: skip,
      cwdOverride,
      terminal
    })
    setLaunching(false)
    if (!res.ok) {
      toast.error(fork ? 'Could not fork the session' : 'Could not resume the session', {
        description: res.error
      })
      return
    }
    close()
    if (res.restored) toast.success('Restored the session file from the archive')
    if (res.simulated) {
      toast(info?.fixtures ? 'Fixtures mode: command not run' : 'Launching only works on Windows', {
        description: res.commandLine,
        action: { label: 'Copy', onClick: () => void api.copyText(res.commandLine) }
      })
    } else {
      toast.success(fork ? 'Forked in a new terminal' : 'Resumed in a new terminal', {
        description: TERMINAL_LABEL[preview?.terminal ?? terminal]
      })
    }
  }

  const pickFolder = async (): Promise<void> => {
    const picked = await api.pickCwd(session.key)
    if (picked) setCwdOverride(picked)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="max-w-[560px]"
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName !== 'BUTTON')
          ) {
            e.preventDefault()
            void launch()
          }
        }}
      >
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              {fork ? <GitFork className="size-4" /> : <Play className="size-4 fill-current" />}
            </div>
          }
          title={fork ? 'Fork session' : 'Resume session'}
          description={
            <span className="line-clamp-1 text-foreground/80" title={session.title}>
              {session.title}
            </span>
          }
        />

        <div className="space-y-4 px-5 pt-3 pb-5">
          {fork && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Starts a new session that continues from this conversation. The original session stays
              untouched.
            </p>
          )}

          {preview?.willRestore && (
            <div className="flex items-start gap-2.5 rounded-lg border border-info/25 bg-info/5 px-3 py-2.5 text-xs">
              <ArchiveRestore className="mt-px size-4 shrink-0 text-info" />
              <div className="min-w-0">
                <div className="font-medium text-foreground">
                  The session file will be restored from the archive first
                </div>
                <div
                  className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                  title={preview.originalPath}
                >
                  {preview.originalPath}
                </div>
              </div>
            </div>
          )}
          {preview?.restoreImpossible && (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
              <TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
              The session file is missing and there is no archive copy, so it can't be resumed.
            </div>
          )}

          <div>
            <div className="mb-1.5 text-xs font-medium">Working folder</div>
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2',
                preview && !preview.cwdExists
                  ? 'border-warning/40 bg-warning-soft'
                  : 'border-border bg-secondary/60'
              )}
            >
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span
                className="selectable min-w-0 flex-1 truncate font-mono text-[12px]"
                title={preview?.cwd}
              >
                {preview?.cwd ?? session.cwd ?? 'Unknown'}
              </span>
              {preview && preview.cwdExists && (
                <Check className="size-4 shrink-0 text-success" aria-label="Folder exists" />
              )}
              <Button variant="outline" size="xs" onClick={() => void pickFolder()}>
                {cwdOverride ? 'Change…' : 'Choose…'}
              </Button>
            </div>
            {preview && !preview.cwdExists && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-warning">
                <TriangleAlert className="size-3.5" />
                {preview.cwd
                  ? 'This folder no longer exists. Choose another folder to continue.'
                  : 'No working folder is recorded. Choose one to continue.'}
              </div>
            )}
            {cwdOverride && (
              <div className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                Claude Code looks sessions up by project folder, so resuming from a different folder
                may not find it.
                <button
                  type="button"
                  className="shrink-0 font-medium text-primary hover:underline"
                  onClick={() => setCwdOverride(undefined)}
                >
                  Reset
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium">Open in</div>
            <Segmented
              ariaLabel="Terminal"
              value={terminal}
              onChange={setTerminal}
              options={[
                { value: 'wt', label: 'Windows Terminal' },
                { value: 'powershell', label: 'PowerShell' },
                { value: 'cmd', label: 'cmd' }
              ]}
            />
            {preview?.fellBack && (
              <div className="mt-1.5 text-xs text-muted-foreground">
                Windows Terminal wasn't found, so PowerShell will be used.
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border p-3">
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={skip}
                onCheckedChange={(v) => setSkip(v === true)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">Skip permission prompts</span>
                <span className="block font-mono text-[11px] text-muted-foreground">
                  --dangerously-skip-permissions
                </span>
              </span>
            </label>
            {skip && <SkipPermissionsWarning className="mt-2 pl-[26px]" />}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium">Command</span>
              <button
                type="button"
                onClick={() => {
                  if (!preview) return
                  void api.copyText(preview.commandLine)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                }}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="selectable max-h-28 overflow-auto rounded-lg border border-code-border bg-code-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-foreground/90">
              {preview?.commandLine ?? '…'}
            </pre>
          </div>
        </div>

        <DialogFooter>
          {info?.fixtures && (
            <span className="mr-auto text-2xs text-subtle-foreground">
              Fixtures mode: nothing will be launched
            </span>
          )}
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void launch()}
            disabled={blocked || launching}
            autoFocus
          >
            {launching ? (
              <Loader2 className="animate-spin" />
            ) : fork ? (
              <GitFork />
            ) : (
              <Play className="fill-current" />
            )}
            {fork ? 'Fork' : 'Resume'}
            <Kbd className="ml-1 border-white/25 bg-white/15 text-primary-foreground">↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
