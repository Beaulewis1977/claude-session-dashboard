// Resume / Fork: restore a missing session file from the archive, check the
// working directory, then open a terminal running `claude --resume`.

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  BranchPreview,
  ContinueFreshPreview,
  ContinueFreshRequest,
  LaunchOptions,
  LaunchPreview,
  LaunchResult,
  SessionSummary,
  TerminalPref
} from '@shared/types'
import {
  buildLaunchCommand,
  buildShellCommand,
  claudeArgs,
  claudeCommandLine,
  cwdProblem,
  remoteControlName,
  REMOTE_CONTROL_API_ERROR,
  type ContinueFreshArgs,
  type LaunchCommand,
  type LaunchTools,
  type RemoteControl
} from '../core/launch'
import { restoreIfMissing } from '../core/restore'
import { handoffPath, writeHandoff } from '../core/handoff'
import { windowsPathToWsl } from '../core/wsl'
import { isUuid } from '@shared/jsonl'
import { buildHandoff, continuedName, handoffPrompt, newSinceSummary } from '@shared/summary'
import { resolveModelChoice, type ModelSettings, type ResolvedModel } from '@shared/model-choice'
import { fileExists, isAbsoluteWindowsPath } from '../core/which'
import type { Platform } from '../platform'
import { BranchService } from './branches'
import type { SessionService } from './sessions'

/** API-credit launches (Phase 5). */
export interface LaunchBilling {
  /** Decrypted key for an API account (main process only). */
  keyFor(accountId: string): string | undefined | Promise<string | undefined>
  /** "API · Personal credits", or undefined for an unknown account. */
  label(accountId: string): string | undefined
  /** "Subscription (Max 5x)". */
  subscriptionLabel(): string
  /** Called after a successful launch, to tag the session's billing (and Remote Control). */
  launched(s: SessionSummary, opts: LaunchOptions, cwd: string, ctx: LaunchContext): void
}

/** Who asked for a launch: the desktop app, or a paired phone (see mobile/). */
export interface LaunchContext {
  via: 'desktop' | 'phone'
  /** The phone's name. */
  device?: string
  /**
   * Asked again right before anything is written or started (a launch from a
   * phone waits on file checks): a reason to stop, or undefined to go on.
   */
  stillAllowed?: () => string | undefined
}

const DESKTOP: LaunchContext = { via: 'desktop' }

export const NO_SUMMARY =
  'Summarize this session first: Continue fresh starts the new session from its summary.'

interface ContinuePlan {
  preview: ContinueFreshPreview
  args: ContinueFreshArgs
  /** The new session, as far as it's known before Claude Code writes its file. */
  target: SessionSummary
}

export const CLAUDE_NOT_FOUND =
  "Claude Code wasn't found on this computer's PATH. Install it (or open a new terminal once after installing), then try again."

type CwdState = 'exists' | 'missing' | 'unreachable'

export class Launcher {
  readonly branches: BranchService

  constructor(
    private readonly platform: Platform,
    private readonly sessions: SessionService,
    private readonly defaultTerminal: () => TerminalPref,
    private readonly billing?: LaunchBilling,
    /** Settings → Resume defaults and per-project defaults for model / effort. */
    private readonly modelSettings: () => Partial<ModelSettings> = () => ({}),
    /** The app's data folder, for Continue fresh's handoff files (none: Continue fresh is off). */
    private readonly dataDir?: string
  ) {
    this.branches = new BranchService(sessions, (p) => platform.pathExists(p))
  }

  /**
   * Does the session's folder exist? WSL folders are checked through the
   * distro's file system; a distro that can't be reached can't be checked,
   * and then nothing is launched.
   */
  private async cwdState(s: SessionSummary, cwd: string): Promise<CwdState> {
    if (s.env === 'windows') return (await this.platform.pathExists(cwd)) ? 'exists' : 'missing'
    const known = this.sessions.source(s.sourceId)?.distroRoot
    const roots = known ? [known] : s.distro ? this.platform.distroRoots(s.distro) : []
    const parts = cwd.split('/').filter(Boolean)
    for (const root of roots)
      if (await this.platform.pathExists(join(root, ...parts))) return 'exists'
    for (const root of roots) if (await this.platform.pathExists(root)) return 'missing'
    return 'unreachable'
  }

