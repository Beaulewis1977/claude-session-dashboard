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
import { buildLaunchCommand, type LaunchCommand } from '../core/launch'
import { restoreIfMissing } from '../core/restore'
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

  /** Host path for checking a session's cwd (WSL paths go through the distro root). */
  private hostPath(s: SessionSummary, cwd: string): string | undefined {
    if (s.env === 'windows') return cwd
    const root = this.sessions.source(s.sourceId)?.distroRoot
    return root ? join(root, ...cwd.split('/').filter(Boolean)) : undefined
  }

  private async cwdExists(s: SessionSummary, cwd: string | undefined): Promise<boolean> {
    if (!cwd) return false
    const host = this.hostPath(s, cwd)
    // A stopped distro can't be checked from Windows; let WSL report it.
    if (!host) return true
    return this.platform.pathExists(host)
  }

  private async resolveTerminal(
    requested: TerminalPref
  ): Promise<{ terminal: TerminalPref; fellBack: boolean }> {
    if (requested === 'wt' && !(await this.platform.hasWindowsTerminal())) {
      return { terminal: 'powershell', fellBack: true }
    }
    return { terminal: requested, fellBack: false }
  }

  private command(
    s: SessionSummary,
    opts: LaunchOptions,
    cwd: string,
    terminal: TerminalPref,
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
      // Only used to decide the terminal and env; never shown.
      apiKey: apiKey ?? (opts.billingAccountId ? 'sk-ant-api00-preview-placeholder' : undefined),
      wslenv: process.env.WSLENV
    })
  }

  private billingLabel(opts: LaunchOptions): string {
    if (!opts.billingAccountId) return this.billing?.subscriptionLabel() ?? 'Subscription'
    return this.billing?.label(opts.billingAccountId) ?? 'API key'
  }

  async preview(opts: LaunchOptions): Promise<LaunchPreview> {
    const s = this.sessions.get(opts.key)
    if (!s) throw new Error('Session not found')
    const cwd = opts.cwdOverride ?? s.cwd
    const { terminal, fellBack } = await this.resolveTerminal(
      opts.terminal ?? this.defaultTerminal()
    )
    if (opts.branch) {
      // Branch from a message: the command resumes the new session that will be created.
      let branch: BranchPreview | undefined
      let branchError: string | undefined
      try {
        branch = await this.branches.preview(s, opts.branch)
      } catch (err) {
        branchError = (err as Error).message
      }
      const cmd = this.command(
        branch ? { ...s, sessionId: branch.newSessionId } : s,
        { ...opts, fork: false, newSession: false },
        cwd ?? (s.env === 'wsl' ? '~' : '.'),
        terminal
      )
      return {
        commandLine: cmd.commandLine,
        claudeCommand: cmd.claudeCommand,
        fellBack,
        cwd,
        cwdExists: await this.cwdExists(s, cwd),
        willRestore: false,
        restoreImpossible: false,
        originalPath: branch?.targetPath ?? s.originalPath,
        terminal: cmd.terminal,
        terminalReason: cmd.terminalReason,
        billingLabel: this.billingLabel(opts),
        branch,
        branchError
      }
    }
    const originalExists = await this.platform.pathExists(s.originalPath)
    const record = this.sessions.archiveRecord(s.key)
    const cmd = this.command(s, opts, cwd ?? (s.env === 'wsl' ? '~' : '.'), terminal)
    return {
      commandLine: cmd.commandLine,
      claudeCommand: cmd.claudeCommand,
      fellBack,
      cwd,
      cwdExists: await this.cwdExists(s, cwd),
      willRestore: !opts.newSession && !originalExists && !!record,
      restoreImpossible:
        !opts.newSession && !originalExists && !record && s.availability !== 'source-offline',
      originalPath: s.originalPath,
      terminal: cmd.terminal,
      terminalReason: cmd.terminalReason,
      billingLabel: this.billingLabel(opts)
    }
  }

  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    const s = this.sessions.get(opts.key)
    if (!s) return { ok: false, restored: false, commandLine: '', error: 'Session not found' }
    const cwd = opts.cwdOverride ?? s.cwd
    // Create a branch without opening a terminal: the folder doesn't matter yet.
    if (opts.branch?.createOnly) {
      try {
        const created = await this.branches.create(s, opts.branch)
        const { terminal } = await this.resolveTerminal(opts.terminal ?? this.defaultTerminal())
        const cmd = this.command(
          created,
          { ...opts, fork: false },
          cwd ?? (s.env === 'wsl' ? '~' : '.'),
          terminal
        )
        return { ok: true, restored: false, commandLine: cmd.commandLine, branch: created }
      } catch (err) {
        return { ok: false, restored: false, commandLine: '', error: (err as Error).message }
      }
    }
    if (!cwd)
      return {
        ok: false,
        restored: false,
        commandLine: '',
        error: 'No working directory is recorded for this session.'
      }
    if (!(await this.cwdExists(s, cwd))) {
      return {
        ok: false,
        restored: false,
        commandLine: '',
        error: `The folder no longer exists: ${cwd}`
      }
    }

    // API billing: the key, decrypted only now and passed only to the child process.
    let apiKey: string | undefined
    if (opts.billingAccountId) {
      apiKey = this.billing?.keyFor(opts.billingAccountId)
      if (!apiKey && this.platform.canLaunch) {
        return {
          ok: false,
          restored: false,
          commandLine: '',
          error:
            "The API key for this account isn't available. Add it again in Settings → Accounts."
        }
      }
    }

    // Branch from a message: create the new session file, then resume that one.
    if (opts.branch) {
      let created: SessionSummary
      try {
        created = await this.branches.create(s, opts.branch)
      } catch (err) {
        return { ok: false, restored: false, commandLine: '', error: (err as Error).message }
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

    // 1. Restore the original file from the archive if it's missing. Never overwrite.
    let restored = false
    if (!opts.newSession && !(await this.platform.pathExists(s.originalPath))) {
      const rec = this.sessions.archiveRecord(s.key)
      if (rec) {
        const outcome = await restoreIfMissing(rec.archivePath, rec.originalPath)
        restored = outcome === 'restored'
        if (outcome === 'archive-missing') {
          return {
            ok: false,
            restored,
            commandLine: '',
            error: 'The archive copy of this session is missing.'
          }
        }
        if (restored) void this.sessions.fileChanged(s.sourceId, rec.originalPath)
      } else if (s.availability !== 'source-offline') {
        return {
          ok: false,
          restored,
          commandLine: '',
          error: 'The session file is missing and there is no archive copy.'
        }
      }
    }

    // 2. Launch.
    let { terminal } = await this.resolveTerminal(opts.terminal ?? this.defaultTerminal())
    let cmd = this.command(s, opts, cwd, terminal, apiKey)
    if (!this.platform.canLaunch) {
      this.billing?.launched(s, opts, cwd)
      return { ok: true, restored, commandLine: cmd.commandLine, simulated: true }
    }
    try {
      await this.platform.spawnDetached(cmd)
    } catch (err) {
      if (terminal === 'wt' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        terminal = 'powershell'
        cmd = this.command(s, opts, cwd, terminal, apiKey)
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
