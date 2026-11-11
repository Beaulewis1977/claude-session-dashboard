import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AppWindow,
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
  SquareTerminal,
  TriangleAlert
} from 'lucide-react'
import { ContinueFreshCard, ContinueIcon } from './summary/ContinueFreshCard'
import { ContextLine, ContextWarning } from './context/ContextSize'
import { useWarmExpiry } from '@/lib/use-warm-expiry'
import { DEFAULT_CONTEXT_WARNING, shouldWarn } from '@shared/context'
import { updateMeta } from '@/lib/actions'
import { summarize } from '@/lib/summaries'
import type { LaunchPlacement, LaunchPreview, TerminalPref } from '@shared/types'
import { api } from '@/lib/api'
import { showNewSession } from '@/lib/actions'
import { launchesOnEnter } from '@/lib/dialog-keys'
import { useApp, type ResumeRequest } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from './ui/dialog'
import { Kbd } from './ui/kbd'
import { Segmented } from './ui/segmented'
import { Tooltip } from './ui/tooltip'
import { validBilling } from '@/lib/billing'
import { BillingPicker } from './BillingPicker'
import { capsOf, providerOf } from '@shared/provider'
import { BranchPointCard } from './viewer/Branches'
import { SessionModelControls } from './ModelPicker'
import { FastModeNotes } from './FastModeNote'
import { fastNotes } from '@shared/fast-notes'
import { asBranch } from '@/lib/model-choice'
import { choiceLabel } from '@shared/model-choice'
import { projectDefault, projectDefaultKey, withProjectDefault } from '@shared/project-key'
import type { AcceptedProject, CodexAppKind, OpenIn } from '@shared/codex-app'
import { CodexAppPanel, OpenInChoice } from './CodexAppOpen'
import { appChoosable, useOpenIn } from '@/lib/open-in'
import { RunningNotice } from './RunningNotice'
import { ACTION_LABEL, primaryAction, runRunningAction } from '@/lib/running-actions'

export const SKIP_WARNING = 'Claude will not ask before running commands or deleting files.'
export const BYPASS_WARNING =
  'Codex will not ask before running commands, and runs them outside its sandbox.'

const TERMINAL_LABEL: Record<TerminalPref, string> = {
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: 'Command Prompt'
}

