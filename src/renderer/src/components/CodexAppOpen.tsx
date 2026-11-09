// "Open in: Terminal / Codex app" for Codex sessions in the launch dialog:
// the choice (saved for the session right away, like the model picker; a menu
// makes it the project's or every Codex session's default) and what opening in
// the app will do.

import { toast } from 'sonner'
import { AppWindow, ChevronDown, Info, SquareTerminal, TriangleAlert } from 'lucide-react'
import type { AcceptedProject, CodexAppKind, CodexAppPreview, OpenIn } from '@shared/codex-app'
import { projectDefaultKey } from '@shared/project-key'
import type { SessionMeta, SessionSummary } from '@shared/types'
import { api } from '@/lib/api'
import { updateMeta } from '@/lib/actions'
import { useApp } from '@/lib/store'
import { useOpenIn } from '@/lib/open-in'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import { Segmented } from './ui/segmented'

/** A cleared meta field (the main process drops '' and removes the key). */
const CLEAR = '' as unknown as SessionMeta['openIn']

const FROM_LABEL = {
  session: 'Saved for this session',
  project: "This project's default",
  global: 'Default from Settings',
  default: 'Default'
} as const

export function OpenInChoice({
  session,
  value,
  onChange
}: {
  session: SessionSummary
  value: OpenIn
  onChange: (v: OpenIn) => void
}) {
  const settings = useApp((s) => s.settings)
  const set = useApp((s) => s.set)
  const resolved = useOpenIn(session)
  const key = projectDefaultKey(session)
  const projectChoice = key ? settings.codexProjectOpenIn?.[key] : undefined
  const save = async (patch: Parameters<typeof api.updateSettings>[0]): Promise<void> => {
    try {
      set({ settings: await api.updateSettings(patch) })
    } catch (err) {
      toast.error('Could not save the default', { description: (err as Error).message })
    }
  }
  const pick = (v: OpenIn): void => {
    onChange(v)
    void updateMeta(session.key, { openIn: v })
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented<OpenIn>
        ariaLabel="Open in"
        value={value}
        onChange={pick}
        options={[
          { value: 'terminal', label: 'Terminal', icon: <SquareTerminal /> },
          { value: 'codex-app', label: 'Codex app', icon: <AppWindow /> }
        ]}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            {FROM_LABEL[resolved.from]} <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>
            Remember “{value === 'codex-app' ? 'Codex app' : 'Terminal'}”
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => pick(value)}>For this session</DropdownMenuItem>
          {key && (
            <DropdownMenuItem
              onSelect={() =>
                void save({
                  codexProjectOpenIn: { ...(settings.codexProjectOpenIn ?? {}), [key]: value }
                })
              }
            >
              For every session in {session.projectName}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void save({ codexOpenInDefault: value })}>
            For all Codex sessions
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!session.meta.openIn}
            onSelect={() => {
              // The dialog follows what the session now inherits.
              onChange(projectChoice ?? settings.codexOpenInDefault ?? 'terminal')
              void updateMeta(session.key, { openIn: CLEAR })
            }}
          >
            Clear this session&apos;s choice
          </DropdownMenuItem>
          {key && (
            <DropdownMenuItem
              disabled={!projectChoice}
              onSelect={() => {
                const next = { ...(settings.codexProjectOpenIn ?? {}) }
                delete next[key]
                if (!session.meta.openIn) onChange(settings.codexOpenInDefault ?? 'terminal')
                void save({ codexProjectOpenIn: next })
              }}
            >
              Clear the project&apos;s choice
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** What opening in the Codex app does, the subfolder opt-in, or why it can't. */
export function CodexAppPanel({
  kind,
  app,
  accepted,
  onAccept
}: {
  kind: CodexAppKind
  app: CodexAppPreview | undefined
  /** The project the user agreed to use ("Use that project anyway?"). */
  accepted: AcceptedProject | undefined
  onAccept: (p: AcceptedProject | undefined) => void
}) {
  if (!app) return <div className="text-xs text-muted-foreground">Checking the Codex app…</div>
  // The consent counts only for the project it was given for (same id and root).
  const insideOk =
    !!app.inside && accepted?.id === app.inside.id && accepted.root === app.inside.root
  if (app.inside && !insideOk)
    return (
      <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-xs">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            This folder is inside the Codex project <b>{app.inside.name}</b>. Use that project
            anyway? The new thread works in{' '}
            <span className="font-mono break-all">{app.inside.root}</span>, not in this
            session&apos;s folder.
          </span>
        </div>
        <div className="pl-[22px]">
          <Button
            variant="outline"
            size="xs"
            onClick={() => app.inside && onAccept({ id: app.inside.id, root: app.inside.root })}
          >
            Use {app.inside.name}
          </Button>
        </div>
      </div>
    )
  if (!app.available)
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
        {app.reason ?? "This session can't be opened in the Codex app."}
      </div>
    )
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs leading-relaxed">
      <Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
      <span>
        {kind === 'resume' && 'Opens this thread in the Codex app, in its project.'}
        {kind === 'fork' && (
          <>
            Opens this thread in the Codex app. The app has no link that forks a thread:{' '}
            <b>{app.note ?? "Use Fork in the Codex app's menu."}</b>
          </>
        )}
        {kind === 'continue' && app.project && (
          <>
            Opens a new thread in the Codex project <b>{app.project.name}</b> (
            <span className="font-mono break-all">{app.project.root}</span>) with a line asking
            Codex to read the handoff typed in. It isn&apos;t sent: press Enter in the Codex app to
            send it.
            {insideOk && (
              <>
                {' '}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => onAccept(undefined)}
                >
                  Don&apos;t use this project
                </button>
              </>
            )}
          </>
        )}
      </span>
    </div>
  )
}
