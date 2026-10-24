// Terminal access: reach a real terminal on this PC from a phone over SSH,
// through Windows' own OpenSSH Server and only over Tailscale.
//
// The dashboard never runs commands for the phone. It only helps set up
// OpenSSH (each change confirmed, logged and undoable) and builds the ssh
// command or link a phone's SSH app uses. Everything here is pure, so the
// desktop and the phone web app share it.

import type { EnvKind } from './types'

export const SSH_PORT = 22

/** The shell sshd starts (HKLM\SOFTWARE\OpenSSH DefaultShell). Unset means cmd.exe. */
export type SshShellKind = 'pwsh' | 'powershell' | 'wsl' | 'cmd' | 'other'

export interface SshShellInfo {
  kind: SshShellKind
  /** The DefaultShell value, when set. */
  path?: string
  /** For 'wsl': the default distro bash.exe opens. */
  distro?: string
}

/** What a paired phone learns: enough to build ssh commands and links, nothing more. */
export interface TerminalAccessInfo {
  /** OpenSSH is running, the Tailscale-only firewall rule is in place, and the PC has a tailnet name. */
  ready: boolean
  host?: string
  user?: string
  port: number
  shell: SshShellInfo
  /** To compare when the SSH app asks to trust the PC. */
  hostKeys?: HostKey[]
}

/** The Windows account type: which password a (password) SSH login needs. */
export type AccountKind = 'local' | 'microsoft' | 'other'

/** One of the PC's SSH host keys, as an SSH app shows it on first connect. */
export interface HostKey {
  /** "ED25519", "ECDSA", "RSA". */
  type: string
  fingerprint: string
}

/** A login sshd recorded in its event log. */
export interface SshLogin {
  at: string
  user: string
  from: string
  method: 'publickey' | 'password'
  /** "SHA256:…" for a key login. */
  fingerprint?: string
  /** From a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48). */
  tailscale: boolean
}

export interface ShellOption {
  kind: Exclude<SshShellKind, 'other' | 'cmd'>
  label: string
  path: string
  available: boolean
}

/** An SSH key a paired phone sent, waiting for Allow on the PC. */
export interface PendingKey {
  device: string
  type: string
  fingerprint: string
  comment?: string
  at: string
}

export interface TerminalLogEntry {
  at: string
  /** e.g. "install", "service", "firewall", "shell", "key", "password", "turn-off". */
  action: string
  detail: string
  ok: boolean
}

/** What the wizard changed, so each change can be undone (and all of them by "Turn off"). */
export interface TerminalChanges {
  installedByApp: boolean
  service?: { prevStartType: string; prevStatus: string }
  firewallRule: boolean
  defaultRuleDisabled: boolean
  shell?: { prevValue?: string; value: string }
  keys: { fingerprint: string; comment?: string; addedAt: string }[]
  sshdConfig?: { at: string }
}

export interface TerminalStatus {
  /** Windows, and not fixtures mode (fixtures show sample data and change nothing). */
  supported: boolean
  simulated: boolean
  user: string
  sshd: { installed: boolean; running: boolean; startType?: string; version?: string }
  firewall: {
    ours: boolean
    /** Our rule exists but was changed by hand (why). */
    problem?: string
    /** Other enabled rules that let sshd in. */
    others: string[]
    /** Windows' own "OpenSSH SSH Server (sshd)" rule, which allows any address. */
    defaultRule: { exists: boolean; enabled: boolean }
  }
  shell: SshShellInfo & { options: ShellOption[]; defaultDistro?: string }
  keys: { file: string; admin: boolean }
  account?: AccountKind
  /** Empty while sshd isn't running. */
  hostKeys: HostKey[]
  /** The global PasswordAuthentication setting ('unknown' when sshd_config can't be read). */
  passwordAuth: 'yes' | 'no' | 'partial' | 'unknown'
  /** Lines (Include, PasswordAuthentication yes in a Match block) that can turn passwords back on. */
  passwordOverrides: string[]
  lastLogin?: SshLogin
  eventLogReadable: boolean
  tailscale: { installed: boolean; loggedIn: boolean; dnsName?: string; interfaceAlias?: string }
  ready: boolean
  changes: TerminalChanges
  pendingKey?: PendingKey
  /** Accepting a key from a paired phone until then. */
  listeningUntil?: string
  error?: string
}

