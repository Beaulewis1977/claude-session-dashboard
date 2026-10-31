// Settings on the phone: only a safe subset. Pairing, security, API keys,
// Tailscale and the companion server itself can only be changed on the PC.

import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  KeyRound,
  Lock,
  LogOut,
  Monitor,
  Moon,
  Send,
  ShieldCheck,
  Smartphone,
  Sun
} from 'lucide-react'
import type { AppSettings, TerminalPref } from '@shared/types'
import type { MobileSafeSetting } from '@shared/mobile'
import { parsePublicKey } from '@shared/terminal'
import { formatDateTime } from '@shared/format'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { phone } from '@/lib/web-api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/checkbox'
import { Input, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { useMobile } from './state'
import { DefaultModelPickers } from '@/components/ModelPicker'

function Card({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mx-4 mt-5">
      <h2 className="mb-2 px-1 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </div>
      {note && (
        <p className="mt-1.5 px-1 text-[12px] leading-relaxed text-muted-foreground">{note}</p>
      )}
    </section>
  )
}

function Line({
  label,
  hint,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[15px]">{label}</div>
        {hint && (
          <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{hint}</div>
        )}
      </div>
      {children}
    </div>
  )
}

export function SettingsTab() {
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const set = useApp((s) => s.set)
  const me = useMobile((s) => s.me)
  const setMe = useMobile((s) => s.setMe)
  const theme = useMobile((s) => s.theme)
  const setTheme = useMobile((s) => s.setTheme)
  const readOnly = me?.readOnly ?? false
  const [name, setName] = useState(me?.device.name ?? '')
  const [confirmUnpair, setConfirmUnpair] = useState(false)

  const update = async (patch: Pick<Partial<AppSettings>, MobileSafeSetting>): Promise<void> => {
    if (readOnly) {
      toast('Read-only mode is on', { description: 'Change it on your PC.' })
      return
    }
    set({ settings: { ...settings, ...patch } })
    try {
      set({ settings: await api.updateSettings(patch) })
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message })
      set({ settings: await api.getSettings() })
    }
  }

  const thresholds = settings.alertThresholds

  return (
    <div className="h-full overflow-y-auto pt-[calc(env(safe-area-inset-top)+10px)] pb-8">
      <h1 className="px-5 text-[22px] font-semibold tracking-[-0.015em]">Settings</h1>

      <Card
        title="This phone"
        note={
          readOnly
            ? 'Read-only mode is on: you can look, but not change or launch anything. It can be turned off on your PC.'
            : 'Paired with your PC. You can revoke it there at any time.'
        }
      >
        <Line label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (!me || !name.trim() || name.trim() === me.device.name) return
              void phone
                .renameDevice(name.trim())
                .then(() => setMe({ ...me, device: { ...me.device, name: name.trim() } }))
            }}
            maxLength={60}
            className="h-9 w-44 text-right text-[15px]"
            aria-label="Name for this phone"
          />
        </Line>
        <Line label="Paired" hint={me ? formatDateTime(me.device.createdAt) : undefined}>
          {readOnly ? (
            <span className="inline-flex items-center gap-1 text-[13px] text-muted-foreground">
              <Lock className="size-3.5" /> Read-only
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[13px] text-success">
              <ShieldCheck className="size-3.5" /> Full access
            </span>
          )}
        </Line>
      </Card>

      <Card title="Appearance" note="Only on this phone.">
        <Line label="Theme">
          <Segmented
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: '', icon: <Sun /> },
              { value: 'dark', label: '', icon: <Moon /> },
              { value: 'system', label: 'Auto', icon: <Monitor /> }
            ]}
          />
        </Line>
      </Card>

      <Card
        title="Launch defaults"
        note={
          <>
            <Smartphone className="mr-1 inline size-3 align-[-1px]" />
            Launches from a phone always turn Remote Control on, use your Claude subscription and
            keep permission prompts on.
          </>
        }
      >
        <Line label="Terminal on the PC">
          <Segmented
            ariaLabel="Terminal"
            value={settings.terminal}
            onChange={(terminal: TerminalPref) => void update({ terminal })}
            options={[
              { value: 'wt', label: 'Terminal' },
              { value: 'powershell', label: 'PS' },
              { value: 'cmd', label: 'cmd' }
            ]}
          />
        </Line>
        <Line label="Remote Control on the PC" hint="Default for launches from the desktop app">
          <Switch
            checked={settings.remoteControlDefault}
            onCheckedChange={(v) => void update({ remoteControlDefault: v })}
            aria-label="Remote Control by default on the PC"
          />
        </Line>
        <div className="px-4 py-2.5">
          <div className="text-[15px]">Model and effort</div>
          <div className="mt-0.5 mb-2 text-[12px] leading-snug text-muted-foreground">
            For sessions without their own choice (or a project default). Default lets Claude Code
            decide.
          </div>
          <DefaultModelPickers
            model={settings.defaultModel}
            effort={settings.defaultEffort}
            onModel={(defaultModel) => void update({ defaultModel })}
            onEffort={(defaultEffort) => void update({ defaultEffort })}
          />
        </div>
      </Card>

      <Card
        title="Alerts"
        note="Limit alerts show on the PC, and as a message on paired phones that are open."
      >
        <Line label="Limit alerts">
          <Switch
            checked={settings.alertsEnabled}
            onCheckedChange={(v) => void update({ alertsEnabled: v })}
            aria-label="Limit alerts"
          />
        </Line>
        {settings.alertsEnabled && (
          <Line label="Alert at" hint="Percent of the 5-hour and weekly limits">
            <div className="flex items-center gap-1.5">
              {thresholds.map((t, i) => (
                <Input
                  key={`${i}-${t}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  defaultValue={t}
                  onBlur={(e) => {
                    const v = Math.round(Number(e.target.value))
                    if (!v || v === t) return
                    const next = [...thresholds]
                    next[i] = v
                    void update({ alertThresholds: next })
                  }}
                  className="h-9 w-16 text-center text-[15px]"
                  aria-label={`Alert threshold ${i + 1}`}
                />
              ))}
              <span className="text-[13px] text-muted-foreground">%</span>
            </div>
          </Line>
        )}
      </Card>

      <Card title="Display">
        <Line label="Weeks start on">
          <Segmented
            ariaLabel="Week start"
            value={settings.weekStart}
            onChange={(weekStart) => void update({ weekStart })}
            options={[
              { value: 'monday', label: 'Monday' },
              { value: 'sunday', label: 'Sunday' }
            ]}
          />
        </Line>
      </Card>

      <SendKeyCard readOnly={readOnly} />

      <Card title="About">
        <Line
          label="Claude Session Dashboard"
          hint={`Version ${info?.version ?? me?.appVersion ?? '…'} · ${location.host}`}
        />
      </Card>

      <div className="mx-4 mt-6">
        {confirmUnpair ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
            <div className="text-[14px]">
              Unpair this phone? You’ll need a new code from your PC to connect again.
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                variant="ghost"
                className="h-11 flex-1"
                onClick={() => setConfirmUnpair(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="h-11 flex-1"
                onClick={() => void phone.unpair()}
              >
                Unpair
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            className="h-11 w-full text-destructive"
            onClick={() => setConfirmUnpair(true)}
          >
            <LogOut /> Unpair this phone
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Terminal access: offer this phone's public SSH key to the PC. The PC only
 * shows it (with its fingerprint) while its Keys step is waiting; nothing is
 * added until it's allowed there.
 */
function SendKeyCard({ readOnly }: { readOnly: boolean }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const parsed = key.trim() ? parsePublicKey(key) : null
  const send = async (): Promise<void> => {
    if (readOnly) {
      toast('Read-only mode is on', { description: 'Change it on your PC.' })
      return
    }
    setBusy(true)
    try {
      const r = await phone.sendSshKey(key)
      if (r.ok) {
        setSent(r.fingerprint ?? '')
        setKey('')
      } else toast.error('Not sent', { description: r.error })
    } catch (err) {
      toast.error('Not sent', { description: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card
      title="Send SSH key to PC"
      note="For terminal access. On the PC, open Settings → Terminal access (SSH) → Keys and click “Get key from phone” first. Only the public key: it’s safe to share."
    >
      <div className="space-y-2.5 px-4 py-3">
        {sent !== null ? (
          <div className="flex items-start gap-2 text-[14px]">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-success" />
            <span>
              Sent. On your PC, check the fingerprint ends the same as in your SSH app, then click
              Allow.
              <span className="mt-1 block font-mono text-[11.5px] break-all text-muted-foreground">
                {sent}
              </span>
            </span>
          </div>
        ) : (
          <>
            <Textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="ssh-ed25519 AAAA… (copy it from your SSH app)"
              rows={3}
              className="font-mono text-[13px]"
              aria-label="Public SSH key"
            />
            {parsed && !parsed.ok && (
              <div className="text-[12.5px] text-destructive">{parsed.error}</div>
            )}
            <Button
              variant="primary"
              className="h-11 w-full"
              disabled={!parsed?.ok || busy}
              onClick={() => void send()}
            >
              <Send /> Send to PC
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}
