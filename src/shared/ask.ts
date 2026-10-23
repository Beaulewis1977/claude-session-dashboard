// "Ask Claude" about usage and limit trends, through the official CLI
// (`claude -p`) on the user's own subscription.
//
// Only aggregated numbers are sent: window scores, the baseline, plan
// history, token totals, model and version change dates, untracked-usage
// estimates and pace. Never session titles, project names, prompts or any
// conversation text. The prompt goes to the CLI on stdin, never as an
// argument, and the CLI runs with no tools, in safe mode with no settings
// files (so no CLAUDE.md, memory or hooks are added), with an allowlisted
// environment, and only after `claude auth status` confirms it would use the
// Claude subscription.

import { ASK_MARKER } from './source-label'
import type { HealthReport, PlanChange } from './usage/health'
import type { PaceState } from './usage/pace'
import type { LimitHit, UsageRecord } from './usage/types'
import type { Plan } from './usage/limits'
import { dayKey, monthKey } from './usage/time'
import { costParts, type ModelPrice } from './usage/pricing'

export { ASK_MARKER }

export const SUGGESTED_QUESTIONS = [
  'Have my limits dropped?',
  'Why did I hit my limit Tuesday?',
  'Compare this month to last month'
]

/**
 * Arguments for `claude`: print mode, JSON output, no tools, no MCP servers.
 * `--safe-mode` keeps CLAUDE.md files, auto memory, hooks, plugins and skills
 * out, and `--setting-sources ""` loads none of the settings files (so neither
 * their hooks nor an apiKeyHelper or provider switch in them apply). Sign-in
 * works as normal. The prompt goes on stdin.
 */
export const ASK_ISOLATION = ['--safe-mode', '--setting-sources', '']

export const ASK_ARGS = [
  '-p',
  '--output-format',
  'json',
  '--tools',
  '',
  '--strict-mcp-config',
  ...ASK_ISOLATION
]

/**
 * The CLI's environment is built from this allowlist, never from the app's own
 * environment minus a few names: what Windows, WSL and the CLI need to start,
 * networking (a proxy or a company CA routes traffic but can't change the
 * account it's billed to), and the subscription login's own settings. API keys,
 * custom headers, gateway tokens, base URLs, provider switches and anything a
 * later Claude Code version adds never reach it.
 */
export const ASK_ENV_ALLOW = [
  // Windows
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  // Linux (WSL)
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  // Both
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // The subscription login (`claude setup-token`), where it's stored, and Git Bash on Windows.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH'
]

const ALLOW = new Set(ASK_ENV_ALLOW)

/** May this variable reach the CLI? (Windows names are case-insensitive.) */
export function askEnvAllowed(name: string): boolean {
  return ALLOW.has(name.toUpperCase())
}

/**
 * WSL runs a login shell (so `claude` is on PATH), and its profile can export
 * anything. The CLI is then started with `env -i`: an empty environment plus
 * the allowed variables that are set, after the profile has loaded.
 */
export const WSL_ENV_ALLOWLIST = `a=(); for v in ${ASK_ENV_ALLOW.filter((v) => /^[A-Z_][A-Z0-9_]*$/.test(v)).join(' ')}; do [ -n "\${!v+x}" ] && a+=("$v=\${!v}"); done; exec env -i "\${a[@]}"`

export interface AskCli {
  /** "native": a claude install on this OS (Windows); "wsl": inside a WSL distro. */
  kind: 'native' | 'wsl'
  /** native: the claude executable (.exe, or the npm .cmd shim on Windows). */
  path?: string
  /** WSL: distro (undefined = the default distro). */
  distro?: string
  label: string
}

export interface AskCommand {
  command: string
  args: string[]
  /** Windows .cmd shims need a shell. */
  shell: boolean
}

function claudeCommand(cli: AskCli, claudeArgs: string[]): AskCommand {
  if (cli.kind === 'wsl') {
    const inner = [
      `${WSL_ENV_ALLOWLIST}`,
      'claude',
      ...claudeArgs.map((a) => (a === '' ? '""' : a))
    ].join(' ')
    return {
      command: 'wsl.exe',
      args: [...(cli.distro ? ['-d', cli.distro] : []), '--cd', '~', '--', 'bash', '-lic', inner],
      shell: false
    }
  }
  const path = cli.path ?? 'claude'
  const shell = /\.(cmd|bat)$/i.test(path)
  return {
    command: shell ? `"${path}"` : path,
    // With a shell, an empty argument would vanish: quote it.
    args: shell ? claudeArgs.map((a) => (a === '' ? '""' : a)) : [...claudeArgs],
    shell
  }
}

