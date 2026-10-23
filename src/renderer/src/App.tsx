import { useEffect, useMemo, useRef, useState } from 'react'
import { Toaster } from 'sonner'
import { setClockOffset } from '@shared/clock'
import { api } from '@/lib/api'
import { copyResumeCommand, exportMarkdown, openResume, toggleHidden } from '@/lib/actions'
import { branchCounts, groupBranches, visibleSessions } from '@/lib/filters'
import { useHotkeys } from '@/lib/hotkeys'
import { useLiveData } from '@/lib/live'
import { useApp } from '@/lib/store'
import { useThemeEffect } from '@/lib/theme'
import { cn, MOD } from '@/lib/utils'
import { ClaudeMark } from './components/brand'
import { BranchIntroDialog } from './components/BranchIntroDialog'
import { CommandPalette } from './components/CommandPalette'
import { SessionList } from './components/list/SessionList'
import { ResumeDialog } from './components/ResumeDialog'
import { SettingsView } from './components/SettingsView'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Shortcut } from './components/ui/kbd'
import { TooltipProvider } from './components/ui/tooltip'
import { SessionViewer } from './components/viewer/SessionViewer'
import { TrayPainter } from './components/usage/TrayPainter'
import { UsageView } from './components/usage/UsageView'

const LIST_WIDTH_KEY = 'csd.listWidth'

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(LIST_WIDTH_KEY))
    return v >= 300 && v <= 640 ? v : 400
  } catch {
    return 400
  }
}

function useBootstrap(): void {
  const set = useApp((s) => s.set)
  useEffect(() => {
    void Promise.all([api.getInfo(), api.getSettings(), api.getSessions()]).then(
      ([info, settings, payload]) => {
        setClockOffset(info.clockOffset)
        set({
          info,
          settings,
          sessions: payload.sessions,
          sources: payload.sources,
          scan: payload.scan,
          loaded: true
        })
      }
    )
    const offs = [
      api.onSessionsChanged((p) => set({ sessions: p.sessions, sources: p.sources, scan: p.scan })),
      // Tray icon or limit notification clicked.
      api.onShowUsage(() => set({ view: 'usage' }))
    ]
    return () => offs.forEach((off) => off())
  }, [set])
}

function NoSelection() {
  const set = useApp((s) => s.set)
  return (
    <div className="flex h-full flex-col items-center justify-center bg-background px-8 text-center">
      <ClaudeMark className="size-10 rounded-xl opacity-90" />
      <div className="mt-4 text-[15px] font-semibold">Select a session</div>
      <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
        Read the conversation, give it a name, and resume it in a terminal with its full context.
      </p>
      <div className="mt-6 grid grid-cols-[auto_auto] gap-x-6 gap-y-2 text-left text-xs text-muted-foreground">
        <Shortcut keys={`${MOD}+K`} />
        <span>Jump anywhere</span>
        <Shortcut keys="J+K" />
        <span>Move through the list</span>
        <Shortcut keys={`${MOD}+Enter`} />
        <span>Resume the selected session</span>
        <Shortcut keys="?" />
        <button
          type="button"
          className="text-left hover:text-foreground"
          onClick={() => set({ shortcutsOpen: true })}
        >
          All keyboard shortcuts
        </button>
      </div>
    </div>
  )
}

