// The Settings page's map: its sections (in order), their sub-headings, and
// every setting on it, with the words search finds it by and what "Reset to
// default" may do. Shared by the desktop Settings page and the phone's Settings
// tab, so both find the same setting by the same words.
//
// Each setting on the page is wrapped in <SettingItem id="…"> (renderer), and a
// test checks that every id here is on the page exactly once, and that every
// key of AppSettings is claimed here or listed in SET_ELSEWHERE.
//
// Pure data and functions: no React, no DOM, no Node.

import { DEFAULT_SETTINGS, type AppSettings } from './types'
import { DEFAULT_PROVIDER_TOGGLES } from './provider'
import { DEFAULT_HEALTH } from './usage/health'
import { DEFAULT_CODEX_PRICES } from './usage/pricing'
import { DEFAULT_GIT_SETTINGS } from './git/types'
import { DEFAULT_ASK_SESSIONS } from './ask-sessions/types'
import { DEFAULT_MOBILE, MOBILE_SAFE_SETTINGS } from './mobile'
import { DEFAULT_KEEP } from './backup'

export type SectionId =
  | 'general'
  | 'sources'
  | 'launching'
  | 'usage'
  | 'alerts'
  | 'ai'
  | 'git'
  | 'phone'
  | 'accounts'
  | 'archive'
  | 'advanced'

export interface SubsectionDef {
  /** Unique across the page (used in links and the menu). */
  id: string
  title: string
}

export interface SectionDef {
  id: SectionId
  title: string
  description: string
  /** A lucide icon name (the renderer maps it). */
  icon: string
  subsections?: SubsectionDef[]
  /** Extra words for the section as a whole. */
  keywords?: string[]
}

export const SECTIONS: SectionDef[] = [
  {
    id: 'general',
    title: 'General',
    description: 'How the app looks and starts.',
    icon: 'sliders'
  },
  {
    id: 'sources',
    title: 'Providers & sources',
    description: 'Which coding agents are on and where their sessions are read from.',
    icon: 'folders'
  },
  {
    id: 'launching',
    title: 'Launching',
    description: 'How Resume, Fork, Branch and Continue fresh start a session.',
    icon: 'play',
    subsections: [
      { id: 'launching.claude', title: 'Claude Code' },
      { id: 'launching.codex', title: 'Codex' },
      { id: 'launching.large', title: 'Large sessions' }
    ]
  },
  {
    id: 'usage',
    title: 'Usage & limits',
    description: 'Your plan, live limits, limit health, pacing and prices.',
    icon: 'chart',
    subsections: [
      { id: 'usage.plan', title: 'Plan' },
      { id: 'usage.live-limits', title: 'Live limits' },
      { id: 'usage.health', title: 'Limit health' },
      { id: 'usage.pacing', title: 'Pacing' },
      { id: 'usage.prices', title: 'Prices' },
      { id: 'usage.codex', title: 'Codex' },
      { id: 'usage.meter', title: 'Tray & meter' }
    ]
  },
  {
    id: 'alerts',
    title: 'Alerts',
    description: 'Desktop and phone notifications for limits and running sessions.',
    icon: 'bell',
    keywords: ['notifications']
  },
  {
    id: 'ai',
    title: 'Summaries & Ask',
    description: 'Summaries, Ask Claude and Ask across sessions, run with your own Claude Code.',
    icon: 'sparkles',
    subsections: [
      { id: 'ai.summaries', title: 'Summaries' },
      { id: 'ai.ask-claude', title: 'Ask Claude' },
      { id: 'ai.ask-sessions', title: 'Ask across sessions' }
    ]
  },
  {
    id: 'git',
    title: 'Git',
    description: 'Links between sessions and the commits, branches and pull requests they made.',
    icon: 'git'
  },
  {
    id: 'phone',
    title: 'Phone & remote',
    description: 'The phone companion and terminal access over SSH, on your tailnet only.',
    icon: 'phone',
    subsections: [
      { id: 'phone.access', title: 'Phone access' },
      { id: 'phone.paired', title: 'Paired phones' },
      { id: 'phone.terminal', title: 'Terminal access' }
    ]
  },
  {
    id: 'accounts',
    title: 'Accounts & credits',
    description: 'API keys, credit grants and which account launches bill to.',
    icon: 'wallet'
  },
  {
    id: 'archive',
    title: 'Archive & backup',
    description: 'The archive that keeps every session, and backups of the app’s own data.',
    icon: 'archive'
  },
  {
    id: 'advanced',
    title: 'Advanced',
    description:
      'Recalculating usage, capacity weights, server ports and where the app keeps its data.',
    icon: 'wrench'
  }
]

/** Where a setting's value lives. */
export type SettingStore = 'app' | 'mobile' | 'backup'

export interface SettingDef {
  id: string
  section: SectionId
  /** A sub-heading of the section (SubsectionDef.id). */
  sub?: string
  label: string
  description?: string
  /** Words a search finds it by besides its label and description. */
  keywords?: string[]
  /**
   * The values it shows, as dotted paths (`liveAlerts.quiet.enabled`). Empty
   * for an action or information (no "Changed", no reset).
   */
  keys?: string[]
  store?: SettingStore
  /**
   * Never reset, with why (shown in its tooltip): secrets, keys, paired
   * devices, backup passwords, your own data, and system changes that have
   * their own review-and-confirm flow.
   */
  never?: string
  /**
   * Values that saving this setting changes too, in the app (not shown or reset
   * by it): a reset sends their current value along so the app leaves them as
   * they are, and Undo puts back what they were. E.g. a plan change records a
   * plan history entry unless the history comes with it.
   */
  keeps?: string[]
  /** The phone can change it too (MOBILE_SAFE_SETTINGS). */
  phone?: boolean
  /** Only while Codex is on. */
  codex?: boolean
}

const SYSTEM = 'A change to Windows or another program’s files, with its own review and Undo'

