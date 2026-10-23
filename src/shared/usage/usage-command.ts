// Backfill: /usage output that Claude Code recorded in old transcripts gives
// extra limit readings from before the status line bridge was enabled (the
// idea comes from claude-nerf-watcher's backfill, MIT; the parsing is our own,
// for Claude Code's /usage panel text). Example of what gets recorded:
//
//   Current session
//   ███████▌                    15% used
//   Resets 7pm (America/Los_Angeles)
//
//   Current week (all models)
//   ██                          4% used
//   Resets Oct 28, 7pm (America/Los_Angeles)

import type { WindowKind } from './limits'
import { localParts } from './time'

export interface UsageCommandReading {
  /** Stable id: `${eventId}:${kind}`. */
  id: string
  ts: number
  key: string
  kind: WindowKind
  pct: number
  resetsAt?: number
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g

const TITLE_RE =
  /^\s*(Current session|Current week \(all models\)|Current week \([^)]*\)|Extra usage|Current month)(?=\s|$|:)/im

/** UTC offset (ms) of a time zone at a moment. */
function zoneOffset(ts: number, zone: string): number {
  const p = localParts(ts, zone)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
  return asUtc - (ts - (ts % 1000))
}

/** Epoch ms of a wall-clock time in a zone. */
function zonedTime(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  let t = guess - zoneOffset(guess, zone)
  t = guess - zoneOffset(t, zone)
  return t
}

function validZone(z: string | undefined): string | undefined {
  if (!z) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return z
  } catch {
    return undefined
  }
}

/**
 * Parse a "Resets …" phrase relative to when it was printed. Handles
 * "7pm", "3:59pm", "15:00", "Oct 28, 7pm", "Oct 28 at 7:30 pm", "in 2h 14m",
 * with an optional "(Area/City)" time zone (else `fallbackZone`).
 */
export function parseResetPhrase(
  phrase: string,
  printedAt: number,
  fallbackZone: string
): number | undefined {
  const s = phrase.trim()
  const rel =
    /^in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:r|rs|ours?)?\s*)?(?:(\d+)\s*m(?:in|ins|inutes?)?)?/i.exec(
      s
    )
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms =
      (Number(rel[1] ?? 0) * 24 * 60 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * 60_000
    return printedAt + ms
  }
  const zone = validZone(/\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC)\)/.exec(s)?.[1]) ?? fallbackZone
  const date = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(s)
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?!\s*,?\s*\d{4})/i.exec(
    date ? s.slice(date.index + date[0].length) : s
  )
  if (!time) return undefined
  let hour = Number(time[1])
  const minute = Number(time[2] ?? 0)
  const ampm = time[3]?.toLowerCase()
  if (!ampm && !time[2]) return undefined // a bare number isn't a time
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined
    hour = (hour % 12) + (ampm === 'pm' ? 12 : 0)
  } else if (hour > 23) return undefined
  if (minute > 59) return undefined
  const here = localParts(printedAt, zone)
  if (date) {
    const mo = MONTHS.indexOf(date[1].toLowerCase().slice(0, 3)) + 1
    const day = Number(date[2])
    let t = zonedTime(here.y, mo, day, hour, minute, zone)
    if (t < printedAt - 86_400_000) t = zonedTime(here.y + 1, mo, day, hour, minute, zone)
    return t
  }
  let t = zonedTime(here.y, here.m, here.d, hour, minute, zone)
  if (t <= printedAt) t += 86_400_000
  return t
}

/** Read the windows out of /usage text. */
export function parseUsageCommandOutput(
  text: string,
  printedAt: number,
  fallbackZone: string
): { kind: WindowKind; pct: number; resetsAt?: number }[] {
  const clean = text.replace(ANSI_RE, '').replace(/\r/g, '')
  if (!/%\s*used/i.test(clean) || !TITLE_RE.test(clean)) return []
  const lines = clean.split('\n')
  const out: { kind: WindowKind; pct: number; resetsAt?: number }[] = []
  let cur: { kind?: WindowKind; pct?: number; resetsAt?: number } | undefined
  const flush = (): void => {
    if (cur?.kind && cur.pct !== undefined && !out.some((o) => o.kind === cur!.kind)) {
      const len = cur.kind === 'five_hour' ? 5 * 3_600_000 : 7 * 86_400_000
      const r = cur.resetsAt
      out.push({
        kind: cur.kind,
        pct: cur.pct,
        // A reset further away than the window's length is a misread.
        ...(r && r > printedAt && r - printedAt <= len + 3_600_000 ? { resetsAt: r } : {})
      })
    }
  }
  for (const line of lines) {
    const title = TITLE_RE.exec(line)
    if (title) {
      flush()
      const t = title[1].toLowerCase()
      cur = {
        kind:
          t === 'current session'
            ? 'five_hour'
            : t === 'current week (all models)'
              ? 'seven_day'
              : undefined
      }
      continue
    }
    if (!cur) continue
    const pct = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i.exec(line)
    if (pct && cur.pct === undefined) cur.pct = Math.min(Number(pct[1]), 1000)
    const reset = /\bResets?\s+(.+)$/i.exec(line)
    if (reset && cur.resetsAt === undefined)
      cur.resetsAt = parseResetPhrase(reset[1], printedAt, fallbackZone)
  }
  flush()
  return out
}
