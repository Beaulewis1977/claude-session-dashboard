// Settings → Phone: the companion server, its connection mode, paired phones,
// security switches and the activity log. Desktop only.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Activity,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wand2,
  Wifi,
  X
} from 'lucide-react'
import type { ActivityEntry, LanAddress, MobileSettings as MS } from '@shared/mobile'
import { formatDateTime, formatRelative } from '@shared/format'
import { api } from '@/lib/api'
import { tailscaleLinkIn, useMobileStatus } from '@/lib/mobile-status'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Row, Section } from '../SettingsView'
import { MobileWizard } from './MobileWizard'
import { TerminalAccessBlock } from './TerminalAccessSettings'

function ActivityLog() {
  const [items, setItems] = useState<ActivityEntry[] | null>(null)
  useEffect(() => {
    const load = (): void => void api.mobileActivity().then(setItems)
    load()
    return api.onMobileChanged(load)
  }, [])
  if (!items) return null
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
      {items.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">Nothing yet.</div>
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
                    <CircleAlert className="size-3.5 text-warning" aria-label="Refused or failed" />
                  )}
                </td>
                <td className="py-1.5 pr-2 font-medium whitespace-nowrap">{e.device ?? 'PC'}</td>
                <td className="py-1.5 pr-3 text-muted-foreground">
                  <span className="text-foreground/80">{e.action}</span>
                  {e.detail ? ` · ${e.detail}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function MobileSettingsSection() {
  const { status, setStatus, refresh } = useMobileStatus()
  const [busy, setBusy] = useState(false)
  const [wizard, setWizard] = useState<false | 'setup' | 'troubleshoot'>(false)
  const [lan, setLan] = useState<LanAddress[]>([])
  const [copied, setCopied] = useState(false)
  const s = status?.settings

  useEffect(() => {
    if (s?.mode === 'lan') void api.mobileLanAddresses().then(setLan)
  }, [s?.mode])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error('Something went wrong', { description: (err as Error).message })
    } finally {
      setBusy(false)
      void refresh()
    }
  }
  const update = (patch: Partial<MS>): Promise<void> =>
    run(async () => setStatus(await api.mobileUpdate(patch)))

  if (!status || !s) return null
  const link = tailscaleLinkIn(status.error)
  const connected = status.devices.filter((d) => d.connected).length

  return (
    <Section
      title="Phone"
      description={
        <>
          Use the dashboard on your phone: search and read sessions, check usage, and resume
          sessions on this PC with Remote Control. Off by default. It's reachable only through your
          own Tailscale network (or your home Wi-Fi, if you choose), and only by phones you pair.
        </>
      }
    >
      <div className="rounded-xl border border-border p-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg',
              status.running ? 'bg-success/10 text-success' : 'bg-secondary text-muted-foreground'
            )}
          >
            <Smartphone className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">
              {status.running
                ? status.url
                  ? `On · ${connected} phone${connected === 1 ? '' : 's'} connected`
                  : 'On · not reachable from the phone yet'
                : 'Off'}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {status.running
                ? (status.url ?? `Listening on ${status.listening} (this PC only)`)
                : 'Nothing listens for phones while this is off.'}
            </div>
          </div>
          {status.url && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy address"
              onClick={() => {
                void api.copyText(status.url!)
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          )}
          <Switch
            checked={status.running}
            disabled={busy}
            onCheckedChange={(on) =>
              void run(async () => setStatus(on ? await api.mobileStart() : await api.mobileStop()))
            }
            aria-label="Phone access"
          />
        </div>
        {status.error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs">
            <CircleAlert className="mt-px size-3.5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 break-words">
              {link
                ? 'Tailscale needs you to turn on HTTPS certificates for your tailnet (one click).'
                : status.error}
            </div>
            {link && (
              <Button variant="outline" size="xs" onClick={() => void api.openTailscaleLink(link)}>
                <ExternalLink /> Open Tailscale
              </Button>
            )}
            {link && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void run(async () => setStatus(await api.mobileRetryServe()))}
              >
                Try again
              </Button>
            )}
          </div>
        )}
        {status.webAppMissing && (
          <div className="mt-3 text-xs text-warning">
            The phone app isn't built yet: run <span className="font-mono">npm run build</span>{' '}
            first.
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => setWizard('setup')}>
            <Wand2 /> Connect your phone…
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setWizard('troubleshoot')}>
            Troubleshooting
          </Button>
          {busy && <Loader2 className="size-4 animate-spin self-center text-muted-foreground" />}
        </div>
      </div>

      <Row
        label="Connection"
        hint={
          s.mode === 'tailscale'
            ? 'Recommended. Your phone reaches this PC through your private Tailscale network, from anywhere, with a real HTTPS certificate. Never public.'
            : 'Only phones on the same Wi-Fi. Uses a self-signed certificate (your phone warns once) and a Windows Firewall rule limited to private networks.'
        }
      >
        <Segmented
          ariaLabel="Connection"
          value={s.mode}
          onChange={(mode) => void update({ mode })}
          options={[
            { value: 'tailscale', label: 'Tailscale', icon: <Globe /> },
            { value: 'lan', label: 'Home Wi-Fi', icon: <Wifi /> }
          ]}
        />
      </Row>
      {s.mode === 'lan' && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <Row label="Network address" hint="The PC's address on your home network.">
            <select
              value={s.lanAddress ?? ''}
              onChange={(e) => void update({ lanAddress: e.target.value })}
              className="h-8 rounded-md border border-border-strong bg-background px-2 text-[13px]"
              aria-label="Network address"
            >
              <option value="" disabled>
                Choose…
              </option>
              {lan.map((a) => (
                <option key={a.address} value={a.address}>
                  {a.address} ({a.interface})
                </option>
              ))}
            </select>
          </Row>
          {status.certFingerprint && (
            <Row
              label="Certificate fingerprint"
              hint="When your phone warns about the certificate, its SHA-256 fingerprint must match this. Launches from a phone are confirmed here in this mode."
            >
              <span className="selectable block max-w-[260px] font-mono text-[11px] break-all text-muted-foreground">
                {status.certFingerprint}
              </span>
            </Row>
          )}
          <Row
            label="Windows Firewall rule"
            hint="Only this app, only its port, only from your local network, only on Private networks."
          >
            {status.firewallRule ? (
              <div className="flex items-center gap-2">
                <Badge variant="muted" className="text-success">
                  <ShieldCheck /> Added
                </Badge>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void run(() => api.mobileFirewallRemove())}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={!s.lanAddress}
                onClick={() => void run(() => api.mobileFirewallAdd())}
              >
                Add rule…
              </Button>
            )}
          </Row>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium">Paired phones</span>
          {status.running && (
            <Button variant="ghost" size="xs" onClick={() => setWizard('setup')}>
              Pair a phone…
            </Button>
          )}
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {status.devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-3 py-2.5">
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  d.connected ? 'bg-success' : 'bg-border-strong'
                )}
                title={d.connected ? 'Connected now' : 'Not connected'}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{d.name}</div>
                <div className="text-xs text-muted-foreground">
                  Paired {formatDateTime(d.createdAt)} · last seen {formatRelative(d.lastSeenAt)} ·
                  forgotten after 30 days unused
                </div>
              </div>
              <Button
                variant="ghost"
                size="xs"
                disabled={!d.connected}
                onClick={() =>
                  void api
                    .mobileSendTest(d.id)
                    .then((n) => toast(n ? 'Test sent' : 'Not connected'))
                }
              >
                <Send /> Test
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive"
                onClick={() =>
                  void run(() => api.mobileRevoke(d.id)).then(() => toast(`Revoked “${d.name}”`))
                }
              >
                <Trash2 /> Revoke
              </Button>
            </div>
          ))}
          {status.devices.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground">No phones paired.</div>
          )}
        </div>
      </div>

      <Row
        label="Read-only mode"
        hint="Phones can look and search, but can't rename, change settings or launch anything."
      >
        <Switch
          checked={s.readOnly}
          onCheckedChange={(v) => void update({ readOnly: v })}
          aria-label="Read-only mode"
        />
      </Row>
      <Row
        label="Confirm launches on this PC"
        hint="Each Resume, Fork or Branch from a phone waits until you click Allow here (1 minute, then it's refused)."
      >
        <Switch
          checked={s.confirmOnPc}
          onCheckedChange={(v) => void update({ confirmOnPc: v })}
          aria-label="Confirm launches on this PC"
        />
      </Row>
      <Row
        label="Start with the app"
        hint="If phone access was on when the app closed, turn it back on at startup."
      >
        <Switch
          checked={s.autoStart}
          onCheckedChange={(v) => void update({ autoStart: v })}
          aria-label="Start with the app"
        />
      </Row>
      <div className="flex items-start gap-2 rounded-lg bg-secondary/70 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
        Launches from a phone only ever run Resume, Fork or Branch for sessions on this PC, with
        Remote Control on, on your Claude subscription, and with permission prompts on (never
        --dangerously-skip-permissions). At most one every 10 seconds.
      </div>

      <TerminalAccessBlock />

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium">
          <Activity className="size-3.5 text-muted-foreground" /> Activity log
          <span className="text-xs font-normal text-muted-foreground">
            (every action from a phone)
          </span>
        </summary>
        <div className="mt-2">
          <ActivityLog />
        </div>
      </details>

      <details>
        <summary className="cursor-pointer list-none text-[13px] font-medium">Advanced</summary>
        <div className="mt-3 space-y-3">
          <Row label="Local port" hint="Where the companion listens on this PC (1024–65535).">
            <PortInput value={s.port} onSave={(port) => void update({ port })} />
          </Row>
          <Row
            label="Tailscale HTTPS port"
            hint="The port on your tailnet. Change it if another serve rule uses it."
          >
            <PortInput
              value={s.httpsPort}
              onSave={(httpsPort) => void update({ httpsPort })}
              allow443
            />
          </Row>
        </div>
      </details>

      {wizard && <MobileWizard initial={wizard} onClose={() => setWizard(false)} />}
    </Section>
  )
}

function PortInput({
  value,
  onSave,
  allow443
}: {
  value: number
  onSave: (v: number) => void
  allow443?: boolean
}) {
  const [v, setV] = useState(String(value))
  const n = Number(v)
  const ok = Number.isInteger(n) && ((n >= 1024 && n <= 65535) || (allow443 && n === 443))
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={v}
        onChange={(e) => setV(e.target.value.replace(/\D/g, ''))}
        className={cn('h-8 w-24 font-mono text-[13px]', !ok && 'border-destructive')}
        inputMode="numeric"
        aria-label="Port"
      />
      {ok && n !== value && (
        <Button variant="outline" size="xs" onClick={() => onSave(n)}>
          Save
        </Button>
      )}
      {!ok && <X className="size-3.5 text-destructive" />}
    </div>
  )
}
