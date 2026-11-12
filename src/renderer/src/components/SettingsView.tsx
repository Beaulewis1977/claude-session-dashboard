// Settings: one scrolling page of sections (shared/settings-registry.ts has
// the map), with the sidebar's Settings menu (settings/SettingsMenu.tsx) for
// moving around and searching. This file lays the sections out and runs the
// page: scroll-spy, links to a setting, search highlighting, ↑ Top, Home / End
// and Ctrl+F.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Archive,
  ArrowUp,
  CircleCheck,
  CircleSlash,
  FileArchive,
  FolderOpen,
  FolderPlus,
  HardDrive,
  MessagesSquare,
  Monitor,
  Moon,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Sun,
  TriangleAlert,
  X
} from 'lucide-react'
import type { AppSettings, ArchiveStats, SourceInfo, StartWithWindows } from '@shared/types'
import { formatBytes } from '@shared/format'
import { matchSetting, resolveTarget, settingDef } from '@shared/settings-registry'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { useHotkeys } from '@/lib/hotkeys'
import { cn } from '@/lib/utils'
import {
  readLastSection,
  saveLastSection,
  settingsIn,
  settingsUi,
  useSettingsUi,
  visibleSettingIds
} from '@/lib/settings-ui'
import { useSearchHighlight } from '@/lib/settings-highlight'
import { useEnabledProviders } from '@/lib/scope'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Switch } from './ui/checkbox'
import { Segmented } from './ui/segmented'
import { SkipPermissionsWarning } from './ResumeDialog'
import { DefaultModelPickers } from './ModelPicker'
import { ProviderBadge } from './ProviderSwitch'
import { Row, SeeAlso, SettingItem, SettingsSection, SettingsSub } from './settings/page'
import { SECTION_HEADER_PX, SUB_HEADER_PX } from '@/lib/settings-actions'
import { SettingsSearchField } from './settings/SettingsMenu'
import { ProjectModelDefaults } from './settings/ProjectModelDefaults'
import { AccountsSettings } from './settings/AccountsSettings'
import { LimitAlertsSetting, LiveLimitsBridge, PlanSetting } from './settings/LiveLimitsSettings'
import {
  CapacityWeightsSetting,
  PriceTable,
  RecalculateUsage,
  WeekStartSetting
} from './settings/UsageSettings'
import { CodexUsageSettings, MeterProviderSetting } from './settings/CodexUsageSettings'
import {
  AskClaudeSettings,
  LimitHealthSettings,
  PacingSettings,
  PlanHistory
} from './settings/HealthSettings'
import { MobileSettingsSection, PhonePortsSetting } from './settings/MobileSettings'
import { AlertsSettings } from './settings/AlertsSettings'
import { TerminalAccessBlock } from './settings/TerminalAccessSettings'
import { BackupSettings } from './settings/BackupSettings'
import { SummariesSettings } from './settings/SummariesSettings'
import { AskSettings } from './settings/AskSettings'
import { ContextSettings } from './settings/ContextSettings'
import { GitSettings } from './settings/GitSettings'
import {
  CodexArchiveSettings,
  CodexLaunchSettings,
  ProvidersSettings
} from './settings/ProvidersSettings'

type Update = (patch: Partial<AppSettings>) => Promise<void>

