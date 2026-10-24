// "Connect your phone": a step-by-step setup with a live check (✓ / ✗ / Fix)
// at every step. Tailscale is the main route; home Wi-Fi is the other one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Apple,
  Check,
  ClipboardCopy,
  Download,
  ExternalLink,
  Globe,
  KeyRound,
  Link2,
  Loader2,
  LogIn,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Terminal,
  Wifi
} from 'lucide-react'
import {
  APP_STORE_URL,
  PLAY_STORE_URL,
  TAILSCALE_DOWNLOAD_URL,
  type ClaudeCheck,
  type LanAddress,
  type MobileStatus,
  type PairingInfo
} from '@shared/mobile'
import { api } from '@/lib/api'
import { tailscaleLinkIn, useMobileStatus } from '@/lib/mobile-status'
import { cn } from '@/lib/utils'
import { QrCode } from '../QrCode'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader } from '../ui/dialog'
import { Countdown, Mark, PhonePicture, Status, Steps, type Step } from './wizard-parts'

function useClaudeCheck(): [ClaudeCheck | null, () => void, boolean] {
  const [c, setC] = useState<ClaudeCheck | null>(null)
  const [busy, setBusy] = useState(true)
  const load = useCallback(() => {
    void api
      .mobileClaudeCheck()
      .then(setC)
      .finally(() => setBusy(false))
  }, [])
  useEffect(load, [load])
  const run = useCallback(() => {
    setBusy(true)
    load()
  }, [load])
  return [c, run, busy]
}

