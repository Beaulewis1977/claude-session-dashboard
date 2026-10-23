import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  Archive,
  CircleCheck,
  FileArchive,
  MessagesSquare,
  CircleSlash,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Sun,
  TriangleAlert,
  X
} from 'lucide-react'
import type { AppSettings, ArchiveStats, SourceInfo } from '@shared/types'
import { formatBytes } from '@shared/format'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Switch } from './ui/checkbox'
import { Segmented } from './ui/segmented'
import { SkipPermissionsWarning } from './ResumeDialog'
import { AccountsSettings } from './settings/AccountsSettings'
import { LiveLimitsSettings } from './settings/LiveLimitsSettings'
import { UsageSettings } from './settings/UsageSettings'
import { HealthSettings } from './settings/HealthSettings'

export function Section({
  title,
  description,
  children
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border-b border-border py-7 last:border-0">
      <h2 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h2>
      {description && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

export function Row({
  label,
  hint,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function StatusBadge({ s }: { s: SourceInfo }) {
  switch (s.status) {
    case 'ok':
      return (
        <Badge variant="muted" className="text-success">
          <CircleCheck /> {s.sessionCount} session{s.sessionCount === 1 ? '' : 's'}
        </Badge>
      )
    case 'not-running':
      return (
        <Badge variant="muted">
          <CircleSlash /> Not running
        </Badge>
      )
    case 'missing':
      return <Badge variant="muted">No sessions yet</Badge>
    default:
      return (
        <Badge variant="warning">
          <TriangleAlert /> Can't read
        </Badge>
      )
  }
}

function SourceRow({ s, onRemove }: { s: SourceInfo; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md',
          s.env === 'wsl' ? 'bg-env-wsl/10 text-env-wsl' : 'bg-env-windows/10 text-env-windows'
        )}
      >
        {s.env === 'wsl' ? (
          <SquareTerminal className="size-3.5" />
        ) : (
          <Monitor className="size-3.5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          {s.label}
          {s.user && <span className="text-xs font-normal text-muted-foreground">{s.user}</span>}
          {s.kind === 'custom' && <Badge variant="muted">Added</Badge>}
        </div>
        <div
          className="selectable truncate font-mono text-[11px] text-muted-foreground"
          title={s.projectsDir}
        >
          {s.projectsDir}
        </div>
        {s.statusMessage && s.status !== 'ok' && (
          <div className="mt-0.5 text-xs text-muted-foreground">{s.statusMessage}</div>
        )}
      </div>
      <StatusBadge s={s} />
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={`Stop scanning ${s.projectsDir}`}
        >
          <X />
        </Button>
      )}
    </div>
  )
}

export function SettingsView() {
  const settings = useApp((s) => s.settings)
  const sources = useApp((s) => s.sources)
  const scan = useApp((s) => s.scan)
  const info = useApp((s) => s.info)
  const set = useApp((s) => s.set)
  const [archive, setArchive] = useState<ArchiveStats | null>(null)
  const [rescanning, setRescanning] = useState(false)

  useEffect(() => {
    void api.getArchiveStats().then(setArchive)
  }, [scan.phase, sources])

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    set({ settings: { ...settings, ...patch } })
    set({ settings: await api.updateSettings(patch) })
  }

  const rescan = async (): Promise<void> => {
    setRescanning(true)
    await api.rescan()
    setRescanning(false)
    toast.success('Rescan complete')
  }

  const customByFolder = new Map(settings.extraFolders.map((f) => [f, f]))
  const homes = sources.filter(
    (s) => s.kind === 'auto' && s.claudeSettingsPath && s.status === 'ok'
  )

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-[720px] px-8 pt-8 pb-16">
        <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Settings</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Everything stays on this computer. The app only reads Claude Code's files and keeps its
          own data separately.
        </p>

        <Section title="Appearance">
          <Row label="Theme">
            <Segmented
              ariaLabel="Theme"
              value={settings.theme}
              onChange={(theme) => void update({ theme })}
              options={[
                { value: 'light', label: 'Light', icon: <Sun /> },
                { value: 'dark', label: 'Dark', icon: <Moon /> },
                { value: 'system', label: 'System', icon: <Monitor /> }
              ]}
            />
          </Row>
        </Section>

        <Section title="Resume">
          <Row
            label="Terminal"
            hint="Falls back to PowerShell if Windows Terminal isn't installed."
          >
            <Segmented
              ariaLabel="Terminal"
              value={settings.terminal}
              onChange={(terminal) => void update({ terminal })}
              options={[
                { value: 'wt', label: 'Windows Terminal' },
                { value: 'powershell', label: 'PowerShell' },
                { value: 'cmd', label: 'cmd' }
              ]}
            />
          </Row>
          <div>
            <Row
              label="Skip permission prompts by default"
              hint={
                <>
                  Adds <span className="font-mono">--dangerously-skip-permissions</span>. You can
                  still change it for each launch.
                </>
              }
            >
              <Switch
                checked={settings.skipPermissionsDefault}
                onCheckedChange={(v) => void update({ skipPermissionsDefault: v })}
                aria-label="Skip permission prompts by default"
              />
            </Row>
            {settings.skipPermissionsDefault && <SkipPermissionsWarning className="mt-2" />}
          </div>
        </Section>

        <LiveLimitsSettings update={update} />

        <AccountsSettings update={update} />

        <UsageSettings update={update} />
        <HealthSettings update={update} />

        <Section
          title="Scan sources"
          description="Detected automatically: your Windows profile and every WSL distro (each user in /home, plus /root). Add any other folder that contains Claude Code sessions."
        >
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                s={s}
                onRemove={
                  s.kind === 'custom'
                    ? () => {
                        const folder = [...customByFolder.keys()].find((f) =>
                          s.projectsDir.toLowerCase().startsWith(f.toLowerCase())
                        )
                        if (folder)
                          void api.removeExtraFolder(folder).then((st) => set({ settings: st }))
                      }
                    : undefined
                }
              />
            ))}
            {sources.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">Scanning…</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void api.addExtraFolder().then((st) => set({ settings: st }))}
            >
              <FolderPlus /> Add folder…
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void rescan()} disabled={rescanning}>
              <RefreshCw className={cn(rescanning && 'animate-spin')} /> Rescan now
            </Button>
          </div>
          <Row
            label="Scan stopped WSL distros"
            hint="Reading a stopped distro starts it in the background, so this is off by default."
          >
            <Switch
              checked={settings.scanStoppedDistros}
              onCheckedChange={(v) => void update({ scanStoppedDistros: v })}
              aria-label="Scan stopped WSL distros"
            />
          </Row>
        </Section>

        <Section
          title="Archive"
          description="Every session file is copied here and kept forever, so sessions survive Claude Code's cleanup. Nothing is ever removed from the archive automatically."
        >
          <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
              <Archive className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">
                {archive
                  ? `${archive.files} session${archive.files === 1 ? '' : 's'} · ${formatBytes(archive.bytes)}`
                  : '…'}
              </div>
              <div
                className="selectable truncate font-mono text-[11px] text-muted-foreground"
                title={archive?.dir}
              >
                {archive?.dir ?? info?.archiveDir}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => void api.openArchiveFolder()}>
              <FolderOpen /> Open folder
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-3 rounded-lg border border-border px-3 py-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
              <MessagesSquare className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">Import claude.ai data export</div>
              <div className="text-xs text-muted-foreground">
                Adds your claude.ai conversations to the archive as view-only sessions you can read
                and search. The zip is only read, never changed.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const r = await api.importClaudeAi()
                if (!r) return
                if (!r.ok) toast.error("Couldn't import", { description: r.error })
                else {
                  toast.success(`Imported ${r.conversations} conversations`, {
                    description: `${r.added} new · ${r.updated} updated · ${r.unchanged} unchanged${r.skipped ? ` · ${r.skipped} skipped` : ''}`
                  })
                  void api.getArchiveStats().then(setArchive)
                }
              }}
            >
              <FileArchive /> Choose zip…
            </Button>
          </div>
        </Section>

        <Section
          title="Claude Code cleanup"
          description={
            <>
              Claude Code deletes sessions older than{' '}
              <span className="font-mono">cleanupPeriodDays</span> (30 days by default). The archive
              above keeps them anyway. This app never edits Claude's settings.
            </>
          }
        >
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {homes.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    {s.label}
                    {s.user ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {s.user}
                      </span>
                    ) : null}
                  </div>
                  <div className="selectable truncate font-mono text-[11px] text-muted-foreground">
                    {s.claudeSettingsPath}
                  </div>
                </div>
                <span className="text-[13px] tabular-nums">
                  {s.cleanupPeriodDays == null ? (
                    <span className="text-muted-foreground">
                      {s.cleanupPeriodDays === null ? 'Not set (30 days)' : 'Unreadable'}
                    </span>
                  ) : (
                    <span className="font-medium">{s.cleanupPeriodDays} days</span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open folder"
                  onClick={() => void api.openClaudeSettings(s.id)}
                >
                  <FolderOpen />
                </Button>
              </div>
            ))}
            {homes.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">
                No Claude Code settings found.
              </div>
            )}
          </div>
          <div className="rounded-lg bg-secondary/70 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            To keep sessions longer inside Claude Code too, add this to{' '}
            <span className="font-mono">~/.claude/settings.json</span> yourself:
            <pre className="selectable mt-1.5 rounded-md border border-code-border bg-code-bg px-2.5 py-1.5 font-mono text-[11.5px] text-foreground">
              {'{\n  "cleanupPeriodDays": 3650\n}'}
            </pre>
          </div>
        </Section>

        <Section title="About">
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success" />
              No network access, except read-only usage reports from api.anthropic.com when you add
              an Admin API key. Names, descriptions and tags are stored only in the app's own data
              folder.
            </div>
            <div className="flex items-center gap-2">
              <HardDrive className="size-4" />
              <span className="selectable font-mono text-[11px]">{info?.dataDir}</span>
            </div>
            <div>
              Version {info?.version}
              {info?.fixtures && (
                <Badge variant="accent" className="ml-2">
                  Fixtures mode
                </Badge>
              )}
            </div>
          </div>
        </Section>
      </div>
    </div>
  )
}
