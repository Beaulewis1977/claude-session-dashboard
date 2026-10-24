// Terminal access (Settings → Phone → Terminal access): set up Windows'
// OpenSSH Server so a phone can open a real terminal on this PC over
// Tailscale, and undo it again.
//
// Every change is shown first (the exact script), confirmed, logged, and has
// an undo. What the wizard changed is recorded in terminal.json in the app's
// data folder, so "Turn off" puts back exactly that and nothing else. Keys
// that were already there, and sshd_config lines the wizard didn't write, are
// never touched. The dashboard never runs commands for a phone: SSH logins are
// handled entirely by Windows' OpenSSH.

import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import {
  keyFingerprint,
  parsePublicKey,
  parseSshdLogins,
  SSH_PORT,
  type ActionResult,
  type HostKey,
  type PendingKey,
  type PreparedChange,
  type ShellOption,
  type SshShellKind,
  type TerminalAccessInfo,
  type TerminalAction,
  type TerminalLogEntry,
  type TerminalStatus
} from '@shared/terminal'
import type { JsonStore } from '../core/json-store'
import { assertRealAppDataWrite } from '../core/safe-paths'
import { systemRoot } from '../core/which'
import type { ProbeResult, ScriptRunner } from './host'
import {
  combine,
  configWriteScript,
  defaultRuleScript,
  firewallAddScript,
  firewallRemoveScript,
  installScript,
  keyAddScript,
  keyRemoveScript,
  serviceOnScript,
  serviceSetScript,
  shellRestoreScript,
  shellSetScript,
  shownText,
  sshdExe,
  START_TYPES,
  uninstallScript,
  validAdapterName,
  type BuiltScript,
  type StartType
} from './scripts'
import { lineDiff, passwordAuthSetting, setPasswordAuth } from './sshd-config'

export interface StoredKey {
  fingerprint: string
  comment?: string
  /** The exact line written (removing the key removes only this line). */
  line: string
  file: string
  admin: boolean
  addedAt: string
}

export interface TerminalFile {
  version: 1
  /** The wizard installed OpenSSH Server (so it may offer to uninstall it). */
  installedByApp?: boolean
  /** The sshd service before the wizard started it. */
  service?: { prevStartType: string; prevStatus: string }
  firewallRule?: boolean
  defaultRuleDisabled?: boolean
  /** DefaultShell before the wizard set it (prevValue undefined: it wasn't set). */
  shell?: { prevValue?: string; value: string }
  keys: StoredKey[]
  /** The wizard edited sshd_config: the original is in backupFile. */
  sshdConfig?: { backupFile: string; writtenSha256: string; at: string }
  log: TerminalLogEntry[]
}

export const emptyTerminalFile = (): TerminalFile => ({ version: 1, keys: [], log: [] })

