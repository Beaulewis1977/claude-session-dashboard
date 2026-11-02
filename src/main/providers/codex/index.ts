// OpenAI Codex as a provider (docs/ROADMAP.md, feature 5, Phase B: sessions).
//
// Reads rollouts from every Codex home (Windows and each WSL user), plain or
// zstd-compressed, and the thread names in `session_index.jsonl`. Launches
// `codex resume <id>` / `codex fork <id>` in the session's folder. Never
// opens auth.json or any other file of the home, and never writes into it:
// there is no restore from the archive, no Branch from here, and no new
// session files. Usage and limits come in Phase C.

import { basename, dirname, join } from 'node:path'
import { CODEX_EFFORT_LEVELS } from '@shared/model-choice'
import { baseName } from '@shared/format'
import type { BaseSummary, SessionProvider } from '../types'
import { buildCodexLaunch, codexCommandLine } from './launch'
import { analyzeCodex, buildCodexMessages } from './parse'
import { readCodexText } from './read'
import {
  CodexNames,
  codexHomeOf,
  codexSessionFileOf,
  detectCodexSources,
  listCodexFiles
} from './sessions'
import { detectCodexSource } from './source'

const NO_BRANCH = "Branch from here isn't available for Codex sessions."

export function createCodexProvider(): SessionProvider {
  const names = new CodexNames()
  return {
    id: 'codex',
    productName: 'Codex',
    capabilities: {
      // `codex fork <id>`: a new session with the same history; the original stays as it is.
      fork: true,
      branch: false,
      continueFresh: false,
      remoteControl: false,
      apiBilling: false,
      newSession: false,
      summaries: false,
      usage: false,
      restore: false
    },
    effortLevels: CODEX_EFFORT_LEVELS,

    detectSources: (platform, opts) => detectCodexSources(platform, opts),
    listSessionFiles: (src) => listCodexFiles(codexHomeOf(src)),
    sessionFileOf: codexSessionFileOf,
    watchSpec: (src) => ({
      root: src.projectsDir,
      // sessions/YYYY/MM/DD/rollout-….jsonl
      depth: 3,
      isSessionFile: (path) => !!codexSessionFileOf(path)
    }),
    names: {
      get: (sourceId, sessionId) => names.get(sourceId, sessionId),
      refresh: (src) => names.refresh(src.id, codexHomeOf(src))
    },

    readText: (path) => readCodexText(path),
    parseSession(text, file, src) {
      const a = analyzeCodex(text, file.sessionId)
      const base: BaseSummary = {
        key: `${src.id}:${file.sessionId}`,
        sessionId: file.sessionId,
        sourceId: src.id,
        sourceLabel: src.label,
        env: src.env,
        distro: src.distro,
        filePath: file.path,
        originalPath: file.path,
        availability: 'live',
        projectDir: file.projectDir,
        projectName: baseName(a.cwd) || file.projectDir,
        cwd: a.cwd,
        gitBranch: a.gitBranch,
        version: a.version,
        firstPrompt: a.firstPrompt,
        startedAt: a.startedAt,
        lastActivityAt: a.lastActivityAt,
        messageCount: a.userMessageCount + a.assistantMessageCount,
        userMessageCount: a.userMessageCount,
        assistantMessageCount: a.assistantMessageCount,
        toolCallCount: a.toolCallCount,
        malformedLines: a.malformedLines,
        sizeBytes: file.size,
        models: a.models,
        ...(a.effort ? { reasoningEffort: a.effort } : {}),
        ...(a.subagent ? { subagent: a.subagent } : {}),
        ...(a.forkedFromId ? { forkedFromId: a.forkedFromId } : {}),
        ...(a.gitCommit ? { gitCommit: a.gitCommit } : {}),
        ...(a.gitRemote ? { gitRemote: a.gitRemote } : {}),
        origin: a.origin,
        ...(a.historyNote ? { historyNote: a.historyNote } : {})
      }
      return { base, searchText: a.searchText }
    },
    buildMessages: (text) => buildCodexMessages(text),
    searchText: (text) => analyzeCodex(text).searchText,
    // Codex message ids aren't shared between a thread and its forks the way
    // Claude Code's are; forks are linked by `forked_from_id` instead.
    messageStarts: () => [],
    detectSource: (base) => detectCodexSource(base),
    ownRunTitle: () => undefined,

    archiveExt: '.jsonl',
    archiveExtOf: (originalPath) => (originalPath.endsWith('.zst') ? '.jsonl.zst' : '.jsonl'),
    projectDirOf: (originalPath) => basename(dirname(originalPath)),

    launch: {
      cliMissing: (env, tools) => env === 'windows' && !tools.codex,
      buildCommand: buildCodexLaunch,
      commandLine: codexCommandLine,
      handoffPrompt: () => undefined,
      sessionFilePath: (s, sessionId) => join(dirname(s.originalPath), `${sessionId}.jsonl`)
    },

    branching: {
      projectDir: (s) => dirname(s.originalPath),
      filePath: (projectDir, sessionId) => join(projectDir, `${sessionId}.jsonl`),
      plan: () => ({ ok: false, error: NO_BRANCH }),
      write: async () => {
        throw new Error(NO_BRANCH)
      }
    },

    usage: {
      extraFiles: async () => [],
      extrasArchiveDir: (archivePath, sessionId) => join(dirname(archivePath), sessionId),
      analyze: () => ({ records: [], turns: [], limitHits: [], usageReadings: [] })
    }
  }
}

export const codexProvider = createCodexProvider()