/** How to start the CLI. Fixed arguments only: the question and data never appear here. */
export function askCommand(cli: AskCli): AskCommand {
  return claudeCommand(cli, ASK_ARGS)
}

/**
 * `claude auth status`, in the same environment the question will run in and
 * with the same settings files left out (the flags go before the subcommand).
 */
export function authStatusCommand(cli: AskCli): AskCommand {
  return claudeCommand(cli, [...ASK_ISOLATION, 'auth', 'status'])
}

export type SubscriptionCheck = { ok: true; method: string } | { ok: false; reason: string }

const PROVIDER_LABEL: Record<string, string> = {
  bedrock: 'Amazon Bedrock',
  vertex: "Google Cloud's Vertex AI",
  foundry: 'Microsoft Foundry',
  anthropicAws: 'Claude Platform on AWS',
  anthropicGoogleCloud: 'Claude on Google Cloud',
  gateway: 'a cloud gateway'
}

/**
 * Would the CLI run on the Claude subscription? Reads `claude auth status`
 * (JSON). Anything else, an answer that can't be read, or a check that didn't
 * finish cleanly (exit code 0) is refused: Ask Claude never runs on
 * separately billed credits.
 */
export function subscriptionCheck(stdout: string, code: number | null = 0): SubscriptionCheck {
  const i = stdout.indexOf('{')
  const j = stdout.lastIndexOf('}')
  let o: Record<string, unknown> | undefined
  try {
    if (i >= 0 && j > i) o = JSON.parse(stdout.slice(i, j + 1)) as Record<string, unknown>
  } catch {
    o = undefined
  }
  if (!o)
    return {
      ok: false,
      reason: `Couldn't confirm that Claude Code would use your Claude subscription (\`claude auth status\` ${code === 0 ? 'gave no readable answer' : 'failed'}). Updating Claude Code (\`claude update\`) usually fixes this.`
    }
  if (o.loggedIn !== true)
    return {
      ok: false,
      reason: "Claude Code isn't signed in. Run `claude` once and sign in with your Claude account."
    }
  const provider = typeof o.apiProvider === 'string' ? o.apiProvider : 'firstParty'
  if (provider !== 'firstParty')
    return {
      ok: false,
      reason: `Claude Code is set up to use ${PROVIDER_LABEL[provider] ?? provider}, which is billed separately. Ask Claude only runs on your Claude subscription.`
    }
  if (typeof o.apiKeySource === 'string' && o.apiKeySource)
    return {
      ok: false,
      reason: `Claude Code would use an API key (from ${o.apiKeySource}), which is billed separately. Ask Claude only runs on your Claude subscription.`
    }
  const method = typeof o.authMethod === 'string' ? o.authMethod : ''
  if (method !== 'claude.ai' && method !== 'oauth_token')
    return {
      ok: false,
      reason: `Claude Code is signed in with ${method || 'an unknown method'}, not your Claude subscription. Ask Claude only runs on your subscription.`
    }
  if (code !== 0)
    return {
      ok: false,
      reason: `Couldn't confirm that Claude Code would use your Claude subscription (\`claude auth status\` failed${code === null ? '' : ` with exit code ${code}`}). Updating Claude Code (\`claude update\`) usually fixes this.`
    }
  return { ok: true, method }
}

/** The CLI refused one of the isolation flags: it's older than they are. */
export function tooOldForAsk(stderr: string): boolean {
  return /unknown option '--(safe-mode|setting-sources)'/.test(stderr)
}

// ------------------------------------------------------------------ data

const r2 = (n: number): number => Math.round(n * 100) / 100
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000

