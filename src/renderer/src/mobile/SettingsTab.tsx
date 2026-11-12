// Settings on the phone: only a safe subset. Pairing, security, API keys,
// Tailscale and the companion server itself can only be changed on the PC.
//
// The same sections, in the same order, and the same search as the desktop
// Settings page (shared/settings-registry.ts), with only what the phone may
// change (MOBILE_SAFE_SETTINGS) plus this phone's own settings. A setting the
// phone can change shows "Changed" and a reset when it differs from its default.

import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  KeyRound,
  Lock,
  LogOut,
  Monitor,
  Moon,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Sun,
  X
} from 'lucide-react'
import type { AppSettings, TerminalPref } from '@shared/types'
import type { MobileSafeSetting } from '@shared/mobile'
import { parsePublicKey } from '@shared/terminal'
import { formatDateTime } from '@shared/format'
import {
  isChanged,
  matchSetting,
  PHONE_LOCAL_SETTINGS,
  phoneSettings,
  resetPatch,
  SECTIONS,
  settingDef,
  undoPatch,
  type SectionId,
  type SettingDef
} from '@shared/settings-registry'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { phone } from '@/lib/web-api'
import { useSearchHighlight } from '@/lib/settings-highlight'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/checkbox'
import { Input, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { useMobile } from './state'
import { DefaultModelPickers } from '@/components/ModelPicker'
import { sanitizeLiveAlerts, type LiveAlertSettings } from '@shared/live-alerts'
import { turnPushOn, usePushState } from './push'

type Update = (patch: Pick<Partial<AppSettings>, MobileSafeSetting>) => Promise<void>

/** Every setting the phone lists: the PC's safe subset and this phone's own. */
const PHONE_DEFS: SettingDef[] = [...phoneSettings(), ...PHONE_LOCAL_SETTINGS]
const DEF_BY_ID = new Map(PHONE_DEFS.map((d) => [d.id, d]))

interface TabContext {
  query: string
  readOnly: boolean
  update: Update
  /** Like update, but a failure is thrown to the caller (resets and Undo). */
  save: Update
}

const Ctx = createContext<TabContext>({
  query: '',
  readOnly: false,
  update: async () => undefined,
  save: async () => undefined
})

function shown(id: string, query: string): boolean {
  const d = DEF_BY_ID.get(id)
  return !!d && matchSetting(d, query).match
}

/** A section, as a card of lines (hidden while a search matches none of its settings). */
function Card({
  section,
  ids,
  note,
  children
}: {
  section: SectionId
  /** The settings in it (to know whether a search leaves any). */
  ids: string[]
  note?: ReactNode
  children: ReactNode
}) {
  const { query } = useContext(Ctx)
  const title = SECTIONS.find((s) => s.id === section)?.title ?? section
  const visible = ids.some((id) => shown(id, query))
  return (
    <section
      className="mx-4 mt-5"
      hidden={!visible}
      aria-label={title}
      data-phone-section={section}
    >
      <h2 className="mb-2 px-1 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </div>
      {note && !query.trim() && (
        <p className="mt-1.5 px-1 text-[12px] leading-relaxed text-muted-foreground">{note}</p>
      )}
    </section>
  )
}

/** "Changed · Reset" for a PC setting the phone may change. */
function ChangedMarker({ def }: { def: SettingDef }) {
  const settings = useApp((s) => s.settings)
  const { readOnly, save } = useContext(Ctx)
  if (!def.keys?.length || !isChanged(def, settings)) return null
  const reset = async (): Promise<void> => {
    const before = useApp.getState().settings as unknown as Record<string, unknown>
    try {
      await save(resetPatch([def], before) as Pick<Partial<AppSettings>, MobileSafeSetting>)
    } catch (err) {
      toast.error("Couldn't reset it", { description: (err as Error).message })
      return
    }
    toast.success(`“${def.label}” is back to its default`, {
      action: {
        label: 'Undo',
        onClick: () => {
          const now = useApp.getState().settings as unknown as Record<string, unknown>
          void save(
            undoPatch([def], before, now) as Pick<Partial<AppSettings>, MobileSafeSetting>
          ).catch((err: Error) => toast.error("Couldn't undo", { description: err.message }))
        }
      }
    })
  }
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
      <span
        className="rounded bg-accent-soft px-1 py-px text-[11px] leading-none font-medium text-primary"
        data-changed-marker
      >
        Changed
      </span>
      {!readOnly && (
        <button
          type="button"
          onClick={() => void reset()}
          aria-label={`Reset “${def.label}” to default`}
          data-reset-setting={def.id}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground active:bg-hover"
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
    </span>
  )
}

/** One line: a setting from the registry (hidden when the search doesn't match it). */
function Line({
  id,
  label,
  hint,
  secondary,
  children
}: {
  id: string
  label?: ReactNode
  hint?: ReactNode
  /** A second line of the same setting (no second "Changed"). */
  secondary?: boolean
  children?: ReactNode
}) {
  const { query } = useContext(Ctx)
  const def = DEF_BY_ID.get(id) ?? settingDef(id)
  if (!def) throw new Error(`Unknown setting: ${id}`)
  return (
    <div
      className="flex min-h-12 items-center gap-3 px-4 py-2.5"
      data-setting-id={id}
      hidden={!shown(id, query)}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[15px]">
          {label ?? def.label}
          {!secondary && <ChangedMarker def={def} />}
        </div>
        {hint && (
          <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{hint}</div>
        )}
      </div>
      {children}
    </div>
  )
}

/** A setting laid out as a block (pickers, a key field) instead of a line. */
function Block({ id, children }: { id: string; children: ReactNode }) {
  const { query } = useContext(Ctx)
  return (
    <div className="px-4 py-2.5" data-setting-id={id} hidden={!shown(id, query)}>
      {children}
    </div>
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const total = value.trim() ? PHONE_DEFS.filter((d) => shown(d.id, value)).length : 0
  return (
    <div role="search" className="mx-4 mt-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground"
          aria-hidden
        />
        <input
          ref={ref}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onChange('')
            }
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          aria-describedby="phone-settings-count"
          spellCheck={false}
          className="h-10 w-full rounded-xl border border-border bg-card pr-10 pl-9 text-[15px] outline-none placeholder:text-subtle-foreground focus-visible:border-ring [&::-webkit-search-cancel-button]:hidden"
          data-settings-search
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange('')
              ref.current?.focus()
            }}
            aria-label="Clear the search"
            className="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div
        id="phone-settings-count"
        aria-live="polite"
        className={cn('mt-1.5 px-1 text-[12px] text-muted-foreground', !value.trim() && 'sr-only')}
        data-settings-count
      >
        {value.trim() ? (total ? `${total} result${total === 1 ? '' : 's'}` : 'No results') : ''}
      </div>
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
  const [query, setQuery] = useState('')
  const pageRef = useRef<HTMLDivElement>(null)
  useSearchHighlight(pageRef, query)

  /** Saves on the PC; a failure (or read-only mode) is thrown, with the PC's settings shown again. */
  const save: Update = async (patch) => {
    if (readOnly) throw new Error('Read-only mode is on. Change it on your PC.')
    const before = useApp.getState().settings
    set({ settings: { ...before, ...patch } })
    try {
      set({ settings: await api.updateSettings(patch) })
    } catch (err) {
      set({ settings: await api.getSettings().catch(() => before) })
      throw err
    }
  }
  const update: Update = async (patch) => {
    if (readOnly) {
      toast('Read-only mode is on', { description: 'Change it on your PC.' })
      return
    }
    try {
      await save(patch)
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message })
    }
  }

  const ctx = { query, readOnly, update, save }
  const thresholds = settings.alertThresholds
  const none = query.trim() !== '' && !PHONE_DEFS.some((d) => shown(d.id, query))

  return (
    <Ctx.Provider value={ctx}>
      <div
        ref={pageRef}
        className="h-full overflow-y-auto pt-[calc(env(safe-area-inset-top)+10px)] pb-8"
        data-phone-settings
      >
        <h1 className="px-5 text-[22px] font-semibold tracking-[-0.015em]">Settings</h1>
        <SearchBox value={query} onChange={setQuery} />
        {none && (
          <p className="mx-5 mt-6 text-center text-[14px] text-muted-foreground">
            No settings match “{query.trim()}”. Others can be changed on your PC.
          </p>
        )}

        <Card section="general" ids={['phone-local.theme']} note="Theme is only on this phone.">
          <Line id="phone-local.theme">
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
          section="launching"
          ids={['launching.terminal', 'launching.remote-control', 'launching.model']}
          note={
            <>
              <Smartphone className="mr-1 inline size-3 align-[-1px]" />
              Launches from a phone always turn Remote Control on, use your Claude subscription and
              keep permission prompts on.
            </>
          }
        >
          <Line id="launching.terminal" label="Terminal on the PC">
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
          <Line
            id="launching.remote-control"
            label="Remote Control on the PC"
            hint="Default for launches from the desktop app"
          >
            <Switch
              checked={settings.remoteControlDefault}
              onCheckedChange={(v) => void update({ remoteControlDefault: v })}
              aria-label="Remote Control by default on the PC"
            />
          </Line>
          <Block id="launching.model">
            <div className="text-[15px]">
              Model, effort and fast mode
              <ChangedMarker def={DEF_BY_ID.get('launching.model')!} />
            </div>
            <div className="mt-0.5 mb-2 text-[12px] leading-snug text-muted-foreground">
              For sessions without their own choice (or a project default). Default lets Claude Code
              decide.
            </div>
            <DefaultModelPickers
              model={settings.defaultModel}
              effort={settings.defaultEffort}
              fast={settings.defaultFast}
              onModel={(defaultModel) => void update({ defaultModel })}
              onEffort={(defaultEffort) => void update({ defaultEffort })}
              onFast={(defaultFast) => void update({ defaultFast })}
            />
          </Block>
        </Card>

        <Card section="usage" ids={['usage.week-start']}>
          <Line id="usage.week-start">
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

        <Card
          section="alerts"
          ids={[
            'alerts.limits',
            'phone-local.push',
            ...PHONE_DEFS.filter((d) => d.section === 'alerts').map((d) => d.id)
          ]}
          note="Push alerts say only what happened (like “A session needs your approval”), never names, folders or text. Tapping one loads the details from your PC. Which events alert, and quiet hours, are shared with the PC."
        >
          <Line id="alerts.limits">
            <Switch
              checked={settings.alertsEnabled}
              onCheckedChange={(v) => void update({ alertsEnabled: v })}
              aria-label="Limit alerts"
            />
          </Line>
          {settings.alertsEnabled && (
            <Line
              id="alerts.limits"
              secondary
              label="Alert at"
              hint="Percent of the 5-hour and weekly limits"
            >
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
          <SessionAlertLines update={update} />
        </Card>

        <Card
          section="phone"
          ids={['phone-local.device', 'phone-local.ssh-key', 'phone-local.unpair']}
          note={
            readOnly
              ? 'Read-only mode is on: you can look, but not change or launch anything. It can be turned off on your PC.'
              : 'Paired with your PC. You can revoke it there at any time.'
          }
        >
          <Line id="phone-local.device" label="Name">
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
          <Line
            id="phone-local.device"
            secondary
            label="Paired"
            hint={me ? formatDateTime(me.device.createdAt) : undefined}
          >
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
          <Block id="phone-local.ssh-key">
            <SendKey readOnly={readOnly} />
          </Block>
          <Block id="phone-local.unpair">
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
          </Block>
        </Card>

        <Card section="advanced" ids={['phone-local.about']}>
          <Line
            id="phone-local.about"
            label="Claude Session Dashboard"
            hint={`Version ${info?.version ?? me?.appVersion ?? '…'} · ${location.host}`}
          />
        </Card>
      </div>
    </Ctx.Provider>
  )
}

/**
 * Terminal access: offer this phone's public SSH key to the PC. The PC only
 * shows it (with its fingerprint) while its Keys step is waiting; nothing is
 * added until it's allowed there.
 */
function SendKey({ readOnly }: { readOnly: boolean }) {
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
    <div className="space-y-2.5">
      <div>
        <div className="text-[15px]">Send SSH key to PC</div>
        <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
          For terminal access. On the PC, open Settings → Phone &amp; remote → Terminal access →
          Keys and click “Get key from phone” first. Only the public key: it’s safe to share.
        </div>
      </div>
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
  )
}