export const SETTINGS: SettingDef[] = [
  // General
  {
    id: 'general.theme',
    section: 'general',
    label: 'Theme',
    description: 'Light, dark, or follow Windows.',
    keywords: ['appearance', 'dark mode', 'light mode', 'colors', 'system theme'],
    keys: ['theme']
  },
  {
    id: 'general.startup',
    section: 'general',
    label: 'Start with Windows (minimized to tray)',
    description: 'Starts when you sign in to Windows, with just the tray icon.',
    keywords: ['login', 'sign in', 'boot', 'autostart', 'startup', 'tray', 'background'],
    never: SYSTEM
  },

  // Providers & sources
  {
    id: 'sources.providers',
    section: 'sources',
    label: 'Coding agents',
    description: 'Claude Code and Codex, each on or off. Off hides its sessions, usage and alerts.',
    keywords: ['providers', 'claude code', 'codex', 'openai', 'enable', 'disable'],
    keys: ['providers']
  },
  {
    id: 'sources.folders',
    section: 'sources',
    label: 'Scan sources',
    description: 'Your Windows profile, every WSL distro, and folders you added.',
    keywords: [
      'folders',
      'wsl',
      'distro',
      'add folder',
      'rescan',
      'paths',
      '.claude',
      '.codex',
      'projects'
    ],
    keys: ['extraFolders'],
    never: 'Folders you added (remove one with its ×)'
  },
  {
    id: 'sources.stopped-distros',
    section: 'sources',
    label: 'Scan stopped WSL distros',
    description: 'Reading a stopped distro starts it in the background.',
    keywords: ['wsl', 'distro', 'linux', 'ubuntu', 'boot'],
    keys: ['scanStoppedDistros']
  },
  {
    id: 'sources.cowork',
    section: 'sources',
    label: 'Claude desktop (Cowork) sessions',
    description: 'Also show the Claude desktop app’s Cowork tasks, view-only.',
    keywords: ['claude desktop', 'cowork', 'desktop app', 'tasks'],
    keys: ['coworkSource']
  },
  {
    id: 'sources.claude-ai',
    section: 'sources',
    label: 'Import claude.ai data export',
    description: 'Adds your claude.ai conversations to the archive as view-only sessions.',
    keywords: ['zip', 'export', 'chats', 'conversations', 'claude.ai', 'import']
  },

  // Launching (both agents)
  {
    id: 'launching.terminal',
    section: 'launching',
    label: 'Terminal',
    description: 'Windows Terminal, PowerShell or cmd, for every launch.',
    keywords: ['windows terminal', 'wt', 'powershell', 'cmd', 'console', 'shell', 'resume'],
    keys: ['terminal'],
    phone: true
  },
  // Launching · Claude Code
  {
    id: 'launching.remote-control',
    section: 'launching',
    sub: 'launching.claude',
    label: 'Remote Control by default',
    description: 'Makes launched sessions continuable from the Claude mobile app.',
    keywords: ['remote', 'mobile app', 'claude.ai/code', 'phone', 'continue elsewhere'],
    keys: ['remoteControlDefault'],
    phone: true
  },
  {
    id: 'launching.model',
    section: 'launching',
    sub: 'launching.claude',
    label: 'Model, effort and fast mode',
    description: '--model, --effort and fast mode for every Claude Code launch.',
    keywords: ['opus', 'sonnet', 'haiku', 'reasoning', 'thinking', 'fast', 'speed', 'model'],
    keys: ['defaultModel', 'defaultEffort', 'defaultFast'],
    phone: true
  },
  {
    id: 'launching.project-models',
    section: 'launching',
    sub: 'launching.claude',
    label: 'Project model defaults',
    description: 'Model, effort and fast mode chosen for one project.',
    keywords: ['per project', 'project default', 'model', 'fast'],
    keys: ['projectModels']
  },
  {
    id: 'launching.skip-permissions',
    section: 'launching',
    sub: 'launching.claude',
    label: 'Skip permission prompts by default',
    description: 'Claude Code’s --dangerously-skip-permissions for every launch.',
    keywords: ['dangerously', 'bypass', 'approvals', 'yolo', 'permissions', 'ask'],
    keys: ['skipPermissionsDefault']
  },
  // Launching · Codex
  {
    id: 'launching.codex-bypass',
    section: 'launching',
    sub: 'launching.codex',
    label: 'Codex: bypass approvals and sandbox by default',
    description:
      'Codex’s --dangerously-bypass-approvals-and-sandbox: no approval prompts and no sandbox.',
    keywords: [
      'dangerously',
      'yolo',
      'permissions',
      'approvals',
      'sandbox',
      'codex bypass',
      'skip'
    ],
    keys: ['codexBypassDefault'],
    codex: true
  },
  {
    id: 'launching.codex-open-in',
    section: 'launching',
    sub: 'launching.codex',
    label: 'Open Codex sessions in',
    description: 'A terminal or the Codex desktop app.',
    keywords: ['codex app', 'desktop app', 'terminal', 'open in'],
    keys: ['codexOpenInDefault', 'codexProjectOpenIn'],
    codex: true
  },
  {
    id: 'launching.codex-model',
    section: 'launching',
    sub: 'launching.codex',
    label: 'Codex model and effort',
    description: '-m, reasoning effort and fast mode for every Codex launch.',
    keywords: ['gpt', 'reasoning', 'fast', 'service tier', 'speed', 'model', 'codex'],
    keys: ['codexDefaultModel', 'codexDefaultEffort', 'codexDefaultFast', 'codexProjectModels'],
    codex: true
  },
  // Launching · Large sessions
  {
    id: 'launching.context-warning',
    section: 'launching',
    sub: 'launching.large',
    label: 'Warn before resuming a large session',
    description: 'Resume shows how big the session’s context is first.',
    keywords: ['context', 'tokens', 'large', 'big', 'compact', 'resume warning'],
    keys: ['contextWarning.enabled']
  },
  {
    id: 'launching.context-threshold',
    section: 'launching',
    sub: 'launching.large',
    label: 'Warn from',
    description: 'Thousand tokens of context.',
    keywords: ['context', 'tokens', 'threshold', 'large session'],
    keys: ['contextWarning.thresholdTokens']
  },

  // Usage & limits · Plan
  {
    id: 'usage.plan',
    section: 'usage',
    sub: 'usage.plan',
    label: 'Plan',
    description: 'Your Claude plan, for labels and limit health.',
    keywords: ['pro', 'max', 'max5', 'max20', 'subscription', 'team'],
    keys: ['plan'],
    // Saving a new plan records a plan change unless the history comes along.
    keeps: ['planHistory']
  },
  {
    id: 'usage.plan-history',
    section: 'usage',
    sub: 'usage.plan',
    label: 'Plan changes',
    description: 'When your plan changed, so older windows are judged by the plan they ran on.',
    keywords: ['upgrade', 'downgrade', 'history', 'plan'],
    keys: ['planHistory'],
    never: 'Your plan history'
  },
  {
    id: 'usage.week-start',
    section: 'usage',
    sub: 'usage.plan',
    label: 'Weeks start on',
    description: 'The first day of the week in usage charts.',
    keywords: ['monday', 'sunday', 'calendar', 'week', 'charts'],
    keys: ['weekStart'],
    phone: true
  },
  // Usage & limits · Live limits
  {
    id: 'usage.status-line',
    section: 'usage',
    sub: 'usage.live-limits',
    label: 'Live limits (status line)',
    description: 'Your real 5-hour and weekly percentages, from Claude Code’s status line.',
    keywords: [
      'statusline',
      'status line',
      'settings.json',
      '5-hour',
      'weekly',
      'bridge',
      'percent',
      'live'
    ],
    never: SYSTEM
  },
  // Usage & limits · Limit health
  {
    id: 'usage.health-threshold',
    section: 'usage',
    sub: 'usage.health',
    label: 'Flag threshold',
    description: 'How much less a window may buy than your normal dates before it’s flagged.',
    keywords: ['health', 'reduction', 'nerf', 'baseline', 'limit cut'],
    keys: ['health.threshold']
  },
  {
    id: 'usage.health-streak',
    section: 'usage',
    sub: 'usage.health',
    label: 'Low windows in a row',
    keywords: ['health', 'streak', 'reduction'],
    keys: ['health.streak']
  },
  {
    id: 'usage.health-min',
    section: 'usage',
    sub: 'usage.health',
    label: 'Skip windows under',
    description: 'Low percentages are too coarse to score.',
    keywords: ['health', 'minimum', 'percent'],
    keys: ['health.minPct']
  },
  {
    id: 'usage.health-elsewhere',
    section: 'usage',
    sub: 'usage.health',
    label: 'Leave out windows used elsewhere',
    description: 'Windows where much of the usage came from claude.ai or another PC.',
    keywords: ['health', 'untracked', 'elsewhere', 'claude.ai', 'other pc'],
    keys: ['health.excludeUntracked', 'health.untrackedLimit']
  },
  {
    id: 'usage.family-pricing',
    section: 'usage',
    sub: 'usage.health',
    label: 'One price per model family',
    description: 'Price every Opus, Sonnet or Haiku at the newest member’s rates.',
    keywords: ['health', 'pricing', 'opus', 'sonnet', 'haiku', 'family'],
    keys: ['health.familyPricing']
  },
  // Usage & limits · Pacing
  {
    id: 'usage.pace-cap',
    section: 'usage',
    sub: 'usage.pacing',
    label: 'Cap',
    description: 'Target ceiling for both windows.',
    keywords: ['pace', 'pacing', 'target', 'gauge', 'budget'],
    keys: ['pace.cap']
  },
  {
    id: 'usage.pace-tolerance',
    section: 'usage',
    sub: 'usage.pacing',
    label: 'On-pace tolerance',
    keywords: ['pace', 'pacing', 'tolerance', 'gauge'],
    keys: ['pace.tolerance']
  },
  // Usage & limits · Prices
  {
    id: 'usage.prices',
    section: 'usage',
    sub: 'usage.prices',
    label: 'API prices',
    description: 'Dollars per million tokens, for cost estimates.',
    keywords: ['cost', 'price', 'dollars', 'usd', 'tokens', 'pricing', 'cache'],
    keys: ['prices']
  },
  // Usage & limits · Codex
  {
    id: 'usage.codex-plan',
    section: 'usage',
    sub: 'usage.codex',
    label: 'Plan (Codex)',
    description: 'Detected from Codex’s logs, or chosen.',
    keywords: ['chatgpt', 'plus', 'pro', 'codex', 'plan', 'openai'],
    keys: ['codexPlan'],
    codex: true
  },
  {
    id: 'usage.codex-multipliers',
    section: 'usage',
    sub: 'usage.codex',
    label: 'Codex plan multipliers',
    description: 'How much more each plan allows than Plus.',
    keywords: ['codex', 'multiplier', 'plan'],
    keys: ['codexPlanMults'],
    codex: true
  },
  {
    id: 'usage.codex-dates',
    section: 'usage',
    sub: 'usage.codex',
    label: 'Codex normal dates',
    description: 'The dates Codex’s limit health compares with.',
    keywords: ['codex', 'baseline', 'health', 'normal'],
    keys: ['codexHealth.baselineFrom', 'codexHealth.baselineTo'],
    never: 'Dates you picked',
    codex: true
  },
  {
    id: 'usage.codex-flag',
    section: 'usage',
    sub: 'usage.codex',
    label: 'Flag a possible Codex reduction below',
    keywords: ['codex', 'health', 'threshold', 'streak', 'reduction'],
    keys: ['codexHealth.threshold', 'codexHealth.streak'],
    codex: true
  },
  {
    id: 'usage.codex-accounts',
    section: 'usage',
    sub: 'usage.codex',
    label: 'Different plans in the logs are',
    description: 'Separate sign-ins, or one account that changed plan.',
    keywords: ['codex', 'accounts', 'sign-in', 'plan type'],
    keys: ['codexAccounts'],
    codex: true
  },
  {
    id: 'usage.codex-prices',
    section: 'usage',
    sub: 'usage.codex',
    label: 'Codex API prices',
    description: 'OpenAI API prices, for Codex cost estimates.',
    keywords: ['codex', 'openai', 'cost', 'price', 'gpt', 'unpriced'],
    keys: ['codexPrices'],
    codex: true
  },
  // Usage & limits · Tray & meter
  {
    id: 'usage.meter',
    section: 'usage',
    sub: 'usage.meter',
    label: 'Tray, mini meter and status bar',
    description: 'Whose limits they show.',
    keywords: ['tray', 'meter', 'status bar', 'icon', 'mini meter', 'codex', 'claude'],
    keys: ['meterProvider'],
    codex: true
  },

  // Alerts
  {
    id: 'alerts.limits',
    section: 'alerts',
    label: 'Limit alerts',
    description: 'A notification when the 5-hour or weekly limit passes these percentages.',
    keywords: ['threshold', 'percent', '5-hour', 'weekly', 'warning', 'notification'],
    keys: ['alertsEnabled', 'alertThresholds'],
    phone: true
  },
  {
    id: 'alerts.hooks',
    section: 'alerts',
    label: 'Session alerts',
    description: 'Exact alerts from hooks the app adds after you review the change.',
    keywords: [
      'hook',
      'hooks',
      'hooks.json',
      'settings.json',
      'trust',
      '/hooks',
      'codex',
      'approval hook'
    ],
    never: SYSTEM
  },
  {
    id: 'alerts.approval',
    section: 'alerts',
    label: 'Needs approval',
    description: 'A permission prompt or a question.',
    keywords: ['permission', 'prompt', 'question', 'blocked', 'approve'],
    keys: ['liveAlerts.approval'],
    phone: true
  },
  {
    id: 'alerts.finished',
    section: 'alerts',
    label: 'Finished',
    description: 'A session finished its turn and waits for you.',
    keywords: ['done', 'complete', 'turn', 'idle'],
    keys: ['liveAlerts.finished'],
    phone: true
  },
  {
    id: 'alerts.failed',
    section: 'alerts',
    label: 'Stopped with an error',
    keywords: ['error', 'failed', 'crash'],
    keys: ['liveAlerts.failed'],
    phone: true
  },
  {
    id: 'alerts.waiting',
    section: 'alerts',
    label: 'Still waiting',
    description: 'Claude Code’s own reminder after a minute idle.',
    keywords: ['idle', 'reminder', 'waiting'],
    keys: ['liveAlerts.waiting'],
    phone: true
  },
  {
    id: 'alerts.exited',
    section: 'alerts',
    label: 'Ended',
    description: 'The session’s process exited.',
    keywords: ['exit', 'closed', 'ended', 'quit'],
    keys: ['liveAlerts.exited'],
    phone: true
  },
  {
    id: 'alerts.min-work',
    section: 'alerts',
    label: '“Finished” only after',
    description: 'Quick replies don’t alert.',
    keywords: ['seconds', 'minimum', 'quick replies', 'finished'],
    keys: ['liveAlerts.minWorkSec'],
    phone: true
  },
  {
    id: 'alerts.desktop',
    section: 'alerts',
    label: 'Desktop notifications',
    description: 'Windows notifications. Click one to open the session.',
    keywords: ['toast', 'windows notification', 'popup'],
    keys: ['liveAlerts.desktop'],
    phone: true
  },
  {
    id: 'alerts.phone',
    section: 'alerts',
    label: 'Phone push alerts',
    description: 'To phones that turned push alerts on.',
    keywords: ['push', 'mobile', 'web push', 'phone notification'],
    keys: ['liveAlerts.phone'],
    phone: true
  },
  {
    id: 'alerts.quiet',
    section: 'alerts',
    label: 'Quiet hours',
    description: 'No alerts in this time (local time).',
    keywords: ['do not disturb', 'dnd', 'night', 'sleep', 'silence', 'mute', 'schedule'],
    keys: ['liveAlerts.quiet.enabled', 'liveAlerts.quiet.from', 'liveAlerts.quiet.to'],
    phone: true
  },
  {
    id: 'alerts.quiet-approvals',
    section: 'alerts',
    label: 'Approvals during quiet hours',
    description: 'A session that needs approval is stuck until you answer.',
    keywords: ['quiet hours', 'do not disturb', 'approval'],
    keys: ['liveAlerts.quiet.allowApprovals'],
    phone: true
  },
  {
    id: 'alerts.muted',
    section: 'alerts',
    label: 'Muted sessions',
    description: 'Sessions muted from Running now.',
    keywords: ['mute', 'bell', 'silence', 'unmute'],
    never: 'Your choice for each session'
  },

  // Summaries & Ask · Summaries
  {
    id: 'ai.summary-model',
    section: 'ai',
    sub: 'ai.summaries',
    label: 'Summary model',
    keywords: ['summaries', 'sonnet', 'haiku', 'opus', 'model', 'summarize'],
    keys: ['summaries.model']
  },
  {
    id: 'ai.summary-max',
    section: 'ai',
    sub: 'ai.summaries',
    label: 'Most text sent per session',
    keywords: ['summaries', 'characters', 'size', 'limit'],
    keys: ['summaries.maxChars']
  },
  {
    id: 'ai.summary-pause',
    section: 'ai',
    sub: 'ai.summaries',
    label: 'Pause above',
    description: 'Bulk summaries pause above this 5-hour %.',
    keywords: ['summaries', 'limit', '5-hour', 'guard', 'queue', 'pause'],
    keys: ['summaries.pauseAbovePct']
  },
  {
    id: 'ai.summary-auto',
    section: 'ai',
    sub: 'ai.summaries',
    label: 'Auto-summarize big sessions',
    keywords: ['summaries', 'automatic', 'idle', 'messages', 'auto'],
    keys: ['summaries.autoEnabled', 'summaries.autoMinMessages']
  },
  {
    id: 'ai.summary-notice',
    section: 'ai',
    sub: 'ai.summaries',
    label: 'What is sent',
    description: 'The one-time notice about what a summary sends to Claude.',
    keywords: ['summaries', 'privacy', 'notice', 'preview', 'sent'],
    // A consent, not a preference: never "Changed", and only its own button resets it.
    keys: []
  },
  {
    id: 'ai.handoffs',
    section: 'ai',
    sub: 'ai.summaries',
    label: 'Continue fresh handoffs',
    description: 'The summary files Continue fresh starts new sessions with.',
    keywords: ['continue fresh', 'handoff', 'cleanup', 'files']
  },
  // Summaries & Ask · Ask Claude
  {
    id: 'ai.ask-preview',
    section: 'ai',
    sub: 'ai.ask-claude',
    label: 'Show what will be sent first',
    description: 'Ask Claude shows its exact prompt before sending.',
    keywords: ['ask claude', 'preview', 'privacy'],
    keys: ['askSkipPreview']
  },
  {
    id: 'ai.ask-timeout',
    section: 'ai',
    sub: 'ai.ask-claude',
    label: 'Ask Claude timeout',
    keywords: ['ask claude', 'seconds', 'timeout'],
    keys: ['askTimeoutSec']
  },
  // Summaries & Ask · Ask across sessions
  {
    id: 'ai.ask-content',
    section: 'ai',
    sub: 'ai.ask-sessions',
    label: 'Content questions',
    description: 'Questions answered from what your sessions say (an index is built first).',
    keywords: ['ask', 'search index', 'history', 'questions', 'content'],
    keys: ['askSessions.enabled']
  },
  {
    id: 'ai.ask-model',
    section: 'ai',
    sub: 'ai.ask-sessions',
    label: 'Ask model and effort',
    keywords: ['ask', 'model', 'effort', 'sonnet', 'opus'],
    keys: ['askSessions.model', 'askSessions.effort'],
    // A new default replaces the Ask screen's remembered choice unless it comes along.
    keeps: ['askSessions.lastModel', 'askSessions.lastEffort']
  },
  {
    id: 'ai.ask-snippets',
    section: 'ai',
    sub: 'ai.ask-sessions',
    label: 'Snippets per question',
    keywords: ['ask', 'snippets', 'limit'],
    keys: ['askSessions.maxSnippets']
  },
  {
    id: 'ai.ask-chars',
    section: 'ai',
    sub: 'ai.ask-sessions',
    label: 'Characters per question',
    keywords: ['ask', 'characters', 'limit', 'size'],
    keys: ['askSessions.maxChars']
  },
  {
    id: 'ai.ask-per-session',
    section: 'ai',
    sub: 'ai.ask-sessions',
    label: 'Snippets from one session',
    keywords: ['ask', 'snippets', 'per session'],
    keys: ['askSessions.perSession']
  },
  {
    id: 'ai.ask-index',
    section: 'ai',
    sub: 'ai.ask-sessions',
    label: 'Index size limit',
    description: 'The oldest sessions are left out past it. Rebuild or delete the index here.',
    keywords: ['ask', 'index', 'megabytes', 'rebuild', 'delete index', 'cache'],
    keys: ['askSessions.indexBudgetMB']
  },

  // Git
  {
    id: 'git.links',
    section: 'git',
    label: 'Link sessions to git commits',
    description: 'Reads your repos (never writes) to find what each session committed.',
    keywords: ['commits', 'branches', 'repo', 'changes', 'touched'],
    keys: ['gitLinks.enabled']
  },
  {
    id: 'git.gh',
    section: 'git',
    label: 'Look up pull requests with the GitHub CLI',
    description: 'gh pr list, with your own sign-in.',
    keywords: ['github', 'gh', 'pull request', 'pr', 'cli'],
    keys: ['gitLinks.gh']
  },

  // Phone & remote · Phone access
  {
    id: 'phone.access',
    section: 'phone',
    sub: 'phone.access',
    label: 'Phone access',
    description: 'The companion server for the phone app, over Tailscale or home Wi-Fi.',
    keywords: ['mobile', 'companion', 'tailscale', 'serve', 'qr', 'pair', 'server', 'wifi', 'lan'],
    never: SYSTEM
  },
  {
    id: 'phone.connection',
    section: 'phone',
    sub: 'phone.access',
    label: 'Connection',
    description: 'Tailscale, or home Wi-Fi with a firewall rule.',
    keywords: [
      'tailscale',
      'wifi',
      'wi-fi',
      'lan',
      'firewall',
      'certificate',
      'network address',
      'fingerprint'
    ],
    keys: ['mode', 'lanAddress'],
    store: 'mobile',
    never: 'Changes how the phone server can be reached'
  },
  // Phone & remote · Paired phones
  {
    id: 'phone.devices',
    section: 'phone',
    sub: 'phone.paired',
    label: 'Paired phones',
    description: 'Each phone has its own token. Revoke one any time.',
    keywords: ['revoke', 'devices', 'pair', 'token', 'push'],
    never: 'Paired devices'
  },
  {
    id: 'phone.read-only',
    section: 'phone',
    sub: 'phone.paired',
    label: 'Read-only mode',
    description: 'Phones can look, but not change or launch anything.',
    keywords: ['security', 'read only', 'lock', 'view only'],
    keys: ['readOnly'],
    store: 'mobile',
    never: 'A security choice'
  },
  {
    id: 'phone.confirm',
    section: 'phone',
    sub: 'phone.paired',
    label: 'Confirm launches on this PC',
    keywords: ['security', 'confirm', 'launch', 'approve'],
    keys: ['confirmOnPc'],
    store: 'mobile',
    never: 'A security choice'
  },
  {
    id: 'phone.auto-start',
    section: 'phone',
    sub: 'phone.paired',
    label: 'Start with the app',
    description: 'Phone access starts again when the app starts (if it was on).',
    keywords: ['autostart', 'startup'],
    keys: ['autoStart'],
    store: 'mobile'
  },
  {
    id: 'phone.activity',
    section: 'phone',
    sub: 'phone.paired',
    label: 'Activity log',
    description: 'What phones did and asked for.',
    keywords: ['log', 'history', 'activity', 'audit']
  },
  // Phone & remote · Terminal access
  {
    id: 'phone.terminal',
    section: 'phone',
    sub: 'phone.terminal',
    label: 'Terminal access (SSH)',
    description: 'A real terminal on this PC from your phone, through Windows’ own OpenSSH Server.',
    keywords: [
      'ssh',
      'openssh',
      'sshd',
      'authorized_keys',
      'shell',
      'terminal',
      'tailscale',
      'firewall',
      'key'
    ],
    never: SYSTEM
  },

  // Accounts & credits
  {
    id: 'accounts.keys',
    section: 'accounts',
    label: 'API accounts',
    description: 'API keys and Admin keys, and the credit grants you received.',
    keywords: ['api key', 'admin key', 'credits', 'grant', 'console', 'anthropic', 'reconnect'],
    never: 'API keys and credit grants'
  },
  {
    id: 'accounts.billing',
    section: 'accounts',
    label: 'Default billing for launches',
    description: 'Your subscription or an API account, for every launch.',
    keywords: ['billing', 'subscription', 'api key', 'launch', 'project billing', 'account'],
    keys: ['defaultBilling', 'projectBilling']
  },
  {
    id: 'accounts.refresh',
    section: 'accounts',
    label: 'Refresh Admin reports',
    description: 'Read-only calls to api.anthropic.com.',
    keywords: ['admin', 'reports', 'refresh', 'minutes', 'api'],
    keys: ['adminRefreshMinutes']
  },

  // Archive & backup
  {
    id: 'archive.archive',
    section: 'archive',
    label: 'Archive',
    description: 'Every Claude Code session file is copied here and kept forever.',
    keywords: ['archive', 'copy', 'keep forever', 'folder', 'size']
  },
  {
    id: 'archive.codex',
    section: 'archive',
    label: 'Codex sessions in the archive',
    description: 'None, the ones you named, pinned or tagged, or all.',
    keywords: ['codex', 'archive', 'rollouts'],
    keys: ['codexArchive'],
    codex: true
  },
  {
    id: 'archive.cleanup',
    section: 'archive',
    label: 'Claude Code cleanup',
    description: 'cleanupPeriodDays, read only. This app never edits Claude’s settings.',
    keywords: ['cleanupPeriodDays', 'cleanup', 'retention', '30 days', 'deleted'],
    keys: []
  },
  {
    id: 'archive.backup-folder',
    section: 'archive',
    label: 'Backup folder',
    description: 'OneDrive, an external drive or a NAS share.',
    keywords: ['backup', 'onedrive', 'drive', 'nas', 'folder', 'snapshot', 'take over'],
    never: 'Your backup folder'
  },
  {
    id: 'archive.backup-schedule',
    section: 'archive',
    label: 'Backup schedule',
    keywords: ['backup', 'daily', 'weekly', 'schedule', 'automatic'],
    keys: ['schedule'],
    store: 'backup'
  },
  {
    id: 'archive.backup-keep',
    section: 'archive',
    label: 'Keep the last',
    description: 'Older snapshots are deleted from the backup set.',
    keywords: ['backup', 'retention', 'snapshots', 'keep'],
    keys: ['keep'],
    store: 'backup'
  },
  {
    id: 'archive.backup-password',
    section: 'archive',
    label: 'Backup password',
    description: 'Encrypts new snapshots. A lost password means unreadable backups.',
    keywords: ['backup', 'encrypt', 'encryption', 'password', 'remember'],
    never: 'Backup passwords'
  },
  {
    id: 'archive.restore',
    section: 'archive',
    label: 'Restore from a backup',
    keywords: ['restore', 'recover', 'snapshot', 'backup']
  },
  {
    id: 'archive.safety',
    section: 'archive',
    label: 'Restore safety copies',
    description: 'Copies of files a restore replaced.',
    keywords: ['restore', 'safety copies', 'cleanup', 'backup'],
    keys: ['autoCleanSafety'],
    store: 'backup'
  },

  // Advanced
  {
    id: 'advanced.recalculate',
    section: 'advanced',
    label: 'Recalculate usage',
    description: 'Reads every session again, or checks the totals against ccusage.',
    keywords: ['usage', 'ccusage', 'recalculate', 'rebuild', 'verify', 'tokens'],
    keys: []
  },
  {
    id: 'advanced.weights',
    section: 'advanced',
    label: 'Capacity weights',
    description: 'Token weights for the implied-capacity estimate.',
    keywords: ['capacity', 'weights', 'tokens', 'estimate', 'cache'],
    keys: ['capacityWeights']
  },
  {
    id: 'advanced.ports',
    section: 'advanced',
    label: 'Phone server ports',
    description: 'Where the phone companion listens, and the Tailscale HTTPS port.',
    keywords: ['port', 'https', 'tailscale', 'server', 'network', 'phone'],
    keys: ['port', 'httpsPort'],
    store: 'mobile'
  },
  {
    id: 'advanced.about',
    section: 'advanced',
    label: 'About',
    description: 'Version, data folder and what leaves this PC.',
    keywords: ['version', 'data folder', 'appdata', 'privacy', 'network', 'fixtures']
  }
]

