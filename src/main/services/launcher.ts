// Resume / Fork: restore a missing session file from the archive, check the
// working directory, then open a terminal running `claude --resume`.

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  BranchPreview,
  ContinueFreshPreview,
  ContinueFreshRequest,
  LaunchOptions,
  LaunchPlacement,
  LaunchPreview,
  LaunchResult,
  SessionSummary,
  TerminalPref
} from '@shared/types'
import {
  buildShellCommand,
  cwdProblem,
  remoteControlName,
  REMOTE_CONTROL_API_ERROR,
  type ContinueFreshArgs,
  type LaunchCommand,
  type LaunchInput,
  type LaunchTools,
  type RemoteControl
} from '../core/launch'
import {
  isInfrastructureDistro,
  isLinuxPath,
  isValidDistroName,
  isWindowsPath,
  linuxToUnc,
  mntToWindows,
  wslRoots
} from '../core/wsl'

/**
 * Why place() can't launch it, unless a folder was chosen in the dialog for a
 * folder it couldn't confirm (then that folder is used).
 */
function placeError(
  placed: { placement?: LaunchPlacement; error?: string },
  opts: Pick<LaunchOptions, 'cwdOverride'>
): string | undefined {
  return placed.placement?.needsFolder && opts.cwdOverride ? undefined : placed.error
}

/** `\\server\share\…` or `\\wsl.localhost\…`: not a folder on a Windows drive. */
const isUncPath = (p: string): boolean => /^[\\/]{2}/.test(p)
import { restoreIfMissing } from '../core/restore'
import { handoffPath, writeHandoff } from '../core/handoff'
import { isUuid } from '@shared/jsonl'
import { buildHandoff, continuedName, newSinceSummary } from '@shared/summary'
import {
  codexModelSettings,
  resolveModelChoice,
  type CodexModelSettings,
  type ModelSettings,
  type ResolvedModel
} from '@shared/model-choice'
import { fileExists, isAbsoluteWindowsPath } from '../core/which'
import type { Platform } from '../platform'
import { BranchService } from './branches'
import type { ResumeEstimate } from '@shared/context'
import { sessionProvider } from '../providers/registry'
import type { SessionProvider } from '../providers/types'
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

/** The agent's command isn't installed (or not on PATH). */
export function notFoundMessage(product: string): string {
  return `${product} wasn't found on this computer's PATH. Install it (or open a new terminal once after installing), then try again.`
}

export const CLAUDE_NOT_FOUND = notFoundMessage('Claude Code')

type CwdState = 'exists' | 'missing' | 'unreachable'

export class Launcher {
  readonly branches: BranchService
  /** Resume / Fork previews: the context size and what reloading it would cost (set at startup). */
  contextEstimate?: (
    s: SessionSummary,
    launch: { billingAccountId?: string; modelChoice?: string }
  ) => Promise<ResumeEstimate | undefined>

  constructor(
    private readonly platform: Platform,
    private readonly sessions: SessionService,
    private readonly defaultTerminal: () => TerminalPref,
    private readonly billing?: LaunchBilling,
    /** Settings → Resume defaults and per-project defaults for model / effort. */
    private readonly modelSettings: () => Partial<ModelSettings> & CodexModelSettings = () => ({}),
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
    // A Windows drive mounted in WSL (/mnt/c/…) can't be seen through \\wsl.localhost
    // (access is denied there): its Windows path is checked instead.
    const onDrive = mntToWindows(cwd)
    if (onDrive && (await this.platform.pathExists(onDrive))) return 'exists'
    const known = this.sessions.source(s.sourceId)?.distroRoot
    const roots = known ? [known] : s.distro ? this.platform.distroRoots(s.distro) : []
    const parts = cwd.split('/').filter(Boolean)
    for (const root of roots)
      if (await this.platform.pathExists(join(root, ...parts))) return 'exists'
    for (const root of roots)
      if (await this.platform.pathExists(root)) {
        // Mounts under /mnt (a drive with a different letter mapping, a network
        // share) are only seen inside the distro: ask it before calling one gone.
        if (
          cwd.startsWith('/mnt/') &&
          s.distro &&
          (await this.platform.wslCanRead(s.distro, cwd).catch(() => false))
        )
          return 'exists'
        return 'missing'
      }
    return 'unreachable'
  }

