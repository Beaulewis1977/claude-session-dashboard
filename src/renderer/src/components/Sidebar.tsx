import { useState, type ReactNode } from 'react'
import {
  Archive,
  ChartColumnBig,
  ChevronRight,
  CircleHelp,
  EyeOff,
  Folder,
  Inbox,
  MessagesSquare,
  Monitor,
  Settings,
  SquareTerminal,
  TriangleAlert,
  Zap
} from 'lucide-react'
import { useLiveCounts } from '@/lib/live-sessions'
import { facets, tagColor, type Facet, type Filters, type Visibility } from '@/lib/filters'
import { useApp } from '@/lib/store'
import { openTerminalHere, projectSessionKey } from '@/lib/actions'
import { cn, MOD } from '@/lib/utils'
import { Tooltip } from './ui/tooltip'
import { SOURCE_ICON } from '@/lib/source-icons'
import type { SourceLabel } from '@shared/source-label'

function Item({
  active,
  icon,
  label,
  count,
  badge,
  onClick,
  title
}: {
  active?: boolean
  icon: ReactNode
  label: ReactNode
  count?: number
  /** Shown instead of the count (e.g. Running now). */
  badge?: ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'group flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors',
        active
          ? 'bg-selected font-medium text-foreground'
          : 'text-foreground/75 hover:bg-hover hover:text-foreground'
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-[15px]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
      {count !== undefined && (
        <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums">{count}</span>
      )}
    </button>
  )
}

function Section({
  title,
  children,
  collapsible = true
}: {
  title: string
  children: ReactNode
  collapsible?: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => collapsible && setOpen((v) => !v)}
        className="group mb-0.5 flex h-6 w-full items-center gap-1 px-2 text-2xs font-medium tracking-wide text-subtle-foreground uppercase hover:text-muted-foreground"
      >
        {title}
        {collapsible && (
          <ChevronRight
            className={cn(
              'size-3 opacity-0 transition-[transform,opacity] group-hover:opacity-100',
              open && 'rotate-90'
            )}
          />
        )}
      </button>
      {open && <div className="space-y-px">{children}</div>}
    </div>
  )
}

const PROJECT_LIMIT = 8