/**
 * Settings keys that aren't on the Settings page, with where they're set.
 * With SETTINGS, every key of AppSettings is accounted for (tested).
 */
export const SET_ELSEWHERE: Record<string, string> = {
  providerView: 'The All / Claude / Codex switch in the sidebar',
  showSubagents: 'The subagent toggle in the sidebar',
  usageSplit: 'Usage & limits screen (stacked or split charts)',
  elsewhere: 'Usage & limits screen (used elsewhere ranges)',
  codexElsewhere: 'Usage & limits screen (used elsewhere ranges)',
  'health.baselineFrom': 'The Limit health card (normal dates)',
  'health.baselineTo': 'The Limit health card (normal dates)',
  branchConfirmed: 'The one-time Branch from here explanation',
  // Codex limit health has controls only for its dates, threshold and streak
  // (as before this page); these keep Claude Code's defaults.
  'codexHealth.minPct': 'No control: Codex limit health uses the default',
  'codexHealth.untrackedLimit': 'No control: Codex limit health uses the default',
  'codexHealth.excludeUntracked': 'No control: Codex limit health uses the default',
  'codexHealth.familyPricing': 'No control: Codex limit health uses the default',
  'askSessions.noticeAccepted': 'The one-time notice when content questions are turned on',
  'askSessions.noticeVersion': 'The one-time notice when content questions are turned on',
  'askSessions.lastModel': 'The Ask screen’s own choice for the next question',
  'askSessions.lastEffort': 'The Ask screen’s own choice for the next question',
  'summaries.noticeAccepted':
    'The one-time notice before the first summary (What is sent shows it again)',
  'summaries.noticeVersion': 'The one-time notice before the first summary'
}