  private provider(s: SessionSummary): SessionProvider {
    return sessionProvider(this.sessions, s)
  }

  /** Why this launch isn't possible for the session's provider, if it isn't. */
  private unsupported(s: SessionSummary, opts: LaunchOptions): string | undefined {
    const p = this.provider(s)
    const c = p.capabilities
    const no = (what: string): string => `${what} isn't available for ${p.productName} sessions.`
    if (opts.fork && !c.fork) return no('Fork')
    if (opts.branch && !c.branch) return no('Branch from here')
    if (opts.continueFresh && !c.continueFresh) return no('Continue fresh')
    if (opts.remoteControl && !c.remoteControl) return no('Remote Control')
    if (opts.billingAccountId && !c.apiBilling) return no('Launching on API credits')
    if (opts.newSession && !c.newSession) return no('A new session in this folder')
    return undefined
  }

  /**
   * Why a session whose file is gone can't be launched without a restore,
   * for an agent the app never writes files for (Codex), or undefined.
   */
  private noRestore(
    s: SessionSummary,
    opts: LaunchOptions,
    originalExists: boolean
  ): string | undefined {
    if (opts.newSession || originalExists || this.provider(s).capabilities.restore) return undefined
    if (s.availability === 'source-offline')
      return ` can't be read right now, so this session can't be resumed. Start it, then try again.`
    return `This session's file is no longer in ${this.provider(s).productName}'s sessions folder. The app doesn't copy files into ${this.provider(s).productName}'s folder, so it can't be resumed or forked from here. You can still read, search and export it.`
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
    const p = this.provider(s)
    // Codex has its own defaults and levels, kept apart from Claude Code's.
    if (p.id === 'codex')
      return resolveModelChoice(s.meta, s, codexModelSettings(this.modelSettings()), p.effortLevels)
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
    const p = this.provider(s)
    // A WSL-only folder run with Windows Codex: never bypass; read-only sandbox, so a command
    // that would change anything needs approval (Codex has no 'ask for every command').
    const forced = this.askForced.has(s)
    return p.launch.buildCommand({
      ...this.targetOf(s),
      // A translated or chosen folder is given to the agent too (Codex: -C), or it asks
      // which folder to use, or uses the one it recorded.
      ...(this.translated.has(s) || opts.cwdOverride ? { passCwd: true } : {}),
      continueFresh,
      remoteControl: this.remoteControl(s, opts),
      askPermissions: forced || opts.askPermissions === true,
      ...(forced ? { readOnly: true } : {}),
      modelChoice: this.modelChoice(s),
      env: s.env,
      distro: s.distro,
      sessionId: s.sessionId,
      cwd,
      fork: opts.fork,
      newSession: opts.newSession,
      skipPermissions: forced ? false : opts.skipPermissions,
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

  /** Per distro: where it sees the app's data folder (checked readable), and when. */
  private wslRoots = new Map<string, { path: string; at: number }>()

  /**
   * The app's data folder as a distro sees it, asked inside the distro
   * (`wslpath`, then `test -r`), so a custom automount root works and
   * unmounted drives are caught. Kept for a few minutes (the dialog asks often).
   */
  private async wslDataDir(distro: string, dataDir: string): Promise<string | undefined> {
    const hit = this.wslRoots.get(distro)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.path
    const path = await this.platform.wslPath(distro, dataDir)
    if (!path || !(await this.platform.wslCanRead(distro, path))) {
      this.wslRoots.delete(distro)
      return undefined
    }
    this.wslRoots.set(distro, { path, at: Date.now() })
    return path
  }

  /** Sessions place() put in a WSL-only folder: never bypass, read-only sandbox (see command()). */
  private askForced = new WeakSet<SessionSummary>()
  /** Sessions place() gave a translated folder: the agent is told it (`-C`), not just started there. */
  private translated = new WeakSet<SessionSummary>()

  /** Remember a placed session's folder as translated, and return it. */
  private translatedTo(s: SessionSummary, cwd: string): SessionSummary {
    const placed: SessionSummary = { ...s, cwd }
    this.translated.add(placed)
    return placed
  }
  /** Per distro and Windows folder: the folder as that distro sees it (`wslpath`), and when. */
  private wslFolders = new Map<string, { path: string; at: number }>()
  private distroList?: { list: string[]; def?: string; at: number }

  /** The user's distros (not Docker's or Rancher's), and the default one. */
  private async distros(): Promise<{ list: string[]; def?: string }> {
    const hit = this.distroList
    if (hit && Date.now() - hit.at < 60_000) return hit
    const list = ((await this.platform.listDistros().catch(() => undefined)) ?? []).filter(
      (d) => isValidDistroName(d) && !isInfrastructureDistro(d)
    )
    const marked = await this.platform.defaultDistro?.().catch(() => undefined)
    const def = marked && list.includes(marked) ? marked : list[0]
    this.distroList = { list, def, at: Date.now() }
    return this.distroList
  }

  /**
   * A Windows folder as a distro sees it, asked in the distro (`wslpath -u`, so its
   * own mounts count). Undefined when the distro can't say: never guessed.
   */
  private async inDistro(distro: string, windowsPath: string): Promise<string | undefined> {
    return this.askDistro(`u|${distro}|${windowsPath}`, () =>
      this.platform.wslPath(distro, windowsPath)
    )
  }

  /**
   * A Linux folder as Windows sees it, asked in the distro (`wslpath -w`): `C:\…`
   * for a mounted Windows drive, `\\wsl.localhost\…` for a Linux folder.
   */
  private async windowsPathIn(distro: string, linuxPath: string): Promise<string | undefined> {
    const ask = this.platform.wslWindowsPath
    if (!ask) return undefined
    return this.askDistro(`w|${distro}|${linuxPath}`, () => ask(distro, linuxPath))
  }

  /** A distro's answer, kept for a few minutes (the dialog asks again on every change). */
  private async askDistro(
    k: string,
    ask: () => Promise<string | undefined>
  ): Promise<string | undefined> {
    const hit = this.wslFolders.get(k)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.path
    const path = await ask().catch(() => undefined)
    if (path) this.wslFolders.set(k, { path, at: Date.now() })
    return path
  }

  /**
   * Where a session runs, for a provider whose sessions can have a folder from
   * the other environment than the home holding them (Codex: the desktop app
   * on Windows can run its agent in WSL and still keep the session in the
   * Windows `.codex`). The agent always runs where its home is: its SQLite
   * database can't be used across the WSL / Windows boundary (opening the
   * Windows `.codex` from WSL fails with "disk I/O error"). Only the folder is
   * translated:
   * - a folder on a Windows drive in a Windows home: `/mnt/c/x` → `C:\x`;
   * - a Windows folder in a WSL home: `C:\x` → `/mnt/c/x` (as that distro
   *   mounts it);
   * - a Linux-only folder (`/home/…`) in a Windows home can't be resumed
   *   there, unless opted in (`wslFolder`, desktop only): then Windows Codex
   *   runs in `\\wsl.localhost\<distro>\…`, always asking before commands
   *   (they run in Windows PowerShell against the Linux files).
   * The returned session has the run's environment and folder.
   */
  async place(
    s: SessionSummary,
    opts: Pick<LaunchOptions, 'wslFolder' | 'distro'>
  ): Promise<{ s: SessionSummary; placement?: LaunchPlacement; error?: string }> {
    const p = this.provider(s)
    if (!p.launch.crossEnvFolders || !s.cwd) return { s }
    const appLink = !!p.launch.appLink?.(s.sessionId)
    const name = p.productName
    if (s.env === 'windows' && isLinuxPath(s.cwd)) {
      const { list, def } = await this.distros()
      // What the folder is on Windows, asked in the distro (`wslpath -w`): a /mnt path is
      // a Windows drive only with the usual mounts. A custom wsl.conf can mount drives
      // elsewhere and make /mnt/c an ordinary Linux folder.
      const asked = def ? await this.windowsPathIn(def, s.cwd) : undefined
      const onDrive = asked ? (isUncPath(asked) ? undefined : asked) : undefined
      if (onDrive)
        return {
          s: this.translatedTo(s, onDrive),
          placement: {
            kind: 'translated',
            runIn: 'windows',
            cwd: onDrive,
            distros: [],
            appLink,
            reason: `${name} ran this session in WSL, in ${s.cwd}. Its history is in the Windows .codex folder, so it resumes with Windows ${name} in the same folder: ${onDrive}.`
          }
        }
      // Looks like a drive folder, but WSL couldn't confirm it (no distro, the folder is
      // gone, …): never guessed. Choosing a folder in the dialog runs it there.
      const guess = asked ? undefined : mntToWindows(s.cwd)
      if (guess)
        return {
          s,
          placement: {
            kind: 'translated',
            runIn: 'windows',
            cwd: s.cwd,
            distros: [],
            appLink,
            needsFolder: true,
            reason: `${name} ran this session in WSL, in ${s.cwd}. Its history is in the Windows .codex folder, so it resumes with Windows ${name}, in the matching Windows folder.`
          },
          error: `WSL couldn't confirm which Windows folder ${s.cwd} is (it may be ${guess}). Choose the folder to resume in.`
        }
      const distro = opts.distro && list.includes(opts.distro) ? opts.distro : def
      const placement: LaunchPlacement = {
        kind: 'wsl-only',
        runIn: 'windows',
        cwd: s.cwd,
        distros: list,
        ...(distro ? { distro } : {}),
        appLink,
        reason: `${name} ran this session in WSL, in ${s.cwd}, a folder only Linux has. Its history is in the Windows .codex folder, and ${name} can only run where that folder is (its database can't be opened from WSL), so it can't be resumed in WSL.`
      }
      if (!opts.wslFolder)
        return {
          s,
          placement,
          error: `This session ran in WSL in a Linux-only folder, so it isn't resumed from here.${appLink ? ` Open it in the ${name} app,` : ''} or resume it with Windows ${name} in the WSL folder (desktop only).`
        }
      if (!distro)
        return { s, placement, error: 'No WSL distro was found that could hold this folder.' }
      const unc = linuxToUnc(wslRoots(distro)[0], s.cwd)
      const placed = this.translatedTo(s, unc)
      this.askForced.add(placed)
      return {
        s: placed,
        placement: { ...placement, cwd: unc, optedIn: true, askForced: true }
      }
    }
    if (s.env === 'wsl' && isWindowsPath(s.cwd)) {
      // Asked in the distro that holds the session (its own mounts): never guessed.
      const path = s.distro ? await this.inDistro(s.distro, s.cwd) : undefined
      const reason = `${name} ran this session on Windows, in ${s.cwd}. Its history is in the ${s.sourceLabel} .codex folder, so it resumes in WSL in the same folder`
      if (!path)
        return {
          s,
          placement: {
            kind: 'translated',
            runIn: 'wsl',
            cwd: s.cwd,
            distros: [],
            needsFolder: true,
            reason: `${reason}.`
          },
          error: `${s.sourceLabel} couldn't say where ${s.cwd} is in WSL. Choose the folder to resume in.`
        }
      return {
        s: this.translatedTo(s, path),
        placement: {
          // No app link: the Codex app on Windows reads the Windows .codex, not this one.
          kind: 'translated',
          runIn: 'wsl',
          cwd: path,
          distros: [],
          reason: `${reason}: ${path}.`
        }
      }
    }
    return { s }
  }

  /**
   * Where "Open terminal here" opens a plain shell (no agent, so no home to
   * stay with): in the environment the folder belongs to. Undefined when a
   * Linux folder has no distro to open in.
   */
  private async shellPlace(s: SessionSummary): Promise<SessionSummary | undefined> {
    if (!this.provider(s).launch.crossEnvFolders || !s.cwd) return s
    if (s.env === 'windows' && isLinuxPath(s.cwd)) {
      const { def } = await this.distros()
      return def ? { ...s, env: 'wsl', distro: def } : undefined
    }
    if (s.env === 'wsl' && isWindowsPath(s.cwd)) return { ...s, env: 'windows', distro: undefined }
    return s
  }

  /** The launch target: its source's (who and which home the agent runs as). */
  private targetOf(s: SessionSummary): Pick<LaunchInput, 'wslUser' | 'agentEnv'> | undefined {
    const src = this.sessions.source(s.sourceId)
    return src ? this.provider(s).launch.target?.(src) : undefined
  }

  /** A new session id that no session file or handoff uses yet (the one asked for, if free). */
  private async freeContinueId(
    s: SessionSummary,
    dataDir: string,
    wanted?: string
  ): Promise<string> {
    const p = this.provider(s)
    // The handoff is in the app's own folder: checked directly, not through the platform.
    const free = async (id: string): Promise<boolean> =>
      !(await this.platform.pathExists(p.launch.sessionFilePath(s, id))) &&
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
    let sessionPath: string | undefined = path
    if (s.env === 'wsl') {
      // Where this distro mounts the app's data folder (its own automount root).
      const root = s.distro ? await this.wslDataDir(s.distro, dataDir) : undefined
      if (!root)
        throw new Error(
          `${s.sourceLabel} can't read the app's data folder, where the handoff goes. Check that Windows drives are mounted in this distro ([automount] in /etc/wsl.conf), and that it's running.`
        )
      sessionPath = `${root}/handoffs/${id}.md`
    }
    const p = this.provider(s)
    const prompt = p.launch.handoffPrompt(sessionPath)
    if (!prompt)
      throw new Error(
        `The app's data folder has characters in its path that can't be passed to ${p.productName} safely.`
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

  /** Just the agent's own command (`claude …`), even when the full command can't be built. */
  private claudeCommand(s: SessionSummary, opts: LaunchOptions, cmd?: LaunchCommand): string {
    if (cmd) return cmd.claudeCommand
    // A session that needs its own home or WSL user (Codex): the bare command
    // would run against the wrong one, so there's nothing to copy.
    const p = this.provider(s)
    const target = this.targetOf(s)
    if (target && (target.wslUser || Object.keys(target.agentEnv ?? {}).length)) return ''
    try {
      const forced = this.askForced.has(s)
      return p.launch.commandLine({
        sessionId: s.sessionId,
        skipPermissions: forced ? false : opts.skipPermissions,
        fork: opts.fork,
        newSession: opts.newSession,
        remoteControl: this.remoteControl(s, opts),
        askPermissions: forced || opts.askPermissions === true,
        ...(forced ? { readOnly: true } : {}),
        modelChoice: this.modelChoice(s)
      })
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
    const found = this.sessions.get(opts.key)
    if (!found) throw new Error('Session not found')
    // Where it runs (WSL for a Codex desktop session with a Linux folder, …).
    const placed = await this.place(found, opts)
    const s = placed.s
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
        ...(cmd?.agentNote ? { agentNote: cmd.agentNote } : {}),
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
        launchError: this.unsupported(s, opts) ?? error ?? folderError,
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
        ...(built.cmd?.agentNote ? { agentNote: built.cmd.agentNote } : {}),
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
        launchError: this.unsupported(s, opts) ?? built.error ?? folderError,
        remoteControlName: this.remoteControl(target, opts)?.name,
        modelChoice: this.modelChoice(s)
      }
    }
    const originalExists = await this.platform.pathExists(s.originalPath)
    const record = this.sessions.archiveRecord(s.key)
    const noRestore = this.noRestore(s, opts, originalExists)
    const { cmd, error } = this.tryCommand(s, opts, cwd ?? this.placeholderCwd(s), terminal, tools)
    const modelChoice = this.modelChoice(s)
    // An estimate that fails never stops a launch. Only for agents whose usage is read.
    const context =
      opts.newSession || !this.provider(s).capabilities.usage
        ? undefined
        : await this.contextEstimate?.(s, {
            billingAccountId: opts.billingAccountId,
            modelChoice: modelChoice.model
          }).catch(() => undefined)
    return {
      commandLine: cmd?.commandLine ?? '',
      claudeCommand: this.claudeCommand(s, opts, cmd),
      ...(cmd?.agentNote ? { agentNote: cmd.agentNote } : {}),
      fellBack,
      cwd,
      cwdExists: state === 'exists',
      willRestore: !noRestore && !opts.newSession && !originalExists && !!record,
      restoreImpossible:
        !!noRestore ||
        (!opts.newSession && !originalExists && !record && s.availability !== 'source-offline'),
      originalPath: s.originalPath,
      terminal: cmd?.terminal ?? terminal,
      terminalReason: cmd?.terminalReason,
      billingLabel: this.billingLabel(opts),
      launchError:
        this.unsupported(s, opts) ?? placeError(placed, opts) ?? noRestore ?? error ?? folderError,
      remoteControlName: this.remoteControl(s, opts)?.name,
      modelChoice,
      ...(context ? { context } : {}),
      ...(placed.placement ? { placement: placed.placement } : {})
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
    const found = this.sessions.get(key)
    if (!found) return fail('Session not found')
    if (found.availability === 'imported')
      return fail('Conversations imported from claude.ai have no folder on this PC.')
    // A plain shell in the folder where the session ran: WSL for a Codex desktop
    // session with a Linux folder, Windows for a Windows folder in a WSL home.
    const s = await this.shellPlace(found)
    if (!s) return fail('No WSL distro was found to open this Linux folder in.')
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
    const found = this.sessions.get(opts.key)
    if (!found) return { ok: false, restored: false, commandLine: '', error: 'Session not found' }
    // Where it runs (a Codex desktop session's Linux folder, translated). Never opted in
    // to a WSL-only folder from a phone.
    const placed = await this.place(found, ctx.via === 'phone' ? { distro: opts.distro } : opts)
    const unplaced = placeError(placed, opts)
    if (unplaced) return { ok: false, restored: false, commandLine: '', error: unplaced }
    const s = placed.s
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
    const unsupported = this.unsupported(s, opts)
    if (unsupported) return fail(unsupported)
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
    const p = this.provider(s)
    if (p.launch.cliMissing(s.env, tools)) return fail(notFoundMessage(p.productName))

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
    //    (Claude Code only: the app never writes into another agent's folder.)
    let restored = false
    if (!opts.newSession && !cont && !(await this.platform.pathExists(s.originalPath))) {
      const refuse = this.noRestore(s, opts, false)
      if (refuse) return fail(refuse)
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
      // WSL: the distro must really see the file before Claude is told to read it.
      if (s.env === 'wsl' && s.distro) {
        const seen = await this.platform.wslCanRead(s.distro, cont.preview.sessionPath)
        if (!seen) {
          this.wslRoots.delete(s.distro)
          return {
            ...fail(
              `${s.sourceLabel} can't read the handoff file at ${cont.preview.sessionPath}, so nothing was started. Check that Windows drives are mounted in this distro ([automount] in /etc/wsl.conf).`
            ),
            commandLine: cmd.commandLine
          }
        }
      }
    }
    // Asked again right before starting anything: the checks above take time
    // (writing the handoff, asking WSL), and a phone can be revoked or
    // read-only mode turned on meanwhile.
    const late = ctx.stillAllowed?.()
    if (late)
      return { ok: false, restored, commandLine: cmd.commandLine, error: `Not launched: ${late}.` }
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
