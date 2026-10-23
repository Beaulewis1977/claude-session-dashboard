// "Branch from here": plan a cut at a message and create the new session file.

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildBranchFile, branchName, planBranch, type BranchPlanOk } from '@shared/branch'
import { isUuid, parseJsonl } from '@shared/jsonl'
import type { BranchPreview, BranchRequest, SessionSummary } from '@shared/types'
import { branchFilePath, writeNewSessionFile } from '../core/branch-write'
import type { SessionService } from './sessions'

export class BranchError extends Error {}

export class BranchService {
  constructor(
    private readonly sessions: SessionService,
    private readonly pathExists: (p: string) => Promise<boolean>
  ) {}

  /** The project folder the new file goes into: the same one as the original session. */
  projectDir(s: SessionSummary): string {
    return dirname(s.originalPath)
  }

  private async plan(
    s: SessionSummary,
    req: BranchRequest
  ): Promise<BranchPlanOk & { events: ReturnType<typeof parseJsonl>['events'] }> {
    let text: string
    try {
      text = await readFile(s.filePath, 'utf8')
    } catch {
      throw new BranchError("This session's file can't be read right now.")
    }
    const { events } = parseJsonl(text)
    const plan = planBranch(events, req.at, req.mode)
    if (!plan.ok) throw new BranchError(plan.error)
    return { ...plan, events }
  }

  private writable(s: SessionSummary): void {
    if (s.availability === 'imported')
      throw new BranchError(
        'Conversations imported from claude.ai can be read and searched, but not resumed or branched.'
      )
    const src = this.sessions.source(s.sourceId)
    if (!src || src.status !== 'ok')
      throw new BranchError(
        `${s.sourceLabel} can't be written to right now${s.env === 'wsl' ? ' (is the distro running?)' : ''}.`
      )
  }

  private async freeId(s: SessionSummary, wanted?: string): Promise<string> {
    const dir = this.projectDir(s)
    if (wanted && isUuid(wanted) && !(await this.pathExists(branchFilePath(dir, wanted))))
      return wanted
    for (;;) {
      const id = randomUUID()
      if (!(await this.pathExists(branchFilePath(dir, id)))) return id
    }
  }

  private defaultName(s: SessionSummary): string {
    const names = this.sessions
      .list()
      .map((x) => x.meta.name)
      .filter((n): n is string => !!n)
    return branchName(s.title, names)
  }

  async preview(s: SessionSummary, req: BranchRequest): Promise<BranchPreview> {
    this.writable(s)
    const plan = await this.plan(s, req)
    const newSessionId = await this.freeId(s, req.newSessionId)
    return {
      newSessionId,
      targetPath: branchFilePath(this.projectDir(s), newSessionId),
      atMessageId: plan.atMessageId,
      atRole: plan.atRole,
      atPreview: plan.atPreview,
      atTime: plan.atTime,
      snapped: plan.snapped,
      snapTools: plan.snapTools,
      keptMessages: plan.keptMessages,
      totalMessages: plan.totalMessages,
      name: this.defaultName(s)
    }
  }

  /** Write the new session file, add it to the catalogue and record where it came from. */
  async create(s: SessionSummary, req: BranchRequest): Promise<SessionSummary> {
    this.writable(s)
    const plan = await this.plan(s, req)
    const name = this.defaultName(s)
    let id = await this.freeId(s, req.newSessionId)
    let path: string
    try {
      path = await writeNewSessionFile(
        this.projectDir(s),
        id,
        buildBranchFile(plan.events, plan, id, s.sessionId)
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Appeared in the meantime: never overwrite, pick another id.
      id = await this.freeId(s)
      path = await writeNewSessionFile(
        this.projectDir(s),
        id,
        buildBranchFile(plan.events, plan, id, s.sessionId)
      )
    }
    const created = await this.sessions.loadNew(s.sourceId, path)
    if (!created) throw new BranchError('The branch was created but could not be read back.')
    this.sessions.recordBranch(
      id,
      {
        parentSessionId: s.sessionId,
        parentKey: s.key,
        via: 'app',
        atMessageId: plan.atMessageId,
        atPreview: plan.atPreview,
        ...(plan.snapped !== 'none' ? { snapped: plan.snapped } : {}),
        createdAt: new Date().toISOString()
      },
      name
    )
    return this.sessions.get(created.key) ?? created
  }
}