export function App() {
  useBootstrap()
  useLiveData(useApp((s) => s.info !== null))
  const sessions = useApp((s) => s.sessions)
  const filters = useApp((s) => s.filters)
  const sort = useApp((s) => s.sort)
  const hits = useApp((s) => s.hits)
  const selectedKey = useApp((s) => s.selectedKey)
  const view = useApp((s) => s.view)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const loaded = useApp((s) => s.loaded)
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const select = useApp((s) => s.select)
  const requestFocus = useApp((s) => s.requestFocus)
  const resolvedTheme = useThemeEffect(settings.theme)
  const grouped = useApp((s) => s.groupBranches)

  // With grouping on, branches follow their parent (keyboard order matches the list).
  const { items, depth } = useMemo(() => {
    const list = visibleSessions(sessions, filters, sort, hits)
    return grouped ? groupBranches(list) : { items: list, depth: undefined }
  }, [sessions, filters, sort, hits, grouped])
  const counts = useMemo(() => branchCounts(sessions), [sessions])
  const selected = sessions.find((s) => s.key === selectedKey)
  const allTags = useMemo(
    () => [...new Set(sessions.flatMap((s) => s.meta.tags ?? []))].sort(),
    [sessions]
  )

  // Select the first session once data arrives.
  const autoSelected = useRef(false)
  useEffect(() => {
    if (!autoSelected.current && loaded && items.length > 0 && !selectedKey) {
      autoSelected.current = true
      select(items[0].key)
    }
  }, [loaded, items, selectedKey, select])

  // Keep the viewer in sync with the list: if a search or filter hides the
  // selected session, select the first visible one.
  useEffect(() => {
    if (!loaded || view !== 'sessions' || !items.length) return
    if (selectedKey && !items.some((s) => s.key === selectedKey)) select(items[0].key)
  }, [items, selectedKey, loaded, view, select])

  const [listWidth, setListWidth] = useState(readWidth)
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const start = listWidth
    let latest = start
    const move = (ev: PointerEvent): void => {
      latest = Math.min(640, Math.max(300, start + ev.clientX - startX))
      setListWidth(latest)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      try {
        localStorage.setItem(LIST_WIDTH_KEY, String(latest))
      } catch {
        // per-viewer convenience only
      }
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const step = (delta: number | 'first' | 'last'): void => {
    if (!items.length) return
    const i = items.findIndex((s) => s.key === selectedKey)
    const next =
      delta === 'first'
        ? 0
        : delta === 'last'
          ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, (i < 0 ? -1 : i) + delta))
    select(items[next].key)
  }
  const listFocused = (): boolean => {
    const a = document.activeElement
    return !a || a === document.body || a.id === 'session-list'
  }
  const inSessions = (): boolean => view === 'sessions' && !useApp.getState().resume
  const withSel = (fn: (key: string) => void) => () => {
    if (selectedKey) fn(selectedKey)
  }

  useHotkeys([
    {
      combo: 'mod+k',
      allowInInput: true,
      handler: () => set({ paletteOpen: !useApp.getState().paletteOpen })
    },
    { combo: 'mod+p', allowInInput: true, handler: () => set({ paletteOpen: true }) },
    {
      combo: 'mod+,',
      allowInInput: true,
      handler: () => set({ view: view === 'settings' ? 'sessions' : 'settings' })
    },
    { combo: 'mod+b', allowInInput: true, handler: () => set({ sidebarOpen: !sidebarOpen }) },
    {
      combo: 'mod+u',
      allowInInput: true,
      handler: () => set({ view: view === 'usage' ? 'sessions' : 'usage' })
    },
    { combo: 'f5', allowInInput: true, handler: () => void api.rescan() },
    { combo: '?', handler: () => set({ shortcutsOpen: true }) },
    {
      combo: '/',
      handler: () => {
        set({ view: 'sessions' })
        requestFocus('search')
      }
    },
    {
      combo: 'escape',
      handler: () => set({ view: 'sessions' }),
      when: () => view === 'settings' || view === 'usage'
    },
    { combo: 'j', handler: () => step(1), when: inSessions },
    { combo: 'k', handler: () => step(-1), when: inSessions },
    { combo: 'arrowdown', handler: () => step(1), when: () => inSessions() && listFocused() },
    { combo: 'arrowup', handler: () => step(-1), when: () => inSessions() && listFocused() },
    { combo: 'home', handler: () => step('first'), when: () => inSessions() && listFocused() },
    { combo: 'end', handler: () => step('last'), when: () => inSessions() && listFocused() },
    { combo: 'mod+enter', handler: withSel((k) => openResume(k, false)), when: inSessions },
    { combo: 'mod+shift+enter', handler: withSel((k) => openResume(k, true)), when: inSessions },
    {
      combo: 'f2',
      allowInInput: true,
      handler: () => requestFocus('name'),
      when: () => inSessions() && !!selectedKey
    },
    {
      combo: 'd',
      handler: () => requestFocus('description'),
      when: () => inSessions() && !!selectedKey
    },
    { combo: 't', handler: () => requestFocus('tags'), when: () => inSessions() && !!selectedKey },
    { combo: 'h', handler: withSel((k) => void toggleHidden(k)), when: inSessions },
    {
      combo: 'mod+e',
      allowInInput: true,
      handler: withSel((k) => void exportMarkdown(k)),
      when: inSessions
    },
    { combo: 'mod+shift+c', handler: withSel((k) => void copyResumeCommand(k)), when: inSessions }
  ])

  return (
    <TooltipProvider delayDuration={450} skipDelayDuration={150}>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              'shrink-0 overflow-hidden border-r border-border transition-[width] duration-200 ease-out',
              sidebarOpen ? 'w-[232px]' : 'w-0 border-r-0'
            )}
          >
            <div className="h-full w-[232px]">
              <Sidebar />
            </div>
          </div>
          {view === 'settings' ? (
            <div className="min-w-0 flex-1">
              <SettingsView />
            </div>
          ) : view === 'usage' ? (
            <div className="min-w-0 flex-1">
              <UsageView />
            </div>
          ) : (
            <>
              <div
                className="relative shrink-0 border-r border-border"
                style={{ width: listWidth }}
              >
                <SessionList
                  items={items}
                  total={sessions.length}
                  depth={depth}
                  branchCounts={counts}
                />
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize list"
                  onPointerDown={startResize}
                  onDoubleClick={() => setListWidth(400)}
                  className="absolute top-0 -right-[3px] z-10 h-full w-[5px] cursor-col-resize transition-colors hover:bg-primary/30"
                />
              </div>
              <main className="min-w-0 flex-1">
                {selected ? (
                  <SessionViewer key={selected.key} session={selected} allTags={allTags} />
                ) : (
                  <NoSelection />
                )}
              </main>
            </>
          )}
        </div>
      </div>
      <CommandPalette />
      <ResumeDialog />
      <BranchIntroDialog />
      <ShortcutsDialog />
      <TrayPainter dark={resolvedTheme === 'dark'} />
      <Toaster
        theme={resolvedTheme}
        position="bottom-right"
        offset={16}
        toastOptions={{
          classNames: {
            toast:
              '!bg-popover !text-popover-foreground !border-border !rounded-lg !shadow-xl !text-[13px] !font-sans',
            description: '!text-muted-foreground !text-xs !font-mono break-all',
            actionButton: '!bg-primary !text-primary-foreground'
          }
        }}
      />
    </TooltipProvider>
  )
}
