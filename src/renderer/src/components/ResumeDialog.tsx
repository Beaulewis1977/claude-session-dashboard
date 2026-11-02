import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArchiveRestore,
  Check,
  Copy,
  FolderOpen,
  GitBranchPlus,
  GitFork,
  Info,
  Loader2,
  Play,
  Plus,
  Smartphone,
  TriangleAlert
} from 'lucide-react'
import { ContinueFreshCard, ContinueIcon } from './summary/ContinueFreshCard'
import type { LaunchPreview, TerminalPref } from '@shared/types'
import { api } from '@/lib/api'
import { showNewSession } from '@/lib/actions'
import { launchesOnEnter } from '@/lib/dialog-keys'
import { useApp, type BranchTarget } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from './ui/dialog'
import { Kbd } from './ui/kbd'
import { Segmented } from './ui/segmented'
import { Tooltip } from './ui/tooltip'
import { validBilling } from '@/lib/billing'
import { BillingPicker } from './BillingPicker'
import { BranchPointCard } from './viewer/Branches'
import { SessionModelControls } from './ModelPicker'
import { choiceLabel } from '@shared/model-choice'
import { projectDefault, projectDefaultKey, withProjectDefault } from '@shared/project-key'

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

/** The Remote Control checkbox of the launch dialog. */
export function RemoteControlOption({
  checked,
  onChange,
  name
}: {
  checked: boolean
  onChange: (v: boolean) => void
  name?: string
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[13px] font-medium">
            <Smartphone className="size-3.5 text-info" /> Remote Control
          </span>
          <span className="block text-xs leading-relaxed text-muted-foreground">
            Continue this session from the Claude app on your phone or at claude.ai/code. Uses your
            Claude subscription.
          </span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            --remote-control{checked && name ? ` "${name}"` : ''}
          </span>
        </span>
      </label>
    </div>
  )
}

export function ResumeDialog() {
  const resume = useApp((s) => s.resume)
  if (!resume) return null
  return (
    <ResumeDialogBody
      key={`${resume.key}:${resume.fork}:${!!resume.newSession}:${!!resume.continueFresh}:${resume.branch?.at}:${resume.branch?.mode}`}
      resume={resume}
    />
  )
}

