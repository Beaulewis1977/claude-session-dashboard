// "Open terminal here" on the phone: an ssh:// link to this PC over Tailscale
// and the ssh command that lands in the right folder. The phone's own SSH app
// connects; the dashboard never runs anything for it.

import { useState } from 'react'
import { Check, Copy, ExternalLink, FolderOpen, Lightbulb, SquareTerminal } from 'lucide-react'
import {
  remoteCommand,
  sshCommand,
  sshUrl,
  type FolderTarget,
  type TerminalAccessInfo
} from '@shared/terminal'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'

const SHELL_LABEL: Record<string, string> = {
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  wsl: 'WSL',
  cmd: 'Command Prompt',
  other: 'a custom shell'
}

function CopyRow({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1">
      <div className="text-[12px] font-medium text-muted-foreground">{label}</div>
      <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/50 p-2.5">
        <code className="selectable min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all">
          {text}
        </code>
        <Button
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          onClick={() => {
            void api.copyText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

export function TerminalSheet({
  info,
  target,
  title,
  onClose
}: {
  info: TerminalAccessInfo
  target: FolderTarget
  title: string
  onClose: () => void
}) {
  const remote = remoteCommand(target, info.shell)
  const shell =
    SHELL_LABEL[info.shell.kind] +
    (info.shell.kind === 'wsl' && info.shell.distro ? ` (${info.shell.distro})` : '')
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="Open terminal here" description={title}>
        <div className="space-y-4 pt-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <FolderOpen className="size-3.5 shrink-0" />
            <span className="truncate font-mono text-[11.5px]">{target.cwd}</span>
          </div>
          <a
            href={sshUrl(info)}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[15px] font-semibold text-primary-foreground active:bg-primary-hover"
          >
            <SquareTerminal className="size-5" /> Open in SSH app{' '}
            <ExternalLink className="size-4 opacity-80" />
          </a>
          <p className="-mt-2 text-center text-[12px] text-muted-foreground">
            Opens your SSH app if it handles ssh:// links (ConnectBot does; in others, add the host
            once).
          </p>
          {remote.command ? (
            <>
              <CopyRow
                label="Command (lands in this folder)"
                text={sshCommand(info, remote.command)}
              />
              <CopyRow label={`After logging in (${shell})`} text={remote.command} />
            </>
          ) : (
            <p className="rounded-lg bg-secondary/70 px-3 py-2.5 text-[13px] text-muted-foreground">
              {remote.note}
            </p>
          )}
          <div className="flex items-start gap-2 rounded-lg bg-secondary/70 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Tip: save <span className="font-mono">{info.host}</span> as a host in your SSH app
              (user <span className="font-mono">{info.user}</span>, port {info.port}, your key), and
              the “after logging in” line as a snippet (in Termius: Snippets), to come back here in
              one tap.
            </span>
          </div>
          {info.hostKeys && info.hostKeys.length > 0 && (
            <details className="rounded-lg border border-border px-3 py-2 text-[12.5px]">
              <summary className="cursor-pointer font-medium">
                First connect: “Trust this host?”
              </summary>
              <p className="mt-1.5 text-muted-foreground">
                Accept only if the app shows one of these fingerprints:
              </p>
              {info.hostKeys.map((k) => (
                <div key={k.fingerprint} className="selectable font-mono text-[11.5px] break-all">
                  {k.type} {k.fingerprint}
                </div>
              ))}
            </details>
          )}
          <Button variant="ghost" className="h-11 w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
