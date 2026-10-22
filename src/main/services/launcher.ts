// Resume / Fork: restore a missing session file from the archive, check the
// working directory, then open a terminal running `claude --resume`.

import { join } from 'node:path'
import type {
  LaunchOptions,
  LaunchPreview,
  LaunchResult,
  SessionSummary,
  TerminalPref
} from '@shared/types'
import { buildLaunchCommand, type LaunchCommand } from '../core/launch'
import { restoreIfMissing } from '../core/restore'
import type { Platform } from '../platform'
import type { SessionService } from './sessions'

export class Launcher {
  constructor(
    private readonly platform: Platform,
    private readonly sessions: SessionService,
    private readonly defaultTerminal: () => TerminalPref
  ) {}

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
    terminal: TerminalPref
  ): LaunchCommand {
    return buildLaunchCommand({
      env: s.env,
      distro: s.distro,
      sessionId: s.sessionId,
      cwd,
      fork: opts.fork,
      skipPermissions: opts.skipPermissions,
      terminal
    })
  }

  async preview(opts: LaunchOptions): Promise<LaunchPreview> {
    const s = this.sessions.get(opts.key)
    if (!s) throw new Error('Session not found')
    const cwd = opts.cwdOverride ?? s.cwd
    const { terminal, fellBack } = await this.resolveTerminal(
      opts.terminal ?? this.defaultTerminal()
    )
    const originalExists = await this.platform.pathExists(s.originalPath)
    const record = this.sessions.archiveRecord(s.key)
    const cmd = this.command(s, opts, cwd ?? (s.env === 'wsl' ? '~' : '.'), terminal)
    return {
      commandLine: cmd.commandLine,
      claudeCommand: cmd.claudeCommand,
      terminal,
      fellBack,
      cwd,
      cwdExists: await this.cwdExists(s, cwd),
      willRestore: !originalExists && !!record,
      restoreImpossible: !originalExists && !record && s.availability !== 'source-offline',
      originalPath: s.originalPath
    }
  }

  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    const s = this.sessions.get(opts.key)
    if (!s) return { ok: false, restored: false, commandLine: '', error: 'Session not found' }
    const cwd = opts.cwdOverride ?? s.cwd
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

    // 1. Restore the original file from the archive if it's missing. Never overwrite.
    let restored = false
    if (!(await this.platform.pathExists(s.originalPath))) {
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
    let cmd = this.command(s, opts, cwd, terminal)
    if (!this.platform.canLaunch) {
      return { ok: true, restored, commandLine: cmd.commandLine, simulated: true }
    }
    try {
      await this.platform.spawnDetached(cmd)
    } catch (err) {
      if (terminal === 'wt' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        terminal = 'powershell'
        cmd = this.command(s, opts, cwd, terminal)
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
    return { ok: true, restored, commandLine: cmd.commandLine }
  }
}