function ResumeDialogBody({
  resume
}: {
  resume: {
    key: string
    fork: boolean
    newSession?: boolean
    branch?: BranchTarget
    continueFresh?: boolean
  }
}) {
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
  const accounts = useApp((s) => s.credits?.accounts) ?? []
  // Same project keys as the model defaults: WSL by distro and exact path.
  const projectKey = projectDefaultKey(session)
  const projectBillingNow = projectDefault(settings.projectBilling, session)
  const [billing, setBilling] = useState(() =>
    validBilling(projectBillingNow ?? settings.defaultBilling, accounts)
  )
  const [rememberProject, setRememberProject] = useState(() => projectBillingNow !== undefined)
  // Remote Control runs only on the subscription: turning one on turns the other off.
  const [remoteControl, setRemoteControlState] = useState(
    () => settings.remoteControlDefault && billing === 'subscription'
  )
  const setRemoteControl = (on: boolean): void => {
    setRemoteControlState(on)
    if (on) setBilling('subscription')
  }
  const pickBilling = (v: string): void => {
    setBilling(v)
    if (v !== 'subscription') setRemoteControlState(false)
  }
  const billingAccountId = billing === 'subscription' ? undefined : billing
  const newSession = resume.newSession === true
  const branchAt = resume.branch
  // Keep the new session id stable across previews, so the copied command matches.
  const branchId = useRef<string | undefined>(undefined)
  const continueFresh = resume.continueFresh === true
  // The new session's id, kept across previews like a branch's.
  const continueId = useRef<string | undefined>(undefined)
  const continueReq = () => (continueFresh ? { newSessionId: continueId.current } : undefined)
  const branchReq = (createOnly = false) =>
    branchAt
      ? { ...branchAt, newSessionId: branchId.current, ...(createOnly ? { createOnly } : {}) }
      : undefined

  useEffect(() => {
    let cancelled = false
    void api
      .previewLaunch({
        key: resume.key,
        fork: resume.fork,
        skipPermissions: skip,
        cwdOverride,
        terminal,
        billingAccountId,
        newSession,
        branch: branchReq(),
        continueFresh: continueReq(),
        remoteControl
      })
      .then((p) => {
        if (cancelled) return
        if (p.branch) branchId.current = p.branch.newSessionId
        if (p.continueFresh) continueId.current = p.continueFresh.newSessionId
        setPreview(p)
      })
      .catch((err: Error) =>
        toast.error('Could not prepare the command', { description: err.message })
      )
    return () => {
      cancelled = true
    }
    // branchReq / continueReq read refs; resume.branch is covered by `resume`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    resume,
    skip,
    cwdOverride,
    terminal,
    session?.availability,
    billingAccountId,
    newSession,
    remoteControl,
    // The model / effort pickers save right away; the command follows them.
    session?.meta.model,
    session?.meta.effort,
    settings.defaultModel,
    settings.defaultEffort,
    settings.projectModels
  ])

  const close = (): void => set({ resume: null })
  if (!session) return null
  const choice = preview?.modelChoice ? choiceLabel(preview.modelChoice) : ''
  const fork = resume.fork
  const branchBlocked = !!branchAt && (!preview?.branch || !!preview.branchError)
  const continueBlocked = continueFresh && (!preview?.continueFresh || !!preview.continueError)
  const blocked =
    continueBlocked ||
    !preview ||
    !preview.cwd ||
    !preview.cwdExists ||
    !!preview.launchError ||
    (!newSession && preview.restoreImpossible) ||
    branchBlocked

  const launch = async (createOnly = false): Promise<void> => {
    if (launching || (createOnly ? branchBlocked || !preview : blocked)) return
    setLaunching(true)
    const res = await api.launch({
      key: resume.key,
      fork,
      skipPermissions: skip,
      cwdOverride,
      terminal,
      billingAccountId,
      newSession,
      branch: branchReq(createOnly),
      continueFresh: continueReq(),
      remoteControl
    })
    // Per-project default ("always use API credits for this project").
    const current = projectDefault(settings.projectBilling, session)
    const want = rememberProject ? billing : undefined
    if (session && projectKey && current !== want) {
      const projectBilling = withProjectDefault(settings.projectBilling, session, want, sessions)
      void api.updateSettings({ projectBilling }).then((st) => set({ settings: st }))
    }
    setLaunching(false)
    if (res.branch) {
      // The branch exists now (even if opening the terminal failed): show it, ready to rename.
      close()
      showNewSession(res.branch)
    }
    if (!res.ok) {
      toast.error(
        res.branch
          ? 'Branch created, but the terminal could not be opened'
          : branchAt
            ? 'Could not create the branch'
            : continueFresh
              ? 'Could not continue in a new session'
              : newSession
                ? 'Could not start the session'
                : fork
                  ? 'Could not fork the session'
                  : 'Could not resume the session',
        {
          description: res.error
        }
      )
      return
    }
    if (createOnly) {
      toast.success('Branch created', {
        description: 'Give it a name, then resume it whenever you like.'
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
      toast.success(
        branchAt
          ? 'Branched in a new terminal'
          : continueFresh
            ? 'Continued fresh in a new terminal'
            : newSession
              ? 'Started in a new terminal'
              : fork
                ? 'Forked in a new terminal'
                : 'Resumed in a new terminal',
        {
          description: `${TERMINAL_LABEL[preview?.terminal ?? terminal]} · ${preview?.billingLabel ?? ''}${
            remoteControl
              ? ' · Remote Control on: open it in the Claude app or at claude.ai/code'
              : ''
          }`
        }
      )
    }
  }

  const pickFolder = async (): Promise<void> => {
    const picked = await api.pickCwd(session.key)
    if (picked) setCwdOverride(picked)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] max-w-[560px] flex-col"
        // A new branch takes focus (its rename box), so don't send focus back.
        onCloseAutoFocus={branchAt ? (e) => e.preventDefault() : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && launchesOnEnter(e)) {
            e.preventDefault()
            void launch()
          }
        }}
      >
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              {branchAt ? (
                <GitBranchPlus className="size-4" />
              ) : continueFresh ? (
                <ContinueIcon className="size-4" />
              ) : newSession ? (
                <Plus className="size-4" />
              ) : fork ? (
                <GitFork className="size-4" />
              ) : (
                <Play className="size-4 fill-current" />
              )}
            </div>
          }
          title={
            branchAt
              ? branchAt.mode === 'before'
                ? 'Branch from before this message'
                : 'Branch from here'
              : continueFresh
                ? 'Continue fresh'
                : newSession
                  ? 'New session'
                  : fork
                    ? 'Fork session'
                    : 'Resume session'
          }
          description={
            <span className="line-clamp-1 text-foreground/80" title={session.title}>
              {session.title}
            </span>
          }
        />

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-3 pb-5">
          {newSession && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Starts a fresh Claude Code session in this session&apos;s folder.
            </p>
          )}
          {continueFresh && (
            <ContinueFreshCard
              preview={preview?.continueFresh}
              error={preview?.continueError}
              messageCount={session.messageCount}
            />
          )}
          {fork && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Starts a new session that continues from this conversation. The original session stays
              untouched.
            </p>
          )}
          {branchAt && (
            <>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Creates a new session with the conversation up to this point, then resumes it. The
                original session stays untouched.
              </p>
              {preview?.branchError ? (
                <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
                  <TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
                  {preview.branchError}
                </div>
              ) : (
                <BranchPointCard branch={preview?.branch} mode={branchAt.mode} />
              )}
            </>
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
          {preview?.launchError && (
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
              <TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
              {preview.launchError}
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
            {preview && !preview.cwdExists && !preview.launchError && (
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
            {preview?.terminalReason && (
              <div className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                {preview.terminalReason}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              Billing
              <Tooltip
                content="With an API key, Claude Code may ask once to confirm that it should use the key. The key is only given to this one terminal."
                side="right"
              >
                <Info className="size-3.5 text-subtle-foreground" aria-label="About billing" />
              </Tooltip>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <BillingPicker value={billing} onChange={pickBilling} />
              {projectKey && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={rememberProject}
                    onCheckedChange={(v) => setRememberProject(v === true)}
                  />
                  Always use this for {session.projectName}
                </label>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              Model and effort
              <Tooltip
                content="Saved for this session. Default uses the project's default, then Settings, then Claude Code's own (no flag). An effort level set with CLAUDE_CODE_EFFORT_LEVEL wins over --effort."
                side="right"
              >
                <Info
                  className="size-3.5 text-subtle-foreground"
                  aria-label="About model and effort"
                />
              </Tooltip>
            </div>
            <SessionModelControls session={session} />
          </div>

          <RemoteControlOption
            checked={remoteControl}
            onChange={setRemoteControl}
            name={preview?.remoteControlName}
          />

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
              <span className="text-xs font-medium">PowerShell command</span>
              {/* Continue fresh writes its handoff file and links the new session only
                  when launched from here: a copied command would point at no file. */}
              {!continueFresh && (
                <button
                  type="button"
                  onClick={() => {
                    if (!preview?.commandLine) return
                    void api.copyText(preview.commandLine)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1200)
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
                >
                  {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
            {continueFresh && (
              <div className="mb-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                Not for copying: the handoff file is written, and the new session linked, only when
                you click Continue fresh.
              </div>
            )}
            <pre className="selectable max-h-28 overflow-auto rounded-lg border border-code-border bg-code-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-foreground/90">
              {preview ? preview.commandLine || '—' : '…'}
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
          {branchAt && (
            <Tooltip content="Create the branch without opening a terminal">
              <Button
                variant="outline"
                onClick={() => void launch(true)}
                disabled={branchBlocked || launching}
              >
                Create only
              </Button>
            </Tooltip>
          )}
          <Button
            variant="primary"
            onClick={() => void launch()}
            disabled={blocked || launching}
            autoFocus
          >
            {launching ? (
              <Loader2 className="animate-spin" />
            ) : branchAt ? (
              <GitBranchPlus />
            ) : continueFresh ? (
              <ContinueIcon />
            ) : newSession ? (
              <Plus />
            ) : fork ? (
              <GitFork />
            ) : (
              <Play className="fill-current" />
            )}
            {branchAt
              ? 'Branch'
              : continueFresh
                ? 'Continue fresh'
                : newSession
                  ? 'Start'
                  : fork
                    ? 'Fork'
                    : 'Resume'}
            {choice && <span className="font-normal opacity-85">· {choice}</span>}
            <Kbd className="ml-1 border-white/25 bg-white/15 text-primary-foreground">↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