/** "Start with Windows (minimized to tray)": off by default; the state comes from Windows. */
function StartupSetting() {
  const [s, setS] = useState<StartWithWindows | null>(null)
  useEffect(() => {
    void api
      .startWithWindows()
      .then(setS)
      .catch(() => setS(null))
  }, [])
  if (!s) return null
  const set = async (on: boolean): Promise<void> => {
    try {
      setS(await api.setStartWithWindows(on))
    } catch (e) {
      toast.error('Couldn’t change it', { description: (e as Error).message })
    }
  }
  return (
    <SettingItem id="general.startup">
      <Row
        label="Start with Windows (minimized to tray)"
        hint={
          s.supported
            ? 'Starts when you sign in to Windows, with just the tray icon, so scheduled backups and alerts keep running. Click the tray icon to open it.'
            : s.reason
        }
      >
        <Switch
          checked={s.on}
          disabled={!s.supported}
          onCheckedChange={(v) => void set(v)}
          aria-label="Start with Windows (minimized to tray)"
        />
      </Row>
      {s.disabledInTaskManager && (
        <p className="mt-2 text-xs text-warning">
          It’s turned off in Task Manager → Startup apps, so Windows won’t start it. Turn it on
          there.
        </p>
      )}
      {s.otherCopy && (
        <p className="mt-2 text-xs text-muted-foreground">
          Another copy of the app starts with Windows now (
          <span className="selectable font-mono">{s.otherCopy}</span>). Turning this on starts this
          copy instead.
        </p>
      )}
    </SettingItem>
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
          <TriangleAlert /> Can&apos;t read
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
          <ProviderBadge provider={s.provider} />
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

// ─── Scrolling ───────────────────────────────────────────────────────────

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Where on the page (scrollTop) a target's heading or setting sits under the sticky headers. */
function targetTop(container: HTMLElement, target: string): number | null {
  const r = resolveTarget(target)
  if (!r) return null
  const cTop = container.getBoundingClientRect().top - container.scrollTop
  if (r.kind === 'section') {
    const el = container.querySelector<HTMLElement>(`[data-settings-section="${r.id}"]`)
    if (!el || el.closest('[hidden]')) return null
    // The header's own place (not where it's stuck): the section's top plus its padding.
    return (
      el.getBoundingClientRect().top - cTop + parseFloat(getComputedStyle(el).paddingTop || '0')
    )
  }
  if (r.kind === 'sub') {
    const el = container.querySelector<HTMLElement>(`[data-settings-sub-group="${r.id}"]`)
    if (!el || el.closest('[hidden]')) return null
    return el.getBoundingClientRect().top - cTop - SECTION_HEADER_PX
  }
  const el = container.querySelector<HTMLElement>(`[data-setting-id="${r.id}"]`)
  if (!el || el.closest('[hidden]')) return null
  const def = settingDef(r.id)
  const under = SECTION_HEADER_PX + (def?.sub ? SUB_HEADER_PX : 0) + 16
  return el.getBoundingClientRect().top - cTop - under
}

// ─── The page ────────────────────────────────────────────────────────────

export function SettingsView() {
  const settings = useApp((s) => s.settings)
  const sources = useApp((s) => s.sources)
  const scan = useApp((s) => s.scan)
  const info = useApp((s) => s.info)
  const set = useApp((s) => s.set)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const query = useSettingsUi((s) => s.query)
  const [archive, setArchive] = useState<ArchiveStats | null>(null)
  const [rescanning, setRescanning] = useState(false)
  const [showTop, setShowTop] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  /** Scroll-spy waits while the page scrolls itself to a link. */
  const spyLockUntil = useRef(0)
  /** The newest link being followed; an older one still waiting for its target stops. */
  const linkToken = useRef(0)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void api.getArchiveStats().then(setArchive)
  }, [scan.phase, sources])

  const codexOn = useEnabledProviders().includes('codex')

  const update: Update = async (patch) => {
    set({ settings: { ...useApp.getState().settings, ...patch } })
    set({ settings: await api.updateSettings(patch) })
  }

  const spy = useCallback((): void => {
    const c = scrollRef.current
    if (!c) return
    setShowTop(c.scrollTop > 480)
    if (performance.now() < spyLockUntil.current) return
    const top = c.getBoundingClientRect().top
    const sections = [...c.querySelectorAll<HTMLElement>('[data-settings-section]:not([hidden])')]
    if (!sections.length) return
    let active = sections[0]
    for (const s of sections)
      if (s.getBoundingClientRect().top - top <= SECTION_HEADER_PX + 8) active = s
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 2 && c.scrollTop > 0) {
      // At the very bottom: the last section that shows on screen.
      const shown = sections.filter((s) => s.getBoundingClientRect().top - top < c.clientHeight)
      active = shown[shown.length - 1] ?? active
    }
    let sub: string | null = null
    for (const g of active.querySelectorAll<HTMLElement>('[data-settings-sub-group]:not([hidden])'))
      if (g.getBoundingClientRect().top - top <= SECTION_HEADER_PX + SUB_HEADER_PX + 8)
        sub = g.dataset.settingsSubGroup ?? null
    const section = active.dataset.settingsSection as Parameters<typeof settingsUi.setActive>[0]
    settingsUi.setActive(section, sub)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => saveLastSection(sub ?? section), 400)
  }, [])

  const scrollToTarget = useCallback((target: string, smooth: boolean): void => {
    const r = resolveTarget(target)
    const c = scrollRef.current
    if (!r || !c) return
    const ui = useSettingsUi.getState()
    // A search that hides the target is cleared: a setting it doesn't match, or a
    // section or sub-heading where it matches nothing.
    if (ui.query.trim()) {
      const shown = visibleSettingIds(ui.mounted, ui.query)
      const hidden =
        r.kind === 'setting'
          ? !matchSetting(settingDef(r.id)!, ui.query).match
          : settingsIn(shown, r.kind === 'sub' ? { sub: r.id } : { section: r.section }).length ===
            0
      if (hidden) settingsUi.setQuery('')
    }
    if (ui.collapsed[r.section]) settingsUi.toggleCollapsed(r.section, false)
    const def = r.kind === 'setting' ? settingDef(r.id) : undefined
    const go = (to: string, kind: 'section' | 'sub' | 'setting'): void => {
      const y = targetTop(c, to)
      if (y === null) return
      settingsUi.setActive(
        r.section,
        kind === 'sub' ? to : kind === 'setting' ? (def?.sub ?? null) : null
      )
      const behavior: ScrollBehavior = smooth && !reducedMotion() ? 'smooth' : 'auto'
      spyLockUntil.current = performance.now() + (behavior === 'smooth' ? 900 : 50)
      c.scrollTo({ top: Math.max(0, Math.round(y)), behavior })
      if (kind === 'setting') settingsUi.highlight(to)
      saveLastSection(kind === 'setting' ? (def?.sub ?? r.section) : to)
    }
    // Wait for it to be on the page: an unfolded section or a cleared search renders
    // next frame, and a few settings appear once their status has loaded (phone,
    // startup). One that never shows (e.g. Codex's while Codex is off) goes to its
    // heading instead, and says so.
    const started = performance.now()
    const token = ++linkToken.current
    const tick = (): void => {
      if (token !== linkToken.current) return
      if (targetTop(c, r.id) !== null) return go(r.id, r.kind)
      if (performance.now() - started < 1500) {
        requestAnimationFrame(tick)
        return
      }
      if (r.kind === 'setting') {
        const fallback = def?.sub && targetTop(c, def.sub) !== null ? def.sub : r.section
        go(fallback, fallback === r.section ? 'section' : 'sub')
        toast(`“${def?.label ?? r.id}” isn’t shown right now`, {
          description: def?.codex
            ? 'It’s a Codex setting: turn Codex on in Providers & sources.'
            : 'It appears when it applies here.'
        })
      }
    }
    requestAnimationFrame(tick)
  }, [])

  // Opened with a link (a section, a sub-heading or one setting), or a menu click.
  const target = useApp((s) => s.settingsSection)
  const firstRender = useRef(true)
  useLayoutEffect(() => {
    const first = firstRender.current
    firstRender.current = false
    if (target) {
      scrollToTarget(target, !first)
      set({ settingsSection: null })
      return
    }
    // Opened without one: back to the section that was in view last time.
    if (first) {
      const last = readLastSection()
      if (last) scrollToTarget(last, false)
    }
  }, [target, set, scrollToTarget])

  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current)
      linkToken.current++
    },
    []
  )

  useSearchHighlight(pageRef, query)
  // A search changes what's on the page: the section in view may have changed.
  useEffect(() => {
    requestAnimationFrame(spy)
  }, [query, spy])

  useHotkeys([
    { combo: 'mod+f', allowInInput: true, handler: () => settingsUi.focusSearch() },
    {
      combo: 'home',
      handler: () =>
        scrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
    },
    {
      combo: 'end',
      handler: () => {
        const c = scrollRef.current
        if (c) c.scrollTo({ top: c.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
      }
    }
  ])

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
  const searching = query.trim() !== ''

  return (
    <main aria-label="Settings" className="relative h-full bg-background">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto"
        data-nav-scroll="main"
        onScroll={spy}
        id="settings-scroll"
      >
        <div ref={pageRef} className="mx-auto max-w-[760px] px-10 pt-8 pb-[40vh]">
          <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Settings</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Everything stays on this computer. The app only reads Claude Code&apos;s and
            Codex&apos;s files and keeps its own data separately.
          </p>
          {!sidebarOpen && (
            <div className="mt-4 max-w-sm">
              <SettingsSearchField />
            </div>
          )}
          {searching && <NoResults />}

          <SettingsSection id="general">
            <SettingItem id="general.theme">
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
            </SettingItem>
            <StartupSetting />
          </SettingsSection>

          <SettingsSection id="sources">
            <ProvidersSettings update={update} />
            <SettingItem id="sources.folders" className="space-y-3">
              <div>
                <div className="text-[13px] font-medium">Scan sources</div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Detected automatically: your Windows profile and every WSL distro (each user in
                  /home, plus /root). Add any other folder that contains Claude Code sessions, or a
                  .codex folder.
                </p>
              </div>
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void rescan()}
                  disabled={rescanning}
                >
                  <RefreshCw className={cn(rescanning && 'animate-spin')} /> Rescan now
                </Button>
              </div>
            </SettingItem>
            <SettingItem id="sources.stopped-distros">
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
            </SettingItem>
            <SettingItem id="sources.cowork">
              <Row
                label="Claude desktop (Cowork) sessions"
                hint="Also show the Claude desktop app's Cowork tasks, view-only (read, search, usage and git links; no Resume). Only their transcripts are read, never the sign-in files kept next to them; their archive copies are backed up only while this is on. The desktop app's Code tab sessions are already included: they live in the same folder as the terminal's."
              >
                <Switch
                  checked={settings.coworkSource === true}
                  onCheckedChange={(v) => void update({ coworkSource: v })}
                  aria-label="Claude desktop (Cowork) sessions"
                />
              </Row>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Cloud sessions (claude.ai/code, Claude Code on the web) and normal claude.ai chats
                aren&apos;t stored on this PC, so they aren&apos;t listed. claude.ai chats can be
                imported from a claude.ai data export.
              </p>
            </SettingItem>
            <SettingItem id="sources.claude-ai">
              <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <MessagesSquare className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">Import claude.ai data export</div>
                  <div className="text-xs text-muted-foreground">
                    Adds your claude.ai conversations to the archive as view-only sessions you can
                    read and search. The zip is only read, never changed.
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
            </SettingItem>
          </SettingsSection>

          <SettingsSection id="launching">
            <SettingItem id="launching.terminal">
              <Row
                label="Terminal"
                hint="For Claude Code and Codex launches. Falls back to PowerShell if Windows Terminal isn't installed."
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
            </SettingItem>
            <SettingsSub id="launching.claude">
              <SettingItem id="launching.remote-control">
                <Row
                  label="Remote Control by default"
                  hint={
                    <>
                      Adds{' '}
                      <span className="font-mono">
                        --remote-control &quot;&lt;session name&gt;&quot;
                      </span>{' '}
                      to Resume, Fork, Continue fresh and Branch, for Windows and WSL sessions. It
                      makes the session continuable from the Claude mobile app (and at
                      claude.ai/code). Needs Claude Code 2.1.51 or later and your Claude
                      subscription (not an API key). Launches from a paired phone always have it on.
                      <span className="block">
                        <SeeAlso to="phone">Phone &amp; remote</SeeAlso>
                      </span>
                    </>
                  }
                >
                  <Switch
                    checked={settings.remoteControlDefault}
                    onCheckedChange={(v) => void update({ remoteControlDefault: v })}
                    aria-label="Remote Control by default"
                  />
                </Row>
              </SettingItem>
              <SettingItem id="launching.model">
                <Row
                  label="Model, effort and fast mode"
                  hint={
                    <>
                      <span className="font-mono">--model</span>,{' '}
                      <span className="font-mono">--effort</span> and fast mode for every launch. A
                      session&apos;s own choice wins, then its project&apos;s. Default and Off add
                      no flag.
                      <span className="block">
                        <SeeAlso to="accounts.billing">Default billing for launches</SeeAlso>
                      </span>
                    </>
                  }
                >
                  <DefaultModelPickers
                    model={settings.defaultModel}
                    effort={settings.defaultEffort}
                    fast={settings.defaultFast}
                    onModel={(defaultModel) => void update({ defaultModel })}
                    onEffort={(defaultEffort) => void update({ defaultEffort })}
                    onFast={(defaultFast) => void update({ defaultFast })}
                  />
                </Row>
              </SettingItem>
              <SettingItem id="launching.project-models">
                <ProjectModelDefaults field="projectModels" update={update} />
              </SettingItem>
              <SettingItem id="launching.skip-permissions">
                <Row
                  label="Skip permission prompts by default"
                  hint={
                    <>
                      Claude Code: adds{' '}
                      <span className="font-mono">--dangerously-skip-permissions</span>. You can
                      still change it for each launch. Never for launches from the phone.
                      {codexOn && (
                        <span className="block">
                          <SeeAlso to="launching.codex-bypass">Codex’s own default</SeeAlso>
                        </span>
                      )}
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
              </SettingItem>
            </SettingsSub>

            {codexOn && (
              <SettingsSub id="launching.codex">
                <SettingItem id="launching.codex-bypass">
                  <Row
                    label="Codex: bypass approvals and sandbox by default"
                    hint={
                      <>
                        Adds{' '}
                        <span className="font-mono">
                          --dangerously-bypass-approvals-and-sandbox
                        </span>
                        : Codex runs commands without asking <b>and</b> outside its sandbox, so they
                        can read and change anything your Windows (or WSL) user can. Separate from
                        Claude Code&apos;s. You can still change it for each launch. Never for
                        launches from the phone.
                      </>
                    }
                  >
                    <Switch
                      checked={settings.codexBypassDefault ?? settings.skipPermissionsDefault}
                      onCheckedChange={(v) => void update({ codexBypassDefault: v })}
                      aria-label="Codex: bypass approvals and sandbox by default"
                    />
                  </Row>
                  {(settings.codexBypassDefault ?? settings.skipPermissionsDefault) && (
                    <SkipPermissionsWarning codex className="mt-2" />
                  )}
                </SettingItem>
                <CodexLaunchSettings update={update} />
              </SettingsSub>
            )}

            <SettingsSub id="launching.large">
              <ContextSettings update={update} />
            </SettingsSub>
          </SettingsSection>

          <SettingsSection id="usage">
            <SettingsSub id="usage.plan">
              <PlanSetting update={update} />
              <PlanHistory update={update} />
              <WeekStartSetting update={update} />
            </SettingsSub>
            <SettingsSub id="usage.live-limits">
              <LiveLimitsBridge />
            </SettingsSub>
            <SettingsSub id="usage.health">
              <LimitHealthSettings update={update} />
            </SettingsSub>
            <SettingsSub id="usage.pacing">
              <PacingSettings update={update} />
            </SettingsSub>
            <SettingsSub id="usage.prices">
              <PriceTable update={update} />
            </SettingsSub>
            {codexOn && (
              <SettingsSub id="usage.codex">
                <CodexUsageSettings update={update} />
              </SettingsSub>
            )}
            {codexOn && (
              <SettingsSub id="usage.meter">
                <MeterProviderSetting update={update} />
              </SettingsSub>
            )}
          </SettingsSection>

          <SettingsSection id="alerts">
            <LimitAlertsSetting update={update} />
            <AlertsSettings update={update} />
          </SettingsSection>

          <SettingsSection id="ai">
            <SettingsSub id="ai.summaries">
              <SummariesSettings update={update} />
            </SettingsSub>
            <SettingsSub id="ai.ask-claude">
              <AskClaudeSettings update={update} />
            </SettingsSub>
            {!api.remote && (
              <SettingsSub id="ai.ask-sessions">
                <AskSettings />
              </SettingsSub>
            )}
          </SettingsSection>

          {!api.remote && (
            <SettingsSection id="git">
              <GitSettings />
            </SettingsSection>
          )}

          <SettingsSection id="phone">
            <MobileSettingsSection />
            <SettingsSub id="phone.terminal">
              <SettingItem id="phone.terminal">
                <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                  A real terminal on this PC from your phone, through Windows’ own OpenSSH Server,
                  over Tailscale only. Every change is shown first and can be undone.
                </p>
                <TerminalAccessBlock />
              </SettingItem>
            </SettingsSub>
          </SettingsSection>

          <SettingsSection id="accounts">
            <AccountsSettings update={update} />
          </SettingsSection>

          <SettingsSection id="archive">
            <SettingItem id="archive.archive">
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                Every Claude Code session file is copied here and kept forever, so sessions survive
                Claude Code&apos;s cleanup (Codex sessions as set below). Nothing is ever removed
                from the archive automatically.
              </p>
              <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <Archive className="size-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    Archive ·{' '}
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
            </SettingItem>
            <CodexArchiveSettings update={update} />
            <SettingItem id="archive.cleanup" className="space-y-3">
              <div>
                <div className="text-[13px] font-medium">Claude Code cleanup</div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Claude Code deletes sessions older than{' '}
                  <span className="font-mono">cleanupPeriodDays</span> (30 days by default). The
                  archive above keeps them anyway. This app never edits Claude&apos;s settings.
                </p>
              </div>
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
                      aria-label={`Open the folder of ${s.label}’s settings`}
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
            </SettingItem>
            <BackupSettings />
          </SettingsSection>

          <SettingsSection id="advanced">
            <RecalculateUsage />
            <CapacityWeightsSetting update={update} />
            <PhonePortsSetting />
            <SettingItem id="advanced.about">
              <div className="text-[13px] font-medium">About</div>
              <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 shrink-0 text-success" />
                  No network access, except read-only usage reports from api.anthropic.com when you
                  add an Admin API key, and what you turn on yourself (phone access, push alerts,
                  GitHub CLI lookups). Names, descriptions and tags are stored only in the
                  app&apos;s own data folder.
                </div>
                <div className="flex items-center gap-2">
                  <HardDrive className="size-4 shrink-0" />
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
            </SettingItem>
          </SettingsSection>
        </div>
      </div>
      <button
        type="button"
        onClick={() =>
          scrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
        }
        aria-label="Back to the top"
        tabIndex={showTop ? 0 : -1}
        aria-hidden={!showTop}
        className={cn(
          'absolute right-6 bottom-6 z-30 flex h-8 items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs font-medium text-foreground shadow-md transition-[opacity,transform] duration-150 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none motion-reduce:transition-none',
          showTop ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
        )}
        data-top-button
      >
        <ArrowUp className="size-3.5" /> Top
      </button>
    </main>
  )
}

/** "No settings match": shown when a search hides everything. */
function NoResults() {
  const query = useSettingsUi((s) => s.query)
  const mounted = useSettingsUi((s) => s.mounted)
  const any = Object.keys(mounted).some((id) => {
    const d = settingDef(id)
    return d && matchSetting(d, query).match
  })
  if (any) return null
  return (
    <div className="mt-10 rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
      No settings match “{query.trim()}”.{' '}
      <button
        type="button"
        className="font-medium text-primary hover:underline"
        onClick={() => settingsUi.setQuery('')}
      >
        Clear the search
      </button>
    </div>
  )
}
