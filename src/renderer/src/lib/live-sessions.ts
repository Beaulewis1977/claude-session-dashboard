// Running now in the renderer: keeps the live list in the store, and the
// actions its rows offer (desktop and phone).

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { now } from '@shared/clock'
import { baseName, formatDuration, formatTime } from '@shared/format'
import { isRunning, stateLine, type LiveSession } from '@shared/live'
import type { SessionSummary } from '@shared/types'
import { api } from './api'
import { copyResumeCommand, updateMeta } from './actions'
import { useApp } from './store'

/** Loads Running now once `enabled`, and again on every change the PC reports. */
export function useLiveSessions(enabled = true): void {
  const set = useApp((s) => s.set)
  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    let alive = true
    const load = (): void => {
      void api
        .getLive()
        .then((live) => alive && set({ live }))
        .catch(() => undefined)
    }
    const soon = (): void => {
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        load()
      }, 250)
    }
    load()
    const off = api.onLiveChanged(soon)
    return () => {
      alive = false
      off()
      window.clearTimeout(timer)
    }
  }, [set, enabled])
}

/** The app clock, ticking (for elapsed times and "since …"). */
export function useNow(everyMs = 15_000): number {
  // Read on every render, not kept: the app clock can be set after mounting
  // (fixtures mode), and new data re-renders anyway. The timer only ticks.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), everyMs)
    return () => window.clearInterval(id)
  }, [everyMs])
  return now()
}

/** Running now with the session list's summary of each (if it knows it yet). */
export function useLiveList(): { live: LiveSession; summary?: SessionSummary }[] {
  const live = useApp((s) => s.live)
  const sessions = useApp((s) => s.sessions)
  if (!live) return []
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  return live.sessions.map((l) => ({ live: l, summary: byKey.get(l.key) }))
}

/** How many are running, and how many wait for me (approval or my next message). */
export function useLiveCounts(): { running: number; needsMe: number; approval: number } {
  const live = useApp((s) => s.live)
  const list = live?.sessions ?? []
  return {
    running: list.filter(isRunning).length,
    needsMe: list.filter((s) => s.state === 'approval' || s.state === 'idle').length,
    approval: list.filter((s) => s.state === 'approval').length
  }
}

export function liveTitle(l: LiveSession, s?: SessionSummary): string {
  return s?.title || l.name || baseName(l.cwd) || 'New session'
}

export function liveMuted(_l: LiveSession, s?: SessionSummary): boolean {
  return s?.meta.muteAlerts === true
}

/** Bring its terminal forward (desktop). */
export async function focusLive(key: string): Promise<void> {
  try {
    const r = await api.focusTerminal(key)
    if (r.ok) {
      if (r.how === 'window')
        toast('Terminal window in front', {
          description: "Its tab couldn't be picked automatically: look for the session's name."
        })
      return
    }
    toast(r.simulated ? 'Fixtures mode' : "Couldn't bring the terminal forward", {
      description: r.error
    })
  } catch (err) {
    toast.error("Couldn't bring the terminal forward", { description: (err as Error).message })
  }
}

/** `claude --resume <id>`: what a phone (or a session the list doesn't know yet) can copy. */
export function plainResume(l: LiveSession): string {
  return `claude --resume ${l.sessionId}`
}

export async function copyLiveResume(l: LiveSession, s?: SessionSummary): Promise<void> {
  if (s && !api.remote) {
    await copyResumeCommand(l.key)
    return
  }
  try {
    await api.copyText(plainResume(l))
    toast.success('Resume command copied', {
      description: l.cwd ? `Run it from ${l.cwd}` : undefined
    })
  } catch (err) {
    toast.error("Couldn't copy", { description: (err as Error).message })
  }
}

export async function toggleMute(l: LiveSession, s?: SessionSummary): Promise<void> {
  if (!s) {
    toast("This session isn't in the list yet", {
      description: 'Try again in a moment, once its transcript has been read.'
    })
    return
  }
  const muted = !liveMuted(l, s)
  try {
    await updateMeta(l.key, { muteAlerts: muted })
    toast(muted ? 'Alerts muted for this session' : 'Alerts on for this session')
  } catch (err) {
    toast.error("Couldn't change it", { description: (err as Error).message })
  }
}

/** "Working for 3m", "Waiting for you since 2:47 PM", with the run time. */
export function timeLine(l: LiveSession, t: number): { state: string; run?: string } {
  const at = (ms: number): string => formatTime(new Date(ms).toISOString())
  return {
    state: stateLine(l, t, at),
    run:
      l.startedAt && l.state !== 'exited' ? `running ${formatDuration(t - l.startedAt)}` : undefined
  }
}
