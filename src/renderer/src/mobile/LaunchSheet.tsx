import { useEffect, useState } from 'react'
import {
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
  TriangleAlert
} from 'lucide-react'
import type { RemoteLaunchPreview, RemoteLaunchRequest, RemoteLaunchResult } from '@shared/mobile'
import { CLAUDE_CODE_WEB_URL } from '@shared/mobile'
import type { SessionSummary, TerminalPref } from '@shared/types'
import { now } from '@shared/clock'
import { effortLabel, modelLabel } from '@shared/model-choice'
import { freshRemoteUrl } from '@/lib/remote'
import { useApp } from '@/lib/store'
import { phone } from '@/lib/web-api'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'

export type LaunchTarget =
  { kind: 'resume' } | { kind: 'fork' } | { kind: 'branch'; at: string; mode: 'include' | 'before' }

const TERMINAL: Record<string, string> = {
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: 'Command Prompt'
} satisfies Record<TerminalPref, string>

const VERB = { resume: 'Resume', fork: 'Fork', branch: 'Branch' } as const

/**
 * Wait for Claude Code to record the session's Remote Control link (a few
 * seconds after it starts), so "Open in Claude app" goes straight to it.
 */
type Launched = RemoteLaunchResult & { at: number; existing: ReadonlySet<string> }

function useFreshRemoteUrl(result: Launched | null, since: number): string | undefined {
  const sessions = useApp((st) => st.sessions)
  return freshRemoteUrl(sessions, result, since, result?.existing)
}

export function LaunchSheet({
  session,
  target,
  onClose
}: {
  session: SessionSummary
  target: LaunchTarget
  onClose: () => void
}) {
  const req: RemoteLaunchRequest =
    target.kind === 'branch'
      ? { key: session.key, kind: 'branch', branch: { at: target.at, mode: target.mode } }
      : { key: session.key, kind: target.kind }
  const [preview, setPreview] = useState<RemoteLaunchPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Launched | null>(null)
  const [error, setError] = useState<string>()
  const fresh = useFreshRemoteUrl(result?.ok ? result : null, result?.at ?? 0)
  const [waitedLong, setWaitedLong] = useState(false)

  useEffect(() => {
    let cancelled = false
    void phone
      .previewLaunch(req)
      .then((p) => !cancelled && setPreview(p))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
    // The request is fixed for the sheet's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!result?.ok || fresh) return
    const t = window.setTimeout(() => setWaitedLong(true), 45_000)
    return () => window.clearTimeout(t)
  }, [result, fresh])

  const go = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      // Sessions that exist now can't be the fork Claude Code is about to create.
      const existing = new Set(useApp.getState().sessions.map((x) => x.key))
      const r = await phone.launch(req)
      if (r.ok) setResult({ ...r, at: now(), existing })
      else setError(r.error ?? 'It could not be launched.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const Icon = target.kind === 'branch' ? GitBranchPlus : target.kind === 'fork' ? GitFork : Play
  const title =
    target.kind === 'branch'
      ? target.mode === 'before'
        ? 'Branch from before this message'
        : 'Branch from here'
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
                ) : (
                  <>
                    A terminal opened on your PC with Remote Control on. Continue the session in the
                    Claude app or at claude.ai/code.
                  </>
                )}
              </div>
            </div>
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
                  <CircleCheck className="size-3.5 text-success" /> Linked straight to this session
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
            {!result.simulated && (
              <p className="rounded-lg bg-secondary/70 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
                Claude has the whole conversation, but the Claude app only shows messages from now
                on. The earlier ones are here in the dashboard.
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
            {preview && (
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
                <li className="flex items-start gap-2.5">
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    {preview.modelChoice?.model ? (
                      <b>{modelLabel(preview.modelChoice.model)}</b>
                    ) : (
                      'Claude Code’s default model'
                    )}
                    {preview.modelChoice?.effort && (
                      <> · {effortLabel(preview.modelChoice.effort)} effort</>
                    )}
                    {preview.modelChoice?.model && (
                      <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted-foreground">
                        --model {preview.modelChoice.model}
                        {preview.modelChoice.effort
                          ? ` --effort ${preview.modelChoice.effort}`
                          : ''}
                      </span>
                    )}
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                  <span>Your Claude subscription · Claude still asks before running commands</span>
                </li>
                {target.kind === 'fork' && (
                  <li className="flex items-start gap-2.5 text-muted-foreground">
                    <GitFork className="mt-0.5 size-4 shrink-0" />
                    <span>
                      A new session continues from this one; the original stays untouched.
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
                {busy && preview?.confirmOnPc ? 'Waiting for the PC…' : VERB[target.kind]}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
