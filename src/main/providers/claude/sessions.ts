// Claude Code's session files: `<projects>/<encoded project>/<session-id>.jsonl`,
// one JSON event per line (see shared/jsonl.ts).

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { analyzeEvents, isUuid, parseJsonl } from '@shared/jsonl'
import { analyzeContext } from '@shared/context'
import { claudeGitSignals } from '@shared/git/claude-signals'
import type { SessionGitSignals } from '@shared/git/types'
import { baseName } from '@shared/format'
import type { BaseSummary, SessionFile, SourceRef } from '../types'

export const SESSION_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.jsonl$/i

/** A session file's id and project folder, or undefined if the path isn't one. */
export function sessionFileOf(path: string): { sessionId: string; projectDir: string } | undefined {
  const name = basename(path)
  if (!SESSION_FILE_RE.test(name)) return undefined
  return { sessionId: name.slice(0, -6), projectDir: basename(join(path, '..')) }
}

/** Lists `<projectsDir>/<project>/<session>.jsonl`. Undefined if the folder can't be read. */
export async function listSessionFiles(projectsDir: string): Promise<SessionFile[] | undefined> {
  const out: SessionFile[] = []
  let projects
  try {
    projects = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const dir = join(projectsDir, p.name)
    let files
    try {
      files = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !SESSION_FILE_RE.test(f.name)) continue
      const path = join(dir, f.name)
      try {
        const st = await stat(path)
        out.push({
          path,
          projectDir: p.name,
          sessionId: f.name.slice(0, -6),
          size: st.size,
          mtimeMs: st.mtimeMs
        })
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out
}

/** The encoded project folder an archived session was in. */
export function projectDirOf(originalPath: string): string {
  return basename(join(originalPath, '..'))
}

/** The file a session with this id would have, in the same project folder. */
export function siblingSessionFile(sessionPath: string, sessionId: string): string {
  return join(dirname(sessionPath), `${sessionId}.jsonl`)
}

export function parseSessionText(
  text: string,
  file: Omit<SessionFile, 'mtimeMs'>,
  src: SourceRef
): { base: BaseSummary; searchText: string; git: SessionGitSignals } {
  const { events, malformedLines } = parseJsonl(text)
  const a = analyzeEvents(events, { sessionId: file.sessionId })
  const context = analyzeContext(events)
  return {
    searchText: a.searchText,
    git: claudeGitSignals(events, file.sessionId),
    base: {
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
      summary: a.summary,
      claudeName: a.claudeName,
      claudeNameAt: a.claudeNameAt,
      firstPrompt: a.firstPrompt,
      startedAt: a.startedAt,
      lastActivityAt: a.lastActivityAt,
      messageCount: a.userMessageCount + a.assistantMessageCount,
      userMessageCount: a.userMessageCount,
      assistantMessageCount: a.assistantMessageCount,
      toolCallCount: a.toolCallCount,
      malformedLines,
      sizeBytes: file.size,
      models: a.models,
      firstUuid: a.firstUuid,
      forkedFrom: a.forkedFrom,
      copiedFrom:
        a.sessionId && a.sessionId !== file.sessionId && isUuid(a.sessionId)
          ? a.sessionId
          : undefined,
      sourceHints: a.sourceHints,
      remoteUrl: a.remoteUrl,
      remoteUrlAt: a.remoteUrlAt,
      ...(context ? { context } : {})
    }
  }
}
