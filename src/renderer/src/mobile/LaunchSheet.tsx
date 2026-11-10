import { useEffect, useState } from 'react'
import {
  AppWindow,
  ArchiveRestore,
  CircleCheck,
  ExternalLink,
  GitBranchPlus,
  GitFork,
  Loader2,
  MonitorSmartphone,
  Play,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Zap
} from 'lucide-react'
import type { RemoteLaunchPreview, RemoteLaunchRequest, RemoteLaunchResult } from '@shared/mobile'
import { CLAUDE_CODE_WEB_URL } from '@shared/mobile'
import { providerOf } from '@shared/provider'
import type { SessionSummary, TerminalPref } from '@shared/types'
import { now } from '@shared/clock'
import { effortLabel, modelLabel } from '@shared/model-choice'
import { freshRemoteUrl, runningNow } from '@/lib/remote'
import type { RunningCopy } from '@shared/running'
import { RunningBlock } from './RunningBlock'
import { useMobile } from './state'
import { DEFAULT_CONTEXT_WARNING, shouldWarn } from '@shared/context'
import { updateMeta } from '@/lib/actions'
import { ContextLine, ContextWarning } from '@/components/context/ContextSize'
import { useWarmExpiry } from '@/lib/use-warm-expiry'
import { useApp } from '@/lib/store'
import { phone } from '@/lib/web-api'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'

export type LaunchTarget =
  | { kind: 'resume' }
  | { kind: 'fork' }
  | { kind: 'continue' }
  | { kind: 'branch'; at: string; mode: 'include' | 'before' }
  /** Codex: open the existing thread in the Codex desktop app on the PC. */
  | { kind: 'codex-app' }

const TERMINAL: Record<string, string> = {
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: 'Command Prompt'
} satisfies Record<TerminalPref, string>

const VERB = {
  resume: 'Resume',
  fork: 'Fork',
  branch: 'Branch',
  continue: 'Continue fresh',
  'codex-app': 'Open in Codex app'
} as const

/**
 * Wait for Claude Code to record the session's Remote Control link (a few
 * seconds after it starts), so "Open in Claude app" goes straight to it.
 */
type Launched = RemoteLaunchResult & { at: number; existing: ReadonlySet<string> }

function useFreshRemoteUrl(result: Launched | null, since: number): string | undefined {
  const sessions = useApp((st) => st.sessions)
  // Running now has the link first (Claude Code's running-session file, read every few seconds).
  const live = useApp((st) => st.live?.sessions)
  return freshRemoteUrl(sessions, result, since, result?.existing, live)
}

