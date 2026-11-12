// The Settings page's building blocks: sections (sticky header, fold,
// "N changed", Reset section…), sub-headings, and SettingItem, which wraps one
// setting from the registry (shared/settings-registry.ts): it hides when a
// search doesn't match, shows "Changed" with a reset (and Undo), and lights up
// when a link points at it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { toast } from 'sonner'
import {
  Archive,
  Bell,
  ChartColumnBig,
  ChevronDown,
  FolderTree,
  GitBranch,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Wallet,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import {
  canReset,
  isChanged,
  matchSetting,
  sectionDef,
  settingDef,
  subsectionTitle,
  type SectionId,
  type SettingDef
} from '@shared/settings-registry'
import { useApp } from '@/lib/store'
import {
  openSettingsTarget,
  resetAppSettings,
  SECTION_HEADER_PX,
  SUB_HEADER_PX
} from '@/lib/settings-actions'
import { cn } from '@/lib/utils'
import { changedIn, settingsUi, useMatchCounts, useSettingsUi } from '@/lib/settings-ui'
import { Button } from '../ui/button'
import { Tooltip } from '../ui/tooltip'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '../ui/dialog'

const SECTION_ICONS: Record<string, LucideIcon> = {
  sliders: SlidersHorizontal,
  folders: FolderTree,
  play: Play,
  chart: ChartColumnBig,
  bell: Bell,
  sparkles: Sparkles,
  git: GitBranch,
  phone: Smartphone,
  wallet: Wallet,
  archive: Archive,
  wrench: Wrench
}

export function SectionIcon({ id, className }: { id: SectionId; className?: string }) {
  const Icon = SECTION_ICONS[sectionDef(id)?.icon ?? ''] ?? SlidersHorizontal
  return <Icon className={className} aria-hidden />
}

function undoToast(title: string, undo: () => Promise<void>): void {
  toast.success(title, {
    action: {
      label: 'Undo',
      onClick: () =>
        void undo().then(
          () => toast('Put back'),
          (e: Error) => toast.error('Couldn’t undo', { description: e.message })
        )
    }
  })
}

// ─── One setting ─────────────────────────────────────────────────────────

interface ItemContext {
  def: SettingDef
  changed: boolean
  resettable: boolean
  onReset: () => void
  /** The first Row in the item shows the marker next to its label. */
  claim: (token: string) => boolean
  release: (token: string) => void
}

const ItemCtx = createContext<ItemContext | null>(null)

/** "Changed" and the reset button (next to the label, or in the gutter). */
function ChangedMarker({ ctx, gutter }: { ctx: ItemContext; gutter?: boolean }) {
  if (!ctx.changed) return null
  const reset = ctx.resettable ? (
    <Tooltip content="Reset to default" side="top">
      <button
        type="button"
        onClick={ctx.onReset}
        aria-label={`Reset “${ctx.def.label}” to default`}
        data-reset-setting={ctx.def.id}
        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none [&_svg]:size-3"
      >
        <RotateCcw />
      </button>
    </Tooltip>
  ) : null
  if (gutter)
    return (
      <span className="absolute top-0 -left-8 flex items-center">
        <span className="sr-only">Changed from default</span>
        {reset}
      </span>
    )
  return (
    <span className="inline-flex items-center gap-0.5 font-normal">
      <Tooltip
        content={
          ctx.resettable
            ? 'Changed from its default'
            : `Changed from its default. No reset here: ${ctx.def.never?.toLowerCase() ?? 'it has its own controls'}.`
        }
        side="top"
      >
        <span
          className="rounded bg-accent-soft px-1 py-px text-2xs leading-none font-medium text-primary"
          data-changed-marker
        >
          Changed
        </span>
      </Tooltip>
      {reset}
    </span>
  )
}

export function SettingItem({
  id,
  children,
  changed: changedProp,
  onReset,
  className
}: {
  id: string
  children: ReactNode
  /** For settings kept outside AppSettings (phone, backup): whether it differs from its default. */
  changed?: boolean
  /** For settings kept outside AppSettings: reset it, resolving to its Undo. */
  onReset?: () => Promise<() => Promise<void>>
  className?: string
}) {
  const def = settingDef(id)
  if (!def) throw new Error(`Unknown setting: ${id}`)
  const query = useSettingsUi((s) => s.query)
  const match = useMemo(() => matchSetting(def, query), [def, query])
  const appChanged = useApp((s) => (def.store ?? 'app') === 'app' && isChanged(def, s.settings))
  const changed = changedProp ?? appChanged
  const resettable = canReset(def) && ((def.store ?? 'app') === 'app' || !!onReset)

  const latestReset = useRef(onReset)
  useEffect(() => {
    latestReset.current = onReset
  })
  const reset = useCallback(
    (): Promise<() => Promise<void>> =>
      (def.store ?? 'app') === 'app'
        ? resetAppSettings([def])
        : (latestReset.current?.() ?? Promise.resolve(async () => undefined)),
    [def]
  )

  useLayoutEffect(() => {
    settingsUi.mount(id, { changed, reset: resettable ? reset : undefined })
  }, [id, changed, resettable, reset])
  useEffect(() => () => settingsUi.unmount(id), [id])

  const onResetClick = useCallback(() => {
    void reset().then(
      (undo) => undoToast(`“${def.label}” is back to its default`, undo),
      (e: Error) => toast.error('Couldn’t reset it', { description: e.message })
    )
  }, [reset, def.label])

  const owner = useRef<string | null>(null)
  const [claimed, setClaimed] = useState(true)
  const ctx = useMemo<ItemContext>(
    () => ({
      def,
      changed,
      resettable,
      onReset: onResetClick,
      claim: (t) => {
        if (owner.current === null) owner.current = t
        return owner.current === t
      },
      release: (t) => {
        if (owner.current === t) owner.current = null
      }
    }),
    [def, changed, resettable, onResetClick]
  )
  // After each render of the item's content: did a Row take the marker?
  useLayoutEffect(() => {
    setClaimed(owner.current !== null)
  }, [children, changed])

  const highlight = useSettingsUi((s) => (s.highlight?.id === id ? s.highlight.token : null))
  useEffect(() => {
    if (highlight === null) return
    const t = window.setTimeout(() => settingsUi.clearHighlight(highlight), 2200)
    return () => window.clearTimeout(t)
  }, [highlight])

  return (
    <ItemCtx.Provider value={ctx}>
      <div
        data-setting-id={id}
        data-changed={changed || undefined}
        data-highlighted={highlight !== null || undefined}
        hidden={!match.match}
        className={cn(
          'relative rounded-md transition-[background-color,box-shadow] duration-500 motion-reduce:transition-none',
          'data-[highlighted]:bg-accent-soft data-[highlighted]:shadow-[0_0_0_6px_var(--accent-soft)]',
          className
        )}
      >
        {changed && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0.5 bottom-0.5 -left-3 w-[2px] rounded-full bg-primary/55"
          />
        )}
        {!claimed && <ChangedMarker ctx={ctx} gutter />}
        {children}
        {match.match && match.viaKeyword.length > 0 && (
          <div className="mt-1 text-2xs text-subtle-foreground">
            Matches “{match.viaKeyword.join('”, “')}”
          </div>
        )}
      </div>
    </ItemCtx.Provider>
  )
}