/** Every change the wizard can make, and its undo. */
export type TerminalAction =
  | { kind: 'install' }
  | { kind: 'uninstall' }
  | { kind: 'service-on' }
  | { kind: 'service-undo' }
  | { kind: 'firewall-add' }
  | { kind: 'firewall-remove' }
  | { kind: 'default-rule-disable' }
  | { kind: 'default-rule-restore' }
  | { kind: 'shell-set'; shell: ShellOption['kind'] }
  | { kind: 'shell-restore' }
  | { kind: 'key-add'; key: string }
  /** The key a paired phone sent (after the user clicked Allow on the PC). */
  | { kind: 'key-pending' }
  | { kind: 'key-remove'; fingerprint: string }
  | { kind: 'password-off' }
  | { kind: 'password-restore' }
  | { kind: 'turn-off'; uninstall: boolean; removeKeys: boolean }

/** A change, worked out and ready to show before it runs. */
export interface PreparedChange {
  token: string
  title: string
  summary: string
  /** The inputs and exact script that will run. */
  script: string
  okLabel: string
  /** Windows will ask for administrator rights. */
  elevate: boolean
}

export interface ActionResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  simulated?: boolean
}

export const TERMIUS_IOS_URL = 'https://apps.apple.com/app/id549039908'
export const TERMIUS_ANDROID_URL =
  'https://play.google.com/store/apps/details?id=com.server.auditor.ssh.client'
export const ASHELL_IOS_URL = 'https://apps.apple.com/app/id1473805438'
export const CONNECTBOT_ANDROID_URL = 'https://play.google.com/store/apps/details?id=org.connectbot'

// ------------------------------------------------------------ addresses

/** 100.64.0.0/10 (Tailscale IPv4) or fd7a:115c:a1e0::/48 (Tailscale IPv6). */
export function isTailscaleAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim())
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 100 && b >= 64 && b <= 127
  }
  return /^fd7a:115c:a1e0:/i.test(ip.trim())
}

// ------------------------------------------------------------ quoting

/** A POSIX shell single-quoted word (the phone's or a laptop's shell, and bash in WSL). */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * One POSIX shell word, as readable as possible: single quotes when the text
 * has none, else double quotes with `$`, backtick, `"` and the backslashes
 * the shell would read escaped (a lone `\` in `C:\Users` stays as it is).
 * Text with `!` (bash history) falls back to single-quote splicing.
 */
export function posixWord(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s
  if (!s.includes("'")) return `'${s}'`
  if (s.includes('!')) return shQuote(s)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') out += i + 1 >= s.length || '\\$`"\n'.includes(s[i + 1]) ? '\\\\' : '\\'
    else if (c === '$' || c === '`' || c === '"') out += `\\${c}`
    else out += c
  }
  return `"${out}"`
}