  private unreachable(s: SessionSummary): string {
    return `Can't reach ${s.distro ? `WSL: ${s.distro}` : 'this WSL distro'} to check the folder. Start the distro, then try again.`
  }

  private resolveTerminal(
    requested: TerminalPref,
    tools: LaunchTools
  ): { terminal: TerminalPref; fellBack: boolean } {
    if (requested === 'wt' && !tools.wt) return { terminal: 'powershell', fellBack: true }
    return { terminal: requested, fellBack: false }
  }

  /**
   * Remote Control named after the session: my name for it (unless a newer
   * name was given in Claude Code), else its title.
   */
  private remoteControl(s: SessionSummary, opts: LaunchOptions): RemoteControl | undefined {
    if (!opts.remoteControl) return undefined
    const name = s.titleSource === 'claude-name' ? s.title : s.meta.name || s.title
    return { name: remoteControlName(name) }
  }

  /**
   * The model and effort for a launch: the session's own choice, else its
   * project's default, else Settings. Read here for every launch path
   * (desktop, phone, copied command), so they all match.
   */
  modelChoice(s: SessionSummary): ResolvedModel {
    return resolveModelChoice(s.meta, s, this.modelSettings())
  }

  private command(
    s: SessionSummary,
    opts: LaunchOptions,
    cwd: string,
    terminal: TerminalPref,
    tools: LaunchTools,
    apiKey?: string,
    continueFresh?: ContinueFreshArgs
  ): LaunchCommand {
    return buildLaunchCommand({
      continueFresh,
      remoteControl: this.remoteControl(s, opts),
      askPermissions: opts.askPermissions === true,
      modelChoice: this.modelChoice(s),
      env: s.env,
      distro: s.distro,
      sessionId: s.sessionId,
      cwd,
      fork: opts.fork,
      newSession: opts.newSession,
      skipPermissions: opts.skipPermissions,
      terminal,
      tools,
      // Only used to decide the terminal and env; never shown.
      apiKey: apiKey ?? (opts.billingAccountId ? 'sk-ant-api00-preview-placeholder' : undefined),
      wslenv: process.env.WSLENV
    })
  }

