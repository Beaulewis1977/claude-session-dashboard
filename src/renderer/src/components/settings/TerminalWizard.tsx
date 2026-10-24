// "Terminal access": set up Windows' OpenSSH Server so a phone can open a
// real terminal on this PC over Tailscale. Every step checks itself (✓ / ✗)
// and every change is shown first, confirmed, logged and can be undone.

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Apple,
  Check,
  ClipboardCopy,
  Copy,
  Download,
  FolderOpen,
  KeyRound,
  LogIn,
  Play,
  RefreshCw,
  Smartphone,
  SquareTerminal,
  Terminal,
  Undo2,
  X
} from 'lucide-react'
import {
  ASHELL_IOS_URL,
  CONNECTBOT_ANDROID_URL,
  keyFingerprint,
  parsePublicKey,
  sshCommand,
  sshUrl,
  TERMIUS_ANDROID_URL,
  TERMIUS_IOS_URL,
  type TerminalAccessInfo,
  type TerminalStatus
} from '@shared/terminal'
import { formatDateTime } from '@shared/format'
import { api } from '@/lib/api'
import { useMobileStatus } from '@/lib/mobile-status'
import { cn } from '@/lib/utils'
import { QrCode } from '../QrCode'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader } from '../ui/dialog'
import { Textarea } from '../ui/input'
import { useChange, useTerminalStatus } from './terminal-change'
import { Countdown, PhonePicture, Status, Steps, WizardFrame, type Step } from './wizard-parts'

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="selectable min-w-0 flex-1 truncate font-mono text-[12.5px]">{value}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void api.copyText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

function Undo({
  onClick,
  disabled,
  children
}: {
  onClick: () => void
  disabled?: boolean
  children: string
}) {
  return (
    <Button variant="ghost" size="xs" disabled={disabled} onClick={onClick}>
      <Undo2 /> {children}
    </Button>
  )
}

/** The phone's connection details, as the phone app would build them. */
function connectionInfo(st: TerminalStatus): TerminalAccessInfo {
  return {
    ready: st.ready,
    host: st.tailscale.dnsName,
    user: st.user,
    port: 22,
    shell: { kind: st.shell.kind, path: st.shell.path, distro: st.shell.distro }
  }
}

