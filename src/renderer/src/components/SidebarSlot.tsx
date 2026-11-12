// The left sidebar's slot: the normal sidebar (environments, projects, tags)
// and, while Settings is open, the Settings menu. Both stay mounted side by
// side and slide, so leaving Settings shows the normal sidebar exactly as it
// was (its scroll, "Show more", what's open). The one out of view is inert (no
// focus, hidden from screen readers). The slide is short and turns off with
// reduced motion.

import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Sidebar } from './Sidebar'
import { SettingsMenu } from './settings/SettingsMenu'

export function SidebarSlot() {
  const settings = useApp((s) => s.view === 'settings')
  const open = useApp((s) => s.sidebarOpen)
  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden border-r border-border transition-[width] duration-200 ease-out motion-reduce:transition-none',
        open ? 'w-[232px]' : 'w-0 border-r-0'
      )}
      data-sidebar-slot={settings ? 'settings' : 'sessions'}
    >
      <div
        className={cn(
          'flex h-full w-[464px] transition-transform duration-200 ease-out motion-reduce:transition-none',
          settings && '-translate-x-[232px]'
        )}
      >
        <div className="h-full w-[232px] shrink-0" inert={settings} data-sessions-sidebar>
          <Sidebar />
        </div>
        <div className="h-full w-[232px] shrink-0" inert={!settings} data-settings-sidebar>
          <SettingsMenu />
        </div>
      </div>
    </div>
  )
}
