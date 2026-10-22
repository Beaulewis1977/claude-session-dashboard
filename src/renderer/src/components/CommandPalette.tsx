import { useState, type ReactNode } from 'react'
import { Command } from 'cmdk'
import { Dialog as D } from 'radix-ui'
import {
  Archive,
  ChartColumnBig,
  PictureInPicture2,
  PlugZap,
  Plus,
  Copy,
  EyeOff,
  FileDown,
  FolderOpen,
  GitFork,
  Inbox,
  Keyboard,
  Monitor,
  Moon,
  PanelLeft,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Settings,
  SquareTerminal,
  Sun,
  Tag,
  Text
} from 'lucide-react'
import { formatRelative } from '@shared/format'
import { api } from '@/lib/api'
import {
  copyResumeCommand,
  exportMarkdown,
  openNewSession,
  openResume,
  showFile,
  toggleHidden
} from '@/lib/actions'
import { useApp, type FocusField } from '@/lib/store'
import { MOD } from '@/lib/utils'
import { EnvDot } from './EnvBadge'
import { Shortcut } from './ui/kbd'

function Item({
  icon,
  children,
  shortcut,
  onSelect,
  value,
  keywords
}: {
  icon?: ReactNode
  children: ReactNode
  shortcut?: string
  onSelect: () => void
  value: string
  keywords?: string[]
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] text-foreground/90 data-[selected=true]:bg-hover data-[selected=true]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Shortcut keys={shortcut} />}
    </Command.Item>
  )
}

