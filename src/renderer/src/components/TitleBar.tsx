import { ArrowLeft, ArrowRight, Loader2, PanelLeft, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { navigate, useNavTargets } from '@/lib/navigation'
import { useApp } from '@/lib/store'
import { cn, MOD } from '@/lib/utils'
import { ClaudeMark } from './brand'
import { Kbd } from './ui/kbd'
import { Tooltip } from './ui/tooltip'
import { MiniGauges } from './usage/MiniGauges'

/** Back or Forward: disabled when there's nowhere to go; the tooltip says where it leads. */
function NavButton({ dir, target, icon }: { dir: -1 | 1; target: string | null; icon: ReactNode }) {
  const name = dir === -1 ? 'Back' : 'Forward'
  return (
    <Tooltip
      content={target ? `${name} to ${target}` : `${name} (nowhere to go)`}
      shortcut={dir === -1 ? 'Alt+←' : 'Alt+→'}
    >
      {/* A wrapper so the tooltip still shows while the button is disabled. */}
      <span className="no-drag inline-flex">
        <button
          type="button"
          onClick={() => navigate(dir)}
          disabled={!target}
          aria-label={name}
          data-nav-target={target ?? undefined}
          className={cn(
            'rounded-md p-1.5 text-muted-foreground transition-colors',
            target ? 'hover:bg-hover hover:text-foreground' : 'pointer-events-none opacity-40'
          )}
        >
          {icon}
        </button>
      </span>
    </Tooltip>
  )
}

export function TitleBar() {
  const nav = useNavTargets()
  const set = useApp((s) => s.set)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const scan = useApp((s) => s.scan)
  const info = useApp((s) => s.info)
  const scanning = scan.phase === 'scanning'
  return (
    <header className="titlebar drag relative flex h-11 shrink-0 items-center gap-2 border-b border-border bg-chrome pl-3">
      <div className="flex items-center gap-2">
        <ClaudeMark className="size-5" />
        <span className="text-[13px] font-semibold tracking-[-0.01em]">Claude Sessions</span>
        {info?.fixtures && (
          <span className="rounded bg-accent-soft px-1.5 py-px text-[10px] font-medium text-primary">
            fixtures
          </span>
        )}
      </div>
      <Tooltip content={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} shortcut={`${MOD}+B`}>
        <button
          type="button"
          onClick={() => set({ sidebarOpen: !sidebarOpen })}
          aria-label="Toggle sidebar"
          className="no-drag ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </button>
      </Tooltip>
      <div className="-ml-1 flex items-center">
        <NavButton dir={-1} target={nav.back} icon={<ArrowLeft className="size-4" />} />
        <NavButton dir={1} target={nav.forward} icon={<ArrowRight className="size-4" />} />
      </div>

      {/* Centred on its own: a full-width wrapper would inherit the header's drag
          region and cover the buttons to its left, so they'd get no clicks. */}
      <button
        type="button"
        onClick={() => set({ paletteOpen: true })}
        className="no-drag absolute inset-x-0 mx-auto flex h-7 w-[min(420px,40vw)] items-center gap-2 rounded-md border border-border bg-background/70 px-2.5 text-[12.5px] text-subtle-foreground shadow-xs transition-colors hover:border-border-strong hover:text-muted-foreground"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Jump to a session or run a command…</span>
        <Kbd>{MOD}</Kbd>
        <Kbd className="-ml-1">K</Kbd>
      </button>

      <div className="ml-auto flex items-center gap-2 pr-2">
        {scanning && (
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {scan.total ? `Scanning ${scan.done}/${scan.total}` : 'Scanning…'}
          </div>
        )}
        <MiniGauges />
      </div>
    </header>
  )
}