export interface TerminalDeps {
  store: JsonStore<TerminalFile>
  dataDir: string
  /** Windows and not fixtures: changes are real. */
  supported: boolean
  /** Fixtures: a stand-in PC (see fake.ts). */
  simulated: boolean
  run: ScriptRunner
  probe(): Promise<ProbeResult>
  /** The running sshd's host key fingerprints. */
  hostKeys?(): Promise<HostKey[]>
  tailscale(): Promise<{ installed: boolean; loggedIn: boolean; dnsName?: string }>
  exists(p: string): Promise<boolean>
  user: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/** How long the PC accepts a key from a paired phone after "Get key from phone". */
export const LISTEN_MS = 10 * 60_000
const PREPARED_TTL_MS = 5 * 60_000
const LOG_MAX = 500

export function shellKind(path: string | undefined): SshShellKind {
  if (!path) return 'cmd'
  const b = win32.basename(path).toLowerCase()
  if (b === 'pwsh.exe') return 'pwsh'
  if (b === 'powershell.exe') return 'powershell'
  if (b === 'bash.exe' || b === 'wsl.exe') return 'wsl'
  if (b === 'cmd.exe') return 'cmd'
  return 'other'
}

/**
 * The name to log in with: the local account name, or `domain\name` for a
 * domain account (OpenSSH for Windows resolves local and Microsoft accounts
 * to the local name).
 */
export function sshUserName(
  env: NodeJS.ProcessEnv = process.env,
  name = userInfo().username
): string {
  const domain = env.USERDOMAIN
  const pc = env.COMPUTERNAME
  return domain && pc && domain.toUpperCase() !== pc.toUpperCase() && !/^AzureAD$/i.test(domain)
    ? `${domain}\\${name}`
    : name
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** Windows' service start types as Set-Service takes them. */
export function startTypeFor(raw: string | undefined): StartType {
  if (raw && /^automatic/i.test(raw)) return 'Automatic'
  return (START_TYPES as readonly string[]).includes(raw ?? '') ? (raw as StartType) : 'Manual'
}

/** Sees a part's result (also a failed one); may return a note for the log. */
type Commit = (out: Record<string, unknown>) => string | void

interface Plan {
  script: BuiltScript
  okLabel: string
  /** One per part, same order as script.parts. */
  commit: Commit[]
  /** Records what undo needs, before the part runs. */
  before: (() => void)[]
  log: string[]
}

export class TerminalService extends EventEmitter<{ changed: [] }> {
  private probing: Promise<ProbeResult> | undefined
  private last: { at: number; probe: ProbeResult } | undefined
  private cached: { at: number; status: TerminalStatus } | undefined
  private pending: (PendingKey & { line: string }) | undefined
  private listenUntil = 0
  private busy = false
  private hostKeyCache: { at: number; keys: HostKey[] } | undefined
  private prepared: { token: string; action: TerminalAction; plan: Plan; at: number } | undefined

  constructor(private readonly deps: TerminalDeps) {
    super()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env
  }

  private get file(): TerminalFile {
    return this.deps.store.value
  }

  /** One probe at a time; a result under 1.5 s old is reused. */
  private async probe(fresh = false): Promise<ProbeResult> {
    if (!fresh && this.last && this.now() - this.last.at < 1500) return this.last.probe
    this.probing ??= this.deps.probe().finally(() => (this.probing = undefined))
    const p = await this.probing
    this.last = { at: this.now(), probe: p }
    return p
  }

  log(action: string, detail: string, ok: boolean): void {
    this.deps.store.update((f) => {
      f.log.push({ at: new Date(this.now()).toISOString(), action, detail, ok })
      if (f.log.length > LOG_MAX) f.log.splice(0, f.log.length - LOG_MAX)
    })
  }

  history(limit = 200): TerminalLogEntry[] {
    return this.file.log.slice(-limit).reverse()
  }

  private changedNow(): void {
    this.cached = undefined
    this.emit('changed')
  }

  // ------------------------------------------------------------ status

  async shellOptions(): Promise<ShellOption[]> {
    const root = systemRoot(this.env)
    const pf = this.env.ProgramFiles ?? 'C:\\Program Files'
    const all: Omit<ShellOption, 'available'>[] = [
      { kind: 'pwsh', label: 'PowerShell 7', path: win32.join(pf, 'PowerShell', '7', 'pwsh.exe') },
      {
        kind: 'powershell',
        label: 'Windows PowerShell',
        path: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      },
      // bash.exe opens the default WSL distro and takes `-c` like bash does.
      { kind: 'wsl', label: 'WSL', path: win32.join(root, 'System32', 'bash.exe') }
    ]
    return Promise.all(
      all.map(async (o) => ({
        ...o,
        available: this.deps.simulated ? true : await this.deps.exists(o.path)
      }))
    )
  }

  keyFile(admin: boolean): string {
    if (admin)
      return win32.join(
        this.env.ProgramData ?? 'C:\\ProgramData',
        'ssh',
        'administrators_authorized_keys'
      )
    return win32.join(this.env.USERPROFILE ?? 'C:\\Users\\you', '.ssh', 'authorized_keys')
  }

  async status(fresh = true): Promise<TerminalStatus> {
    const f = this.file
    const [p, ts, options] = await Promise.all([
      this.probe(fresh),
      this.deps
        .tailscale()
        .catch(() => ({ installed: false, loggedIn: false, dnsName: undefined })),
      this.shellOptions()
    ])
    const running = p.sshdService?.status === 'Running'
    const logins = parseSshdLogins(p.events)
    if (this.listenUntil && this.listenUntil < this.now()) this.listenUntil = 0
    const st: TerminalStatus = {
      supported: this.deps.supported,
      simulated: this.deps.simulated,
      user: this.deps.user,
      sshd: {
        installed: p.sshdExe || !!p.sshdService,
        running,
        startType: p.sshdService?.startType,
        version: p.sshdVersion
      },
      firewall: {
        ours: p.oursRule,
        defaultRule: { exists: !!p.defaultRule, enabled: !!p.defaultRule?.enabled }
      },
      shell: {
        kind: shellKind(p.shell),
        path: p.shell,
        distro: shellKind(p.shell) === 'wsl' ? p.defaultDistro : undefined,
        defaultDistro: p.defaultDistro,
        options
      },
      keys: { file: this.keyFile(p.admin), admin: p.admin },
      account: p.account,
      hostKeys: running ? await this.hostKeys() : [],
      passwordAuth: p.config ? passwordAuthSetting(p.config.toString('utf8')) : 'unknown',
      lastLogin: logins[0],
      eventLogReadable: p.eventsOk,
      tailscale: { ...ts, interfaceAlias: p.tsAlias },
      // Not while Windows' "any address" rule could let other networks reach SSH.
      ready: running && p.oursRule && !p.defaultRule?.enabled && !!ts.loggedIn && !!ts.dnsName,
      changes: {
        installedByApp: !!f.installedByApp,
        service: f.service,
        firewallRule: !!f.firewallRule,
        defaultRuleDisabled: !!f.defaultRuleDisabled,
        shell: f.shell,
        keys: f.keys.map((k) => ({
          fingerprint: k.fingerprint,
          comment: k.comment,
          addedAt: k.addedAt
        })),
        sshdConfig: f.sshdConfig ? { at: f.sshdConfig.at } : undefined
      },
      pendingKey: this.pending
        ? {
            device: this.pending.device,
            type: this.pending.type,
            fingerprint: this.pending.fingerprint,
            comment: this.pending.comment,
            at: this.pending.at
          }
        : undefined,
      listeningUntil: this.listenUntil ? new Date(this.listenUntil).toISOString() : undefined
    }
    this.cached = { at: this.now(), status: st }
    return st
  }

  /** For a paired phone: where to connect, and whether it's set up. */
  async phoneInfo(): Promise<TerminalAccessInfo> {
    const st =
      this.cached && this.now() - this.cached.at < 15_000
        ? this.cached.status
        : await this.status(false)
    return {
      ready: st.ready,
      host: st.ready ? st.tailscale.dnsName : undefined,
      user: st.ready ? st.user : undefined,
      port: SSH_PORT,
      shell: { kind: st.shell.kind, path: st.shell.path, distro: st.shell.distro },
      hostKeys: st.ready ? st.hostKeys : undefined
    }
  }

  /** Each read connects to sshd (and shows in its log): kept for 10 minutes. */
  private async hostKeys(): Promise<HostKey[]> {
    const c = this.hostKeyCache
    if (c && c.keys.length && this.now() - c.at < 10 * 60_000) return c.keys
    const keys = (await this.deps.hostKeys?.().catch(() => [])) ?? []
    this.hostKeyCache = { at: this.now(), keys }
    return keys
  }

  // ------------------------------------------------------------ planning

  private async plan(a: TerminalAction, p: ProbeResult): Promise<Plan | { error: string }> {
    const f = this.file
    const at = new Date(this.now()).toISOString()
    const root = systemRoot(this.env)
    // `before` records what's needed to undo a change *before* it runs (undoing a
    // change that then failed only puts back what was already there). `commit`
    // sees every part's result, also a failed one, and records what the script
    // says it actually did.
    const single = (
      script: BuiltScript,
      okLabel: string,
      log: string,
      commit: Commit = () => undefined,
      before: () => void = () => undefined
    ): Plan => ({ script, okLabel, commit: [commit], before: [before], log: [log] })
    const ok = (out: Record<string, unknown>): boolean => out.ok !== false

    switch (a.kind) {
      case 'install':
        if (p.sshdExe) return { error: 'OpenSSH Server is already installed.' }
        return single(installScript(), 'Install', 'Installed OpenSSH Server', (out) => {
          if (out.installed) this.deps.store.update((x) => (x.installedByApp = true))
        })
      case 'uninstall':
        if (!f.installedByApp)
          return { error: 'The wizard didn’t install OpenSSH Server, so it won’t remove it.' }
        return single(uninstallScript(), 'Uninstall', 'Uninstalled OpenSSH Server', (out) => {
          if (ok(out))
            this.deps.store.update((x) => {
              x.installedByApp = undefined
              x.service = undefined
            })
        })
      case 'service-on': {
        if (!p.sshdService) return { error: 'Install OpenSSH Server first.' }
        // Never listen while SSH could be reached from outside Tailscale.
        if (!p.oursRule || p.defaultRule?.enabled)
          return {
            error:
              'Limit SSH to Tailscale first (the Firewall step): add the Tailscale-only rule and turn off Windows’ “any address” rule. Then start sshd.'
          }
        const prev = { prevStartType: p.sshdService.startType, prevStatus: p.sshdService.status }
        return single(
          serviceOnScript(),
          'Start',
          'Started sshd and set it to Automatic',
          undefined,
          () => this.deps.store.update((x) => (x.service ??= prev))
        )
      }
      case 'service-undo': {
        if (!f.service) return { error: 'The wizard didn’t change the sshd service.' }
        const t = startTypeFor(f.service.prevStartType)
        const running = f.service.prevStatus === 'Running' && t !== 'Disabled'
        return single(
          serviceSetScript(t, running, 'undo'),
          'Put it back',
          `Put sshd back to ${t}${running ? ', running' : ', stopped'}`,
          (out) => {
            if (ok(out)) this.deps.store.update((x) => (x.service = undefined))
          }
        )
      }
      case 'firewall-add':
        if (!validAdapterName(p.tsAlias))
          return {
            error:
              'Tailscale’s network adapter wasn’t found on this PC, so the rule can’t be limited to it. Make sure Tailscale is installed and connected, then try again.'
          }
        return single(
          firewallAddScript({ program: sshdExe(root), interfaceAlias: p.tsAlias }),
          'Add rule',
          'Added the Tailscale-only SSH firewall rule',
          undefined,
          () => this.deps.store.update((x) => (x.firewallRule = true))
        )
      case 'firewall-remove':
        return single(
          firewallRemoveScript(),
          'Remove rule',
          'Removed the Tailscale-only SSH firewall rule',
          (out) => {
            if (ok(out)) this.deps.store.update((x) => (x.firewallRule = undefined))
          }
        )
      case 'default-rule-disable':
        if (!p.defaultRule) return { error: 'Windows’ default SSH rule isn’t there.' }
        if (!p.defaultRule.enabled) return { error: 'Windows’ default SSH rule is already off.' }
        return single(
          defaultRuleScript(false),
          'Turn off rule',
          'Turned off Windows’ default “any address” SSH rule',
          undefined,
          () => this.deps.store.update((x) => (x.defaultRuleDisabled = true))
        )
      case 'default-rule-restore':
        if (!f.defaultRuleDisabled) return { error: 'The wizard didn’t turn that rule off.' }
        return single(
          defaultRuleScript(true),
          'Turn on rule',
          'Turned Windows’ default SSH rule back on',
          (out) => {
            if (ok(out)) this.deps.store.update((x) => (x.defaultRuleDisabled = undefined))
          }
        )
      case 'shell-set': {
        const opt = (await this.shellOptions()).find((o) => o.kind === a.shell)
        if (!opt?.available) return { error: 'That shell isn’t installed on this PC.' }
        if (p.shellOption)
          return {
            error: `HKLM\\SOFTWARE\\OpenSSH\\DefaultShellCommandOption is set (“${p.shellOption}”), which another shell may not understand. The wizard doesn’t change it: remove it by hand first if you want to switch shells.`
          }
        if (p.shell?.toLowerCase() === opt.path.toLowerCase())
          return { error: `${opt.label} is already the SSH shell.` }
        // Keep the value from before the wizard's first change, so Undo goes all the way back.
        const prevValue = f.shell ? f.shell.prevValue : p.shell
        return single(
          shellSetScript(opt.path, opt.label, p.shell),
          `Use ${opt.label}`,
          `Set the SSH shell to ${opt.label} (${opt.path})`,
          undefined,
          () => this.deps.store.update((x) => (x.shell = { prevValue, value: opt.path }))
        )
      }
      case 'shell-restore':
        if (!f.shell) return { error: 'The wizard didn’t change the SSH shell.' }
        return single(
          shellRestoreScript(f.shell.prevValue),
          'Put it back',
          `Put the SSH shell back to ${f.shell.prevValue ?? 'cmd.exe (not set)'}`,
          (out) => {
            if (ok(out)) this.deps.store.update((x) => (x.shell = undefined))
          }
        )
      case 'key-add': {
        const k = parsePublicKey(a.key)
        if (!k.ok) return { error: k.error }
        const fingerprint = await keyFingerprint(k.base64)
        if (f.keys.some((x) => x.fingerprint === fingerprint))
          return { error: 'This key was already added.' }
        const file = this.keyFile(p.admin)
        return single(
          keyAddScript({ file, line: k.line, blob: k.base64, admin: p.admin, fingerprint }),
          'Add key',
          `Added SSH key ${fingerprint}${k.comment ? ` (${k.comment})` : ''} to ${file}`,
          (out) => {
            // Only a line the script appended is the wizard's to remove later.
            if (out.appended)
              this.deps.store.update((x) => {
                x.keys.push({
                  fingerprint,
                  comment: k.comment,
                  line: k.line,
                  file,
                  admin: p.admin,
                  addedAt: at
                })
              })
            else if (out.already)
              return 'it was already in the file, so it stays yours: Undo won’t remove it'
          }
        )
      }
      case 'key-remove': {
        const k = f.keys.find((x) => x.fingerprint === a.fingerprint)
        if (!k) return { error: 'The wizard didn’t add that key.' }
        return single(
          keyRemoveScript({
            file: k.file,
            line: k.line,
            admin: k.admin,
            fingerprint: k.fingerprint
          }),
          'Remove key',
          `Removed SSH key ${k.fingerprint} from ${k.file}`,
          (out) => {
            if (ok(out))
              this.deps.store.update(
                (x) => (x.keys = x.keys.filter((y) => y.fingerprint !== k.fingerprint))
              )
          }
        )
      }
      case 'password-off': {
        if (!p.config)
          return { error: 'sshd_config can’t be read. Start OpenSSH Server once first.' }
        const text = p.config.toString('utf8')
        if (passwordAuthSetting(text) === 'no') return { error: 'Password login is already off.' }
        // A byte-order mark, if any, survives: it decodes to U+FEFF and encodes back.
        const content = Buffer.from(setPasswordAuth(text, 'no'), 'utf8')
        const backupFile = join(
          this.deps.dataDir,
          'terminal-backups',
          `sshd_config.${at.replace(/[:.]/g, '-')}.bak`
        )
        const keyLogin = parseSshdLogins(p.events).some((l) => l.method === 'publickey')
        const plan = single(
          configWriteScript({
            title: 'Turn off password login?',
            summary: `Sets “PasswordAuthentication no” in C:\\ProgramData\\ssh\\sshd_config, so only your SSH keys can log in, checks it with sshd -t and restarts sshd. The current file is saved first to ${backupFile}; Undo puts it back exactly.\n\nThe change:\n${lineDiff(text, content.toString('utf8'))}${keyLogin ? '' : '\n\nNo key login has been seen yet. If your key doesn’t work, you can’t log in from the phone until you undo this here.'}`,
            content,
            expect: sha256(p.config)
          }),
          'Turn off password login',
          `Turned off password login (backup: ${backupFile})`,
          (out) => {
            if (out.written)
              this.deps.store.update(
                (x) => (x.sshdConfig = { backupFile, writtenSha256: sha256(content), at })
              )
            if (out.restartError) return `but sshd didn’t restart: ${String(out.restartError)}`
          }
        )
        // The backup is written (never over another file) before anything runs.
        await assertRealAppDataWrite(backupFile, this.deps.dataDir)
        await mkdir(dirname(backupFile), { recursive: true })
        await writeFile(backupFile, p.config, { flag: 'wx' })
        return plan
      }
      case 'password-restore': {
        const c = f.sshdConfig
        if (!c) return { error: 'The wizard didn’t change sshd_config.' }
        if (!p.config) return { error: 'sshd_config can’t be read right now.' }
        if (sha256(p.config) !== c.writtenSha256)
          return {
            error: `sshd_config was changed after the wizard edited it, so it wasn’t put back automatically. The original is saved at ${c.backupFile}.`
          }
        let original: Buffer
        try {
          original = await readFile(c.backupFile)
        } catch {
          return { error: `The backup ${c.backupFile} is missing.` }
        }
        return single(
          configWriteScript({
            title: 'Put sshd_config back?',
            summary: `Restores C:\\ProgramData\\ssh\\sshd_config from the backup made before the wizard changed it (${c.backupFile}), and restarts sshd. Password login works again.\n\nThe change:\n${lineDiff(p.config.toString('utf8'), original.toString('utf8'))}`,
            content: original,
            expect: c.writtenSha256
          }),
          'Put it back',
          `Restored sshd_config from ${c.backupFile}`,
          (out) => {
            if (out.written) this.deps.store.update((x) => (x.sshdConfig = undefined))
            if (out.restartError) return `but sshd didn’t restart: ${String(out.restartError)}`
          }
        )
      }
      case 'key-pending':
        // Resolved to key-add by prepare().
        return { error: 'No key is waiting.' }
      case 'turn-off':
        return this.planTurnOff(a, p)
    }
  }

  /** Undo everything the wizard changed, newest first, in one administrator prompt. */
  private async planTurnOff(
    a: Extract<TerminalAction, { kind: 'turn-off' }>,
    p: ProbeResult
  ): Promise<Plan | { error: string }> {
    const f = this.file
    const steps: { kind: TerminalAction }[] = []
    if (f.sshdConfig) steps.push({ kind: { kind: 'password-restore' } })
    if (f.shell) steps.push({ kind: { kind: 'shell-restore' } })
    if (a.removeKeys)
      for (const k of f.keys)
        steps.push({ kind: { kind: 'key-remove', fingerprint: k.fingerprint } })
    if (f.defaultRuleDisabled) steps.push({ kind: { kind: 'default-rule-restore' } })
    if (f.firewallRule || p.oursRule) steps.push({ kind: { kind: 'firewall-remove' } })
    const plans: Plan[] = []
    const skipped: string[] = []
    for (const s of steps) {
      const r = await this.plan(s.kind, p)
      if ('error' in r) skipped.push(r.error)
      else plans.push(r)
    }
    // The service: stopped and disabled if the wizard installed it, else put back as it was.
    if (p.sshdService && (f.installedByApp || f.service)) {
      const t: StartType = f.installedByApp ? 'Disabled' : startTypeFor(f.service?.prevStartType)
      plans.push({
        script: serviceSetScript(t, false, 'turn-off'),
        okLabel: '',
        commit: [
          (out) => {
            if (out.ok !== false) this.deps.store.update((x) => (x.service = undefined))
          }
        ],
        before: [() => undefined],
        log: [`Stopped sshd and set it to ${t}`]
      })
    }
    if (a.uninstall && f.installedByApp) {
      const r = await this.plan({ kind: 'uninstall' }, p)
      if (!('error' in r)) plans.push(r)
    }
    if (!plans.length)
      return { error: skipped[0] ?? 'There is nothing the wizard changed to undo.' }
    const notes = [
      a.removeKeys
        ? 'Keys the wizard added are removed (only those lines).'
        : 'SSH keys stay in place (they do nothing while sshd is off).',
      ...skipped.map((s) => `Skipped: ${s}`)
    ]
    return {
      script: combine(
        'Turn off terminal access?',
        `Undoes what the terminal-access wizard changed:\n• ${plans.flatMap((x) => x.log).join('\n• ')}\n\n${notes.join('\n')}\n\nNothing else is changed.`,
        plans.map((x) => x.script)
      ),
      okLabel: 'Turn off',
      commit: plans.flatMap((x) => x.commit),
      before: plans.flatMap((x) => x.before),
      log: plans.flatMap((x) => x.log)
    }
  }

  // ------------------------------------------------------------ applying

  /**
   * Step 1 of a change: work out exactly what would run and return it to be
   * shown. Nothing is changed until apply() is called with the token.
   */
  async prepare(a: TerminalAction): Promise<PreparedChange | { error: string }> {
    if (!this.deps.supported && !this.deps.simulated)
      return { error: 'Terminal access can only be set up on Windows.' }
    // One change at a time: the last one may still be finishing as administrator.
    if (this.busy)
      return { error: 'The previous change is still finishing. Try again in a moment.' }
    if (a.kind === 'key-pending') {
      if (!this.pending) return { error: 'No key is waiting.' }
      a = { kind: 'key-add', key: this.pending.line }
    }
    const p = await this.probe(true)
    let plan: Plan | { error: string }
    try {
      plan = await this.plan(a, p)
    } catch (err) {
      plan = { error: (err as Error).message }
    }
    if ('error' in plan) return plan
    const token = randomBytes(16).toString('hex')
    this.prepared = { token, action: a, plan, at: this.now() }
    const s = plan.script
    return {
      token,
      title: s.title,
      summary: s.summary,
      script: shownText(s),
      okLabel: plan.okLabel,
      elevate: s.elevate
    }
  }

  /** Step 2: run the change the user saw (only the most recent one, within 5 minutes). */
  async apply(token: string): Promise<ActionResult> {
    const prep = this.prepared
    if (!prep || prep.token !== token || this.now() - prep.at > PREPARED_TTL_MS)
      return { ok: false, error: 'That change is out of date. Try again.' }
    if (this.busy) return { ok: false, error: 'Another change is still running.' }
    this.prepared = undefined
    this.busy = true
    const { action: a, plan } = prep
    const s = plan.script
    try {
      // Undo information first: a change that fails halfway can still be undone.
      const { log: _log, ...saved } = structuredClone(this.file)
      plan.before.forEach((b) => b())
      const out = await this.deps.run(s)
      if (!out.parts.length && !out.unknown)
        // Nothing ran (declined, or it never started): forget what `before` recorded.
        this.deps.store.update((x) => {
          for (const k of Object.keys(x) as (keyof TerminalFile)[]) if (k !== 'log') delete x[k]
          Object.assign(x, saved)
        })
      // Every part's result is recorded, also after an earlier one failed.
      out.parts.forEach((part, i) => {
        const note = plan.commit[i]?.(part)
        const what = `${plan.log[i] ?? s.title}${note ? `, ${note}` : ''}`
        if (part.ok !== false) this.log(a.kind, what, true)
        else this.log(a.kind, `${what}: failed (${String(part.error ?? 'unknown error')})`, false)
      })
      if (!out.parts.length)
        this.log(
          a.kind,
          `${s.title.replace(/\?$/, '')}: ${out.cancelled ? 'declined' : `failed (${out.error ?? 'unknown error'})`}`,
          false
        )
      if (a.kind === 'key-add' && out.ok && this.pending) this.pending = undefined
      this.last = undefined
      this.changedNow()
      return {
        ok: out.ok,
        error: out.ok ? undefined : out.error,
        cancelled: out.cancelled,
        simulated: this.deps.simulated || undefined
      }
    } finally {
      this.busy = false
    }
  }

  // ------------------------------------------------------------ keys from a phone

  /** "Get key from phone": accept one key from a paired phone for 10 minutes. */
  listen(on: boolean): void {
    this.listenUntil = on ? this.now() + LISTEN_MS : 0
    if (!on) this.pending = undefined
    this.changedNow()
  }

  /**
   * A paired phone sends a public key. It is only shown on the PC (with its
   * fingerprint); nothing is written until the user clicks Allow there and
   * confirms the change like any other.
   */
  async proposeKey(
    device: string,
    text: unknown
  ): Promise<{ ok: boolean; error?: string; fingerprint?: string }> {
    if (!this.listenUntil || this.listenUntil < this.now())
      return {
        ok: false,
        error:
          'Your PC isn’t waiting for a key. On the PC, open Settings → Phone → Terminal access → Keys and click “Get key from phone”.'
      }
    const k = parsePublicKey(text)
    if (!k.ok) return { ok: false, error: k.error }
    const fingerprint = await keyFingerprint(k.base64)
    this.pending = {
      device,
      type: k.type,
      fingerprint,
      comment: k.comment,
      at: new Date(this.now()).toISOString(),
      line: k.line
    }
    this.log('key', `“${device}” sent SSH key ${fingerprint} (waiting for Allow on the PC)`, true)
    this.changedNow()
    return { ok: true, fingerprint }
  }

  rejectPending(): void {
    if (this.pending)
      this.log(
        'key',
        `Rejected SSH key ${this.pending.fingerprint} from “${this.pending.device}”`,
        true
      )
    this.pending = undefined
    this.changedNow()
  }

  /** For "Copy diagnostics": no keys, only fingerprints and states. */
  async diagnostics(): Promise<string> {
    const s = await this.status()
    return [
      `Terminal access: ${s.ready ? 'ready' : 'not ready'}${s.simulated ? ' (simulated)' : ''}`,
      `OpenSSH Server: ${s.sshd.installed ? `installed ${s.sshd.version ?? ''}` : 'not installed'} · ${s.sshd.running ? 'running' : 'stopped'} · start ${s.sshd.startType ?? '-'}`,
      `Firewall: Tailscale-only rule ${s.firewall.ours ? 'present' : 'missing'} · default rule ${s.firewall.defaultRule.exists ? (s.firewall.defaultRule.enabled ? 'on (any address)' : 'off') : 'absent'}`,
      `Default shell: ${s.shell.path ?? 'not set (cmd.exe)'}${s.shell.distro ? ` (WSL ${s.shell.distro})` : ''}`,
      `Keys file: ${s.keys.file} (${s.keys.admin ? 'administrator account' : 'standard account'}) · added by the wizard: ${s.changes.keys.length}`,
      `Password login: ${s.passwordAuth}`,
      `Tailscale: ${s.tailscale.installed ? (s.tailscale.loggedIn ? `signed in (${s.tailscale.dnsName ?? '?'})` : 'signed out') : 'not installed'} · adapter ${s.tailscale.interfaceAlias ?? '-'}`,
      `Event log: ${s.eventLogReadable ? 'readable' : 'not readable'} · last login ${s.lastLogin ? `${s.lastLogin.method} from ${s.lastLogin.tailscale ? 'Tailscale' : 'another network'} at ${s.lastLogin.at}` : '-'}`
    ].join('\n')
  }
}