export function MobileWizard({
  initial,
  onClose
}: {
  initial: 'setup' | 'troubleshoot'
  onClose: () => void
}) {
  // Poll while open: the wizard waits for sign-in, pairing and so on.
  const { status, setStatus, refresh } = useMobileStatus(3000)
  // Until picked, follow the saved mode (home Wi-Fi if that's what was set up).
  const [pathChoice, setPath] = useState<'tailscale' | 'lan' | null>(null)
  const path = pathChoice ?? (status?.settings.mode === 'lan' ? 'lan' : 'tailscale')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [pairedName, setPairedName] = useState<string | null>(null)
  const [phoneDone, setPhoneDone] = useState(false)
  const [tested, setTested] = useState<number | null>(null)
  const [lan, setLan] = useState<LanAddress[]>([])
  const [claude, rerunClaude, claudeBusy] = useClaudeCheck()
  const [troubleshoot, setTroubleshoot] = useState(initial === 'troubleshoot')
  const devicesAtPairing = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (path === 'lan') void api.mobileLanAddresses().then(setLan)
  }, [path])

  // A new phone appeared while pairing: done.
  useEffect(() => {
    if (!pairing || !status) return
    const added = status.devices.find((d) => !devicesAtPairing.current.has(d.id))
    if (added) {
      setPairedName(added.name)
      setPairing(null)
    }
  }, [status, pairing])

  const act = useCallback(
    async (id: string, fn: () => Promise<unknown>): Promise<void> => {
      setBusy(id)
      try {
        await fn()
      } catch (err) {
        toast.error('That didn’t work', { description: (err as Error).message })
      } finally {
        setBusy(null)
        void refresh()
      }
    },
    [refresh]
  )

  const steps = useMemo<Step[]>(() => {
    if (!status) return []
    const ts = status.tailscale
    const s = status.settings
    const serving = status.running && s.mode === path && (path === 'lan' || ts?.serve === 'on')
    const link = tailscaleLinkIn(status.error)
    const anyConnected = status.devices.some((d) => d.connected)

    const pairStep: Step = {
      id: 'pair',
      title: 'Pair your phone',
      check: pairedName ? 'ok' : pairing ? 'wait' : status.devices.length ? 'ok' : 'todo',
      render: () => (
        <div className="space-y-3">
          {!serving && <Status c="todo">Turn on phone access first (the step before).</Status>}
          {pairing ? (
            <div className="flex gap-5">
              <QrCode value={pairing.url} size={176} label="Pairing QR code" />
              <div className="min-w-0 flex-1 space-y-2 text-[13px]">
                <Steps
                  items={[
                    path === 'tailscale'
                      ? 'Make sure Tailscale is on on your phone.'
                      : 'Make sure your phone is on the same Wi-Fi as this PC.',
                    'Open the camera and scan this code, then tap the link.',
                    ...(path === 'lan'
                      ? [
                          'Your phone warns the connection isn’t private: that’s expected here. Tap “Show details” → “visit this website”.'
                        ]
                      : []),
                    'Tap “Pair this phone”.'
                  ]}
                />
                <div className="rounded-lg bg-secondary px-3 py-2">
                  <div className="text-xs text-muted-foreground">Or type this code</div>
                  <div className="font-mono text-[20px] font-semibold tracking-[0.15em]">
                    {pairing.code}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Works once · expires in <Countdown until={pairing.expiresAt} />
                  </div>
                </div>
                {path === 'lan' && status.certFingerprint && (
                  <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-relaxed">
                    Before you tap “Proceed”, open the warning’s certificate details on the phone
                    and check its SHA-256 fingerprint starts with{' '}
                    <span className="font-mono font-semibold">
                      {status.certFingerprint.slice(0, 23)}
                    </span>
                    . If it doesn’t, someone else is answering: don’t pair.
                  </div>
                )}
                <div
                  className="truncate font-mono text-[11px] text-muted-foreground"
                  title={pairing.url.split('#')[0]}
                >
                  {pairing.url.split('#')[0]}
                </div>
              </div>
            </div>
          ) : pairedName ? (
            <Status c="ok">
              Phone connected ✓ <b>{pairedName}</b> is paired.
            </Status>
          ) : (
            <>
              {status.devices.length > 0 && (
                <Status c="ok">
                  {status.devices.length} phone{status.devices.length === 1 ? ' is' : 's are'}{' '}
                  paired already. Pair another one below if you like.
                </Status>
              )}
              <Button
                variant="primary"
                disabled={!serving || busy === 'pair'}
                onClick={() =>
                  void act('pair', async () => {
                    devicesAtPairing.current = new Set(status.devices.map((d) => d.id))
                    const r = await api.mobilePair()
                    if ('error' in r) throw new Error(r.error)
                    setPairing(r)
                  })
                }
              >
                <Link2 /> Show pairing code
              </Button>
            </>
          )}
        </div>
      )
    }

    const testStep: Step = {
      id: 'test',
      title: 'Test it',
      check:
        tested !== null && tested > 0
          ? 'ok'
          : tested === 0
            ? 'fail'
            : anyConnected
              ? 'todo'
              : 'todo',
      render: () => (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            Sends a message to every phone that has the dashboard open. It should pop up at the top
            of your phone’s screen within a second.
          </p>
          <Button
            variant="primary"
            disabled={busy === 'test'}
            onClick={() => void act('test', async () => setTested(await api.mobileSendTest()))}
          >
            <Send /> Send test
          </Button>
          {tested !== null &&
            (tested > 0 ? (
              <Status c="ok">
                Sent to {tested} connection{tested === 1 ? '' : 's'}. You should see “Hello from
                your PC 👋” on your phone.
              </Status>
            ) : (
              <Status c="fail">
                No phone is connected right now. Open the dashboard on your phone (or the
                home-screen icon), then try again.
              </Status>
            ))}
        </div>
      )
    }

    const claudeStep: Step = {
      id: 'claude',
      title: 'Remote Control check',
      check: claudeBusy
        ? 'wait'
        : !claude
          ? 'todo'
          : claude.found &&
              claude.versionOk &&
              claude.loggedIn &&
              claude.authMethod === 'claude.ai' &&
              !claude.blockingEnv.length
            ? 'ok'
            : 'fail',
      render: () => (
        <div className="space-y-2.5">
          <p className="text-[13px] text-muted-foreground">
            Remote Control lets you continue a session from the Claude app. It needs Claude Code
            2.1.51 or later, signed in with your Claude subscription.
          </p>
          {claude && (
            <>
              <Status c={claude.found && claude.versionOk ? 'ok' : 'fail'}>
                {claude.found
                  ? `Claude Code ${claude.version ?? '(unknown version)'}${claude.versionOk ? '' : ' is too old: run “claude update” in a terminal.'}`
                  : "Claude Code wasn't found on this PC's PATH."}
              </Status>
              <Status c={claude.loggedIn && claude.authMethod === 'claude.ai' ? 'ok' : 'fail'}>
                {claude.loggedIn
                  ? claude.authMethod === 'claude.ai'
                    ? `Signed in with your Claude subscription${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}.`
                    : 'Signed in with an API key: Remote Control needs a claude.ai login. Run “claude auth login” and choose your Claude account.'
                  : 'Not signed in. Run “claude” in a terminal and use /login with your Claude account.'}
              </Status>
              {claude.blockingEnv.length > 0 && (
                <Status c="fail">
                  {claude.blockingEnv.join(' and ')}{' '}
                  {claude.blockingEnv.length === 1 ? 'is' : 'are'} set on this PC, which turns
                  Remote Control off. Remove {claude.blockingEnv.length === 1 ? 'it' : 'them'} from
                  your environment variables.
                </Status>
              )}
              {claude.apiKeyEnv.length > 0 && (
                <Status c="todo">
                  {claude.apiKeyEnv.join(' and ')} {claude.apiKeyEnv.length === 1 ? 'is' : 'are'}{' '}
                  set on this PC. Launches from the app remove{' '}
                  {claude.apiKeyEnv.length === 1 ? 'it' : 'them'} for Remote Control, but WSL shells
                  that set it themselves would still use the API key.
                </Status>
              )}
            </>
          )}
          <Button variant="outline" size="sm" onClick={rerunClaude} disabled={claudeBusy}>
            <RefreshCw className={cn(claudeBusy && 'animate-spin')} /> Check again
          </Button>
        </div>
      )
    }

    if (path === 'lan') {
      return [
        {
          id: 'address',
          title: 'Choose the network',
          check:
            s.lanAddress && lan.some((a) => a.address === s.lanAddress) && s.mode === 'lan'
              ? 'ok'
              : 'todo',
          render: () => (
            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                Pick this PC’s address on your home Wi-Fi. Phones on other networks can’t reach it.
              </p>
              <div className="space-y-1.5">
                {lan.map((a) => (
                  <label
                    key={a.address}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-[13px]"
                  >
                    <input
                      type="radio"
                      name="lan"
                      checked={s.lanAddress === a.address && s.mode === 'lan'}
                      onChange={() =>
                        void act('lan', async () =>
                          setStatus(await api.mobileUpdate({ mode: 'lan', lanAddress: a.address }))
                        )
                      }
                    />
                    <span className="font-mono">{a.address}</span>
                    <span className="text-muted-foreground">{a.interface}</span>
                  </label>
                ))}
                {lan.length === 0 && (
                  <Status c="fail">
                    No private network address found. Is this PC on Wi-Fi or Ethernet?
                  </Status>
                )}
              </div>
            </div>
          )
        },
        {
          id: 'firewall',
          title: 'Allow it in Windows Firewall',
          check: status.firewallRule ? 'ok' : 'todo',
          render: () => (
            <div className="space-y-3">
              <p className="text-[13px] text-muted-foreground">
                Adds one rule: only this app, only its port and address, only from your local
                network, only when Windows treats the network as Private. You’ll see the exact
                command and Windows asks for administrator rights.
              </p>
              {status.firewallRule ? (
                <Status c="ok">The rule is in place.</Status>
              ) : (
                <Button
                  variant="primary"
                  disabled={!s.lanAddress || busy === 'fw'}
                  onClick={() => void act('fw', () => api.mobileFirewallAdd())}
                >
                  <ShieldCheck /> Add firewall rule…
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                If your phone still can’t connect, set this Wi-Fi to “Private” in Windows Settings →
                Network &amp; internet.
              </p>
            </div>
          )
        },
        {
          id: 'on',
          title: 'Turn on phone access',
          check: busy === 'on' ? 'wait' : serving ? 'ok' : status.error ? 'fail' : 'todo',
          render: () => (
            <div className="space-y-3">
              {serving ? (
                <Status c="ok">
                  Listening on <span className="font-mono">{status.listening}</span> with a
                  self-signed certificate.
                </Status>
              ) : (
                <>
                  {status.error && <Status c="fail">{status.error}</Status>}
                  <Button
                    variant="primary"
                    disabled={busy === 'on'}
                    onClick={() => void act('on', async () => setStatus(await api.mobileStart()))}
                  >
                    <Play className="fill-current" /> Turn on
                  </Button>
                </>
              )}
            </div>
          )
        },
        pairStep,
        testStep,
        claudeStep
      ]
    }

    return [
      {
        id: 'install',
        title: 'Tailscale on this PC',
        check: !ts ? 'wait' : ts.installed ? 'ok' : 'fail',
        render: () => (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              Tailscale makes a private network between your own devices. Your phone reaches this PC
              through it from anywhere, and nobody else can.
            </p>
            {ts?.installed ? (
              <Status c="ok">Tailscale {ts.version ?? ''} is installed.</Status>
            ) : (
              <>
                <Status c="fail">Tailscale isn’t installed on this PC.</Status>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={busy === 'install'}
                    onClick={() => void act('install', () => api.tailscaleInstall())}
                  >
                    <Download /> Install for me
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void api.openExternal(TAILSCALE_DOWNLOAD_URL)}
                  >
                    <ExternalLink /> Download page
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  “Install for me” runs{' '}
                  <span className="font-mono">winget install Tailscale.Tailscale</span> in a window
                  you can watch (you’re asked first). This page checks again every few seconds.
                </p>
              </>
            )}
          </div>
        )
      },
      {
        id: 'login',
        title: 'Sign in to Tailscale',
        check: !ts?.installed ? 'todo' : ts.loggedIn ? 'ok' : busy === 'login' ? 'wait' : 'fail',
        render: () => (
          <div className="space-y-3">
            {ts?.loggedIn ? (
              <Status c="ok">
                Connected to <b>{ts.tailnet ?? 'your tailnet'}</b> as{' '}
                <span className="font-mono">{ts.dnsName}</span>.
              </Status>
            ) : (
              <>
                <Status c={ts?.installed ? 'fail' : 'todo'}>
                  {ts?.installed
                    ? `Not signed in yet${ts.backendState ? ` (${ts.backendState})` : ''}.`
                    : 'Install Tailscale first.'}
                </Status>
                <Button
                  variant="primary"
                  disabled={!ts?.installed || busy === 'login'}
                  onClick={() => void act('login', () => api.tailscaleLogin())}
                >
                  <LogIn /> Sign in
                </Button>
                <p className="text-xs text-muted-foreground">
                  Opens Tailscale’s sign-in page in your browser. Use an account you can also use on
                  your phone (Google, Apple, Microsoft or GitHub). This step turns ✓ by itself when
                  you’re connected.
                </p>
              </>
            )}
          </div>
        )
      },
      {
        id: 'phone',
        title: 'Tailscale on your phone',
        check: ts?.phones?.some((p) => p.online) ? 'ok' : phoneDone ? 'ok' : 'todo',
        render: () => (
          <div className="space-y-4">
            <div className="flex gap-6">
              <div className="flex flex-col items-center gap-1.5">
                <QrCode value={APP_STORE_URL} size={112} label="Tailscale on the App Store" />
                <span className="flex items-center gap-1 text-xs font-medium">
                  <Apple className="size-3.5" /> iPhone · App Store
                </span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <QrCode value={PLAY_STORE_URL} size={112} label="Tailscale on Google Play" />
                <span className="flex items-center gap-1 text-xs font-medium">
                  <Play className="size-3.5" /> Android · Google Play
                </span>
              </div>
            </div>
            <div className="flex items-start gap-4">
              <div className="flex gap-2">
                <PhonePicture>
                  <Download className="size-4" />
                  Install Tailscale
                </PhonePicture>
                <PhonePicture>
                  <KeyRound className="size-4" />
                  Same account
                </PhonePicture>
                <PhonePicture>
                  <span className="flex h-3.5 w-6 items-center rounded-full bg-success px-0.5">
                    <span className="ml-auto size-2.5 rounded-full bg-white" />
                  </span>
                  Connected
                </PhonePicture>
              </div>
              <Steps
                items={[
                  'Scan a code with your phone’s camera and install Tailscale.',
                  `Open it and sign in with the same account${ts?.tailnet ? ` (${ts.tailnet})` : ''}.`,
                  'Allow the VPN when asked, and leave the switch on.'
                ]}
              />
            </div>
            {ts?.phones?.length ? (
              <Status c={ts.phones.some((p) => p.online) ? 'ok' : 'todo'}>
                Found on your tailnet:{' '}
                {ts.phones
                  .map((p) => `${p.name} (${p.os}${p.online ? ', online' : ', offline'})`)
                  .join(', ')}
              </Status>
            ) : (
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={phoneDone}
                  onChange={(e) => setPhoneDone(e.target.checked)}
                />
                I’ve done this
              </label>
            )}
          </div>
        )
      },
      {
        id: 'on',
        title: 'Turn on phone access',
        check: busy === 'on' ? 'wait' : serving ? 'ok' : status.error ? 'fail' : 'todo',
        render: () => (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              Starts the companion on this PC (127.0.0.1 only) and runs{' '}
              <span className="font-mono">tailscale serve</span> so it’s reachable at an HTTPS
              address on your tailnet, and only there. Never Funnel, never the public internet.
              Turning it off removes only this one rule.
            </p>
            {serving ? (
              <Status c="ok">
                Reachable at <span className="font-mono">{status.url}</span>
              </Status>
            ) : link ? (
              <>
                <Status c="fail">
                  Tailscale needs HTTPS certificates turned on for your tailnet first. It’s one
                  click on Tailscale’s site.
                </Status>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => void api.openTailscaleLink(link)}>
                    <ExternalLink /> Turn on HTTPS
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy === 'on'}
                    onClick={() =>
                      void act('on', async () => setStatus(await api.mobileRetryServe()))
                    }
                  >
                    <RefreshCw /> Try again
                  </Button>
                </div>
              </>
            ) : (
              <>
                {status.error && <Status c="fail">{status.error}</Status>}
                {ts?.loggedIn && ts.httpsEnabled === false && !status.error && (
                  <Status c="todo">
                    HTTPS certificates look off for your tailnet; the next step may ask you to turn
                    them on.
                  </Status>
                )}
                <Button
                  variant="primary"
                  disabled={!ts?.loggedIn || busy === 'on'}
                  onClick={() =>
                    void act('on', async () => {
                      if (status.settings.mode !== 'tailscale')
                        await api.mobileUpdate({ mode: 'tailscale' })
                      setStatus(
                        status.running ? await api.mobileRetryServe() : await api.mobileStart()
                      )
                    })
                  }
                >
                  <Globe /> Turn on phone access
                </Button>
              </>
            )}
          </div>
        )
      },
      pairStep,
      testStep,
      claudeStep
    ]
  }, [
    status,
    path,
    busy,
    pairing,
    pairedName,
    phoneDone,
    tested,
    lan,
    claude,
    claudeBusy,
    rerunClaude,
    setStatus,
    act
  ])

  const step = steps[Math.min(active, steps.length - 1)]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[820px]">
        <DialogHeader
          icon={
            <div className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
              <Smartphone className="size-4" />
            </div>
          }
          title={troubleshoot ? 'Troubleshooting' : 'Connect your phone'}
          description={
            troubleshoot
              ? 'Common fixes, a fresh check of everything, and diagnostics you can share (no secrets in them).'
              : 'About five minutes. Every step checks itself.'
          }
        />
        {troubleshoot ? (
          <Troubleshooting
            status={status}
            onRecheck={() => void refresh()}
            onBack={() => setTroubleshoot(false)}
          />
        ) : (
          <div className="grid grid-cols-[230px_minmax(0,1fr)] gap-0 border-t border-border">
            <nav className="space-y-0.5 border-r border-border bg-chrome/50 p-3">
              <div className="mb-2 flex rounded-lg bg-secondary p-0.5 text-[12px] font-medium">
                {(
                  [
                    ['tailscale', 'Tailscale', Globe],
                    ['lan', 'Home Wi-Fi', Wifi]
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setPath(id)
                      setActive(0)
                    }}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1 rounded-md py-1.5',
                      path === id ? 'bg-background shadow-sm' : 'text-muted-foreground'
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              {steps.map((st, i) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setActive(i)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]',
                    i === active ? 'bg-selected font-medium' : 'hover:bg-hover'
                  )}
                >
                  <Mark c={st.check} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10.5px] text-subtle-foreground">Step {i + 1}</span>
                    {st.title}
                  </span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setTroubleshoot(true)}
                className="mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-muted-foreground hover:bg-hover"
              >
                <Terminal className="size-3.5" /> Troubleshooting
              </button>
            </nav>
            <div className="flex min-h-[420px] flex-col p-5">
              {!step ? (
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Checking…
                </div>
              ) : (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <Mark c={step.check} />
                    <h3 className="text-[15px] font-semibold">{step.title}</h3>
                  </div>
                  <div className="flex-1">{step.render()}</div>
                  <div className="mt-5 flex items-center justify-between">
                    <Button
                      variant="ghost"
                      disabled={active === 0}
                      onClick={() => setActive((a) => a - 1)}
                    >
                      Back
                    </Button>
                    {active < steps.length - 1 ? (
                      <Button
                        variant={step.check === 'ok' ? 'primary' : 'outline'}
                        onClick={() => setActive((a) => a + 1)}
                      >
                        Next
                      </Button>
                    ) : (
                      <Button variant="primary" onClick={onClose}>
                        <Check /> Done
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

const FIXES: [string, string][] = [
  [
    'The phone can’t open the address',
    'Check that the Tailscale switch is on on the phone and that both devices show as connected in the Tailscale app. On home Wi-Fi, check the phone is on the same network.'
  ],
  [
    '“Tailscale needs HTTPS” or serve fails',
    'Turn on HTTPS certificates in the Tailscale admin console (DNS page), then click “Try again”. MagicDNS must be on too.'
  ],
  [
    'Port already in use',
    'Another program or Tailscale serve rule uses the port. Change “Local port” or “Tailscale HTTPS port” under Settings → Phone → Advanced.'
  ],
  [
    '“This phone is not paired” on the phone',
    'The phone was revoked or unused for 30 days. Show a new pairing code here and pair it again.'
  ],
  [
    'Remote Control doesn’t start',
    'Update Claude Code (claude update), sign in with your Claude account (claude auth login), and make sure CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC isn’t set.'
  ],
  [
    'Home Wi-Fi: certificate warning, or no live updates',
    'Home Wi-Fi uses a self-signed certificate, so the phone warns once. Some phones also block live updates over it; the app then refreshes every 20 seconds. Tailscale avoids both.'
  ]
]

function Troubleshooting({
  status,
  onRecheck,
  onBack
}: {
  status: MobileStatus | null
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
          Now: phone access {status.running ? 'on' : 'off'} ·{' '}
          {status.settings.mode === 'lan' ? 'home Wi-Fi' : 'Tailscale'} · Tailscale{' '}
          {status.tailscale?.installed
            ? status.tailscale.loggedIn
              ? 'signed in'
              : 'signed out'
            : 'not installed'}{' '}
          · serve {status.tailscale?.serve ?? '?'} · {status.devices.length} paired
          {status.error ? ` · ${status.error.replace(/https:\/\/\S+/g, '(link)')}` : ''}
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
              .mobileDiagnostics()
              .then((t) => api.copyText(t))
              .then(() =>
                toast.success('Diagnostics copied', {
                  description: 'No tokens, codes, keys or e-mail in them.'
                })
              )
              .finally(() => setCopying(false))
          }}
        >
          <ClipboardCopy /> Copy diagnostics
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onBack}>
          Back to setup
        </Button>
      </div>
    </div>
  )
}
