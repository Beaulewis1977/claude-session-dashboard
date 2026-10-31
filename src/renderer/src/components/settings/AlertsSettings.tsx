// Settings → Session alerts: the hook bridge per environment, which events
// alert, where (desktop / phones), quiet hours and muted sessions.

import { useState } from 'react'
import {
  Activity,
  BellOff,
  BellRing,
  FolderOpen,
  Monitor,
  Moon,
  SquareTerminal,
  TriangleAlert
} from 'lucide-react'
import { ago } from '@shared/format'
import { DEFAULT_LIVE_ALERTS, type LiveAlertSettings } from '@shared/live-alerts'
import type { HookEnv } from '@shared/live'
import type { AppSettings } from '@shared/types'
import { api } from '@/lib/api'
import { updateMeta } from '@/lib/actions'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Row, Section } from '../SettingsView'
import { BridgeDialog } from './BridgeDialog'

function EnvRow({ e, onAction }: { e: HookEnv; onAction: (a: 'install' | 'uninstall') => void }) {
  const last = e.lastEventAt ? ago(e.lastEventAt) : undefined
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md',
          e.env === 'wsl' ? 'bg-env-wsl/10 text-env-wsl' : 'bg-env-windows/10 text-env-windows'
        )}
      >
        {e.env === 'wsl' ? (
          <SquareTerminal className="size-3.5" />
        ) : (
          <Monitor className="size-3.5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {e.label}
          {e.user && <span className="text-xs font-normal text-muted-foreground">{e.user}</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          {e.unavailable
            ? e.unavailable
            : e.installed
              ? last
                ? `On · last event ${last}`
                : 'On · events arrive from sessions started or resumed from now on'
              : 'Off · states come from Claude Code’s session files and activity'}
        </div>
        {e.changedSinceInstall && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-warning">
            <TriangleAlert className="size-3" /> Some of the app’s hooks were removed since. Enable
            again to add them back.
          </div>
        )}
      </div>
      {e.installed && (
        <Badge variant="muted" className="text-success">
          <Activity /> On
        </Badge>
      )}
      <Button
        variant={e.installed && !e.changedSinceInstall ? 'ghost' : 'outline'}
        size="sm"
        disabled={!!e.unavailable}
        onClick={() => onAction(e.installed && !e.changedSinceInstall ? 'uninstall' : 'install')}
      >
        {e.installed && !e.changedSinceInstall
          ? 'Disable'
          : e.changedSinceInstall
            ? 'Repair'
            : 'Enable session alerts'}
      </Button>
      {e.installed && e.changedSinceInstall && (
        <Button variant="ghost" size="sm" onClick={() => onAction('uninstall')}>
          Disable
        </Button>
      )}
    </div>
  )
}

const EVENTS: { key: keyof LiveAlertSettings; label: string; hint: string }[] = [
  {
    key: 'approval',
    label: 'Needs approval',
    hint: 'A permission prompt or a question is waiting for you.'
  },
  {
    key: 'finished',
    label: 'Finished',
    hint: 'A session worked and now waits for your next message.'
  },
  {
    key: 'failed',
    label: 'Stopped with an error',
    hint: 'A turn ended with an API or other error.'
  },
  {
    key: 'waiting',
    label: 'Still waiting',
    hint: 'Claude Code’s own reminder after a minute of waiting for you (needs session alerts on).'
  },
  { key: 'exited', label: 'Ended', hint: 'A session’s process ended (closed or crashed).' }
]