export interface AskDataInput {
  now: number
  timeZone: string
  plan: Plan
  planHistory: PlanChange[]
  health5h?: HealthReport
  health7d?: HealthReport
  pace5h?: PaceState
  pace7d?: PaceState
  records: UsageRecord[]
  limitHits: LimitHit[]
  prices: ModelPrice[]
  elsewhere: { from: number; to: number }[]
}

function localIso(ts: number, timeZone: string): string {
  const d = new Date(ts)
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d)
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? ''
  const wd = d.toLocaleDateString('en-US', { timeZone, weekday: 'short' })
  return `${g('year')}-${g('month')}-${g('day')} ${wd} ${g('hour')}:${g('minute')}`
}

function healthData(h: HealthReport | undefined, keep: number, tz: string) {
  if (!h) return undefined
  return {
    baseline: h.baseline
      ? {
          dollarsPerPctPer1x: r4(h.baseline.value),
          windows: h.baseline.n,
          dates: `${h.baseline.from} to ${h.baseline.to}`
        }
      : null,
    settings: {
      threshold: h.settings.threshold,
      streak: h.settings.streak,
      minPct: h.settings.minPct
    },
    verdict: {
      status: h.verdict.status,
      lowStreak: h.verdict.lowStreak,
      avgRatio: h.verdict.avgRatio && r2(h.verdict.avgRatio)
    },
    skippedLowWindows: h.skippedLow,
    windows: h.windows.slice(-keep).map((w) => {
      const total = w.dollars || 1
      return {
        end: localIso(w.resetsAt, tz),
        closed: w.closed,
        pct: r2(w.pct),
        dollarsPerPct: r4(w.perPct),
        ratioToBaseline: w.ratio === undefined ? null : r2(w.ratio),
        plan: w.plan,
        untrackedPct: r2(w.untrackedPct),
        excluded: w.excluded ?? null,
        mix: {
          input: r2(w.mix.input / total),
          output: r2(w.mix.output / total),
          cacheRead: r2(w.mix.cacheRead / total),
          cacheWrite: r2(w.mix.cacheWrite / total)
        },
        tokens: w.tokens.input + w.tokens.output + w.tokens.cacheRead + w.tokens.cacheWrite
      }
    })
  }
}

function paceData(p?: PaceState) {
  return p
    ? {
        used: r2(p.used),
        target: r2(p.target),
        status: p.status,
        roomPctPerHour: r2(p.roomPerHour),
        cap: p.cap
      }
    : null
}

