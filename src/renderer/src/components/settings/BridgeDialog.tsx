import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { FileCog, Link2, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BridgeEnv, BridgePlan, DiffLine } from '@shared/usage/limits'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'

/** Collapse long unchanged runs, keeping 2 lines of context around changes. */
function hunks(diff: DiffLine[]): (DiffLine | { type: 'gap'; count: number })[] {
  const keep = new Set<number>()
  diff.forEach((d, i) => {
    if (d.type !== 'same') for (let j = i - 2; j <= i + 2; j++) keep.add(j)
  })
  const out: (DiffLine | { type: 'gap'; count: number })[] = []
  let gap = 0
  diff.forEach((d, i) => {
    if (keep.has(i) || diff.length <= 14) {
      if (gap) out.push({ type: 'gap', count: gap })
      gap = 0
      out.push(d)
    } else gap++
  })
  if (gap) out.push({ type: 'gap', count: gap })
  return out
}

type EnvLike = Pick<BridgeEnv, 'sourceId' | 'label' | 'env' | 'user' | 'settingsPath'>

/** The status line bridge (live limits) or the hook bridge (session alerts). */
const KINDS = {
  limits: {
    plan: (id: string, a: 'install' | 'uninstall') => api.planBridge(id, a),
    apply: (id: string, a: 'install' | 'uninstall', t: string) => api.applyBridge(id, a, t),
    name: 'live limits',
    Name: 'Live limits'
  },
  alerts: {
    plan: (id: string, a: 'install' | 'uninstall') => api.planHooks(id, a),
    apply: (id: string, a: 'install' | 'uninstall', t: string) => api.applyHooks(id, a, t),
    name: 'session alerts',
    Name: 'Session alerts'
  }
}

export function BridgeDialog({
  env,
  action,
  onClose,
  kind = 'limits'
}: {
  env: EnvLike
  action: 'install' | 'uninstall'
  onClose: () => void
  kind?: keyof typeof KINDS
}) {
  const k = KINDS[kind]
  const [plan, setPlan] = useState<BridgePlan | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void k.plan(env.sourceId, action).then(setPlan)
  }, [env.sourceId, action, k])
  const lines = useMemo(() => (plan ? hunks(plan.diff) : []), [plan])
  const install = action === 'install'

  const apply = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    const res = await k.apply(env.sourceId, action, plan.token)
    setBusy(false)
    if (!res.ok) {
      toast.error(install ? `Could not enable ${k.name}` : `Could not disable ${k.name}`, {
        description: res.error
      })
      if (res.error?.includes('changed since')) void k.plan(env.sourceId, action).then(setPlan)
      return
    }
    toast.success(
      install ? `${k.Name} enabled for ${env.label}` : `${k.Name} disabled for ${env.label}`,
      {
        description:
          kind === 'alerts'
            ? install
              ? 'Sessions started (or resumed) from now on send their events. Running sessions pick it up when they restart.'
              : 'Your other hooks are untouched.'
            : install
              ? 'Data appears after Claude Code next updates its status line (send any message).'
              : res.backupPath
                ? 'Your previous status line is back.'
                : undefined
      }
    )
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <FileCog className="size-4" />
            </div>
          }
          title={install ? `Enable ${k.name} · ${env.label}` : `Disable ${k.name} · ${env.label}`}
          description={
            kind === 'alerts'
              ? install
                ? 'Claude Code will run a tiny script on a few session events (needs approval, finished, started, ended) that saves the event for the dashboard. Your existing hooks stay exactly as they are; these are added at the end:'
                : 'This takes out exactly the hooks the app added. Your own hooks stay as they are:'
              : install
                ? 'Claude Code will run a tiny status line script that saves the usage data it already shows in /usage. This is the only change:'
                : 'This puts your previous status line setting back exactly as it was:'
          }
        />
        <div className="space-y-3 px-5 pt-3 pb-5">
          <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
            <span className="truncate" title={env.settingsPath}>
              {env.env === 'windows'
                ? '%USERPROFILE%\\.claude\\settings.json'
                : `${env.user === 'root' ? '/root' : `/home/${env.user ?? '…'}`}/.claude/settings.json`}
              {env.env === 'wsl' && ` (${env.label.replace('WSL: ', '')})`}
            </span>
            {plan?.createsFile && (
              <span className="shrink-0 rounded bg-secondary px-1 font-sans text-[10px]">
                new file
              </span>
            )}
          </div>
          {!plan ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : plan.error ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5 text-xs">
              <TriangleAlert className="mt-px size-4 shrink-0 text-warning" />
              {plan.error}
            </div>
          ) : plan.noop ? (
            <div className="rounded-lg border border-border px-3 py-3 text-xs text-muted-foreground">
              {install ? `${k.Name} are already enabled here.` : `${k.Name} are not enabled here.`}
            </div>
          ) : (
            <pre className="selectable max-h-72 overflow-auto rounded-lg border border-code-border bg-code-bg py-2 font-mono text-[11.5px] leading-[1.6]">
              {lines.map((l, i) =>
                l.type === 'gap' ? (
                  <div key={i} className="px-3 text-subtle-foreground">
                    ⋯ {l.count} unchanged line{l.count === 1 ? '' : 's'}
                  </div>
                ) : (
                  <div
                    key={i}
                    className={cn(
                      'px-3 whitespace-pre-wrap',
                      l.type === 'add' && 'bg-[var(--hl-addition-bg)] text-[var(--hl-addition)]',
                      l.type === 'remove' && 'bg-[var(--hl-deletion-bg)] text-[var(--hl-deletion)]'
                    )}
                  >
                    <span className="mr-2 inline-block w-3 select-none text-subtle-foreground">
                      {l.type === 'add' ? '+' : l.type === 'remove' ? '−' : ' '}
                    </span>
                    {l.text || ' '}
                  </div>
                )
              )}
            </pre>
          )}
          {plan && !plan.error && !plan.noop && (
            <div className="space-y-1.5 text-xs text-muted-foreground">
              {kind === 'alerts' ? (
                install && (
                  <div className="flex items-start gap-2">
                    <Link2 className="mt-px size-3.5 shrink-0 text-info" />
                    <span>
                      The hooks run in the background (they never slow Claude down) and print
                      nothing. They save only the event; the dashboard reads the event and ignores
                      prompts and replies.
                    </span>
                  </div>
                )
              ) : plan.chained ? (
                <div className="flex items-start gap-2">
                  <Link2 className="mt-px size-3.5 shrink-0 text-info" />
                  <span>
                    {install
                      ? 'Your current status line keeps working: the bridge passes the data on to '
                      : 'Restores '}
                    <span className="font-mono text-foreground/85">{plan.chained}</span>
                    {install ? ' and shows its output.' : '.'}
                  </span>
                </div>
              ) : (
                install && (
                  <div className="flex items-start gap-2">
                    <Link2 className="mt-px size-3.5 shrink-0 text-subtle-foreground" />
                    No status line is set now, so the bridge prints a short one: model · 5h % · week
                    % · context %.
                  </div>
                )
              )}
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
                <span>
                  A backup of settings.json goes to the app&apos;s data folder first. Nothing else
                  in <span className="font-mono">.claude</span> is touched.
                </span>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={install ? 'primary' : 'outline'}
            disabled={!plan || !!plan.error || busy}
            onClick={() => (plan?.noop ? onClose() : void apply())}
          >
            {busy && <Loader2 className="animate-spin" />}
            {plan?.noop ? 'Close' : install ? `Enable ${k.name}` : 'Disable and restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
