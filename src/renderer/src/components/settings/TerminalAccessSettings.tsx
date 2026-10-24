// Settings → Phone → Terminal access: status, the setup wizard, "Turn off
// terminal access", and the log of every change the wizard made.

import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, History, Power, SquareTerminal, Wand2 } from 'lucide-react'
import type { TerminalLogEntry } from '@shared/terminal'
import { formatDateTime } from '@shared/format'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'
import { useChange, useTerminalStatus } from './terminal-change'
import { TerminalWizard } from './TerminalWizard'

function ChangeLog() {
  const [items, setItems] = useState<TerminalLogEntry[] | null>(null)
  useEffect(() => {
    const load = (): void => void api.terminalHistory().then(setItems)
    load()
    return api.onTerminalChanged(load)
  }, [])
  if (!items) return null
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
      {items.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">No changes yet.</div>
      ) : (
        <table className="w-full text-xs">
          <tbody className="divide-y divide-border">
            {items.map((e, i) => (
              <tr key={`${e.at}-${i}`} className="align-top">
                <td className="w-[150px] px-3 py-1.5 whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatDateTime(e.at)}
                </td>
                <td className="w-5 py-1.5">
                  {e.ok ? (
                    <CircleCheck className="size-3.5 text-success" aria-label="OK" />
                  ) : (
                    <CircleAlert
                      className="size-3.5 text-warning"
                      aria-label="Failed or declined"
                    />
                  )}
                </td>
                <td className="py-1.5 pr-3 text-muted-foreground">
                  <span className="text-foreground/80">{e.action}</span> · {e.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function TerminalAccessBlock() {
  const { status: st, refresh } = useTerminalStatus()
  const { change, busy, dialog } = useChange(() => void refresh())
  const [wizard, setWizard] = useState<false | 'setup' | 'troubleshoot'>(false)
  const [turnOff, setTurnOff] = useState(false)
  const [uninstall, setUninstall] = useState(false)
  const [removeKeys, setRemoveKeys] = useState(false)

  if (!st) return null
  const c = st.changes
  const anything =
    c.installedByApp ||
    !!c.service ||
    c.firewallRule ||
    c.defaultRuleDisabled ||
    !!c.shell ||
    !!c.sshdConfig ||
    c.keys.length > 0

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            st.ready ? 'bg-success/10 text-success' : 'bg-secondary text-muted-foreground'
          )}
        >
          <SquareTerminal className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            Terminal access · {st.ready ? 'Ready' : st.sshd.running ? 'Not finished' : 'Off'}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {st.ready
              ? `ssh ${st.user}@${st.tailscale.dnsName} · ${st.shell.path ?? 'cmd.exe'}`
              : 'A real terminal on this PC from your phone, through Windows’ OpenSSH Server, over Tailscale only.'}
          </div>
        </div>
      </div>
      {st.sshd.running && (st.firewall.defaultRule.enabled || !st.firewall.ours) && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs">
          <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            sshd is running and SSH isn’t limited to Tailscale: Windows’ “any address” rule is on
            {st.firewall.ours ? '' : ' and the Tailscale-only rule is missing'}. Open the setup’s
            Firewall step to fix it.
          </div>
        </div>
      )}
      {!st.supported && !st.simulated && (
        <div className="mt-3 text-xs text-muted-foreground">Available in the Windows app.</div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!st.supported && !st.simulated}
          onClick={() => setWizard('setup')}
        >
          <Wand2 /> {st.ready ? 'Open terminal access setup…' : 'Set up terminal access…'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setWizard('troubleshoot')}>
          Troubleshooting
        </Button>
        <div className="flex-1" />
        {anything && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={!!busy}
            onClick={() => setTurnOff(true)}
          >
            <Power /> Turn off terminal access…
          </Button>
        )}
      </div>
      <details className="mt-3">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium">
          <History className="size-3.5 text-muted-foreground" /> Change log
          <span className="text-xs font-normal text-muted-foreground">
            (every change the wizard made)
          </span>
        </summary>
        <div className="mt-2">
          <ChangeLog />
        </div>
      </details>

      {turnOff && (
        <Dialog open onOpenChange={(o) => !o && setTurnOff(false)}>
          <DialogContent className="max-w-[520px]">
            <DialogHeader
              icon={
                <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                  <Power className="size-4" />
                </div>
              }
              title="Turn off terminal access?"
              description="Undoes what the wizard changed: stops sshd, removes the app’s firewall rule, and puts the shell setting and sshd_config back from the backups. Nothing else is touched."
            />
            <div className="space-y-2.5 border-t border-border px-5 py-4 text-[13px]">
              {c.installedByApp && (
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox checked={uninstall} onCheckedChange={(v) => setUninstall(v === true)} />
                  <span>
                    Also uninstall OpenSSH Server
                    <span className="block text-xs text-muted-foreground">
                      The wizard installed it. Otherwise it’s only stopped and disabled.
                    </span>
                  </span>
                </label>
              )}
              {c.keys.length > 0 && (
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    checked={removeKeys}
                    onCheckedChange={(v) => setRemoveKeys(v === true)}
                  />
                  <span>
                    Also remove the {c.keys.length} key{c.keys.length === 1 ? '' : 's'} the wizard
                    added
                    <span className="block text-xs text-muted-foreground">
                      Only those exact lines. Keys you had before are never touched.
                    </span>
                  </span>
                </label>
              )}
              <p className="text-xs text-muted-foreground">
                You’ll see exactly what runs next, before Windows asks for administrator rights.
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setTurnOff(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setTurnOff(false)
                  void change({ kind: 'turn-off', uninstall, removeKeys })
                }}
              >
                Continue…
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {wizard && <TerminalWizard initial={wizard} onClose={() => setWizard(false)} />}
      {dialog}
    </div>
  )
}