/**
 * Model ids and Claude Code versions are read from session files, which can
 * hold any text: only values shaped like real ones are sent (others count as
 * "other" models and are left out of the version list).
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/
const MINOR_VERSION_RE = /^\d{1,4}\.\d{1,4}$/

/** The aggregated numbers sent with a question. No text from any session. */
export function buildAskData(i: AskDataInput) {
  const tz = i.timeZone
  const days = new Map<
    string,
    { tokens: number; output: number; costUsd: number; responses: number }
  >()
  const months = new Map<string, { tokens: number; costUsd: number; responses: number }>()
  const firstModel = new Map<string, number>()
  const firstVersion = new Map<string, number>()
  const dayCut = i.now - 62 * 86_400_000
  for (const r of i.records) {
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite
    const p = costParts(r, i.prices)
    const cost = p.input + p.output + p.cacheRead + p.cacheWrite
    const m = monthKey(r.ts, tz)
    const mm = months.get(m) ?? { tokens: 0, costUsd: 0, responses: 0 }
    mm.tokens += tokens
    mm.costUsd += cost
    mm.responses++
    months.set(m, mm)
    if (r.ts >= dayCut) {
      const d = dayKey(r.ts, tz)
      const dd = days.get(d) ?? { tokens: 0, output: 0, costUsd: 0, responses: 0 }
      dd.tokens += tokens
      dd.output += r.output
      dd.costUsd += cost
      dd.responses++
      days.set(d, dd)
    }
    const model = MODEL_ID_RE.test(r.model) ? r.model : 'other'
    if (!firstModel.has(model)) firstModel.set(model, r.ts)
    if (r.version) {
      const minor = r.version.split('.').slice(0, 2).join('.')
      if (MINOR_VERSION_RE.test(minor) && !firstVersion.has(minor)) firstVersion.set(minor, r.ts)
    }
  }
  return {
    generatedAt: localIso(i.now, tz),
    timeZone: tz,
    plan: {
      current: i.plan,
      history: i.planHistory.map((p) => ({ from: p.from, plan: p.plan, multiplier: p.mult }))
    },
    method:
      'Each window is scored as API-equivalent dollars of local Claude Code usage divided by the % of the limit it reached ("$ per 1%"). ratioToBaseline = score / (baseline per 1x × plan multiplier); below 1/threshold counts as low. untrackedPct = % not explained by local usage (claude.ai, mobile, cloud, or a smaller limit).',
    fiveHour: healthData(i.health5h, 60, tz),
    sevenDay: healthData(i.health7d, 16, tz),
    paceNow: { fiveHour: paceData(i.pace5h), sevenDay: paceData(i.pace7d) },
    dailyTotals: [...days.entries()]
      .sort()
      .map(([date, d]) => ({ date, ...d, costUsd: r2(d.costUsd) })),
    monthlyTotals: [...months.entries()]
      .sort()
      .slice(-13)
      .map(([month, d]) => ({ month, ...d, costUsd: r2(d.costUsd) })),
    modelFirstSeen: [...firstModel.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([model, ts]) => ({ model, date: dayKey(ts, tz) })),
    claudeCodeVersionFirstSeen: [...firstVersion.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(-20)
      .map(([version, ts]) => ({ version, date: dayKey(ts, tz) })),
    limitReached: i.limitHits.slice(-30).map((h) => ({ at: localIso(h.ts, tz), window: h.kind })),
    markedElsewhere: i.elsewhere.map((e) => ({
      from: localIso(e.from, tz),
      to: localIso(e.to, tz)
    }))
  }
}

export type AskData = ReturnType<typeof buildAskData>

/** The exact text sent to `claude -p` on stdin. */
export function buildAskPrompt(question: string, data: AskData): string {
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 1000)
  return [
    ASK_MARKER,
    'You are helping me understand my Claude subscription usage and limits, from a local dashboard.',
    'Answer the question using only the JSON data below. Be concise and concrete: cite dates, percentages and ratios.',
    'Say how confident you are, and mention caveats that matter (usage outside this computer, token mix shifts, few windows).',
    'Use short Markdown: a one-line answer first, then a few bullets.',
    '',
    `Question: ${q}`,
    '',
    'Data (JSON):',
    JSON.stringify(data)
  ].join('\n')
}

export interface AskAnswer {
  ok: boolean
  answer: string
  error?: string
  costUsd?: number
  sessionId?: string
}

/** Read `claude -p --output-format json` output (tolerates shell noise before the JSON). */
export function parseAskOutput(stdout: string, stderr = '', code: number | null = 0): AskAnswer {
  const lines = stdout.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.startsWith('{')) continue
    try {
      const o = JSON.parse(lines.slice(i).join('\n')) as Record<string, unknown>
      const text = typeof o.result === 'string' ? o.result : ''
      const isError =
        o.is_error === true || (typeof o.subtype === 'string' && o.subtype.startsWith('error'))
      return {
        ok: !isError && !!text,
        answer: text,
        error: isError
          ? text || String(o.subtype ?? 'Claude returned an error')
          : text
            ? undefined
            : 'Empty answer',
        costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined,
        sessionId: typeof o.session_id === 'string' ? o.session_id : undefined
      }
    } catch {
      // keep looking further up
    }
  }
  if (code === 0 && stdout.trim()) return { ok: true, answer: stdout.trim() }
  return {
    ok: false,
    answer: '',
    error: (stderr.trim() || stdout.trim() || `claude exited with code ${code}`).slice(0, 2000)
  }
}

/** The question asked in a dashboard run, from its first prompt (for the session title). */
export function askQuestionOf(firstPrompt: string | undefined): string | undefined {
  if (!firstPrompt?.startsWith(ASK_MARKER)) return undefined
  return /^Question: (.+)$/m.exec(firstPrompt)?.[1]?.trim()
}

export interface AskHistoryItem {
  id: string
  at: number
  question: string
  ok: boolean
  answer: string
  error?: string
  durationMs: number
  costUsd?: number
  where: string
  /** Size of what was sent, in bytes. */
  sentBytes: number
}