export function LaunchSheet({
  session,
  target,
  onClose,
  onSwitch
}: {
  session: SessionSummary
  target: LaunchTarget
  onClose: () => void
  /** Open the sheet for another launch (the large-session warning's choices). */
  onSwitch?: (t: LaunchTarget) => void
}) {
  const settings = useApp((st) => st.settings)
  // Codex: no Remote Control or Claude app link; it asks before acting, in its sandbox.
  const codex = providerOf(session) === 'codex'
  // "Don't warn for this session": saved right away; the warning stays while the sheet is open.
  const [warnOffAtOpen] = useState(() => session.meta.noContextWarning === true)
  const [dontWarn, setDontWarnState] = useState(warnOffAtOpen)
  const req: RemoteLaunchRequest =
    target.kind === 'branch'
      ? { key: session.key, kind: 'branch', branch: { at: target.at, mode: target.mode } }
      : { key: session.key, kind: target.kind }
  const [preview, setPreview] = useState<RemoteLaunchPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Launched | null>(null)
  const [error, setError] = useState<string>()
  // Refused at launch because it's already running (it started since the preview).
  const [runningRes, setRunningRes] = useState<RunningCopy>()
  const liveSessions = useApp((st) => st.live?.sessions)
  const readOnly = useMobile((st) => st.me?.readOnly) ?? false
  // As Running now says it is now: the link shows as soon as Remote Control is on
  // (/rc typed later included), and goes when the session restarts without it.
  const running: RunningCopy | undefined = runningNow(runningRes ?? preview?.running, liveSessions)
  const fresh = useFreshRemoteUrl(result?.ok && !codex ? result : null, result?.at ?? 0)
  const [waitedLong, setWaitedLong] = useState(false)

  // The estimate goes up when a warm cache runs out: ask the PC again then.
  const [expired, setExpired] = useState(0)
  useWarmExpiry(result ? undefined : preview?.context?.warmUntil, () => setExpired((n) => n + 1))
  useEffect(() => {
    let cancelled = false
    void phone
      .previewLaunch(req)
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
    // The request is fixed for the sheet's lifetime; preview again when the
    // cache runs out or the session's context changes (grew, shrank, compacted).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired, session.sizeBytes, session.context?.tokens, session.context?.at])

  useEffect(() => {
    if (!result?.ok || fresh || codex) return
    const t = window.setTimeout(() => setWaitedLong(true), 45_000)
    return () => window.clearTimeout(t)
  }, [result, fresh, codex])

  const go = async (force = false): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      // Sessions that exist now can't be the fork Claude Code is about to create.
      const existing = new Set([
        ...useApp.getState().sessions.map((x) => x.key),
        ...(useApp.getState().live?.sessions ?? []).map((x) => x.key)
      ])
      // "Start another copy anyway" (confirmed in the block above) adds `force`; nothing else changes.
      const r = await phone.launch(force ? { ...req, force: true } : req)
      if (r.ok) setResult({ ...r, at: now(), existing })
      else if (r.running) setRunningRes(r.running)
      else setError(r.error ?? 'It could not be launched.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const warn =
    target.kind === 'resume' &&
    shouldWarn({
      kind: 'resume',
      tokens: preview?.context?.tokens,
      settings: settings.contextWarning ?? DEFAULT_CONTEXT_WARNING,
      sessionOff: warnOffAtOpen
    })
  const setDontWarn = (v: boolean): void => {
    setDontWarnState(v)
    void updateMeta(session.key, { noContextWarning: v }).catch(() => undefined)
  }

  const Icon =
    target.kind === 'branch'
      ? GitBranchPlus
      : target.kind === 'fork'
        ? GitFork
        : target.kind === 'continue'
          ? Zap
          : target.kind === 'codex-app'
            ? AppWindow
            : Play
  const title =
    target.kind === 'branch'
      ? target.mode === 'before'
        ? 'Branch from before this message'
        : 'Branch from here'
      : target.kind === 'codex-app'
        ? 'Open in Codex app on your PC'
        : `${VERB[target.kind]} on your PC`

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={result?.ok ? 'Started on your PC' : title} description={session.title}>
        {result?.ok ? (
          <div className="space-y-4 pt-2">
            <div className="flex items-start gap-3 rounded-xl border border-success/25 bg-success/5 px-3.5 py-3">
              <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" />
              <div className="text-[14px] leading-relaxed">
                {result.simulated ? (
                  <>Fixtures mode: the command was built but nothing was started.</>
                ) : target.kind === 'codex-app' ? (
                  <>The thread opened in the Codex app on your PC. Continue it there.</>
                ) : codex ? (
                  <>
                    {target.kind === 'continue'
                      ? 'A terminal opened on your PC running a new Codex session that starts from the summary.'
                      : 'A terminal opened on your PC running Codex with this session.'}{' '}
                    Continue it there (or over SSH).
                  </>
                ) : (
                  <>
                    A terminal opened on your PC with Remote Control on. Continue the session in the
                    Claude app or at claude.ai/code.
                  </>
                )}
              </div>
            </div>
            {!codex && (
              <>
                <a
                  href={fresh ?? CLAUDE_CODE_WEB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground active:bg-primary-hover"
                >
                  <MonitorSmartphone className="size-5" /> Open in Claude app{' '}
                  <ExternalLink className="size-4 opacity-80" />
                </a>
                <div className="flex items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
                  {fresh ? (
                    <>
                      <CircleCheck className="size-3.5 text-success" /> Linked straight to this
                      session
                    </>
                  ) : waitedLong || result.simulated ? (
                    <>Find it by name in the Claude app’s Code tab.</>
                  ) : (
                    <>
                      <Loader2 className="size-3.5 animate-spin" /> Waiting for Remote Control to
                      connect…
                    </>
                  )}
                </div>
              </>
            )}
            {!result.simulated && !codex && (
              <p className="rounded-lg bg-secondary/70 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
                {target.kind === 'continue'
                  ? 'The new session starts from the summary, not the whole history. The earlier conversation is here in the dashboard.'
                  : 'Claude has the whole conversation, but the Claude app only shows messages from now on. The earlier ones are here in the dashboard.'}
              </p>
            )}
            <Button variant="ghost" className="h-11 w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            {!preview && !error && (
              <div className="flex items-center gap-2 py-6 text-[14px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Checking with your PC…
              </div>
            )}
            {preview && running && (
              <RunningBlock
                running={running}
                readOnly={readOnly}
                onDone={onClose}
                onRefresh={() => {
                  setRunningRes(undefined)
                  setExpired((n) => n + 1)
                }}
                onAnother={() => void go(true)}
              />
            )}
            {preview && !running && target.kind === 'codex-app' && (
              <ul className="space-y-2.5 text-[14px]">
                <li className="flex items-start gap-2.5">
                  <AppWindow className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    Opens this thread in the <b>Codex app</b> on your PC, in its project. Nothing
                    else is started.
                  </span>
                </li>
                {preview.confirmOnPc && (
                  <li className="rounded-lg bg-info/5 px-3 py-2 text-[13px] text-info">
                    You’ll need to click Allow on the PC.
                  </li>
                )}
              </ul>
            )}
            {preview && !running && target.kind !== 'codex-app' && (
              <ul className="space-y-2.5 text-[14px]">
                <li className="flex items-start gap-2.5">
                  <SquareTerminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    Opens in <b>{TERMINAL[preview.terminal] ?? preview.terminal}</b> on your PC
                    {preview.cwd && (
                      <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted-foreground">
                        {preview.cwd}
                      </span>
                    )}
                  </span>
                </li>
                {!codex && (
                  <li className="flex items-start gap-2.5">
                    <Smartphone className="mt-0.5 size-4 shrink-0 text-info" />
                    <span>
                      Remote Control on
                      {preview.remoteControlName && (
                        <span className="text-muted-foreground">
                          {' '}
                          as “{preview.remoteControlName}”
                        </span>
                      )}
                    </span>
                  </li>
                )}
                <li className="flex items-start gap-2.5">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {preview.modelChoice?.model ? (
                      <b>{modelLabel(preview.modelChoice.model)}</b>
                    ) : codex ? (
                      'Codex’s default model'
                    ) : (
                      'Claude Code’s default model'
                    )}
                    {preview.modelChoice?.effort && (
                      <> · {effortLabel(preview.modelChoice.effort)} effort</>
                    )}
                    {preview.modelChoice?.model && (
                      <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted-foreground">
                        {codex ? '-m' : '--model'} {preview.modelChoice.model}
                        {preview.modelChoice.effort
                          ? codex
                            ? ` -c model_reasoning_effort=${preview.modelChoice.effort}`
                            : ` --effort ${preview.modelChoice.effort}`
                          : ''}
                      </span>
                    )}
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                  <span>
                    {codex
                      ? 'Codex runs in its workspace sandbox and asks for approval when it needs it (never bypassed from the phone)'
                      : 'Your Claude subscription · Claude still asks before running commands'}
                  </span>
                </li>
                {target.kind === 'fork' && (
                  <li className="flex items-start gap-2.5 text-muted-foreground">
                    <GitFork className="mt-0.5 size-4 shrink-0" />
                    <span>
                      A new session continues from this one; the original stays untouched.
                    </span>
                  </li>
                )}
                {target.kind === 'continue' && (
                  <li className="flex items-start gap-2.5 text-muted-foreground">
                    <Zap className="mt-0.5 size-4 shrink-0" />
                    <span>
                      A new session that starts from this session’s summary instead of reloading the
                      whole history; the original stays untouched.
                      {!!preview.newSinceSummary && (
                        <span className="mt-0.5 block text-warning">
                          {preview.newSinceSummary} new message
                          {preview.newSinceSummary === 1 ? '' : 's'} since the summary was written.
                        </span>
                      )}
                    </span>
                  </li>
                )}
                {target.kind === 'branch' && (
                  <li className="flex items-start gap-2.5 text-muted-foreground">
                    <GitBranchPlus className="mt-0.5 size-4 shrink-0" />
                    <span>
                      A new session with the conversation up to this message; the original stays
                      untouched.
                    </span>
                  </li>
                )}
                {preview.willRestore && (
                  <li className="flex items-start gap-2.5 text-muted-foreground">
                    <ArchiveRestore className="mt-0.5 size-4 shrink-0" />
                    <span>The session file is restored from the app’s archive first.</span>
                  </li>
                )}
                {preview.confirmOnPc && (
                  <li className="rounded-lg bg-info/5 px-3 py-2 text-[13px] text-info">
                    You’ll need to click Allow on the PC.
                  </li>
                )}
              </ul>
            )}
            {preview?.context &&
              (warn ? (
                <ContextWarning
                  phone
                  estimate={preview.context}
                  onContinueFresh={
                    session.meta.aiSummary && onSwitch
                      ? () => onSwitch({ kind: 'continue' })
                      : undefined
                  }
                  noSummaryText="summarize on your PC first"
                  onFork={() => onSwitch?.({ kind: 'fork' })}
                  dontWarn={dontWarn}
                  onDontWarn={setDontWarn}
                />
              ) : (
                (target.kind === 'resume' || target.kind === 'fork') && (
                  <ContextLine estimate={preview.context} />
                )
              ))}
            {(error || (preview && !preview.ok && preview.error)) && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {error ?? preview?.error}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" className="h-12 flex-1" onClick={onClose}>
                Cancel
              </Button>
              {!running && (
                <Button
                  variant="primary"
                  className="h-12 flex-[2] text-[15px]"
                  disabled={!preview?.ok || busy}
                  onClick={() => void go()}
                >
                  {busy ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Icon className={target.kind === 'resume' ? 'fill-current' : ''} />
                  )}
                  {busy && preview?.confirmOnPc
                    ? 'Waiting for the PC…'
                    : warn
                      ? 'Resume anyway'
                      : VERB[target.kind]}
                </Button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
