// OpenAI Codex as a provider (docs/ROADMAP.md, feature 5, Phase B: sessions).
//
// Reads rollouts from every Codex home (Windows and each WSL user), plain or
// zstd-compressed, and the thread names in `session_index.jsonl`. Launches
// `codex resume <id>` / `codex fork <id>` in the session's folder. Never
// opens auth.json or any other file of the home, and never writes into it:
// there is no restore from the archive, no Branch from here, and no new
// session files. Usage and limits come in Phase C.

import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CODEX_EFFORT_LEVELS } from '@shared/model-choice'
import { parseWslUnc } from '../../core/wsl'
import { PROVIDER_CAPABILITIES } from '@shared/provider'
import { baseName } from '@shared/format'
import type { BaseSummary, SessionProvider } from '../types'
import { buildCodexLaunch, codexCommandLine } from './launch'
import { analyzeCodex, buildCodexMessages } from './parse'
import { readBytesOf, readCodexText } from './read'
import { CACHE_FROM_BYTES, type CompactTextCache } from './text-cache'
import {
  CodexNames,
  codexHomeOf,
  codexSessionFileOf,
  detectCodexSources,
  listCodexFiles
} from './sessions'
import { detectCodexSource } from './source'

const NO_BRANCH = "Branch from here isn't available for Codex sessions."

export function createCodexProvider(opts: { textCache?: CompactTextCache } = {}): SessionProvider {
  const names = new CodexNames()
  const cache = opts.textCache
  return {
    id: 'codex',
    productName: 'Codex',
    // `codex fork <id>`: a new session with the same history; the original stays as it is.
    capabilities: PROVIDER_CAPABILITIES.codex,
    effortLevels: CODEX_EFFORT_LEVELS,
    // 2: tag-wrapped context isn't a prompt. 3: big rollouts' text is cached. 4: content size
    // (archive across compression). 5: message text kept whole; only snake_case tags are context.
    // 6: re-read big rollouts whose cached text an older reader cut (see COMPACT_FORMAT), and
    // only Codex's own context tags count as injected. 7: hidden context kept short, legacy
    // and newer messages matched one by one, search covers prompts and answers first.
    parseVersion: 7,

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

    async readText(path, purpose) {
      // A big rollout read before: its compact text, unless the file changed.
      const hit = await cache?.get(path)
      if (hit) return hit
      const st = cache ? await stat(path).catch(() => undefined) : undefined
      // With a cache, read to the end so the next look is quick; else stop early when viewing.
      const text = await readCodexText(path, undefined, { partial: purpose === 'view' && !cache })
      if (cache && st && readBytesOf(text) >= CACHE_FROM_BYTES)
        await cache.put(path, st.size, st.mtimeMs, text).catch(() => undefined)
      return text
    },
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
        ...(a.historyNote ? { historyNote: a.historyNote } : {}),
        ...(a.searchPartial ? { searchPartial: true } : {}),
        ...(a.contentBytes !== undefined ? { contentBytes: a.contentBytes } : {})
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
      // The session's own Codex home, always set as CODEX_HOME: a CODEX_HOME the app
      // (or a WSL login profile) already has could point at another home. WSL also runs
      // as the home's user (whose ~/.codex it is, and whose files those are).
      target(src) {
        const home = codexHomeOf(src)
        if (src.env === 'wsl') {
          const unc = parseWslUnc(home)
          const agentEnv = unc ? { agentEnv: { CODEX_HOME: unc.linuxPath } } : {}
          return src.kind !== 'custom' && src.user ? { wslUser: src.user, ...agentEnv } : agentEnv
        }
        return { agentEnv: { CODEX_HOME: home } }
      },
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