/** A PowerShell single-quoted string (also doubles the typographic quotes PowerShell honours). */
export function psSingle(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`
}

/** `C:\x\y` → `/mnt/c/x/y`; undefined for network folders. */
export function windowsToMnt(p: string): string | undefined {
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p)
  if (!m) return undefined
  const rest = m[2]
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

export interface FolderTarget {
  env: EnvKind
  cwd?: string
  distro?: string
}

/**
 * What to type after logging in to land in `target`'s folder, for the shell
 * sshd starts. No double quotes are used: Windows' OpenSSH passes the
 * command on a Windows command line, where they would be taken apart.
 */
export function remoteCommand(
  target: FolderTarget,
  shell: SshShellInfo
): { command?: string; note?: string } {
  const cwd = target.cwd
  if (!cwd) return { note: 'No folder is recorded for this session.' }
  if (CONTROL_RE.test(cwd)) return { note: "This folder's name can't be typed safely." }
  // Windows' command line would take `"` (and `\` before it) apart on the way to the shell.
  if (cwd.includes('"') || (target.env === 'wsl' && cwd.includes('\\')))
    return {
      note: "This folder's name contains \" or \\, which can't be passed through SSH safely."
    }
  if (target.distro !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(target.distro))
    return { note: "This WSL distro's name can't be passed through SSH safely." }
  const wslInto = (distro: string | undefined, path: string, q: (s: string) => string): string =>
    distro ? `wsl.exe -d ${q(distro)} --cd ${q(path)}` : `wsl.exe --cd ${q(path)}`

  switch (shell.kind) {
    case 'pwsh':
    case 'powershell': {
      if (target.env === 'wsl') {
        const psWord = (s: string): string =>
          /^[A-Za-z0-9_\-./:]+$/.test(s) && !s.startsWith('-') ? s : psSingle(s)
        return { command: wslInto(target.distro, cwd, psWord) }
      }
      const exe = shell.kind === 'pwsh' ? 'pwsh' : 'powershell'
      return { command: `Set-Location -LiteralPath ${psSingle(cwd)}; ${exe} -NoLogo` }
    }
    case 'wsl': {
      if (target.env === 'wsl') {
        const same =
          !target.distro ||
          !shell.distro ||
          target.distro.toLowerCase() === shell.distro.toLowerCase()
        if (same) return { command: `cd ${shQuote(cwd)} && exec \${SHELL:-bash} -l` }
        return { command: wslInto(target.distro, cwd, shQuote) }
      }
      const mnt = windowsToMnt(cwd)
      if (!mnt) return { note: "WSL can't open a network folder. Choose PowerShell as the shell." }
      return { command: `cd ${shQuote(mnt)} && exec \${SHELL:-bash} -l` }
    }
    case 'cmd': {
      if (target.env === 'wsl') {
        if (/[%!^&|<>"]/.test(cwd + (target.distro ?? '')))
          return { note: "This folder's name can't be passed through cmd safely." }
        const q = (s: string): string => (/\s/.test(s) ? `"${s}"` : s)
        return { command: wslInto(target.distro, cwd, q) }
      }
      if (/[%!^&|<>"]/.test(cwd))
        return { note: "This folder's name can't be passed through cmd safely." }
      return { command: `cmd /k cd /d ${/\s/.test(cwd) ? `"${cwd}"` : cwd}` }
    }
    default:
      return { note: 'The default shell is a custom program: open the folder by hand.' }
  }
}

/**
 * The phone shows "Open terminal here" only once terminal access is set up
 * on the PC, and only for a session with a folder on it.
 */
export function canOpenTerminal(
  info: TerminalAccessInfo | null | undefined,
  target: { cwd?: string; availability?: string } | undefined
): info is TerminalAccessInfo & { ready: true } {
  return !!info?.ready && !!info.host && !!target?.cwd && target.availability !== 'imported'
}

function userAtHost(info: Pick<TerminalAccessInfo, 'user' | 'host'>): string {
  return `${info.user ?? 'you'}@${info.host ?? 'this-pc'}`
}

/** `ssh user@host`, with `-t` and the command when there is one (quoted for a POSIX shell). */
export function sshCommand(info: TerminalAccessInfo, remote?: string): string {
  const parts = ['ssh']
  if (remote) parts.push('-t')
  if (info.port !== SSH_PORT) parts.push('-p', String(info.port))
  parts.push(posixWord(userAtHost(info)))
  if (remote) parts.push(posixWord(remote))
  return parts.join(' ')
}

/** `ssh://user@host[:port]` (opens the phone's SSH app if it handles ssh:// links). */
export function sshUrl(info: TerminalAccessInfo): string {
  const user = encodeURIComponent(info.user ?? 'you')
  return `ssh://${user}@${info.host ?? 'this-pc'}${info.port !== SSH_PORT ? `:${info.port}` : ''}`
}

// ------------------------------------------------------------ public keys

export const KEY_TYPES = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com'
] as const

export type ParsedKey =
  | { ok: true; type: string; base64: string; comment?: string; line: string }
  | { ok: false; error: string }

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bin = atob(b64)
    const out = new Uint8Array(new ArrayBuffer(bin.length))
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return undefined
  }
}

/**
 * One OpenSSH public key line ("ssh-ed25519 AAAA… comment"). Options before
 * the type (e.g. `command="…"`) are refused, so a pasted line can't change
 * what a login does; the comment is cut down to plain characters.
 */
export function parsePublicKey(text: unknown): ParsedKey {
  if (typeof text !== 'string') return { ok: false, error: 'Paste a public key.' }
  if (text.length > 16_000) return { ok: false, error: 'That is too long for a public key.' }
  if (/PRIVATE KEY/.test(text))
    return {
      ok: false,
      error:
        'That is a private key. Never share it. Paste the public key instead (it starts with ssh-ed25519, ssh-rsa or ecdsa-sha2-).'
    }
  if (/BEGIN SSH2 PUBLIC KEY/.test(text))
    return {
      ok: false,
      error:
        'That is a PuTTY-style key. Export it in OpenSSH format (one line starting with ssh-…).'
    }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return { ok: false, error: 'Paste a public key.' }
  if (lines.length > 1) return { ok: false, error: 'Add one key at a time.' }
  const [type, b64, ...rest] = lines[0].split(/\s+/)
  if (!(KEY_TYPES as readonly string[]).includes(type))
    return {
      ok: false,
      error: 'Not an OpenSSH public key. It should start with ssh-ed25519, ssh-rsa or ecdsa-sha2-.'
    }
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length < 60)
    return { ok: false, error: 'The key is cut off or damaged.' }
  const blob = decodeBase64(b64)
  if (!blob || blob.length < 4) return { ok: false, error: 'The key is cut off or damaged.' }
  const n = (blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]
  const inner = n > 0 && n < 64 ? String.fromCharCode(...blob.slice(4, 4 + n)) : ''
  if (inner !== type) return { ok: false, error: 'The key is cut off or damaged.' }
  const comment =
    rest
      .join(' ')
      .replace(/[^A-Za-z0-9_.@+\-: ]+/g, '')
      .trim()
      .slice(0, 100) || undefined
  return {
    ok: true,
    type,
    base64: b64,
    comment,
    line: comment ? `${type} ${b64} ${comment}` : `${type} ${b64}`
  }
}

/** OpenSSH's fingerprint ("SHA256:…", as `ssh-keygen -l` and SSH apps show it). */
export async function keyFingerprint(base64: string): Promise<string> {
  const blob = decodeBase64(base64) ?? new Uint8Array()
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', blob))
  let bin = ''
  for (const b of digest) bin += String.fromCharCode(b)
  return `SHA256:${btoa(bin).replace(/=+$/, '')}`
}

// ------------------------------------------------------------ the event log

/**
 * Logins in sshd's event log messages ("Accepted publickey for me from
 * 100.101.102.103 port 51234 ssh2: ED25519 SHA256:…"), newest first.
 */
export function parseSshdLogins(events: { at: string; message: string }[]): SshLogin[] {
  const out: SshLogin[] = []
  for (const e of events) {
    const m = /Accepted (publickey|password) for (.+?) from (\S+) port \d+/.exec(e.message)
    if (!m) continue
    out.push({
      at: e.at,
      method: m[1] as SshLogin['method'],
      user: m[2],
      from: m[3],
      fingerprint: /(SHA256:[A-Za-z0-9+/]+)/.exec(e.message)?.[1],
      tailscale: isTailscaleAddress(m[3])
    })
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}