export function Sidebar() {
  const sessions = useApp((s) => s.sessions)
  const filters = useApp((s) => s.filters)
  const sources = useApp((s) => s.sources)
  const view = useApp((s) => s.view)
  const set = useApp((s) => s.set)
  const setFilters = useApp((s) => s.setFilters)
  const [allProjects, setAllProjects] = useState(false)
  const f = facets(sessions, filters)
  const notices = sources.filter((s) => s.status !== 'ok' && s.status !== 'missing').length
  const live = useLiveCounts()

  const showSessions = (patch: Partial<Filters>): void => {
    set({ view: 'sessions' })
    setFilters(patch)
  }
  const toggle = (key: keyof Filters, value: string) =>
    showSessions({ [key]: filters[key] === value ? null : value } as Partial<Filters>)
  const visibility = (v: Visibility): void => showSessions({ visibility: v })

  const projects = allProjects ? f.project : f.project.slice(0, PROJECT_LIMIT)

  return (
    <nav aria-label="Filters" className="flex h-full w-full flex-col bg-chrome">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
        <div className="space-y-px">
          <Tooltip content="Usage & limits" shortcut={`${MOD}+U`} side="right">
            <div>
              <Item
                active={view === 'usage'}
                icon={<ChartColumnBig />}
                label="Usage & limits"
                onClick={() => set({ view: view === 'usage' ? 'sessions' : 'usage' })}
              />
            </div>
          </Tooltip>
          <Item
            active={view === 'running'}
            icon={<Zap />}
            label="Running now"
            onClick={() => set({ view: view === 'running' ? 'sessions' : 'running' })}
            title={
              live.running
                ? `${live.running} running${live.approval ? `, ${live.approval} need approval` : ''}`
                : 'No Claude Code session is running'
            }
            badge={
              live.running > 0 ? (
                <span
                  className={cn(
                    'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
                    live.approval ? 'bg-warning text-white' : 'bg-accent-soft text-primary'
                  )}
                >
                  {live.running}
                </span>
              ) : undefined
            }
          />
        </div>
        <div className="mt-3 space-y-px">
          <Item
            active={view === 'sessions' && filters.visibility === 'visible'}
            icon={<Inbox />}
            label="All sessions"
            count={f.views.visible}
            onClick={() => visibility('visible')}
          />
          <Item
            active={view === 'sessions' && filters.visibility === 'archived'}
            icon={<Archive />}
            label="Archived only"
            count={f.views.archived}
            onClick={() => visibility('archived')}
            title="Sessions whose original file was removed from .claude"
          />
          <Item
            active={view === 'sessions' && filters.visibility === 'hidden'}
            icon={<EyeOff />}
            label="Hidden"
            count={f.views.hidden}
            onClick={() => visibility('hidden')}
          />
        </div>

        {f.env.length > 0 && (
          <Section title="Environments">
            {f.env.map((e) => (
              <Item
                key={e.key}
                active={filters.env === e.key}
                icon={
                  e.key === 'windows' ? (
                    <Monitor className="text-env-windows" />
                  ) : e.key === 'claude-ai' ? (
                    <MessagesSquare />
                  ) : (
                    <SquareTerminal className="text-env-wsl" />
                  )
                }
                label={e.label}
                count={e.count}
                onClick={() => toggle('env', e.key)}
              />
            ))}
          </Section>
        )}

        {f.source.length > 0 && (
          <Section title="Source">
            {f.source.map((src) => {
              const Icon = SOURCE_ICON[src.key as SourceLabel] ?? CircleHelp
              return (
                <Item
                  key={src.key}
                  active={filters.source === src.key}
                  icon={<Icon />}
                  label={src.label}
                  count={src.count}
                  title={
                    src.key === 'ask-claude'
                      ? "Runs started by the dashboard's Ask Claude. Hidden from the list unless picked here."
                      : undefined
                  }
                  onClick={() => toggle('source', src.key)}
                />
              )
            })}
          </Section>
        )}

        {f.project.length > 0 && (
          <Section title="Projects">
            {projects.map((p: Facet) => {
              const key = projectSessionKey(p.key)
              return (
                <div key={p.key} className="group/project relative">
                  <Item
                    active={filters.project === p.key}
                    icon={<Folder />}
                    label={p.label}
                    count={p.count}
                    title={p.detail}
                    onClick={() => toggle('project', p.key)}
                  />
                  {key && (
                    <Tooltip content="Open terminal here" side="right">
                      <button
                        type="button"
                        aria-label={`Open terminal in ${p.label}`}
                        onClick={() => void openTerminalHere(key)}
                        className="absolute top-0.5 right-1 hidden size-6 items-center justify-center rounded bg-chrome text-muted-foreground group-hover/project:flex hover:bg-hover hover:text-foreground focus-visible:flex [&_svg]:size-3.5"
                      >
                        <SquareTerminal />
                      </button>
                    </Tooltip>
                  )}
                </div>
              )
            })}
            {f.project.length > PROJECT_LIMIT && (
              <button
                type="button"
                onClick={() => setAllProjects((v) => !v)}
                className="flex h-7 w-full items-center px-2 pl-8 text-xs text-muted-foreground hover:text-foreground"
              >
                {allProjects ? 'Show fewer' : `Show ${f.project.length - PROJECT_LIMIT} more`}
              </button>
            )}
          </Section>
        )}

        {f.tag.length > 0 && (
          <Section title="Tags">
            {f.tag.map((t) => (
              <Item
                key={t.key}
                active={filters.tag === t.key}
                icon={
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: tagColor(t.key) }}
                  />
                }
                label={t.label}
                count={t.count}
                onClick={() => toggle('tag', t.key)}
              />
            ))}
          </Section>
        )}
      </div>

      <div className="shrink-0 space-y-px border-t border-border px-2 py-2">
        {notices > 0 && (
          <Item
            icon={<TriangleAlert className="text-warning" />}
            label={`${notices} source notice${notices === 1 ? '' : 's'}`}
            onClick={() => set({ view: 'settings' })}
            title={sources
              .filter((s) => s.status !== 'ok' && s.status !== 'missing')
              .map((s) => `${s.label}: ${s.statusMessage ?? s.status}`)
              .join('\n')}
          />
        )}
        <Tooltip content="Settings" shortcut={`${MOD}+,`} side="right">
          <div>
            <Item
              active={view === 'settings'}
              icon={<Settings />}
              label="Settings"
              onClick={() => set({ view: view === 'settings' ? 'sessions' : 'settings' })}
            />
          </div>
        </Tooltip>
      </div>
    </nav>
  )
}