export function AlertsSettings({ update }: { update: (p: Partial<AppSettings>) => Promise<void> }) {
  const settings = useApp((s) => s.settings)
  const live = useApp((s) => s.live)
  const sessions = useApp((s) => s.sessions)
  const [dialog, setDialog] = useState<{ env: HookEnv; action: 'install' | 'uninstall' } | null>(
    null
  )
  const a = settings.liveAlerts ?? DEFAULT_LIVE_ALERTS
  const set = (patch: Partial<LiveAlertSettings>): void =>
    void update({ liveAlerts: { ...a, ...patch } })
  const setQuiet = (patch: Partial<LiveAlertSettings['quiet']>): void =>
    set({ quiet: { ...a.quiet, ...patch } })
  const envs = live?.hooks ?? []
  const muted = sessions.filter((s) => s.meta.muteAlerts)

  return (
    <Section
      id="alerts"
      title="Session alerts"
      description={
        <>
          Running now shows every Claude Code session that&apos;s running. Session alerts make it
          exact: enabling them for an environment adds a few hooks to that environment&apos;s{' '}
          <span className="font-mono">~/.claude/settings.json</span>, after you review the exact
          change. Your own hooks stay as they are; Disable takes out exactly the app&apos;s.
        </>
      }
    >
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {envs.map((e) => (
          <EnvRow key={e.sourceId} e={e} onAction={(action) => setDialog({ env: e, action })} />
        ))}
        {envs.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            No Claude Code homes found yet.
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Backups of <span className="font-mono">settings.json</span> are kept in the app&apos;s
          data folder.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void api.openBackupFolder()}>
          <FolderOpen /> Backups
        </Button>
      </div>

      <div className="space-y-3">
        <div className="text-[13px] font-medium">Alert me when</div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {EVENTS.map((ev) => (
            <label key={ev.key} className="flex cursor-pointer items-start gap-2.5">
              <Switch
                checked={a[ev.key] as boolean}
                onCheckedChange={(v) => set({ [ev.key]: v } as Partial<LiveAlertSettings>)}
                aria-label={ev.label}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-[13px]">{ev.label}</span>
                <span className="block text-xs text-muted-foreground">{ev.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <Row
        label="“Finished” only after"
        hint="Quick replies don't alert: only turns that took at least this long."
      >
        <div className="relative w-[84px]">
          <Input
            type="number"
            min={0}
            max={3600}
            defaultValue={a.minWorkSec}
            aria-label="Minimum working time in seconds"
            className="h-7 pr-7 text-right tabular-nums"
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (n >= 0 && n <= 3600) set({ minWorkSec: Math.round(n) })
            }}
          />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
            sec
          </span>
        </div>
      </Row>

      <Row
        label={
          <span className="flex items-center gap-1.5">
            <BellRing className="size-3.5 text-muted-foreground" /> Desktop notifications
          </span>
        }
        hint="Windows notifications. Click one to open the session."
      >
        <Switch
          checked={a.desktop}
          onCheckedChange={(v) => set({ desktop: v })}
          aria-label="Desktop notifications"
        />
      </Row>
      <Row
        label="Phone push alerts"
        hint={
          <>
            To phones that turned push alerts on (on the phone: Running, or Settings → Session
            alerts). A push says only what happened, like &ldquo;A session needs your
            approval&rdquo;: no names, folders or text. Tapping it loads the details from this PC
            over Tailscale.
          </>
        }
      >
        <Switch
          checked={a.phone}
          onCheckedChange={(v) => set({ phone: v })}
          aria-label="Phone push alerts"
        />
      </Row>

      <Row
        label={
          <span className="flex items-center gap-1.5">
            <Moon className="size-3.5 text-muted-foreground" /> Quiet hours
          </span>
        }
        hint="No alerts in this time (local time). Running now still shows everything."
      >
        <div className="flex items-center gap-2">
          {a.quiet.enabled && (
            <>
              <Input
                type="time"
                defaultValue={a.quiet.from}
                aria-label="Quiet from"
                className="h-7 w-[92px] tabular-nums"
                onBlur={(e) =>
                  /^\d\d:\d\d$/.test(e.target.value) && setQuiet({ from: e.target.value })
                }
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="time"
                defaultValue={a.quiet.to}
                aria-label="Quiet until"
                className="h-7 w-[92px] tabular-nums"
                onBlur={(e) =>
                  /^\d\d:\d\d$/.test(e.target.value) && setQuiet({ to: e.target.value })
                }
              />
            </>
          )}
          <Switch
            checked={a.quiet.enabled}
            onCheckedChange={(v) => setQuiet({ enabled: v })}
            aria-label="Quiet hours"
          />
        </div>
      </Row>
      {a.quiet.enabled && (
        <Row
          label="Approvals during quiet hours"
          hint="A session that needs approval is stuck until you answer."
        >
          <Switch
            checked={a.quiet.allowApprovals}
            onCheckedChange={(v) => setQuiet({ allowApprovals: v })}
            aria-label="Approvals during quiet hours"
          />
        </Row>
      )}

      <div>
        <div className="text-[13px] font-medium">Muted sessions</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Mute a session from Running now (the bell). Muted sessions still show there.
        </p>
        {muted.length > 0 ? (
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {muted.map((s) => (
              <div key={s.key} className="flex items-center gap-2 px-3 py-1.5">
                <BellOff className="size-3.5 shrink-0 text-warning" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{s.title}</span>
                <span className="shrink-0 text-2xs text-subtle-foreground">{s.projectName}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void updateMeta(s.key, { muteAlerts: false })}
                >
                  Unmute
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-xs text-subtle-foreground">None.</div>
        )}
      </div>
      {dialog && (
        <BridgeDialog
          kind="alerts"
          env={dialog.env}
          action={dialog.action}
          onClose={() => setDialog(null)}
        />
      )}
    </Section>
  )
}
