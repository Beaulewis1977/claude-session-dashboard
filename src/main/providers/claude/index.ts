// Claude Code as a provider: the existing Claude-format modules (shared/jsonl,
// shared/branch, shared/usage/parse, core/launch, the status line and hook
// bridges, …) behind the provider interface. Behaviour is exactly what the
// app did before providers existed.

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EFFORT_LEVELS } from '@shared/model-choice'
import { PROVIDER_CAPABILITIES } from '@shared/provider'
import { askQuestionOf } from '@shared/ask'
import { buildBranchFile, planBranch } from '@shared/branch'
import { analyzeEvents, buildMessages, isUuid, parseJsonl } from '@shared/jsonl'
import { parseHookEvent, parseRunningFile } from '@shared/live'
import { detectSource } from '@shared/source-label'
import { handoffPrompt, SUMMARY_MARKER } from '@shared/summary'
import { parseBridgePayload } from '@shared/usage/bridge'
import { analyzeUsage } from '@shared/usage/parse'
import { branchFilePath, writeNewSessionFile } from '../../core/branch-write'
import { buildLaunchCommand, claudeArgs, claudeCommandLine } from '../../core/launch'
import { envPaths } from '../../services/bridge'
import { detectSources } from '../../services/sources'
import type { SessionProvider } from '../types'
import { liveDirs } from './live'
import { isCoworkSessionFile, listCoworkFiles } from './desktop'
import {
  listSessionFiles,
  parseSessionText,
  projectDirOf,
  sessionFileOf,
  siblingSessionFile
} from './sessions'
import { listSubagentFiles, subagentArchiveDir } from './usage'

export const claudeProvider: SessionProvider = {
  id: 'claude',
  productName: 'Claude Code',
  capabilities: PROVIDER_CAPABILITIES.claude,
  effortLevels: EFFORT_LEVELS,

  async detectSources(platform, opts) {
    return (await detectSources(platform, opts)).map((s) => ({ ...s, provider: 'claude' }))
  },
  // Cowork: only each task home's `.claude/projects` (never its sign-in or other files).
  listSessionFiles: (src) =>
    src.cowork ? listCoworkFiles(src.projectsDir) : listSessionFiles(src.projectsDir),
  sessionFileOf,
  watchSpec: (src) =>
    src.cowork
      ? // Polled (no file watcher over the task homes' other files).
        { root: src.projectsDir, depth: 0, isSessionFile: isCoworkSessionFile, poll: true }
      : {
          root: src.projectsDir,
          depth: 1,
          isSessionFile: (path) => path.endsWith('.jsonl')
        },

  readText: (path) => readFile(path, 'utf8'),
  parseSession: parseSessionText,
  buildMessages: (text, base) => buildMessages(parseJsonl(text).events, base.cwd),
  searchText: (text) => analyzeEvents(parseJsonl(text).events).searchText,
  messageStarts: (text) =>
    buildMessages(parseJsonl(text).events)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && isUuid(m.id))
      .map((m) => ({ uuid: m.id, t: m.timestamp })),
  detectSource: (base, ctx) => detectSource(base.sourceHints, ctx),
  ownRunTitle(firstPrompt) {
    // The dashboard's own `claude -p` runs: Ask Claude by its question, summaries by name.
    const asked = askQuestionOf(firstPrompt)
    if (asked) return `Ask Claude: ${asked}`
    if (firstPrompt?.startsWith(SUMMARY_MARKER)) return 'Session summary (dashboard)'
    return undefined
  },

  archiveExt: '.jsonl',
  projectDirOf,

  launch: {
    // On Windows the absolute path is used; WSL finds `claude` on the login shell's PATH.
    cliMissing: (env, tools) => env === 'windows' && !tools.claude,
    buildCommand: buildLaunchCommand,
    commandLine: (i) =>
      claudeCommandLine(
        claudeArgs(
          i.sessionId,
          i.skipPermissions,
          i.fork,
          i.newSession,
          i.remoteControl,
          i.askPermissions === true,
          i.modelChoice,
          i.continueFresh
        )
      ),
    handoffPrompt,
    sessionFilePath: (s, sessionId) => siblingSessionFile(s.originalPath, sessionId)
  },

  branching: {
    projectDir: (s) => dirname(s.originalPath),
    filePath: branchFilePath,
    plan(text, at, mode) {
      const { events } = parseJsonl(text)
      const plan = planBranch(events, at, mode)
      if (!plan.ok) return plan
      return {
        ...plan,
        build: (newSessionId, parentSessionId) =>
          buildBranchFile(events, plan, newSessionId, parentSessionId)
      }
    },
    write: writeNewSessionFile
  },

  usage: {
    extraFiles: (s) => listSubagentFiles(s.filePath, s.sessionId),
    extrasArchiveDir: subagentArchiveDir,
    analyze: (text, ctx) => analyzeUsage(parseJsonl(text).events, ctx)
  },

  limits: {
    bridge(src) {
      const p = envPaths(src)
      return p ? { home: p.home, bridgeDir: p.bridgeDir } : undefined
    },
    parseReading: parseBridgePayload
  },

  live: {
    dirs: liveDirs,
    parseRunning: parseRunningFile,
    parseHook: parseHookEvent,
    hooksPossible: (src) => src.kind === 'auto' && !!src.claudeSettingsPath
  }
}