export function SkipPermissionsWarning({
  className,
  codex = false
}: {
  className?: string
  /** Codex's bypass flag instead of Claude Code's. */
  codex?: boolean
}) {
  return (
    <div className={cn('flex items-center gap-1.5 text-xs font-medium text-warning', className)}>
      <TriangleAlert className="size-3.5 shrink-0" />
      {codex ? BYPASS_WARNING : SKIP_WARNING}
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
            Makes the session continuable from the Claude mobile app (and at claude.ai/code). Uses
            your Claude subscription.
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

function ResumeDialogBody({ resume }: { resume: ResumeRequest }) {
  const sessions = useApp((s) => s.sessions)
  const settings = useApp((s) => s.settings)
  const codexLimits = useApp((s) => s.codexLimits)
  const info = useApp((s) => s.info)
  const set = useApp((s) => s.set)
  const session = sessions.find((s) => s.key === resume.key)
  // Codex: no API billing or Remote Control; its own bypass flag.
  const caps = capsOf(session)
  const codex = providerOf(session) === 'codex'

  const carry = resume.carry
  const [skip, setSkip] = useState(carry?.skip ?? settings.skipPermissionsDefault)
  const [terminal, setTerminal] = useState<TerminalPref>(carry?.terminal ?? settings.terminal)
  const [cwdOverride, setCwdOverride] = useState<string | undefined>(carry?.cwdOverride)
  // A session whose folder exists only in WSL (see preview.placement): resumed with
  // Windows Codex in that folder only when opted in here, in the distro picked.
  const [wslFolder, setWslFolderState] = useState(false)
  const [distro, setDistro] = useState<string | undefined>(undefined)
  const setWslFolder = (v: boolean): void => {
    setWslFolderState(v)
    // A folder picked for one way of running isn't right for the other.
    setCwdOverride(undefined)
  }
  const pickDistro = (v: string): void => {
    setDistro(v)
    setCwdOverride(undefined)
  }
  const where = { ...(wslFolder ? { wslFolder } : {}), ...(distro ? { distro } : {}) }
  const [preview, setPreview] = useState<LaunchPreview | null>(null)
  // Codex: open in a terminal or the Codex app (session → project → Settings → terminal).
  const resolvedOpenIn = useOpenIn(session)
  const [openInChoice, setOpenIn] = useState<OpenIn>(carry?.openIn ?? resolvedOpenIn.value)
  // Continue fresh in the app: the project whose folder holds this one, only when asked.
  // The exact project (id and root) the user agreed to: main checks it's still that one.
  const [acceptedProject, setAcceptedProject] = useState<AcceptedProject | undefined>(undefined)
  const appKind: CodexAppKind | undefined =
    codex && !resume.newSession && !resume.branch
      ? resume.continueFresh
        ? 'continue'
        : resume.fork
          ? 'fork'
          : 'resume'
      : undefined
  // The app only where it can open this launch (the preview says); else the terminal.
  const appMode =
    !!appKind &&
    openInChoice === 'codex-app' &&
    (preview === null || appChoosable(preview.codexApp))
  const appOpts = appMode
    ? {
        openIn: 'codex-app' as const,
        ...(acceptedProject ? { codexAppProject: acceptedProject } : {})
      }
    : {}
  // Approvals are always on for a WSL-only folder run with Windows Codex (main enforces it too).
  const askForced = preview?.placement?.askForced === true
  const [launching, setLaunching] = useState(false)
  const [copied, setCopied] = useState(false)
  // Claude Code: open in a terminal or hand it to the Claude desktop app (not saved).
  const [claudeApp, setClaudeApp] = useState(false)
  // "Start another copy" was confirmed although it's already running.
  const [another, setAnother] = useState(false)
  // "Don't warn for this session": saved right away, but the warning stays until the dialog closes.
  const [warnOffAtOpen] = useState(
    () => sessions.find((s) => s.key === resume.key)?.meta.noContextWarning === true
  )
  const [dontWarn, setDontWarnState] = useState(warnOffAtOpen)
  const accounts = useApp((s) => s.credits?.accounts) ?? []
  // Same project keys as the model defaults: WSL by distro and exact path.
  const projectKey = projectDefaultKey(session)
  const projectBillingNow = projectDefault(settings.projectBilling, session)
  const [billing, setBilling] = useState(() =>
    caps.apiBilling
      ? validBilling(carry?.billing ?? projectBillingNow ?? settings.defaultBilling, accounts)
      : 'subscription'
  )
  const [rememberProject, setRememberProject] = useState(
    () => carry?.rememberProject ?? projectBillingNow !== undefined
  )
  // Remote Control runs only on the subscription: turning one on turns the other off.
  const [remoteControl, setRemoteControlState] = useState(
    () =>
      caps.remoteControl &&
      (carry?.remoteControl ?? settings.remoteControlDefault) &&
      billing === 'subscription'
  )
  // The estimate goes up when a warm cache runs out: preview again then.
  const [expired, setExpired] = useState(0)
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
        remoteControl,
        ...where,
        ...appOpts,
        ...(claudeApp ? { openIn: 'claude-app' as const } : {})
      })
      .then((p) => {
        if (cancelled) return
        if (p.branch) branchId.current = p.branch.newSessionId
        if (p.continueFresh) continueId.current = p.continueFresh.newSessionId
        setPreview(p)
        // A consent for a project the folder no longer opens in is dropped: the dialog
        // previews again and shows where it opens now (asking again for a subfolder).
        if (p.codexApp?.consentChanged) setAcceptedProject(undefined)
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
    expired,
    wslFolder,
    distro,
    appMode,
    claudeApp,
    acceptedProject,
    // The session's context changed (it grew, shrank or was compacted): a new estimate.
    session?.sizeBytes,
    session?.context?.tokens,
    session?.context?.at,
    // The model / effort pickers save right away; the command follows them.
    session?.meta.model,
    session?.meta.effort,
    session?.meta.fast,
    settings.defaultModel,
    settings.defaultEffort,
    settings.defaultFast,
    settings.projectModels,
    settings.codexDefaultModel,
    settings.codexDefaultEffort,
    settings.codexDefaultFast,
    settings.codexProjectModels
  ])

  useWarmExpiry(preview?.context?.warmUntil, () => setExpired((n) => n + 1))
  const close = (): void => set({ resume: null })
  // Switch to another launch of the same session, keeping the choices made here.
  const switchTo = (next: Partial<ResumeRequest>): void =>
    set({
      resume: {
        key: resume.key,
        fork: false,
        ...next,
        carry: {
          skip,
          terminal,
          cwdOverride,
          billing,
          rememberProject,
          remoteControl,
          openIn: openInChoice
        }
      }
    })
  // Plain Resume warns above the threshold; Fork and the rest only show the size.
  const plainResume = !resume.fork && !newSession && !branchAt && !continueFresh
  const warn =
    plainResume &&
    shouldWarn({
      kind: 'resume',
      tokens: preview?.context?.tokens,
      settings: settings.contextWarning ?? DEFAULT_CONTEXT_WARNING,
      sessionOff: warnOffAtOpen
    })
  const setDontWarn = (v: boolean): void => {
    setDontWarnState(v)
    void updateMeta(resume.key, { noContextWarning: v })
  }
  if (!session) return null
  const choice = preview?.modelChoice ? choiceLabel(preview.modelChoice) : ''
  const fork = resume.fork
  const branchBlocked = !!branchAt && (!preview?.branch || !!preview.branchError)
  const continueBlocked = continueFresh && (!preview?.continueFresh || !!preview.continueError)
  const appBlocked = !preview || !preview.codexApp?.available || continueBlocked
  const claudeMode = claudeApp && !!preview?.claudeApp
  // Already running (it, or a fork / continuation of it): switching to it comes first.
  const running = preview?.running && !another ? preview.running : undefined
  const switchAction = running ? primaryAction(running) : undefined
  const blocked = claudeMode
    ? !preview?.claudeApp?.available || !!preview.launchError
    : appMode
      ? appBlocked
      : continueBlocked ||
        !preview ||
        !preview.cwd ||
        !preview.cwdExists ||
        !!preview.launchError ||
        (!newSession && preview.restoreImpossible) ||
        branchBlocked

  const launch = async (createOnly = false, anyway = another): Promise<void> => {
    if (launching) return
    // Still running and not confirmed: the main button switches to it instead (that
    // needs no launch, so a missing folder or other launch problem doesn't stop it).
    if (!createOnly && preview?.running && !anyway) {
      if (switchAction && (await runRunningAction(preview.running, switchAction))) close()
      return
    }
    if (createOnly ? branchBlocked || !preview : blocked) return
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
      remoteControl,
      ...where,
      ...appOpts,
      ...(claudeMode ? { openIn: 'claude-app' as const } : {}),
      ...(anyway ? { allowDuplicate: true } : {})
    })
    // Per-project default ("always use API credits for this project").
    const current = projectDefault(settings.projectBilling, session)
    const want = rememberProject ? billing : undefined
    if (session && caps.apiBilling && projectKey && current !== want) {
      const projectBilling = withProjectDefault(settings.projectBilling, session, want, sessions)
      void api.updateSettings({ projectBilling }).then((st) => set({ settings: st }))
    }
    setLaunching(false)
    if (res.branch) {
      // The branch exists now (even if opening the terminal failed): show it, ready to rename.
      close()
      showNewSession(res.branch)
    }
    if (!res.ok && res.running) {
      // It started running since the dialog opened: show what to do instead.
      setAnother(false)
      setPreview((p) => (p ? { ...p, running: res.running } : p))
      return
    }
    if (!res.ok) {
      // The Codex app's projects may have changed since the preview: check again
      // (a stale consent is then dropped, see above), instead of failing the same way.
      if (appMode) setExpired((n) => n + 1)
      toast.error(
        appMode
          ? "Couldn't open the Codex app"
          : res.branch
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
    if (res.openedIn === 'claude-app') {
      toast.success(
        res.simulated ? 'Fixtures mode: not opened' : 'Opened in the Claude desktop app',
        {
          description: res.simulated
            ? res.commandLine
            : 'It continues the same session there (claude --resume still finds it).'
        }
      )
      return
    }
    if (res.openedIn === 'codex-app') {
      toast.success(
        continueFresh ? 'New thread opened in the Codex app' : 'Opened in the Codex app',
        {
          description:
            res.note ??
            (continueFresh ? 'Press Enter in the Codex app to send the first message.' : undefined)
        }
      )
      return
    }
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
    const picked = await api.pickCwd(session.key, where)
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
          {running && (
            <RunningNotice
              running={running}
              onDone={close}
              onAnother={() => {
                setAnother(true)
                void launch(false, true)
              }}
            />
          )}
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
              provider={session.provider}
            />
          )}
          {fork && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Starts a new session that continues from this conversation. The original session stays
              untouched.
            </p>
          )}
          {warn && preview?.context ? (
            <ContextWarning
              estimate={preview.context}
              onContinueFresh={() => switchTo({ continueFresh: true })}
              onSummarize={() => {
                close()
                summarize([resume.key])
              }}
              onFork={() => switchTo({ fork: true })}
              dontWarn={dontWarn}
              onDontWarn={setDontWarn}
            />
          ) : (
            (plainResume || fork) && preview?.context && <ContextLine estimate={preview.context} />
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

          {preview?.claudeApp && (
            <div>
              <div className="mb-1.5 text-xs font-medium">Open in</div>
              <Segmented<'terminal' | 'claude-app'>
                ariaLabel="Open in"
                value={claudeMode ? 'claude-app' : 'terminal'}
                onChange={(v) => setClaudeApp(v === 'claude-app')}
                options={[
                  { value: 'terminal', label: 'Terminal', icon: <SquareTerminal /> },
                  { value: 'claude-app', label: 'Claude desktop app', icon: <AppWindow /> }
                ]}
              />
              {claudeMode && (
                <div className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-px size-3.5 shrink-0" />
                  {preview.claudeApp.available ? (
                    <span>
                      Claude Code hands this same session to the desktop app&apos;s Code tab (
                      <span className="font-mono">{preview.claudeApp.commandLine}</span>). No
                      terminal opens.
                    </span>
                  ) : (
                    preview.claudeApp.reason
                  )}
                </div>
              )}
            </div>
          )}
          {appKind && appChoosable(preview?.codexApp) && (
            <div>
              <div className="mb-1.5 text-xs font-medium">Open in</div>
              <OpenInChoice session={session} value={openInChoice} onChange={setOpenIn} />
            </div>
          )}
          {appMode && appKind && (
            <CodexAppPanel
              kind={appKind}
              app={preview?.codexApp}
              accepted={acceptedProject}
              onAccept={setAcceptedProject}
            />
          )}
          {!appMode &&
            openInChoice === 'codex-app' &&
            preview?.codexApp &&
            !preview.codexApp.hidden &&
            !appChoosable(preview.codexApp) && (
              <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                Opens in a terminal: {preview.codexApp.reason}
              </div>
            )}

          {!appMode && !claudeMode && (
            <>
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

              {preview?.placement && (
                <PlacementNote
                  placement={preview.placement}
                  onOpenInApp={() =>
                    void api
                      .openInAgentApp(resume.key)
                      .then(() => close())
                      .catch((err: Error) =>
                        toast.error("Couldn't open the Codex app", { description: err.message })
                      )
                  }
                  optedIn={wslFolder}
                  onOptIn={setWslFolder}
                  onDistro={pickDistro}
                />
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
                    {codex
                      ? 'Codex resumes by session id; it will run in the folder you picked.'
                      : 'Claude Code looks sessions up by project folder, so resuming from a different folder may not find it.'}
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
                <div className="mb-1.5 text-xs font-medium">
                  {appKind && appChoosable(preview?.codexApp) ? 'Terminal' : 'Open in'}
                </div>
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

              {caps.apiBilling && (
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                    Billing
                    <Tooltip
                      content="With an API key, Claude Code may ask once to confirm that it should use the key. The key is only given to this one terminal."
                      side="right"
                    >
                      <Info
                        className="size-3.5 text-subtle-foreground"
                        aria-label="About billing"
                      />
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
              )}

              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                  Model, effort and fast mode
                  <Tooltip
                    content={
                      codex
                        ? "Saved for this session. Default uses the project's default, then Settings → Codex, then Codex's own (no -m / -c model_reasoning_effort / -c service_tier)."
                        : "Saved for this session. Default uses the project's default, then Settings, then Claude Code's own (no flag). An effort level set with CLAUDE_CODE_EFFORT_LEVEL wins over --effort."
                    }
                    side="right"
                  >
                    <Info
                      className="size-3.5 text-subtle-foreground"
                      aria-label="About model and effort"
                    />
                  </Tooltip>
                </div>
                <SessionModelControls
                  // A branch resumes on the model of the last reply it keeps (once the preview knows it).
                  session={
                    branchAt && preview?.branch
                      ? asBranch(session, preview.branch.lastModel)
                      : session
                  }
                  newSession={newSession || continueFresh}
                />
                <FastModeNotes
                  className="mt-2"
                  notes={fastNotes({
                    fast: preview?.modelChoice?.fast,
                    agent: codex ? 'codex' : 'claude',
                    api: !!billingAccountId,
                    inApp: claudeMode ? 'claude-app' : appMode ? 'codex-app' : undefined,
                    codexLimits,
                    pauseAbovePct: settings.summaries.pauseAbovePct
                  })}
                />
              </div>

              {caps.remoteControl && (
                <RemoteControlOption
                  checked={remoteControl}
                  onChange={setRemoteControl}
                  name={preview?.remoteControlName}
                />
              )}

              <div className="rounded-lg border border-border p-3">
                <label
                  className={cn(
                    'flex items-start gap-2.5',
                    askForced ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                  )}
                >
                  <Checkbox
                    checked={skip && !askForced}
                    disabled={askForced}
                    onCheckedChange={(v) => setSkip(v === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      {codex ? 'Bypass approvals and sandbox' : 'Skip permission prompts'}
                    </span>
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {codex
                        ? '--dangerously-bypass-approvals-and-sandbox'
                        : '--dangerously-skip-permissions'}
                    </span>
                  </span>
                </label>
                {askForced ? (
                  <div className="mt-2 pl-[26px] text-xs text-muted-foreground">
                    Off for a WSL folder run with Windows Codex. It runs in its read-only sandbox (
                    <span className="font-mono">-a on-request -s read-only</span>): a command that
                    would change anything needs your approval. Codex decides when to ask; it has no
                    setting that asks before every command.
                  </div>
                ) : (
                  skip && <SkipPermissionsWarning className="mt-2 pl-[26px]" codex={codex} />
                )}
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
                    Not for copying: the handoff file is written, and the new session linked, only
                    when you click Continue fresh.
                  </div>
                )}
                <pre className="selectable max-h-28 overflow-auto rounded-lg border border-code-border bg-code-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-foreground/90">
                  {preview ? preview.commandLine || '—' : '…'}
                </pre>
              </div>
            </>
          )}
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
            disabled={(switchAction ? false : blocked || !!running) || launching}
            autoFocus
          >
            {launching ? (
              <Loader2 className="animate-spin" />
            ) : switchAction ? null : appMode || claudeMode ? (
              <AppWindow />
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
            {switchAction
              ? ACTION_LABEL[switchAction]
              : claudeMode
                ? 'Open in Claude desktop app'
                : appMode
                  ? 'Open in Codex app'
                  : branchAt
                    ? 'Branch'
                    : continueFresh
                      ? 'Continue fresh'
                      : newSession
                        ? 'Start'
                        : fork
                          ? 'Fork'
                          : warn
                            ? 'Resume anyway'
                            : 'Resume'}
            {choice && !appMode && !claudeMode && !switchAction && (
              <span className="font-normal opacity-85">· {choice}</span>
            )}
            <Kbd className="ml-1 border-white/25 bg-white/15 text-primary-foreground">↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Why a session runs where it does when its folder belongs to the other
 * environment than its .codex folder, and (for a WSL-only folder) the opt-in to
 * resume it with Windows Codex there, never with bypass.
 */
function PlacementNote({
  placement,
  optedIn,
  onOpenInApp,
  onOptIn,
  onDistro
}: {
  placement: LaunchPlacement
  optedIn: boolean
  onOpenInApp: () => void
  onOptIn: (v: boolean) => void
  onDistro: (v: string) => void
}) {
  const wslOnly = placement.kind === 'wsl-only'
  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border px-3 py-2.5 text-xs',
        wslOnly ? 'border-warning/40 bg-warning-soft' : 'border-border bg-secondary/40'
      )}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        <span>{placement.reason}</span>
      </div>
      {placement.appLink && (
        <div className="pl-[22px]">
          <Button variant="outline" size="xs" onClick={onOpenInApp}>
            Open in Codex app
          </Button>
        </div>
      )}
      {wslOnly && (
        <label className="flex cursor-pointer items-start gap-2 pl-[22px]">
          <Checkbox
            checked={optedIn}
            onCheckedChange={(v) => onOptIn(v === true)}
            className="mt-px"
          />
          <span className="font-medium">Resume with Windows Codex in the WSL folder</span>
        </label>
      )}
      {wslOnly && optedIn && (
        <div className="space-y-2 pl-[22px]">
          <div className="flex items-start gap-1.5 font-medium text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>
              Commands run in Windows PowerShell against the Linux files in{' '}
              <span className="font-mono">{placement.cwd}</span>, not in Linux. Codex runs read-only
              there: anything that would change files needs your approval (Codex decides when to
              ask; it can still run commands that only read).
            </span>
          </div>
          {placement.distros.length > 1 && (
            <Segmented<string>
              ariaLabel="WSL distro that holds the folder"
              value={placement.distro ?? ''}
              onChange={onDistro}
              options={placement.distros.map((d) => ({ value: d, label: d }))}
            />
          )}
        </div>
      )}
    </div>
  )
}
