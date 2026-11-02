// Where a Claude home's "Running now" files are: Claude Code's own running
// sessions in `~/.claude/sessions/<pid>.json`, and the events the app's hook
// script saves in `~/.claude-session-dashboard/events/`.

import { dirname, join } from 'node:path'
import type { SourceInfo } from '@shared/types'
import { envPaths } from '../../services/bridge'
import type { LiveDirs } from '../types'

export function liveDirs(src: SourceInfo): LiveDirs | undefined {
  const p = envPaths(src)
  if (!p || src.status !== 'ok') return undefined
  return {
    src,
    sessionsDir: join(dirname(p.settingsPath), 'sessions'),
    eventsDir: join(p.bridgeDir, 'events'),
    home: p.home
  }
}