  /** The command to show, or why there is none. */
  private tryCommand(...args: Parameters<Launcher['command']>): {
    cmd?: LaunchCommand
    error?: string
  } {
    try {
      return { cmd: this.command(...args) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  /** A new session id that no session file or handoff uses yet (the one asked for, if free). */
  private async freeContinueId(
    s: SessionSummary,
    dataDir: string,
    wanted?: string
  ): Promise<string> {
    const dir = dirname(s.originalPath)
    // The handoff is in the app's own folder: checked directly, not through the platform.
    const free = async (id: string): Promise<boolean> =>
      !(await this.platform.pathExists(join(dir, `${id}.jsonl`))) &&
      !(await fileExists(handoffPath(dataDir, id)))
    if (wanted && isUuid(wanted) && (await free(wanted))) return wanted
    for (let i = 0; i < 20; i++) {
      const id = randomUUID()
      if (await free(id)) return id
    }
    throw new Error("Couldn't find a free id for the new session.")
  }

  /**
   * Continue fresh: the new session's id, its handoff file (where it goes and
   * what it says) and the first message pointing at it.
   */
  private async continuePlan(s: SessionSummary, req: ContinueFreshRequest): Promise<ContinuePlan> {
    const dataDir = this.dataDir
    if (!dataDir) throw new Error("Continue fresh isn't available here.")
    if (s.availability === 'imported')
      throw new Error(
        'Conversations imported from claude.ai can be read and searched, not continued.'
      )
    const summary = s.meta.aiSummary
    if (!summary) throw new Error(NO_SUMMARY)
    const id = await this.freeContinueId(s, dataDir, req.newSessionId)
    const path = handoffPath(dataDir, id)
    const sessionPath = s.env === 'wsl' ? windowsPathToWsl(path) : path
    const prompt = sessionPath ? handoffPrompt(sessionPath) : undefined
    if (!sessionPath || !prompt)
      throw new Error(
        "The app's data folder has characters in its path that can't be passed to Claude Code safely."
      )
    const addDir =
      prompt.mode === 'read'
        ? s.env === 'wsl'
          ? sessionPath.slice(0, sessionPath.lastIndexOf('/'))
          : dirname(path)
        : undefined
    const names = this.sessions
      .list()
      .map((x) => x.meta.name)
      .filter((n): n is string => !!n)
    const name = continuedName(s.title, names)
    const handoff = buildHandoff(
      {
        title: s.title,
        sessionId: s.sessionId,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        lastActivityAt: s.lastActivityAt,
        envLabel: s.sourceLabel
      },
      summary
    )
    const target: SessionSummary = {
      ...s,
      key: `${s.sourceId}:${id}`,
      sessionId: id,
      // Remote Control is named after the new session.
      meta: { ...s.meta, name }
    }
    return {
      preview: {
        newSessionId: id,
        handoffPath: path,
        sessionPath,
        mode: prompt.mode,
        handoff,
        newSince: newSinceSummary(summary, s.messageCount),
        name
      },
      args: { newSessionId: id, prompt: prompt.prompt, ...(addDir ? { addDir } : {}) },
      target
    }
  }

  /** Just the `claude …` part, even when the full command can't be built. */
  private claudeCommand(s: SessionSummary, opts: LaunchOptions, cmd?: LaunchCommand): string {
    if (cmd) return cmd.claudeCommand
    try {
      return claudeCommandLine(
        claudeArgs(
          s.sessionId,
          opts.skipPermissions,
          opts.fork,
          opts.newSession,
          this.remoteControl(s, opts),
          opts.askPermissions === true,
          this.modelChoice(s)
        )
      )
    } catch {
      return ''
    }
  }

  /** Shown in place of a missing folder, so the command can still be previewed. */
  private placeholderCwd(s: SessionSummary): string {
    if (s.env === 'wsl') return '~'
    const home = this.platform.windowsHome
    return isAbsoluteWindowsPath(home) ? home : 'C:\\'
  }

  private billingLabel(opts: LaunchOptions): string {
    if (!opts.billingAccountId) return this.billing?.subscriptionLabel() ?? 'Subscription'
    return this.billing?.label(opts.billingAccountId) ?? 'API key'
  }

  async preview(opts: LaunchOptions): Promise<LaunchPreview> {
    const s = this.sessions.get(opts.key)
    if (!s) throw new Error('Session not found')
    const cwd = opts.cwdOverride ?? s.cwd
    const tools = await this.platform.launchTools()
    const { terminal, fellBack } = this.resolveTerminal(
      opts.terminal ?? this.defaultTerminal(),
      tools
    )
    const state = cwd && !cwdProblem(s.env, cwd) ? await this.cwdState(s, cwd) : undefined
    const folderError = state === 'unreachable' ? this.unreachable(s) : undefined
    if (opts.branch) {
      // Branch from a message: the command resumes the new session that will be created.
      let branch: BranchPreview | undefined
      let branchError: string | undefined
      try {
        branch = await this.branches.preview(s, opts.branch)
      } catch (err) {
        branchError = (err as Error).message
      }
      const target = branch ? { ...s, sessionId: branch.newSessionId } : s
      const branchOpts = { ...opts, fork: false, newSession: false }
      const { cmd, error } = this.tryCommand(
        target,
        branchOpts,
        cwd ?? this.placeholderCwd(s),
        terminal,
        tools
      )
      return {
        commandLine: cmd?.commandLine ?? '',
        claudeCommand: this.claudeCommand(target, branchOpts, cmd),
        fellBack,
        cwd,
        cwdExists: state === 'exists',
        willRestore: false,
        restoreImpossible: false,
        originalPath: branch?.targetPath ?? s.originalPath,
        terminal: cmd?.terminal ?? terminal,
        terminalReason: cmd?.terminalReason,
        billingLabel: this.billingLabel(opts),
        branch,
        branchError,
        launchError: error ?? folderError,
        remoteControlName: this.remoteControl(
          branch ? { ...s, meta: { ...s.meta, name: s.meta.name || branch.name } } : s,
          opts
        )?.name,
        modelChoice: this.modelChoice(s)
      }
    }
    if (opts.continueFresh) {
      let plan: ContinuePlan | undefined
      let continueError: string | undefined
      try {
        plan = await this.continuePlan(s, opts.continueFresh)
      } catch (err) {
        continueError = (err as Error).message
      }
      const target = plan?.target ?? s
      const cOpts = { ...opts, fork: false, newSession: false }
      const built = plan
        ? this.tryCommand(
            target,
            cOpts,
            cwd ?? this.placeholderCwd(s),
            terminal,
            tools,
            undefined,
            plan.args
          )
        : {}
      return {
        commandLine: built.cmd?.commandLine ?? '',
        claudeCommand: built.cmd?.claudeCommand ?? '',
        fellBack,
        cwd,
        cwdExists: state === 'exists',
        willRestore: false,
        restoreImpossible: false,
        originalPath: s.originalPath,
        terminal: built.cmd?.terminal ?? terminal,
        terminalReason: built.cmd?.terminalReason,
        billingLabel: this.billingLabel(opts),
        continueFresh: plan?.preview,
        continueError,
        launchError: built.error ?? folderError,
        remoteControlName: this.remoteControl(target, opts)?.name,
        modelChoice: this.modelChoice(s)
      }
    }
    const originalExists = await this.platform.pathExists(s.originalPath)
    const record = this.sessions.archiveRecord(s.key)
    const { cmd, error } = this.tryCommand(s, opts, cwd ?? this.placeholderCwd(s), terminal, tools)
    return {
      commandLine: cmd?.commandLine ?? '',
      claudeCommand: this.claudeCommand(s, opts, cmd),
      fellBack,
      cwd,
      cwdExists: state === 'exists',
      willRestore: !opts.newSession && !originalExists && !!record,
      restoreImpossible:
        !opts.newSession && !originalExists && !record && s.availability !== 'source-offline',
      originalPath: s.originalPath,
      terminal: cmd?.terminal ?? terminal,
      terminalReason: cmd?.terminalReason,
      billingLabel: this.billingLabel(opts),
      launchError: error ?? folderError,
      remoteControlName: this.remoteControl(s, opts)?.name,
      modelChoice: this.modelChoice(s)
    }
  }

  /**
   * "Open terminal here": a plain shell (no Claude) in the session's folder,
   * in the terminal chosen in Settings. Desktop only.
   */
  async openShell(key: string): Promise<LaunchResult> {
    const fail = (error: string): LaunchResult => ({
      ok: false,
      restored: false,
      commandLine: '',
      error
    })
    const s = this.sessions.get(key)
    if (!s) return fail('Session not found')
    if (s.availability === 'imported')
      return fail('Conversations imported from claude.ai have no folder on this PC.')
    const cwd = s.cwd
    if (!cwd) return fail('No working directory is recorded for this session.')
    const problem = cwdProblem(s.env, cwd)
    if (problem) return fail(problem)
    const state = await this.cwdState(s, cwd)
    if (state === 'unreachable') return fail(this.unreachable(s))
    if (state === 'missing') return fail(`The folder no longer exists: ${cwd}`)
    const tools = await this.platform.launchTools()
    let { terminal } = this.resolveTerminal(this.defaultTerminal(), tools)
    const build = (): LaunchCommand =>
      buildShellCommand({ env: s.env, cwd, distro: s.distro, terminal, tools })
    let cmd: LaunchCommand
    try {
      cmd = build()
    } catch (err) {
      return fail((err as Error).message)
    }
    if (!this.platform.canLaunch)
      return { ok: true, restored: false, commandLine: cmd.commandLine, simulated: true }
    try {
      await this.platform.spawnDetached(cmd)
    } catch (err) {
      if (terminal !== 'wt' || (err as NodeJS.ErrnoException).code !== 'ENOENT')
        return { ...fail(String((err as Error).message)), commandLine: cmd.commandLine }
      terminal = 'powershell'
      cmd = build()
      try {
        await this.platform.spawnDetached(cmd)
      } catch (err2) {
        return { ...fail(String((err2 as Error).message)), commandLine: cmd.commandLine }
      }
    }
    return { ok: true, restored: false, commandLine: cmd.commandLine }
  }

  async launch(opts: LaunchOptions, ctx: LaunchContext = DESKTOP): Promise<LaunchResult> {
    const s = this.sessions.get(opts.key)
    if (!s) return { ok: false, restored: false, commandLine: '', error: 'Session not found' }
    if (s.availability === 'imported')
      return {
        ok: false,
        restored: false,
        commandLine: '',
        error: 'Conversations imported from claude.ai can be read and searched, but not resumed.'
      }
    const fail = (error: string, restored = false): LaunchResult => ({
      ok: false,
      restored,
      commandLine: '',
      error
    })
    if (opts.remoteControl && opts.billingAccountId) return fail(REMOTE_CONTROL_API_ERROR)
    const cwd = opts.cwdOverride ?? s.cwd
    const tools = await this.platform.launchTools()
    // Create a branch without opening a terminal: the folder doesn't matter yet.
    if (opts.branch?.createOnly) {
      let created: SessionSummary
      try {
        const stop = ctx.stillAllowed?.()
        if (stop) return fail(`Not launched: ${stop}.`)
        created = await this.branches.create(s, opts.branch)
      } catch (err) {
        return fail((err as Error).message)
      }
      const { terminal } = this.resolveTerminal(opts.terminal ?? this.defaultTerminal(), tools)
      const { cmd } = this.tryCommand(
        created,
        { ...opts, fork: false },
        cwd ?? this.placeholderCwd(s),
        terminal,
        tools
      )
      return { ok: true, restored: false, commandLine: cmd?.commandLine ?? '', branch: created }
    }
    if (!cwd) return fail('No working directory is recorded for this session.')
    const problem = cwdProblem(s.env, cwd)
    if (problem) return fail(problem)
    const state = await this.cwdState(s, cwd)
    if (state === 'unreachable') return fail(this.unreachable(s))
    if (state === 'missing') return fail(`The folder no longer exists: ${cwd}`)
    if (s.env === 'windows' && !tools.claude) return fail(CLAUDE_NOT_FOUND)

    // API billing: the key, decrypted only now and passed only to the child process.
    let apiKey: string | undefined
    if (opts.billingAccountId) {
      apiKey = await this.billing?.keyFor(opts.billingAccountId)
      if (!apiKey && this.platform.canLaunch) {
        return fail(
          "The API key for this account isn't available. Add it again in Settings → Accounts."
        )
      }
    }

    // Branch from a message: create the new session file, then resume that one.
    if (opts.branch) {
      let created: SessionSummary
      try {
        const stop = ctx.stillAllowed?.()
        if (stop) return fail(`Not launched: ${stop}.`)
        created = await this.branches.create(s, opts.branch)
      } catch (err) {
        return fail((err as Error).message)
      }
      const res = await this.launch(
        {
          ...opts,
          key: created.key,
          fork: false,
          newSession: false,
          branch: undefined
        },
        ctx
      )
      return { ...res, branch: this.sessions.get(created.key) ?? created }
    }

    // Continue fresh: a new session (its id picked now) that starts from the summary.
    let cont: ContinuePlan | undefined
    if (opts.continueFresh) {
      try {
        cont = await this.continuePlan(s, opts.continueFresh)
      } catch (err) {
        return fail((err as Error).message)
      }
      opts = { ...opts, fork: false, newSession: false, branch: undefined }
    }
    const target = cont?.target ?? s

    let { terminal } = this.resolveTerminal(opts.terminal ?? this.defaultTerminal(), tools)
    let cmd: LaunchCommand
    try {
      cmd = this.command(target, opts, cwd, terminal, tools, apiKey, cont?.args)
    } catch (err) {
      return fail((err as Error).message)
    }
    const continued = cont ? { continuedKey: cont.target.key } : {}

    // 1. Restore the original file from the archive if it's missing. Never overwrite.
    let restored = false
    if (!opts.newSession && !cont && !(await this.platform.pathExists(s.originalPath))) {
      const rec = this.sessions.archiveRecord(s.key)
      if (rec) {
        const stop = ctx.stillAllowed?.()
        if (stop) return fail(`Not launched: ${stop}.`)
        const outcome = await restoreIfMissing(rec.archivePath, rec.originalPath)
        restored = outcome === 'restored'
        if (outcome === 'archive-missing')
          return fail('The archive copy of this session is missing.', restored)
        if (restored) void this.sessions.fileChanged(s.sourceId, rec.originalPath)
      } else if (s.availability !== 'source-offline') {
        return fail('The session file is missing and there is no archive copy.', restored)
      }
    }

    // 2. Launch.
    if (!this.platform.canLaunch) {
      if (!cont) this.billing?.launched(s, opts, cwd, ctx)
      return { ok: true, restored, commandLine: cmd.commandLine, simulated: true, ...continued }
    }
    const stop = ctx.stillAllowed?.()
    if (stop)
      return { ok: false, restored, commandLine: cmd.commandLine, error: `Not launched: ${stop}.` }
    if (cont) {
      // A new file only: never overwrites (a clash means another id next time).
      try {
        await writeHandoff(this.dataDir!, cont.preview.newSessionId, cont.preview.handoff)
      } catch (err) {
        return {
          ...fail(
            (err as NodeJS.ErrnoException).code === 'EEXIST'
              ? 'A handoff for this new session already exists. Try again.'
              : `Couldn't write the handoff file: ${(err as Error).message}`
          ),
          commandLine: cmd.commandLine
        }
      }
    }
    try {
      await this.platform.spawnDetached(cmd)
    } catch (err) {
      if (terminal === 'wt' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        terminal = 'powershell'
        cmd = this.command(target, opts, cwd, terminal, tools, apiKey, cont?.args)
        // The first attempt took time: ask again before the second.
        const again = ctx.stillAllowed?.()
        if (again)
          return {
            ok: false,
            restored,
            commandLine: cmd.commandLine,
            error: `Not launched: ${again}.`
          }
        try {
          await this.platform.spawnDetached(cmd)
        } catch (err2) {
          return {
            ok: false,
            restored,
            commandLine: cmd.commandLine,
            error: String((err2 as Error).message)
          }
        }
      } else {
        return {
          ok: false,
          restored,
          commandLine: cmd.commandLine,
          error: String((err as Error).message)
        }
      }
    }
    if (cont) {
      // Where the new session came from (the app's metadata only), named and
      // with the parent's own model / effort, before Claude Code writes its file.
      this.sessions.recordBranch(
        cont.target.sessionId,
        {
          parentSessionId: s.sessionId,
          parentKey: s.key,
          via: 'continue',
          createdAt: new Date().toISOString()
        },
        cont.preview.name,
        { model: s.meta.model, effort: s.meta.effort }
      )
    }
    this.billing?.launched(target, opts, cwd, ctx)
    return { ok: true, restored, commandLine: cmd.commandLine, ...continued }
  }
}