const EVENT_LINES: { id: string; key: keyof LiveAlertSettings }[] = [
  { id: 'alerts.approval', key: 'approval' },
  { id: 'alerts.finished', key: 'finished' },
  { id: 'alerts.failed', key: 'failed' },
  { id: 'alerts.waiting', key: 'waiting' },
  { id: 'alerts.exited', key: 'exited' }
]

/** Running now alerts: push on this phone, and which events alert (shared with the PC). */
function SessionAlertLines({ update }: { update: Update }) {
  const settings = useApp((s) => s.settings)
  const a = sanitizeLiveAlerts(settings.liveAlerts)
  const [push, reloadPush] = usePushState()
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<LiveAlertSettings>): void =>
    void update({ liveAlerts: { ...a, ...patch } })
  const togglePush = async (on: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (on) await turnPushOn(reloadPush)
      else {
        await phone.disablePush()
        reloadPush()
        toast('Push alerts off for this phone')
      }
    } catch (err) {
      // The PC must confirm, or it would keep sending: push stays on.
      toast.error("Couldn't turn push alerts off", {
        description: `Your PC didn't confirm (${(err as Error).message}). Push stays on; try again when your PC can be reached.`
      })
      reloadPush()
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Line
        id="phone-local.push"
        hint={
          push === 'denied'
            ? 'Blocked: allow notifications for this app in your phone settings.'
            : push === 'unsupported'
              ? /iPhone|iPad|iPod/.test(navigator.userAgent)
                ? 'Add this app to your Home Screen first, then open it from there.'
                : "This browser can't receive push alerts."
              : push === 'unknown'
                ? "Can't reach your PC to check right now."
                : 'Even when this app is closed.'
        }
      >
        <Switch
          checked={push === 'on'}
          disabled={
            busy ||
            push === null ||
            push === 'denied' ||
            push === 'unsupported' ||
            push === 'unknown'
          }
          onCheckedChange={(v) => void togglePush(v)}
          aria-label="Push alerts on this phone"
        />
      </Line>
      {push === 'on' && (
        <Line id="phone-local.push" secondary label="Test" hint="Sends a push to this phone now.">
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() =>
              void phone
                .testPush()
                .then((n) =>
                  n
                    ? toast('Test push sent')
                    : toast.error('No push was sent', {
                        description: 'Turn push alerts off and on again.'
                      })
                )
                .catch((err: Error) => toast.error("Couldn't send", { description: err.message }))
            }
          >
            <Send /> Send test
          </Button>
        </Line>
      )}
      {EVENT_LINES.map((ev) => (
        <Line key={ev.id} id={ev.id}>
          <Switch
            checked={a[ev.key] as boolean}
            onCheckedChange={(v) => set({ [ev.key]: v } as Partial<LiveAlertSettings>)}
            aria-label={settingDef(ev.id)?.label}
          />
        </Line>
      ))}
      <Line id="alerts.min-work" hint="Quick replies don't alert.">
        <div className="flex items-center gap-1.5">
          <Input
            key={a.minWorkSec}
            type="number"
            inputMode="numeric"
            min={0}
            max={3600}
            defaultValue={a.minWorkSec}
            onBlur={(e) => {
              const n = Math.round(Number(e.target.value))
              if (n >= 0 && n <= 3600 && n !== a.minWorkSec) set({ minWorkSec: n })
            }}
            className="h-9 w-16 text-center text-[15px]"
            aria-label="Minimum working time in seconds"
          />
          <span className="text-[13px] text-muted-foreground">sec</span>
        </div>
      </Line>
      <Line id="alerts.desktop" label="Desktop notifications on the PC">
        <Switch
          checked={a.desktop}
          onCheckedChange={(v) => set({ desktop: v })}
          aria-label="Desktop notifications"
        />
      </Line>
      <Line id="alerts.phone" label="Send to phones" hint="Off: alerts only on the PC.">
        <Switch
          checked={a.phone}
          onCheckedChange={(v) => set({ phone: v })}
          aria-label="Send to phones"
        />
      </Line>
      <Line
        id="alerts.quiet"
        hint={
          a.quiet.enabled
            ? `${a.quiet.from} – ${a.quiet.to} (PC time)`
            : 'No alerts in a time window.'
        }
      >
        <Switch
          checked={a.quiet.enabled}
          onCheckedChange={(v) => set({ quiet: { ...a.quiet, enabled: v } })}
          aria-label="Quiet hours"
        />
      </Line>
      {a.quiet.enabled && (
        <Line id="alerts.quiet" secondary label="From – to">
          <div className="flex items-center gap-1.5">
            <Input
              key={`from:${a.quiet.from}`}
              type="time"
              defaultValue={a.quiet.from}
              onBlur={(e) =>
                /^\d\d:\d\d$/.test(e.target.value) &&
                set({ quiet: { ...a.quiet, from: e.target.value } })
              }
              className="h-9 w-[104px] text-[15px]"
              aria-label="Quiet from"
            />
            <Input
              key={`to:${a.quiet.to}`}
              type="time"
              defaultValue={a.quiet.to}
              onBlur={(e) =>
                /^\d\d:\d\d$/.test(e.target.value) &&
                set({ quiet: { ...a.quiet, to: e.target.value } })
              }
              className="h-9 w-[104px] text-[15px]"
              aria-label="Quiet until"
            />
          </div>
        </Line>
      )}
      <Line
        id="alerts.quiet-approvals"
        hint={a.quiet.enabled ? undefined : 'Used while quiet hours are on.'}
      >
        <Switch
          checked={a.quiet.allowApprovals}
          disabled={!a.quiet.enabled}
          onCheckedChange={(v) => set({ quiet: { ...a.quiet, allowApprovals: v } })}
          aria-label="Approvals during quiet hours"
        />
      </Line>
    </>
  )
}
