// The phone companion: the desktop app's components in a phone layout
// (bottom tabs, cards, full-screen session view) over the web transport.

import { useEffect, useState } from 'react'
import { toast, Toaster } from 'sonner'
import { ChartNoAxesColumn, MessagesSquare, Settings2, Zap } from 'lucide-react'
import { setClockOffset } from '@shared/clock'
import { api } from '@/lib/api'
import { useLiveData } from '@/lib/live'
import { useLiveCounts, useLiveSessions } from '@/lib/live-sessions'
import { useApp } from '@/lib/store'
import { useThemeEffect } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { phone } from '@/lib/web-api'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UsageView } from '@/components/usage/UsageView'
import { PairScreen } from './PairScreen'
import { SessionsTab } from './SessionsTab'
import { SessionScreen } from './SessionScreen'
import { SettingsTab } from './SettingsTab'
import { RunningTab } from './RunningTab'
import { bootstrap } from './bootstrap'
import { useMobile } from './state'

function useBootstrap(paired: boolean): void {
  const set = useApp((s) => s.set)
  const setMe = useMobile((s) => s.setMe)
  const setTerminal = useMobile((s) => s.setTerminal)
  useEffect(() => {
    if (!paired) return
    let cancelled = false
    // Everything the app needs to start, retried until the PC answers (e.g.
    // the home-screen app opened while the PC was off).
    const boot = bootstrap({
      run: async () => {
        const [info, settings, payload, me] = await Promise.all([
          api.getInfo(),
          api.getSettings(),
          api.getSessions(),
          phone.me()
        ])
        if (cancelled) return
        setClockOffset(info.clockOffset)
        setMe(me)
        set({
          info,
          settings,
          sessions: payload.sessions,
          sources: payload.sources,
          scan: payload.scan,
          loaded: true
        })
      },
      loaded: () => useApp.getState().loaded,
      onError: (err) =>
        toast.error("Couldn't reach your PC", { description: err.message, id: 'boot' })
    })
    const load = boot.load
    const notLoaded = (): boolean => !useApp.getState().loaded
    const reloadMe = (): void => {
      void phone
        .me()
        .then(setMe)
        .catch(() => undefined)
      // Terminal access (SSH) may have been set up or turned off on the PC.
      void api
        .getTerminalAccess()
        .then(setTerminal)
        .catch(() => undefined)
    }
    load()
    reloadMe()
    phone.connect()
    const offs = [
      api.onSessionsChanged((p) => set({ sessions: p.sessions, sources: p.sources, scan: p.scan })),
      // Polling (when live updates are blocked) also reaches here.
      phone.on('sessions', () => notLoaded() && load()),
      phone.onToast((t) => toast(t.title, { description: t.body })),
      // Settings changed on the PC (or another phone).
      phone.on('settings', () => void api.getSettings().then((settings) => set({ settings }))),
      // Read-only / confirm-on-PC changed on the PC.
      phone.on('policy', reloadMe),
      // Back online: finish starting, or catch up on the policy.
      phone.onConnection((c) => {
        if (c !== 'live') return
        if (notLoaded()) load()
        else reloadMe()
      })
    ]
    return () => {
      cancelled = true
      boot.cancel()
      offs.forEach((off) => off())
    }
  }, [paired, set, setMe, setTerminal])
}

const TABS = [
  { id: 'sessions', label: 'Sessions', icon: MessagesSquare },
  { id: 'running', label: 'Running', icon: Zap },
  { id: 'usage', label: 'Usage', icon: ChartNoAxesColumn },
  { id: 'settings', label: 'Settings', icon: Settings2 }
] as const

export function MobileApp() {
  const [paired, setPaired] = useState(phone.paired())
  const theme = useMobile((s) => s.theme)
  const resolved = useThemeEffect(theme)
  useEffect(() => phone.onAuth(setPaired), [])
  useBootstrap(paired)
  useLiveData(useApp((s) => s.info !== null) && paired)
  useLiveSessions(useApp((s) => s.info !== null) && paired)
  const live = useLiveCounts()
  // A tapped push alert: its session (resolved on the PC), else Running now.
  useEffect(() => {
    if (!paired) return
    return phone.onOpenLive((ref) => {
      useApp.getState().set({ view: 'running', selectedKey: null })
      if (!ref) return
      void api
        .resolveLiveRef(ref)
        .then((key) => {
          if (key && useApp.getState().sessions.some((s) => s.key === key))
            useApp.getState().set({ selectedKey: key })
        })
        .catch(() => undefined)
    })
  }, [paired])
  const view = useApp((s) => s.view)
  const set = useApp((s) => s.set)
  const openKey = useApp((s) => s.selectedKey)
  const sessions = useApp((s) => s.sessions)
  const open = openKey ? sessions.find((s) => s.key === openKey) : undefined

  return (
    <TooltipProvider delayDuration={600}>
      {!paired ? (
        <PairScreen />
      ) : (
        <div className="flex h-dvh flex-col bg-surface">
          <div className="relative min-h-0 flex-1">
            <div className={cn('absolute inset-0', view !== 'sessions' && 'hidden')}>
              <SessionsTab />
            </div>
            {view === 'running' && (
              <div className="absolute inset-0">
                <RunningTab />
              </div>
            )}
            {view === 'usage' && (
              <div className="absolute inset-0 pt-[env(safe-area-inset-top)]">
                <UsageView />
              </div>
            )}
            {view === 'settings' && (
              <div className="absolute inset-0">
                <SettingsTab />
              </div>
            )}
          </div>
          <nav
            aria-label="Sections"
            className="flex shrink-0 border-t border-border bg-chrome/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
          >
            {TABS.map((t) => {
              const active = view === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() =>
                    set({ view: t.id, ...(t.id === view ? { selectedKey: null } : {}) })
                  }
                  className={cn(
                    'flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium transition-colors',
                    active ? 'text-primary' : 'text-muted-foreground'
                  )}
                >
                  <span className="relative">
                    <t.icon className="size-[22px]" strokeWidth={active ? 2.2 : 1.8} />
                    {t.id === 'running' && live.running > 0 && (
                      <span
                        className={cn(
                          'absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white tabular-nums',
                          live.approval ? 'bg-warning' : 'bg-primary'
                        )}
                      >
                        {live.running}
                      </span>
                    )}
                  </span>
                  {t.label}
                </button>
              )
            })}
          </nav>
          {open && <SessionScreen key={open.key} session={open} />}
        </div>
      )}
      <Toaster
        theme={resolved}
        position="top-center"
        offset={{ top: 'calc(env(safe-area-inset-top) + 8px)' }}
        toastOptions={{
          classNames: {
            toast:
              '!bg-popover !text-popover-foreground !border-border !rounded-xl !shadow-xl !text-[14px] !font-sans',
            description: '!text-muted-foreground !text-[13px]',
            actionButton: '!bg-primary !text-primary-foreground'
          }
        }}
      />
    </TooltipProvider>
  )
}