/** Old link targets (before sections were regrouped), still accepted. */
export const LEGACY_TARGETS: Record<string, string> = {
  accounts: 'accounts',
  ask: 'ai.ask-sessions',
  alerts: 'alerts',
  backup: 'archive.backup-folder',
  'codex-usage': 'usage.codex',
  context: 'launching.large',
  git: 'git',
  providers: 'sources.providers',
  summaries: 'ai.summaries'
}

export type TargetKind = 'section' | 'sub' | 'setting'

export interface ResolvedTarget {
  kind: TargetKind
  id: string
  section: SectionId
}

const SECTION_BY_ID = new Map(SECTIONS.map((s) => [s.id as string, s]))
const SUB_SECTION = new Map(
  SECTIONS.flatMap((s) => (s.subsections ?? []).map((u) => [u.id, s.id] as const))
)
const SETTING_BY_ID = new Map(SETTINGS.map((s) => [s.id, s]))

export function sectionDef(id: string): SectionDef | undefined {
  return SECTION_BY_ID.get(id)
}

export function settingDef(id: string): SettingDef | undefined {
  return SETTING_BY_ID.get(id)
}

export function subsectionTitle(id: string): string | undefined {
  for (const s of SECTIONS) for (const u of s.subsections ?? []) if (u.id === id) return u.title
  return undefined
}

