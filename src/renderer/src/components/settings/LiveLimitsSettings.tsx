import { useState } from 'react'
import {
  Activity,
  BellRing,
  FolderOpen,
  Monitor,
  SquareTerminal,
  TriangleAlert
} from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { ago } from '@shared/format'
import type { BridgeEnv, Plan } from '@shared/usage/limits'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Segmented } from '../ui/segmented'
import { Row, Section } from '../SettingsView'
import { BridgeDialog } from './BridgeDialog'

function EnvRow({ e, onAction }: { e: BridgeEnv; onAction: (a: 'install' | 'uninstall') => void }) {
  const received = e.lastReceivedAt ? ago(e.lastReceivedAt) : undefined
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
              ? received
                ? `Receiving data · last update ${received}`
                : 'Enabled · waiting for Claude Code to send its first update'
              : received
                ? `Not enabled · last data ${received}`
                : 'Not enabled'}
          {e.installed && e.chained && (
            <span>
              {' '}
              · chained to <span className="font-mono text-[11px]">{e.chained}</span>
            </span>
          )}
        </div>
        {e.changedSinceInstall && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-warning">
            <TriangleAlert className="size-3" /> The status line was changed after the app enabled
            live limits.
          </div>
        )}
      </div>
      {e.installed ? (
        <Badge variant="muted" className="text-success">
          <Activity /> On
        </Badge>
      ) : null}
      <Button
        variant={e.installed ? 'ghost' : 'outline'}
        size="sm"
        disabled={!!e.unavailable}
        onClick={() => onAction(e.installed ? 'uninstall' : 'install')}
      >
        {e.installed ? 'Disable' : 'Enable live limits'}
      </Button>
    </div>
  )
}

const PLANS: { value: Plan; label: string }[] = [
  { value: 'pro', label: 'Pro' },
  { value: 'max5', label: 'Max 5x' },
  { value: 'max20', label: 'Max 20x' },
  { value: 'api', label: 'API' },
  { value: 'team', label: 'Team / Ent.' }
]

export function LiveLimitsSettings({
  update
}: {
  update: (p: Partial<AppSettings>) => Promise<void>
}) {
  const settings = useApp((s) => s.settings)
  const limits = useApp((s) => s.limits)
  const [dialog, setDialog] = useState<{ env: BridgeEnv; action: 'install' | 'uninstall' } | null>(
    null
  )
  const envs = limits?.envs ?? []
  const [t1, t2] = [settings.alertThresholds[0] ?? 75, settings.alertThresholds[1] ?? 90]

  return (
    <Section
      title="Live limits"
      description={
        <>
          Your real 5-hour and weekly percentages come from Claude Code&apos;s status line data.
          Enabling it for an environment changes only the{' '}
          <span className="font-mono">statusLine</span> setting in that environment&apos;s{' '}
          <span className="font-mono">~/.claude/settings.json</span>, after you review the exact
          change. Disable puts your previous setting back.
        </>
      }
    >
      <Row label="Plan" hint="Used for labels and as the default billing name.">
        <Segmented
          ariaLabel="Plan"
          value={settings.plan}
          onChange={(plan) => void update({ plan })}
          options={PLANS}
        />
      </Row>
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
      <Row
        label={
          <span className="flex items-center gap-1.5">
            <BellRing className="size-3.5 text-muted-foreground" /> Limit alerts
          </span>
        }
        hint="A desktop notification when a window passes these percentages."
      >
        <div className="flex items-center gap-2">
          {settings.alertsEnabled && (
            <>
              {[t1, t2].map((v, i) => (
                <div key={i} className="relative w-[66px]">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    defaultValue={v}
                    aria-label={`Alert threshold ${i + 1}`}
                    className="h-7 pr-5 text-right tabular-nums"
                    onBlur={(e) => {
                      const n = Number(e.target.value)
                      if (!(n >= 1 && n <= 100)) return
                      const next = i === 0 ? [n, t2] : [t1, n]
                      void update({ alertThresholds: next })
                    }}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
                    %
                  </span>
                </div>
              ))}
            </>
          )}
          <Switch
            checked={settings.alertsEnabled}
            onCheckedChange={(v) => void update({ alertsEnabled: v })}
            aria-label="Limit alerts"
          />
        </div>
      </Row>
      {dialog && (
        <BridgeDialog env={dialog.env} action={dialog.action} onClose={() => setDialog(null)} />
      )}
    </Section>
  )
}
