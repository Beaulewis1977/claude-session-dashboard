// Resume / Fork: restore a missing session file from the archive, check the
// working directory, then open a terminal running `claude --resume`.

import { join } from 'node:path'
import type {
  BranchPreview,
  LaunchOptions,
  LaunchPreview,
  LaunchResult,
  SessionSummary,
  TerminalPref
} from '@shared/types'
import {
  buildLaunchCommand,
  claudeArgs,
  cwdProblem,
  type LaunchCommand,
  type LaunchTools
} from '../core/launch'
import { restoreIfMissing } from '../core/restore'
import { isAbsoluteWindowsPath } from '../core/which'
import type { Platform } from '../platform'
import { BranchService } from './branches'
import type { SessionService } from './sessions'

/** API-credit launches (Phase 5). */
export interface LaunchBilling {
  /** Decrypted key for an API account (main process only). */
  keyFor(accountId: string): string | undefined
  /** "API · Personal credits", or undefined for an unknown account. */
  label(accountId: string): string | undefined
  /** "Subscription (Max 5x)". */
  subscriptionLabel(): string
  /** Called after a successful launch, to tag the session's billing. */
  launched(s: SessionSummary, opts: LaunchOptions, cwd: string): void
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
    private readonly billing?: LaunchBilling
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

  private command(
    s: SessionSummary,
    opts: LaunchOptions,
    cwd: string,
    terminal: TerminalPref,
    tools: LaunchTools,
    apiKey?: string
  ): LaunchCommand {
    return buildLaunchCommand({
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

  /** Just the `claude …` part, even when the full command can't be built. */
  private claudeCommand(s: SessionSummary, opts: LaunchOptions, cmd?: LaunchCommand): string {
    if (cmd) return cmd.claudeCommand
    try {
      return [
        'claude',
        ...claudeArgs(s.sessionId, opts.skipPermissions, opts.fork, opts.newSession)
      ].join(' ')
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
        launchError: error ?? folderError
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
      launchError: error ?? folderError
    }
  }

  async launch(opts: LaunchOptions): Promise<LaunchResult> {
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
    const cwd = opts.cwdOverride ?? s.cwd
    const tools = await this.platform.launchTools()
    // Create a branch without opening a terminal: the folder doesn't matter yet.
    if (opts.branch?.createOnly) {
      let created: SessionSummary
      try {
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
      apiKey = this.billing?.keyFor(opts.billingAccountId)
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
        created = await this.branches.create(s, opts.branch)
      } catch (err) {
        return fail((err as Error).message)
      }
      const res = await this.launch({
        ...opts,
        key: created.key,
        fork: false,
        newSession: false,
        branch: undefined
      })
      return { ...res, branch: this.sessions.get(created.key) ?? created }
    }

    let { terminal } = this.resolveTerminal(opts.terminal ?? this.defaultTerminal(), tools)
    let cmd: LaunchCommand
    try {
      cmd = this.command(s, opts, cwd, terminal, tools, apiKey)
    } catch (err) {
      return fail((err as Error).message)
    }

    // 1. Restore the original file from the archive if it's missing. Never overwrite.
    let restored = false
    if (!opts.newSession && !(await this.platform.pathExists(s.originalPath))) {
      const rec = this.sessions.archiveRecord(s.key)
      if (rec) {
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
      this.billing?.launched(s, opts, cwd)
      return { ok: true, restored, commandLine: cmd.commandLine, simulated: true }
    }
    try {
      await this.platform.spawnDetached(cmd)
    } catch (err) {
      if (terminal === 'wt' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        terminal = 'powershell'
        cmd = this.command(s, opts, cwd, terminal, tools, apiKey)
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
    this.billing?.launched(s, opts, cwd)
    return { ok: true, restored, commandLine: cmd.commandLine }
  }
}