/** A link target (a section, a sub-heading, a setting, or an old section id). */
export function resolveTarget(target: string | null | undefined): ResolvedTarget | null {
  if (!target) return null
  const t = LEGACY_TARGETS[target] && !SECTION_BY_ID.has(target) ? LEGACY_TARGETS[target] : target
  if (SECTION_BY_ID.has(t)) return { kind: 'section', id: t, section: t as SectionId }
  const sub = SUB_SECTION.get(t)
  if (sub) return { kind: 'sub', id: t, section: sub }
  const s = SETTING_BY_ID.get(t)
  if (s) return { kind: 'setting', id: t, section: s.section }
  return null
}

/** "Alerts › Quiet hours": where a target is, in words (Back / Forward tooltips). */
export function targetLabel(target: string): string {
  const r = resolveTarget(target)
  if (!r) return target
  const section = SECTION_BY_ID.get(r.section)?.title ?? r.section
  if (r.kind === 'section') return section
  if (r.kind === 'sub') return `${section} › ${subsectionTitle(r.id) ?? r.id}`
  return `${section} › ${SETTING_BY_ID.get(r.id)?.label ?? r.id}`
}

// ─── Search ──────────────────────────────────────────────────────────────

/** Words that mean the same thing here: either side finds the other's settings. */
export const SYNONYMS: [string, string[]][] = [
  ['alert', ['notification', 'notify', 'toast', 'ping']],
  ['hook', ['session alerts', 'hooks.json']],
  ['ssh', ['terminal access', 'openssh', 'sshd']],
  ['fast', ['fast mode', 'service tier', 'speed']],
  ['billing', ['api key', 'account', 'subscription']],
  ['phone', ['mobile', 'companion', 'push']],
  ['quiet', ['do not disturb', 'dnd', 'night']],
  ['backup', ['restore', 'snapshot', 'onedrive']],
  ['model', ['opus', 'sonnet', 'haiku', 'gpt']],
  ['cost', ['price', 'pricing', 'dollars']],
  ['permission', ['dangerously', 'bypass', 'yolo', 'approvals']],
  ['dark', ['theme', 'appearance']],
  ['limit', ['quota', 'usage']]
]

