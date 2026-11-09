// Settings → Git: git links on/off, the GitHub CLI for pull requests, and
// what was found (git for Windows and each WSL distro, gh).

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { formatRelative } from '@shared/format'
import { DEFAULT_GIT_SETTINGS, type GhState, type GitLinkSettings, type GitStatus } from '@shared/git/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Switch } from '../ui/checkbox'
import { Row, Section } from '../SettingsView'

const GH_TEXT: Record<GhState, string> = {
  ask: 'Not decided yet: the Changes tab asks the first time a session is in a GitHub repo.',
  on: 'On: signed in, pull requests are looked up.',
  off: 'Off: PR links come only from sessions’ own output and merge commits.',
  missing: 'On, but the GitHub CLI (gh) isn’t installed.',
  'signed-out': 'On, but gh isn’t signed in (run gh auth login).',
  'not-github': 'On.'
}

export function GitSettings() {
  const set = useApp((s) => s.set)
  const cfg = useApp((s) => s.settings.gitLinks) ?? DEFAULT_GIT_SETTINGS
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void api
        .getGitStatus()
        .then((s) => !cancelled && setStatus(s))
        .catch(() => undefined)
    }
    load()
    const off = api.onGitChanged(load)
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const update = async (patch: Partial<GitLinkSettings>): Promise<void> => {
    try {
      setStatus(await api.updateGitSettings(patch))
      set({ settings: await api.getSettings() })
    } catch (e) {
      toast.error('Couldn’t save', { description: (e as Error).message })
    }
  }

  return (
    <Section
      id="git"
      title="Git"
      description="Links each session to the commits, branches and pull requests it produced (the viewer’s Changes tab). Git is only read: the app never commits, fetches, checks out or changes a repo."
    >
      <Row
        label="Link sessions to git commits"
        hint="Reads each session’s repo in the background (git log, for the time its sessions cover). WSL repos are read with the distro’s own git, only while the distro is running."
      >
        <Switch
          checked={cfg.enabled}
          onCheckedChange={(v) => void update({ enabled: v })}
          aria-label="Link sessions to git commits"
        />
      </Row>
      <Row
        label="Look up pull requests with the GitHub CLI"
        hint={
          <>
            Runs <span className="font-mono">gh pr list</span> (read-only) for the branches of sessions in GitHub
            repos. gh talks to GitHub with your own sign-in; nothing else leaves your PC.{' '}
            {status ? GH_TEXT[status.gh] : ''}
          </>
        }
      >
        <Switch
          checked={cfg.gh === 'on'}
          disabled={!cfg.enabled}
          onCheckedChange={(v) => void update({ gh: v ? 'on' : 'off' })}
          aria-label="Look up pull requests with the GitHub CLI"
        />
      </Row>
      {status && (
        <div className="space-y-1 rounded-lg border border-border px-3 py-2.5 text-xs">
          {status.git.map((g) => (
            <div key={g.env} className="flex gap-2">
              <span className="w-28 shrink-0 text-muted-foreground">Git · {g.env}</span>
              <span className={cn('min-w-0', g.error && 'text-warning')}>
                {g.version ? `git ${g.version}` : (g.error ?? 'Not checked yet')}
              </span>
            </div>
          ))}
          <div className="flex gap-2">
            <span className="w-28 shrink-0 text-muted-foreground">Linked</span>
            <span>
              {status.linkedSessions} session{status.linkedSessions === 1 ? '' : 's'} with commits, in{' '}
              {status.repos} repo{status.repos === 1 ? '' : 's'}
              {status.checkedAt ? ` · checked ${formatRelative(status.checkedAt)}` : ''}
            </span>
          </div>
        </div>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !cfg.enabled}
          onClick={() => {
            setBusy(true)
            void api.refreshGit().finally(() => setBusy(false))
          }}
        >
          <RefreshCw className={cn(busy && 'animate-spin')} /> Check all repos again
        </Button>
      </div>
    </Section>
  )
}