export function TerminalWizard({
  initial,
  onClose
}: {
  initial: 'setup' | 'troubleshoot'
  onClose: () => void
}) {
  // The probe takes a few seconds, so poll gently while open.
  const { status: st, refresh } = useTerminalStatus(5000)
  const { status: mobile } = useMobileStatus()
  const { change, busy, dialog } = useChange(() => void refresh())
  const [active, setActive] = useState(0)
  const [troubleshoot, setTroubleshoot] = useState(initial === 'troubleshoot')
  const [pasted, setPasted] = useState('')
  const [fpOf, setFpOf] = useState<{ base64: string; fp: string } | null>(null)
  const [shellPick, setShellPick] = useState<string | null>(null)
  const [keyWorks, setKeyWorks] = useState(false)
  const [appDone, setAppDone] = useState(false)
  const [connected, setConnected] = useState(false)
  const [openedAt] = useState(() => Date.now())

  const parsed = useMemo(() => (pasted.trim() ? parsePublicKey(pasted) : null), [pasted])
  useEffect(() => {
    let alive = true
    if (parsed?.ok) {
      const b = parsed.base64
      void keyFingerprint(b).then((fp) => alive && setFpOf({ base64: b, fp }))
    }
    return () => {
      alive = false
    }
  }, [parsed])
  const fp = parsed?.ok && fpOf?.base64 === parsed.base64 ? fpOf.fp : null

  const steps = useMemo<Step[]>(() => {
    if (!st) return []
    const ts = st.tailscale
    const sshOk = st.sshd.running && /^automatic/i.test(st.sshd.startType ?? '')
    // Only Tailscale can reach SSH: our rule is in, Windows' "any address" rule is off.
    const limited = st.firewall.ours && !st.firewall.defaultRule.enabled
    const keyLogin = st.lastLogin?.method === 'publickey' && st.lastLogin.tailscale
    const recentLogin =
      st.lastLogin?.tailscale && Date.parse(st.lastLogin.at) > openedAt - 15 * 60_000
    const info = connectionInfo(st)
    // One change at a time: every change button waits while one runs.
    const isBusy = (_k: string): boolean => busy !== null
    const running = (k: string): boolean => busy === k

    return [
      {
        id: 'tailscale',
        title: 'Tailscale connected',
        check: !ts.installed ? 'fail' : ts.loggedIn && ts.dnsName ? 'ok' : 'fail',
        render: () => (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              Your phone reaches this PC’s SSH server through your private Tailscale network only.
              The phone needs Tailscale too (Settings → Phone → Connect your phone covers that).
            </p>
            {ts.loggedIn && ts.dnsName ? (
              <Status c="ok">
                Connected. This PC is <span className="font-mono">{ts.dnsName}</span> on your
                tailnet.
              </Status>
            ) : !ts.installed ? (
              <>
                <Status c="fail">Tailscale isn’t installed on this PC.</Status>
                <Button variant="primary" onClick={() => void api.tailscaleInstall()}>
                  <Download /> Install for me
                </Button>
              </>
            ) : (
              <>
                <Status c="fail">Tailscale isn’t signed in.</Status>
                <Button variant="primary" onClick={() => void api.tailscaleLogin()}>
                  <LogIn /> Sign in
                </Button>
              </>
            )}
            {mobile && !mobile.tailscale?.phones?.some((p) => p.online) && ts.loggedIn && (
              <Status c="todo">
                No phone is online on your tailnet right now. Turn Tailscale on on your phone.
              </Status>
            )}
          </div>
        )
      },
      {
        id: 'sshd',
        title: 'OpenSSH Server',
        check:
          running('install') || running('service-on')
            ? 'wait'
            : sshOk
              ? 'ok'
              : st.sshd.installed
                ? 'todo'
                : 'fail',
        render: () => (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              Windows’ own SSH server (from Microsoft) handles every login. The dashboard never runs
              commands for your phone.
            </p>
            {!st.sshd.installed ? (
              <>
                <Status c="fail">OpenSSH Server isn’t installed.</Status>
                <Button
                  variant="primary"
                  disabled={isBusy('install')}
                  onClick={() => void change({ kind: 'install' })}
                >
                  <Download /> Install for me…
                </Button>
                <p className="text-xs text-muted-foreground">
                  Runs <span className="font-mono">Add-WindowsCapability OpenSSH.Server</span> as
                  administrator after you see it. It can take a few minutes.
                </p>
              </>
            ) : sshOk ? (
              <Status c="ok">
                sshd is running and starts with Windows
                {st.sshd.version ? ` (OpenSSH ${st.sshd.version})` : ''}.
              </Status>
            ) : (
              <>
                <Status c="todo">
                  Installed, but {st.sshd.running ? 'not set to start with Windows' : 'not running'}{' '}
                  (start type {st.sshd.startType ?? 'unknown'}).
                </Status>
                {!limited && (
                  <Status c="todo">
                    First limit SSH to Tailscale in the next step (Firewall). sshd is only started
                    once nothing outside Tailscale can reach it.
                  </Status>
                )}
                <Button
                  variant="primary"
                  disabled={!limited || isBusy('service-on')}
                  onClick={() => void change({ kind: 'service-on' })}
                >
                  <Play className="fill-current" /> Start and set to Automatic…
                </Button>
              </>
            )}
            <div className="flex flex-wrap gap-1">
              {st.changes.service && (
                <Undo onClick={() => void change({ kind: 'service-undo' })}>
                  {`Undo: back to ${st.changes.service.prevStartType || 'Manual'}${st.changes.service.prevStatus === 'Running' ? ', running' : ', stopped'}`}
                </Undo>
              )}
              {st.changes.installedByApp && (
                <Undo onClick={() => void change({ kind: 'uninstall' })}>
                  Uninstall OpenSSH Server
                </Undo>
              )}
            </div>
          </div>
        )
      },
      {
        id: 'firewall',
        title: 'Firewall: Tailscale only',
        check:
          st.firewall.ours && !st.firewall.defaultRule.enabled
            ? 'ok'
            : st.firewall.ours
              ? 'todo'
              : 'fail',
        render: () => (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              One Windows Firewall rule lets only sshd, only on port 22, only from Tailscale
              addresses (100.64.0.0/10 and fd7a:115c:a1e0::/48) , only on the “
              {ts.interfaceAlias ?? 'Tailscale'}” network adapter reach it. Nothing is opened on
              your router, and Tailscale Funnel is never used.
            </p>
            {st.firewall.ours ? (
              <Status c="ok">The Tailscale-only rule is in place.</Status>
            ) : (
              <Button
                variant="primary"
                disabled={isBusy('firewall-add')}
                onClick={() => void change({ kind: 'firewall-add' })}
              >
                <Smartphone /> Add the Tailscale-only rule…
              </Button>
            )}
            {st.firewall.defaultRule.exists &&
              (st.firewall.defaultRule.enabled ? (
                <>
                  <Status c="todo">
                    Windows’ own rule “OpenSSH SSH Server (sshd)” is on. It allows SSH from{' '}
                    <b>any</b> address, so devices on your home or public Wi-Fi could try to log in.
                    Turn it off so only Tailscale can reach SSH (only with your OK; Undo turns it
                    back on).
                  </Status>
                  <Button
                    variant="outline"
                    disabled={isBusy('default-rule-disable')}
                    onClick={() => void change({ kind: 'default-rule-disable' })}
                  >
                    Turn off the “any address” rule…
                  </Button>
                </>
              ) : (
                <Status c="ok">Windows’ “any address” SSH rule is off.</Status>
              ))}
            {limited && st.sshd.installed && !sshOk && (
              <Button
                variant="primary"
                disabled={isBusy('service-on')}
                onClick={() => void change({ kind: 'service-on' })}
              >
                <Play className="fill-current" /> Now start sshd and set it to Automatic…
              </Button>
            )}
            <div className="flex flex-wrap gap-1">
              {st.changes.firewallRule && (
                <Undo onClick={() => void change({ kind: 'firewall-remove' })}>
                  Remove the Tailscale-only rule
                </Undo>
              )}
              {st.changes.defaultRuleDisabled && (
                <Undo onClick={() => void change({ kind: 'default-rule-restore' })}>
                  Turn Windows’ rule back on
                </Undo>
              )}
            </div>
          </div>
        )
      },
      {
        id: 'shell',
        title: 'Default shell',
        check: st.shell.kind === 'cmd' || st.shell.kind === 'other' ? 'todo' : 'ok',
        render: () => {
          const current = st.shell.options.find(
            (o) => o.path.toLowerCase() === st.shell.path?.toLowerCase()
          )
          const pick = shellPick ?? current?.kind ?? null
          return (
            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                The shell you get when you log in. Set with the registry value{' '}
                <span className="font-mono">HKLM\SOFTWARE\OpenSSH\DefaultShell</span>.
              </p>
              <Status c={current ? 'ok' : 'todo'}>
                Now:{' '}
                <span className="font-mono">{st.shell.path ?? 'not set (logins get cmd.exe)'}</span>
              </Status>
              <div className="space-y-1.5">
                {st.shell.options.map((o) => (
                  <label
                    key={o.kind}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-[13px]',
                      o.available ? 'cursor-pointer' : 'opacity-50'
                    )}
                  >
                    <input
                      type="radio"
                      name="ssh-shell"
                      disabled={!o.available}
                      checked={pick === o.kind}
                      onChange={() => setShellPick(o.kind)}
                    />
                    <span className="font-medium">
                      {o.label}
                      {o.kind === 'wsl' && st.shell.defaultDistro
                        ? ` (${st.shell.defaultDistro})`
                        : ''}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {o.available ? o.path : 'not installed'}
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  disabled={!pick || pick === current?.kind || isBusy('shell-set')}
                  onClick={() =>
                    pick &&
                    void change({ kind: 'shell-set', shell: pick as 'pwsh' | 'powershell' | 'wsl' })
                  }
                >
                  <Terminal /> Use this shell…
                </Button>
                {st.changes.shell && (
                  <Undo onClick={() => void change({ kind: 'shell-restore' })}>
                    {`Undo: back to ${st.changes.shell.prevValue ?? 'not set'}`}
                  </Undo>
                )}
              </div>
              {pick === 'wsl' && (
                <p className="text-xs text-muted-foreground">
                  WSL logins open your default distro
                  {st.shell.defaultDistro ? ` (${st.shell.defaultDistro})` : ''} through{' '}
                  <span className="font-mono">bash.exe</span>. Change the default with{' '}
                  <span className="font-mono">wsl --set-default</span>.
                </p>
              )}
            </div>
          )
        }
      },
      {
        id: 'keys',
        title: 'Keys (recommended)',
        check: keyLogin || st.changes.keys.length ? 'ok' : 'todo',
        render: () => (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              A key is safer than your Windows password. In your SSH app, create a key (ED25519),
              then copy its <b>public</b> key. It goes into{' '}
              <span className="font-mono">{st.keys.file}</span>
              {st.keys.admin ? ' (the file OpenSSH uses for administrator accounts)' : ''}. Your
              existing keys are never changed.
            </p>
            {st.pendingKey ? (
              <div className="space-y-2 rounded-lg border border-info/30 bg-info/5 p-3">
                <div className="text-[13px]">
                  <b>{st.pendingKey.device}</b> sent a {st.pendingKey.type} key
                  {st.pendingKey.comment ? ` (“${st.pendingKey.comment}”)` : ''}.
                </div>
                <div className="font-mono text-[12px] break-all">{st.pendingKey.fingerprint}</div>
                <div className="text-xs text-muted-foreground">
                  Check that the end of this fingerprint matches what your SSH app shows for the
                  key. Only then allow it.
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={isBusy('key-pending')}
                    onClick={() => void change({ kind: 'key-pending' })}
                  >
                    <Check /> Allow…
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void api.terminalRejectKey()}>
                    <X /> Reject
                  </Button>
                </div>
              </div>
            ) : st.listeningUntil ? (
              <Status c="wait">
                Waiting for your phone (<Countdown until={st.listeningUntil} />
                ). On the phone, open the dashboard → Settings → <b>Send SSH key to PC</b> and paste
                the public key there.{' '}
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto p-0"
                  onClick={() => void api.terminalListen(false)}
                >
                  Stop waiting
                </Button>
              </Status>
            ) : (
              <Button
                variant="outline"
                disabled={!mobile?.running || !mobile.devices.length}
                onClick={() => void api.terminalListen(true)}
              >
                <Smartphone /> Get key from phone
              </Button>
            )}
            {!mobile?.devices.length && !st.pendingKey && (
              <p className="text-xs text-muted-foreground">
                “Get key from phone” needs a paired phone with phone access on. Or paste the key
                below.
              </p>
            )}
            <div className="space-y-1.5">
              <Textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="ssh-ed25519 AAAAC3Nza… my-phone"
                rows={3}
                className="font-mono text-[12px]"
                aria-label="Public key"
              />
              {parsed && !parsed.ok && (
                <div className="text-xs text-destructive">{parsed.error}</div>
              )}
              {parsed?.ok && fp && (
                <div className="text-xs text-muted-foreground">
                  {parsed.type} · <span className="font-mono">{fp}</span>
                  {parsed.comment ? ` · ${parsed.comment}` : ''}
                </div>
              )}
              <Button
                variant="primary"
                disabled={!parsed?.ok || isBusy('key-add')}
                onClick={() =>
                  void change({ kind: 'key-add', key: pasted }).then((ok) => ok && setPasted(''))
                }
              >
                <KeyRound /> Add key…
              </Button>
            </div>
            {st.changes.keys.length > 0 && (
              <div className="divide-y divide-border rounded-lg border border-border">
                {st.changes.keys.map((k) => (
                  <div key={k.fingerprint} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <KeyRound className="size-3.5 shrink-0 text-success" />
                    <span className="min-w-0 flex-1 truncate font-mono">{k.fingerprint}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {k.comment ? `${k.comment} · ` : ''}added {formatDateTime(k.addedAt)}
                    </span>
                    <Undo
                      onClick={() =>
                        void change({ kind: 'key-remove', fingerprint: k.fingerprint })
                      }
                    >
                      Remove
                    </Undo>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-[13px] font-medium">Test login</div>
              {keyLogin ? (
                <Status c="ok">
                  Key login works ✓ ({st.lastLogin!.user} from {st.lastLogin!.from},{' '}
                  {formatDateTime(st.lastLogin!.at)}).
                </Status>
              ) : st.eventLogReadable ? (
                <Status c="todo">
                  Log in from your phone with the key (step 6 shows how). This turns ✓ by itself
                  when sshd records a key login from a Tailscale address.
                </Status>
              ) : (
                <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={keyWorks}
                    onChange={(e) => setKeyWorks(e.target.checked)}
                  />
                  sshd’s log can’t be read here. I logged in with my key and it worked.
                </label>
              )}
              {st.passwordAuth === 'no' ? (
                <Status c="ok">Password login is off: only keys can log in.</Status>
              ) : st.passwordAuth === 'yes' ? (
                <div className="space-y-1.5">
                  <Button
                    variant="outline"
                    disabled={!(keyLogin || keyWorks) || isBusy('password-off')}
                    onClick={() => void change({ kind: 'password-off' })}
                  >
                    Turn off password login…
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    After your key works. sshd_config is backed up first and Undo puts it back
                    exactly.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  sshd_config can’t be read yet (start OpenSSH Server once).
                </p>
              )}
              {st.changes.sshdConfig && (
                <Undo onClick={() => void change({ kind: 'password-restore' })}>
                  Undo: put sshd_config back (password login on)
                </Undo>
              )}
            </div>
          </div>
        )
      },
      {
        id: 'app',
        title: 'Phone app',
        check: appDone || keyLogin ? 'ok' : 'todo',
        render: () => (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              Any SSH app works. Termius has a free plan on iPhone and Android; a-Shell (iPhone) and
              ConnectBot (Android) are free and open source.
            </p>
            <div className="flex flex-wrap gap-5">
              {(
                [
                  [TERMIUS_IOS_URL, 'Termius', 'iPhone', Apple],
                  [TERMIUS_ANDROID_URL, 'Termius', 'Android', Play],
                  [ASHELL_IOS_URL, 'a-Shell (free)', 'iPhone', Apple],
                  [CONNECTBOT_ANDROID_URL, 'ConnectBot (free)', 'Android', Play]
                ] as const
              ).map(([url, name, os, Icon]) => (
                <div key={url} className="flex flex-col items-center gap-1">
                  <QrCode value={url} size={92} label={`${name} for ${os}`} />
                  <span className="flex items-center gap-1 text-xs font-medium">
                    <Icon className="size-3.5" /> {name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{os}</span>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-5">
              <div className="flex flex-col items-center gap-1">
                <QrCode value={sshUrl(info)} size={112} label="Connection details" />
                <span className="text-[11px] text-muted-foreground">Scan in your SSH app</span>
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <CopyField label="Host" value={info.host ?? '(sign in to Tailscale first)'} />
                <CopyField label="User" value={info.user ?? ''} />
                <CopyField label="Port" value="22" />
                <CopyField label="Command" value={sshCommand(info)} />
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="flex gap-2">
                <PhonePicture>
                  <KeyRound className="size-4" />
                  New key
                </PhonePicture>
                <PhonePicture>
                  <SquareTerminal className="size-4" />
                  New host
                </PhonePicture>
              </div>
              <Steps
                items={[
                  'Install an SSH app (codes above) and keep Tailscale on on the phone.',
                  'Create a key in the app and add its public key in step 5.',
                  'Add a host: the host name, user and port above, with that key. Then connect.'
                ]}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={appDone}
                onChange={(e) => setAppDone(e.target.checked)}
              />
              I’ve set up the app
            </label>
          </div>
        )
      },
      {
        id: 'test',
        title: 'Test',
        check: recentLogin || connected ? 'ok' : 'todo',
        render: () => (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              Connect from your phone now. This turns ✓ when sshd records a login from a Tailscale
              address.
            </p>
            {st.lastLogin?.tailscale && recentLogin ? (
              <Status c="ok">
                Connected ✓ <b>{st.lastLogin.user}</b> logged in from {st.lastLogin.from} with{' '}
                {st.lastLogin.method === 'publickey' ? 'a key' : 'a password'} at{' '}
                {formatDateTime(st.lastLogin.at)}.
              </Status>
            ) : st.lastLogin && !st.lastLogin.tailscale ? (
              <Status c="fail">
                The last login came from {st.lastLogin.from}, which isn’t a Tailscale address. Check
                the firewall step.
              </Status>
            ) : (
              <Status c={st.eventLogReadable ? 'wait' : 'todo'}>
                {st.eventLogReadable
                  ? 'Waiting for a login…'
                  : 'sshd’s log can’t be read here, so tick the box when you’re in.'}
              </Status>
            )}
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                <RefreshCw /> Check again
              </Button>
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={connected}
                  onChange={(e) => setConnected(e.target.checked)}
                />
                I’m connected
              </label>
            </div>
            {st.ready && (
              <Status c="ok">
                Terminal access is set up. “Open terminal here” now shows on your phone for each
                session and project.
              </Status>
            )}
          </div>
        )
      }
    ]
  }, [
    st,
    mobile,
    busy,
    change,
    refresh,
    pasted,
    parsed,
    fp,
    shellPick,
    keyWorks,
    appDone,
    connected,
    openedAt
  ])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[860px]">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <SquareTerminal className="size-4" />
            </div>
          }
          title={troubleshoot ? 'Terminal access: troubleshooting' : 'Terminal access'}
          description={
            troubleshoot
              ? 'Common fixes, a fresh check of everything, and diagnostics you can share (no keys in them).'
              : 'A real terminal on this PC from your phone, over Tailscale only. Every change is shown first and can be undone.'
          }
        />
        {troubleshoot ? (
          <TerminalTroubleshooting
            status={st}
            onRecheck={() => void refresh()}
            onBack={() => setTroubleshoot(false)}
          />
        ) : (
          <WizardFrame
            steps={steps}
            active={active}
            setActive={setActive}
            onDone={onClose}
            footer={
              <button
                type="button"
                onClick={() => setTroubleshoot(true)}
                className="mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-muted-foreground hover:bg-hover"
              >
                <Terminal className="size-3.5" /> Troubleshooting
              </button>
            }
          />
        )}
        {dialog}
      </DialogContent>
    </Dialog>
  )
}

const FIXES: [string, string][] = [
  [
    'The SSH app times out',
    'Check Tailscale is on on the phone and both devices show as connected. Use the host name from step 6 (it only works over Tailscale), and check the Tailscale-only firewall rule is in place.'
  ],
  [
    '“Permission denied (publickey)”',
    'The key wasn’t added, or the app uses a different key. Compare the fingerprint in step 5 with the app’s. For administrator accounts the key must be in C:\\ProgramData\\ssh\\administrators_authorized_keys (the wizard does this).'
  ],
  [
    'Password is rejected',
    'Use your Windows password (for a Microsoft account, the account password, not the PIN). If you turned off password login, use your key, or undo that in step 5.'
  ],
  [
    'Wrong shell, or the folder command fails',
    'Change the default shell in step 4. The phone’s “Copy command” is built for the shell set there.'
  ],
  [
    'sshd won’t start',
    'Open Services on the PC and check “OpenSSH SSH Server”. A broken sshd_config stops it: if the wizard changed it, undo that in step 5.'
  ],
  [
    '“Connected ✓” never appears',
    'Windows may not let the app read sshd’s event log. Tick “I’m connected” instead; everything else still works.'
  ]
]

function TerminalTroubleshooting({
  status,
  onRecheck,
  onBack
}: {
  status: TerminalStatus | null
  onRecheck: () => void
  onBack: () => void
}) {
  const [copying, setCopying] = useState(false)
  return (
    <div className="space-y-4 border-t border-border p-5">
      <div className="grid gap-2 sm:grid-cols-2">
        {FIXES.map(([q, a]) => (
          <div key={q} className="rounded-lg border border-border p-3">
            <div className="text-[13px] font-medium">{q}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{a}</div>
          </div>
        ))}
      </div>
      {status && (
        <div className="rounded-lg bg-secondary/70 px-3 py-2 text-xs text-muted-foreground">
          Now: OpenSSH{' '}
          {status.sshd.installed ? (status.sshd.running ? 'running' : 'stopped') : 'not installed'}{' '}
          · Tailscale-only rule {status.firewall.ours ? 'on' : 'missing'} · “any address” rule{' '}
          {status.firewall.defaultRule.exists
            ? status.firewall.defaultRule.enabled
              ? 'on'
              : 'off'
            : 'absent'}{' '}
          · shell {status.shell.kind} · password login {status.passwordAuth} ·{' '}
          {status.ready ? 'ready' : 'not ready'}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onRecheck}>
          <RefreshCw /> Re-run checks
        </Button>
        <Button
          variant="outline"
          disabled={copying}
          onClick={() => {
            setCopying(true)
            void api
              .terminalDiagnostics()
              .then((t) => api.copyText(t))
              .then(() => toast.success('Diagnostics copied', { description: 'No keys in them.' }))
              .finally(() => setCopying(false))
          }}
        >
          <ClipboardCopy /> Copy diagnostics
        </Button>
        <Button variant="outline" onClick={() => void api.terminalOpenBackups()}>
          <FolderOpen /> Open backups folder
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onBack}>
          Back to setup
        </Button>
      </div>
    </div>
  )
}