/** Lower case, no accents, curly quotes as straight. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
}

/** The words of a query (quotes and punctuation that aren't part of a word dropped). */
export function queryWords(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((w) => w.replace(/^["'(]+|["'),]+$/g, ''))
    .filter(Boolean)
}

/** A word and what it also means (SYNONYMS, either direction). */
function expand(word: string): string[] {
  const out = new Set([word])
  for (const [k, vs] of SYNONYMS) {
    const group = [k, ...vs]
    if (group.some((g) => g.startsWith(word) || (word.length >= 3 && word.startsWith(g))))
      for (const g of group) out.add(g)
  }
  return [...out]
}

function haystackHas(text: string, word: string): boolean {
  // A word's start: the beginning, or after a space or punctuation (so "ssh" finds "(SSH)").
  let i = text.indexOf(word)
  while (i >= 0) {
    if (i === 0 || /[^a-z0-9]/.test(text[i - 1])) return true
    i = text.indexOf(word, i + 1)
  }
  return false
}

export interface SettingMatch {
  /** Every word matched. */
  match: boolean
  /** Words found only through keywords or synonyms (shown as "matches …"). */
  viaKeyword: string[]
}

/** Does a setting match a query? Every word must start a word in it (or a synonym must). */
export function matchSetting(def: SettingDef, query: string): SettingMatch {
  const words = queryWords(query)
  if (!words.length) return { match: true, viaKeyword: [] }
  const section = SECTION_BY_ID.get(def.section)
  const sub = def.sub ? subsectionTitle(def.sub) : undefined
  const visible = normalize(
    [def.label, def.description ?? '', section?.title ?? '', sub ?? ''].join(' \u0001 ')
  )
  const hidden = normalize([...(def.keywords ?? []), ...(section?.keywords ?? [])].join(' \u0001 '))
  const viaKeyword: string[] = []
  for (const w of words) {
    if (haystackHas(visible, w)) continue
    const alts = expand(w)
    if (alts.some((a) => haystackHas(hidden, a) || (a !== w && haystackHas(visible, a)))) {
      viaKeyword.push(w)
      continue
    }
    return { match: false, viaKeyword: [] }
  }
  return { match: true, viaKeyword }
}

/** The settings that match, in page order. */
export function searchSettings(query: string, defs: SettingDef[] = SETTINGS): SettingDef[] {
  return defs.filter((d) => matchSetting(d, query).match)
}

/**
 * The words of a query to highlight on the page (each query word, as typed):
 * the renderer marks where they start a word in a setting's visible text.
 */
export function highlightWords(query: string): string[] {
  return [...new Set(queryWords(query))].sort((a, b) => b.length - a.length)
}

// ─── Changed from default, and reset ─────────────────────────────────────

/** AppSettings with every optional key's default filled in (as each reader applies it). */
export const APP_DEFAULTS: AppSettings = {
  ...DEFAULT_SETTINGS,
  defaultFast: 'off',
  providers: { ...DEFAULT_PROVIDER_TOGGLES },
  codexArchive: 'off',
  codexDefaultModel: 'default',
  codexDefaultEffort: 'default',
  codexDefaultFast: 'off',
  codexBypassDefault: true,
  codexProjectModels: {},
  codexOpenInDefault: 'terminal',
  codexProjectOpenIn: {},
  codexPlan: 'auto',
  codexAccounts: 'separate',
  codexPlanMults: {},
  codexHealth: { ...DEFAULT_HEALTH },
  codexPrices: DEFAULT_CODEX_PRICES.map((p) => ({ ...p })),
  meterProvider: 'claude',
  gitLinks: { ...DEFAULT_GIT_SETTINGS },
  askSessions: { ...DEFAULT_ASK_SESSIONS },
  coworkSource: false
}

/** Defaults of the settings kept outside AppSettings (mobile.json, backup.json). */
export const STORE_DEFAULTS: Record<Exclude<SettingStore, 'app'>, Record<string, unknown>> = {
  mobile: { ...DEFAULT_MOBILE },
  backup: { schedule: 'daily', keep: DEFAULT_KEEP, autoCleanSafety: false }
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** A copy of `obj` with `path` set (objects along the way copied, never changed). */
function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const [head, ...rest] = path.split('.')
  const out = { ...obj }
  if (!rest.length) {
    if (value === undefined) delete out[head]
    else out[head] = value
    return out
  }
  const child = out[head]
  out[head] = setPath(
    child && typeof child === 'object' ? (child as Record<string, unknown>) : {},
    rest.join('.'),
    value
  )
  return out
}

/** Same value, order of object keys aside. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => sameValue(x, bb[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
  for (const k of keys) {
    // An absent key and an undefined one are the same.
    if (!sameValue(ao[k], bo[k])) return false
  }
  return true
}

/** The value a setting's key has now, with its default where it's absent. */
function valueOf(path: string, values: unknown, defaults: unknown): unknown {
  const v = getPath(values, path)
  return v === undefined ? getPath(defaults, path) : v
}

export function defaultsFor(def: SettingDef): unknown {
  const store = def.store ?? 'app'
  return store === 'app' ? APP_DEFAULTS : STORE_DEFAULTS[store]
}

/** The setting differs from its default (false for actions, information and unknown values). */
export function isChanged(def: SettingDef, values: unknown): boolean {
  if (!def.keys?.length || values == null) return false
  const defaults = defaultsFor(def)
  return def.keys.some((k) => !sameValue(valueOf(k, values, defaults), getPath(defaults, k)))
}

export function canReset(def: SettingDef): boolean {
  return !def.never && !!def.keys?.length
}

/**
 * A patch that sets `keys` (dotted paths) to their values in `from`, on top of
 * `current`. Top-level keys only, each whole (nested objects merged from
 * `current`), as the settings stores take them.
 */
export function patchFrom(
  keys: string[],
  from: unknown,
  current: Record<string, unknown>,
  defaults: unknown
): Record<string, unknown> {
  return patchOf(
    keys.map((k) => [k, from]),
    current,
    defaults
  )
}

/** Like patchFrom, each path with its own source of values. */
function patchOf(
  entries: [path: string, from: unknown][],
  current: Record<string, unknown>,
  defaults: unknown
): Record<string, unknown> {
  let next: Record<string, unknown> = {}
  for (const [path, from] of entries) {
    const top = path.split('.')[0]
    if (!(top in next)) {
      const cur = current[top]
      next[top] =
        cur && typeof cur === 'object' && !Array.isArray(cur)
          ? { ...(getPath(defaults, top) as object), ...(cur as object) }
          : cur
    }
    // A kept value that's absent gets no default invented for it.
    const v = keptPaths.has(path) ? getPath(from, path) : valueOf(path, from, defaults)
    // A kept value that was absent is sent as null (none), so the app clears it rather than keeping one set since.
    const kept = keptPaths.has(path) && v === undefined ? null : v
    next = setPath(next, path, kept === undefined ? undefined : structuredCopy(kept))
  }
  return next
}

/** Every path some setting keeps (see SettingDef.keeps). */
const keptPaths = new Set(SETTINGS.flatMap((d) => d.keeps ?? []))

function structuredCopy<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/** The patch that puts these settings back to their defaults. */
export function resetPatch(
  defs: SettingDef[],
  current: Record<string, unknown>
): Record<string, unknown> {
  const resettable = defs.filter(canReset)
  const keys = resettable.flatMap((d) => d.keys ?? [])
  const defaults = defs.length ? defaultsFor(defs[0]) : APP_DEFAULTS
  // What saving them would also change goes along as it is now (unless it's reset too).
  const kept = resettable.flatMap((d) => d.keeps ?? []).filter((k) => !keys.includes(k))
  return patchOf(
    [
      ...keys.map((k): [string, unknown] => [k, defaults]),
      ...kept.map((k): [string, unknown] => [k, current])
    ],
    current,
    defaults
  )
}

/** The patch that puts these settings back to what they were (`before`): an Undo. */
export function undoPatch(
  defs: SettingDef[],
  before: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const resettable = defs.filter(canReset)
  const keys = [...new Set(resettable.flatMap((d) => [...(d.keys ?? []), ...(d.keeps ?? [])]))]
  const defaults = defs.length ? defaultsFor(defs[0]) : APP_DEFAULTS
  return patchFrom(keys, before, current, defaults)
}

/** The phone's settings (only ones the phone may change, as the PC allows). */
export function phoneSettings(): SettingDef[] {
  const safe = new Set<string>(MOBILE_SAFE_SETTINGS)
  return SETTINGS.filter((d) => d.phone && (d.keys ?? []).every((k) => safe.has(k.split('.')[0])))
}

/**
 * The phone's own settings (only on that phone, or about it): not on the
 * desktop page, but found by the phone's search the same way.
 */
export const PHONE_LOCAL_SETTINGS: SettingDef[] = [
  {
    id: 'phone-local.theme',
    section: 'general',
    label: 'Theme',
    description: 'Only on this phone.',
    keywords: ['appearance', 'dark mode', 'light mode', 'colors']
  },
  {
    id: 'phone-local.push',
    section: 'alerts',
    label: 'Push alerts on this phone',
    description: 'Even when this app is closed.',
    keywords: ['push', 'notifications', 'mobile', 'test push']
  },
  {
    id: 'phone-local.device',
    section: 'phone',
    label: 'This phone',
    description: 'Its name, and whether it has full access or is read-only.',
    keywords: ['name', 'rename', 'device', 'paired', 'read-only', 'access']
  },
  {
    id: 'phone-local.ssh-key',
    section: 'phone',
    label: 'Send SSH key to PC',
    description: 'For terminal access: offer this phone’s public key.',
    keywords: ['ssh', 'terminal', 'public key', 'openssh', 'key']
  },
  {
    id: 'phone-local.unpair',
    section: 'phone',
    label: 'Unpair this phone',
    keywords: ['revoke', 'sign out', 'log out', 'disconnect', 'pair']
  },
  {
    id: 'phone-local.about',
    section: 'advanced',
    label: 'About',
    description: 'Version and the PC’s address.',
    keywords: ['version', 'address', 'host']
  }
]