const groupClass =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle-foreground'

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const set = useApp((s) => s.set)
  return (
    <D.Root open={open} onOpenChange={(o) => set({ paletteOpen: o })}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content
          className="fixed top-[14vh] left-1/2 z-50 w-[calc(100%-2rem)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <PaletteBody />
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function PaletteBody() {
  const sessions = useApp((s) => s.sessions)
  const selectedKey = useApp((s) => s.selectedKey)
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const select = useApp((s) => s.select)
  const setFilters = useApp((s) => s.setFilters)
  const requestFocus = useApp((s) => s.requestFocus)
  const [search, setSearch] = useState('')

  const selected = sessions.find((s) => s.key === selectedKey)
  const run = (fn: () => void) => () => {
    set({ paletteOpen: false })
    // Let the dialog close before moving focus.
    setTimeout(fn, 10)
  }
  const focus = (f: FocusField) =>
    run(() => {
      set({ view: 'sessions' })
      requestFocus(f)
    })
  const setTheme = (theme: 'light' | 'dark' | 'system') =>
    run(() => {
      set({ settings: { ...settings, theme } })
      void api.updateSettings({ theme }).then((st) => set({ settings: st }))
    })

  const recent = [...sessions]
    .filter((s) => !s.meta.hidden)
    .sort((a, b) => Date.parse(b.lastActivityAt ?? '0') - Date.parse(a.lastActivityAt ?? '0'))

  return (
    <Command loop className="flex max-h-[min(560px,70vh)] flex-col">
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-subtle-foreground" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder={
            selected
              ? `Search sessions, or act on “${selected.title.slice(0, 40)}”…`
              : 'Search sessions and commands…'
          }
          className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle-foreground"
        />
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <Command.Empty className="py-10 text-center text-[13px] text-muted-foreground">
          No matches
        </Command.Empty>

        {selected && (
          <Command.Group heading="Selected session" className={groupClass}>
            <Item
              value="resume session"
              icon={<Play />}
              shortcut={`${MOD}+Enter`}
              onSelect={run(() => openResume(selected.key, false))}
            >
              Resume
            </Item>
            <Item
              value="fork session"
              icon={<GitFork />}
              shortcut={`${MOD}+Shift+Enter`}
              onSelect={run(() => openResume(selected.key, true))}
            >
              Fork
            </Item>
            <Item
              value="new session in this folder"
              icon={<Plus />}
              onSelect={run(() => openNewSession(selected.key))}
            >
              New session in this folder…
            </Item>
            <Item
              value="rename session name"
              icon={<Pencil />}
              shortcut="F2"
              onSelect={focus('name')}
            >
              Rename
            </Item>
            <Item
              value="edit description"
              icon={<Text />}
              shortcut="D"
              onSelect={focus('description')}
            >
              Edit description
            </Item>
            <Item value="add tag" icon={<Tag />} shortcut="T" onSelect={focus('tags')}>
              Add tag
            </Item>
            <Item
              value="find in session"
              icon={<Search />}
              shortcut={`${MOD}+F`}
              onSelect={focus('find')}
            >
              Find in session
            </Item>
            <Item
              value="copy resume command"
              icon={<SquareTerminal />}
              shortcut={`${MOD}+Shift+C`}
              onSelect={run(() => void copyResumeCommand(selected.key))}
            >
              Copy resume command
            </Item>
            <Item
              value="copy claude command"
              icon={<Copy />}
              onSelect={run(() => void copyResumeCommand(selected.key, 'claude'))}
            >
              Copy claude command only
            </Item>
            <Item
              value="export markdown"
              icon={<FileDown />}
              shortcut={`${MOD}+E`}
              onSelect={run(() => void exportMarkdown(selected.key))}
            >
              Export to Markdown…
            </Item>
            <Item
              value="show file in folder explorer"
              icon={<FolderOpen />}
              onSelect={run(() => showFile(selected.key))}
            >
              Show file in folder
            </Item>
            <Item
              value="hide unhide session"
              icon={<EyeOff />}
              shortcut="H"
              onSelect={run(() => void toggleHidden(selected.key))}
            >
              {selected.meta.hidden ? 'Unhide' : 'Hide'}
            </Item>
          </Command.Group>
        )}

        <Command.Group heading="Sessions" className={groupClass}>
          {recent.map((s) => (
            <Command.Item
              key={s.key}
              value={`session ${s.key}`}
              keywords={[
                s.title,
                s.projectName,
                s.gitBranch ?? '',
                ...(s.meta.tags ?? []),
                s.summary ?? ''
              ]}
              onSelect={run(() => {
                set({ view: 'sessions' })
                select(s.key)
              })}
              className="flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] data-[selected=true]:bg-hover"
            >
              <EnvDot env={s.env} />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="max-w-[30%] shrink-0 truncate text-2xs text-muted-foreground">
                {s.projectName}
              </span>
              <span className="w-12 shrink-0 text-right text-2xs whitespace-nowrap text-subtle-foreground tabular-nums">
                {formatRelative(s.lastActivityAt)}
              </span>
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading="Usage" className={groupClass}>
          <Item
            value="usage limits tokens cost"
            icon={<ChartColumnBig />}
            shortcut={`${MOD}+U`}
            onSelect={run(() => set({ view: 'usage' }))}
          >
            Usage &amp; limits
          </Item>
          <Item
            value="mini meter always on top"
            icon={<PictureInPicture2 />}
            onSelect={run(() => void api.toggleMiniMeter())}
          >
            Toggle the mini meter
          </Item>
          <Item
            value="enable live limits status line bridge"
            icon={<PlugZap />}
            onSelect={run(() => set({ view: 'settings' }))}
          >
            Enable live limits…
          </Item>
        </Command.Group>

        <Command.Group heading="Go to" className={groupClass}>
          <Item
            value="all sessions"
            icon={<Inbox />}
            onSelect={run(() => {
              set({ view: 'sessions' })
              setFilters({ visibility: 'visible' })
            })}
          >
            All sessions
          </Item>
          <Item
            value="archived only sessions"
            icon={<Archive />}
            onSelect={run(() => {
              set({ view: 'sessions' })
              setFilters({ visibility: 'archived' })
            })}
          >
            Archived only
          </Item>
          <Item
            value="hidden sessions"
            icon={<EyeOff />}
            onSelect={run(() => {
              set({ view: 'sessions' })
              setFilters({ visibility: 'hidden' })
            })}
          >
            Hidden sessions
          </Item>
          <Item
            value="settings preferences"
            icon={<Settings />}
            shortcut={`${MOD}+,`}
            onSelect={run(() => set({ view: 'settings' }))}
          >
            Settings
          </Item>
        </Command.Group>

        <Command.Group heading="App" className={groupClass}>
          <Item value="theme light" icon={<Sun />} onSelect={setTheme('light')}>
            Light theme
          </Item>
          <Item value="theme dark" icon={<Moon />} onSelect={setTheme('dark')}>
            Dark theme
          </Item>
          <Item value="theme system" icon={<Monitor />} onSelect={setTheme('system')}>
            System theme
          </Item>
          <Item
            value="toggle sidebar"
            icon={<PanelLeft />}
            shortcut={`${MOD}+B`}
            onSelect={run(() => set({ sidebarOpen: !useApp.getState().sidebarOpen }))}
          >
            Toggle sidebar
          </Item>
          <Item
            value="rescan sources refresh"
            icon={<RefreshCw />}
            shortcut="F5"
            onSelect={run(() => void api.rescan())}
          >
            Rescan sources
          </Item>
          <Item
            value="keyboard shortcuts help"
            icon={<Keyboard />}
            shortcut="?"
            onSelect={run(() => set({ shortcutsOpen: true }))}
          >
            Keyboard shortcuts
          </Item>
        </Command.Group>
      </Command.List>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-2xs text-subtle-foreground">
        <span className="flex items-center gap-1">
          <Shortcut keys="↑+↓" /> navigate
        </span>
        <span className="flex items-center gap-1">
          <Shortcut keys="↵" /> select
        </span>
        <span className="flex items-center gap-1">
          <Shortcut keys="Esc" /> close
        </span>
      </div>
    </Command>
  )
}
