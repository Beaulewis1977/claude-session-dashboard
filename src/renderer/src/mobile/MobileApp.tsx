// The phone companion: the desktop app's components in a phone layout
// (bottom tabs, cards, full-screen session view) over the web transport.

import { useEffect, useState } from 'react'
import { toast, Toaster } from 'sonner'
import { ChartNoAxesColumn, MessagesSquare, Settings2 } from 'lucide-react'
import { setClockOffset } from '@shared/clock'
import { api } from '@/lib/api'
import { useLiveData } from '@/lib/live'
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
import { useMobile } from './state'

function useBootstrap(paired: boolean): void {
  const set = useApp((s) => s.set)
  const setMe = useMobile((s) => s.setMe)
  useEffect(() => {
    if (!paired) return
    let cancelled = false
    void Promise.all([api.getInfo(), api.getSettings(), api.getSessions(), phone.me()])
      .then(([info, settings, payload, me]) => {
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
      })
      .catch((err: Error) => toast.error("Couldn't reach your PC", { description: err.message }))
    phone.connect()
    const offs = [
      api.onSessionsChanged((p) => set({ sessions: p.sessions, sources: p.sources, scan: p.scan })),
      phone.onToast((t) => toast(t.title, { description: t.body })),
      // Settings changed on the PC (or another phone).
      phone.on('settings', () => void api.getSettings().then((settings) => set({ settings }))),
      // Read-only / confirm-on-PC may have changed while disconnected.
      phone.onConnection((c) => {
        if (c === 'live')
          void phone
            .me()
            .then(setMe)
            .catch(() => undefined)
      })
    ]
    return () => {
      cancelled = true
      offs.forEach((off) => off())
    }
  }, [paired, set, setMe])
}

const TABS = [
  { id: 'sessions', label: 'Sessions', icon: MessagesSquare },
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
                  <t.icon className="size-[22px]" strokeWidth={active ? 2.2 : 1.8} />
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