/** A setting's line: label and hint on the left, its control on the right. */
export function Row({
  label,
  hint,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  const ctx = useContext(ItemCtx)
  const token = useId()
  const mine = ctx ? ctx.claim(token) : false
  useEffect(() => () => ctx?.release(token), [ctx, token])
  return (
    <div className="flex items-start justify-between gap-6" data-settings-row>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] font-medium">
          {label}
          {mine && ctx && <ChangedMarker ctx={ctx} />}
        </div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** "See also: Phone & remote ›": a link to a related setting in another section. */
export function SeeAlso({ to, children }: { to: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => openSettingsTarget(to)}
      className="mt-1 inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      data-see-also={to}
    >
      See also: <span className="font-medium">{children}</span> ›
    </button>
  )
}

// ─── Sections and sub-headings ───────────────────────────────────────────

function ResetSectionDialog({
  section,
  open,
  onOpenChange
}: {
  section: SectionId
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const mounted = useSettingsUi((s) => s.mounted)
  const ids = changedIn(mounted, section)
  const resettable = ids.filter((id) => mounted[id]?.reset)
  const kept = ids.filter((id) => !mounted[id]?.reset)
  const title = sectionDef(section)?.title ?? section
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    const undos: (() => Promise<void>)[] = []
    try {
      for (const id of resettable) {
        const r = useSettingsUi.getState().mounted[id]?.reset
        if (r) undos.push(await r())
      }
      onOpenChange(false)
      undoToast(
        `Reset ${undos.length} setting${undos.length === 1 ? '' : 's'} in ${title}`,
        async () => {
          for (const u of undos.reverse()) await u()
        }
      )
    } catch (e) {
      toast.error('Couldn’t reset everything', { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader
          icon={<RotateCcw className="size-4 text-muted-foreground" />}
          title={`Reset ${title} to defaults?`}
          description="These settings go back to their defaults. You can undo it right after."
        />
        <div className="max-h-[50vh] space-y-3 overflow-y-auto px-5 py-3 text-[13px]">
          {resettable.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5" aria-label="Settings to reset">
              {resettable.map((id) => (
                <li key={id}>{settingDef(id)?.label}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Nothing here can be reset.</p>
          )}
          {kept.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <div className="font-medium text-foreground/80">Not reset</div>
              <ul className="mt-0.5 space-y-0.5">
                {kept.map((id) => (
                  <li key={id}>
                    {settingDef(id)?.label}: {settingDef(id)?.never ?? 'it has its own controls'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || resettable.length === 0}
            onClick={() => void run()}
          >
            Reset {resettable.length} setting{resettable.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SettingsSection({ id, children }: { id: SectionId; children: ReactNode }) {
  const def = sectionDef(id)!
  const query = useSettingsUi((s) => s.query)
  const folded = useSettingsUi((s) => s.collapsed[id] === true)
  const { bySection } = useMatchCounts()
  const changedCount = useSettingsUi((s) => changedIn(s.mounted, id).length)
  const [confirm, setConfirm] = useState(false)
  const searching = query.trim() !== ''
  const matches = bySection[id] ?? 0
  // A search opens folded sections that have matches (only while it's on).
  const collapsed = folded && !searching
  const titleId = `settings-${id}-title`
  const bodyId = `settings-${id}-body`

  return (
    <section
      id={`settings-${id}`}
      data-settings-section={id}
      aria-labelledby={titleId}
      hidden={searching && matches === 0}
      className="pt-6"
    >
      <header
        className="sticky top-0 z-20 -mx-3 flex items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85"
        style={{ height: SECTION_HEADER_PX }}
      >
        <button
          type="button"
          onClick={() => settingsUi.toggleCollapsed(id)}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${def.title}`}
          className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          data-collapse={id}
        >
          <ChevronDown
            className={cn(
              'size-4 transition-transform duration-150 motion-reduce:transition-none',
              collapsed && '-rotate-90'
            )}
          />
        </button>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
          <SectionIcon id={id} className="size-3.5" />
        </span>
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em]"
        >
          {def.title}
          {searching && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {matches} match{matches === 1 ? '' : 'es'}
            </span>
          )}
        </h2>
        {changedCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <span data-changed-count={id}>{changedCount} changed</span>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={() => setConfirm(true)}
              className="rounded px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              data-reset-section={id}
            >
              Reset section…
            </button>
          </span>
        )}
      </header>
      <div id={bodyId} hidden={collapsed} className="pt-2 pb-4">
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{def.description}</p>
        <div className="space-y-5">{children}</div>
      </div>
      {confirm && <ResetSectionDialog section={id} open={confirm} onOpenChange={setConfirm} />}
    </section>
  )
}

/** A sub-heading and its settings (sticks under the section header while they're in view). */
export function SettingsSub({ id, children }: { id: string; children: ReactNode }) {
  const query = useSettingsUi((s) => s.query)
  const { bySub } = useMatchCounts()
  const searching = query.trim() !== ''
  const title = subsectionTitle(id) ?? id
  return (
    <div data-settings-sub-group={id} hidden={searching && !bySub[id]}>
      <h3
        id={`settings-${id}`}
        data-settings-sub={id}
        className="sticky z-10 -mx-3 mb-3 flex items-center bg-background/95 px-3 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase backdrop-blur supports-[backdrop-filter]:bg-background/85"
        style={{ top: SECTION_HEADER_PX, height: SUB_HEADER_PX }}
      >
        {title}
      </h3>
      <div className="space-y-5">{children}</div>
    </div>
  )
}

/** A heading inside a setting group that isn't a menu item (e.g. "Claude Code" above a list). */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="text-[13px] font-medium">{children}</div>
}
