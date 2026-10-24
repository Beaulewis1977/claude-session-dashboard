// Running the wizard's scripts, and reading the PC's SSH state.
//
// Scripts run through Windows PowerShell with -EncodedCommand. An elevated
// one is started by a hidden, unelevated PowerShell with `Start-Process -Verb
// RunAs` (Windows shows its administrator prompt); its arguments reach that
// PowerShell only as an environment variable. The probe only reads: services,
// firewall rules, one registry value, sshd_config and sshd's event log.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import type { AccountKind, HostKey } from '@shared/terminal'
import { systemRoot } from '../core/which'
import { encodedCommand, scriptText, type BuiltScript } from './scripts'

export interface RunOutcome {
  ok: boolean
  cancelled?: boolean
  error?: string
  /** It took too long: it may still be running, so whether it changed anything is unknown. */
  unknown?: boolean
  /** Each part's result (`ok`, `error` and whatever the part reported). */
  parts: Record<string, unknown>[]
}

export type ScriptRunner = (s: BuiltScript) => Promise<RunOutcome>

/** What the probe reports (all optional: anything unreadable is left out). */
export interface ProbeResult {
  sshdService?: { status: string; startType: string }
  sshdExe: boolean
  sshdVersion?: string
  /** Our rule exists and is exactly as the wizard made it. */
  oursRule: boolean
  /** Our rule exists but was changed (why). */
  ruleProblem?: string
  /** Other enabled rules that allow sshd in (their names). */
  otherSshRules: string[]
  defaultRule?: { enabled: boolean }
  shell?: string
  /** HKLM\SOFTWARE\OpenSSH\DefaultShellCommandOption, if someone set it. */
  shellOption?: string
  admin: boolean
  /** Which password an SSH login would need (if passwords are on). */
  account?: AccountKind
  tsAlias?: string
  defaultDistro?: string
  /** sshd_config exactly as on disk. */
  config?: Buffer
  configError?: string
  events: { at: string; message: string }[]
  eventsOk: boolean
}

export function powershellExe(): string {
  return win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

/** Windows' command-line limit is 32,767 characters; stay well under it. */
export const MAX_ENCODED = 30_000
/** How long to wait for an elevated script (it may be installing a Windows feature). */
const ELEVATED_WAIT_MS = 60 * 60_000

const ELEVATE = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $p = Start-Process -FilePath $env:CSD_PS -ArgumentList $env:CSD_PS_ARGS -Verb RunAs -Wait -PassThru -WindowStyle Hidden',
  '  exit $p.ExitCode',
  '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }'
].join('\n')

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      powershellExe(),
      args,
      { windowsHide: true, timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        const timedOut = !!err && (err as { killed?: boolean }).killed === true
        resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut })
      }
    )
  })
}

/** Runs scripts for real. `workDir` (in the app's data folder) holds the result files. */
export function realRunner(workDir: string): ScriptRunner {
  return async (s) => {
    const resultFile = join(workDir, `result-${randomBytes(8).toString('hex')}.json`)
    const encoded = encodedCommand(scriptText(s, resultFile))
    if (encoded.length > MAX_ENCODED)
      return { ok: false, error: 'The change is too large to run.', parts: [] }
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workDir, { recursive: true })
    // An elevated script can't be stopped from here (it isn't our process), so
    // wait long; if even that runs out, the result is unknown, not "failed".
    const r = s.elevate
      ? await run(
          ['-NoProfile', '-NonInteractive', '-Command', ELEVATE],
          {
            ...process.env,
            CSD_PS: powershellExe(),
            CSD_PS_ARGS: [...PS_FLAGS, '-WindowStyle', 'Hidden', '-EncodedCommand', encoded].join(
              ' '
            )
          },
          Math.max(s.timeoutMs, ELEVATED_WAIT_MS)
        )
      : await run([...PS_FLAGS, '-EncodedCommand', encoded], process.env, s.timeoutMs)
    let parts: Record<string, unknown>[] = []
    try {
      const j = JSON.parse(await readFile(resultFile, 'utf8')) as {
        parts?: Record<string, Record<string, unknown>>
      }
      parts = s.parts.map((_, i) => j.parts?.[String(i)] ?? { ok: false })
    } catch {
      // No result file: the script never ran (declined) or stopped early.
    } finally {
      await unlink(resultFile).catch(() => undefined)
    }
    if (r.timedOut && !parts.length)
      return {
        ok: false,
        unknown: true,
        error:
          'It took too long to answer and may still be running as administrator. Check again in a minute: the wizard reads the PC again.',
        parts
      }
    if (r.code === 1223)
      return {
        ok: false,
        cancelled: true,
        error: 'Windows asked for administrator rights and it was declined.',
        parts
      }
    const failed = parts.find((p) => p.ok === false && typeof p.error === 'string')
    if (r.code !== 0 || !parts.length)
      return {
        ok: false,
        error:
          (failed?.error as string | undefined) ??
          (r.stderr.trim().slice(0, 400) || `It stopped with code ${r.code}.`),
        parts
      }
    return { ok: parts.every((p) => p.ok !== false), parts }
  }
}

export const PROBE = `$ErrorActionPreference = 'SilentlyContinue'
$o = @{ events = @(); eventsOk = $false }
$svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
if ($svc) { $o.sshdService = @{ status = [string]$svc.Status; startType = [string]$svc.StartType } }
$exe = Join-Path $env:SystemRoot 'System32\\OpenSSH\\sshd.exe'
$o.sshdExe = Test-Path -LiteralPath $exe
if ($o.sshdExe) { $o.sshdVersion = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }
$fw = Get-NetFirewallRule -Name 'CSD-SSH-Tailscale' -ErrorAction SilentlyContinue
if ($fw) {
  $o.ours = @{
    enabled = ([string]$fw.Enabled -eq 'True'); action = [string]$fw.Action; direction = [string]$fw.Direction
    remote = @(($fw | Get-NetFirewallAddressFilter).RemoteAddress | ForEach-Object { [string]$_ })
    iface = @(($fw | Get-NetFirewallInterfaceFilter).InterfaceAlias | ForEach-Object { [string]$_ })
    port = @(($fw | Get-NetFirewallPortFilter).LocalPort | ForEach-Object { [string]$_ })
    program = [string]($fw | Get-NetFirewallApplicationFilter).Program
  }
}
# Other enabled rules that let sshd in (besides ours and Windows' default, checked by name).
$o.otherSsh = @(Get-NetFirewallApplicationFilter -Program '*\\OpenSSH\\sshd.exe' -ErrorAction SilentlyContinue |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Name -ne 'CSD-SSH-Tailscale' -and $_.Name -ne 'OpenSSH-Server-In-TCP' } |
  ForEach-Object { [string]$_.DisplayName })
$d = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($d) { $o.defaultRule = @{ enabled = ([string]$d.Enabled -eq 'True') } }
$o.shell = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
$o.shellOption = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShellCommandOption -ErrorAction SilentlyContinue).DefaultShellCommandOption
$o.admin = [bool]((& (Join-Path $env:SystemRoot 'System32\\whoami.exe') /groups /fo csv /nh) -match 'S-1-5-32-544')
$o.account = [string](Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue).PrincipalSource
$o.tsAlias = [string](Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -like 'Tailscale*' } | Select-Object -First 1).Name
$lx = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
$g = (Get-ItemProperty -Path $lx -ErrorAction SilentlyContinue).DefaultDistribution
if ($g) { $o.defaultDistro = [string](Get-ItemProperty -Path (Join-Path $lx $g) -ErrorAction SilentlyContinue).DistributionName }
try { $o.configB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $env:ProgramData 'ssh\\sshd_config'))) } catch { $o.configError = $_.Exception.Message }
try {
  $o.events = @(Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 300 -ErrorAction Stop |
    Where-Object { $_.Message -like '*Accepted *' } | Select-Object -First 20 |
    ForEach-Object { @{ at = $_.TimeCreated.ToUniversalTime().ToString('o'); message = [string]$_.Message } })
  $o.eventsOk = $true
} catch { $o.eventsOk = ($_.Exception.Message -like '*No events*') }
$o | ConvertTo-Json -Compress -Depth 5`

/** Read the PC's SSH state as the user (no administrator rights needed). */
export async function realProbe(): Promise<ProbeResult> {
  const r = await run([...PS_FLAGS, '-EncodedCommand', encodedCommand(PROBE)], process.env, 30_000)
  return parseProbe(r.stdout)
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => String(x))

/**
 * Is our rule still exactly what the wizard made? Enabled, inbound, allow,
 * sshd.exe only, port 22 only, Tailscale's ranges only, on its adapter only.
 * A rule that was switched off or widened by hand doesn't count.
 */
export function ruleCheck(
  raw: unknown,
  tsAlias: string | undefined
): { oursRule: boolean; ruleProblem?: string } {
  if (!raw || typeof raw !== 'object') return { oursRule: false }
  const r = raw as Record<string, unknown>
  const remote = list(r.remote).map((a) => a.replace('/255.192.0.0', '/10').toLowerCase())
  const want = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']
  const problems = [
    r.enabled !== true && 'it is turned off',
    (r.action !== 'Allow' || r.direction !== 'Inbound') && 'it is not an inbound allow rule',
    !/\\OpenSSH\\sshd\.exe$/i.test(String(r.program ?? '')) && 'it is not limited to sshd.exe',
    list(r.port).join(',') !== '22' && 'it is not limited to port 22',
    (remote.length !== want.length || !want.every((w) => remote.includes(w))) &&
      'it allows addresses outside Tailscale',
    (list(r.iface).length !== 1 || !tsAlias || list(r.iface)[0] !== tsAlias) &&
      'it is not limited to the Tailscale adapter'
  ].filter(Boolean)
  return problems.length
    ? {
        oursRule: false,
        ruleProblem: `The app's firewall rule was changed: ${problems.join(', ')}.`
      }
    : { oursRule: true }
}

/** Get-LocalUser's PrincipalSource: which password an SSH login needs. */
export function accountKind(source: string | undefined): AccountKind | undefined {
  if (!source) return undefined
  if (/^Local$/i.test(source)) return 'local'
  if (/^MicrosoftAccount$/i.test(source)) return 'microsoft'
  return 'other'
}

// The PC's own SSH host keys, as an SSH app shows them when it first connects.
// Read from the running server (the key files themselves are administrator-only).
const HOST_KEYS = `$ErrorActionPreference = 'SilentlyContinue'
$dir = Join-Path $env:SystemRoot 'System32\\OpenSSH'
$keys = & (Join-Path $dir 'ssh-keyscan.exe') -T 5 -t ed25519,ecdsa,rsa 127.0.0.1 2>$null
if ($keys) { $keys | & (Join-Path $dir 'ssh-keygen.exe') -l -f - 2>$null }`

/** "256 SHA256:… 127.0.0.1 (ED25519)" lines → type and fingerprint. */
export function parseHostKeys(text: string): HostKey[] {
  const out: HostKey[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\d+\s+(SHA256:[A-Za-z0-9+/]+)\s+\S+\s+\((\w+)\)\s*$/.exec(line.trim())
    if (m) out.push({ type: m[2], fingerprint: m[1] })
  }
  return out
}

export async function realHostKeys(): Promise<HostKey[]> {
  const r = await run(
    [...PS_FLAGS, '-EncodedCommand', encodedCommand(HOST_KEYS)],
    process.env,
    20_000
  )
  return parseHostKeys(r.stdout)
}

export function parseProbe(text: string): ProbeResult {
  let j: Record<string, unknown> = {}
  try {
    j = JSON.parse(text.trim() || '{}') as Record<string, unknown>
  } catch {
    // Treated as "nothing could be read".
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const svc = j.sshdService as { status?: unknown; startType?: unknown } | undefined
  const events = Array.isArray(j.events) ? j.events : j.events ? [j.events] : []
  return {
    sshdService:
      svc && typeof svc.status === 'string'
        ? { status: svc.status, startType: String(svc.startType ?? '') }
        : undefined,
    sshdExe: j.sshdExe === true,
    sshdVersion: str(j.sshdVersion),
    ...ruleCheck(j.ours, str(j.tsAlias)),
    otherSshRules: (Array.isArray(j.otherSsh) ? j.otherSsh : j.otherSsh ? [j.otherSsh] : []).filter(
      (x): x is string => typeof x === 'string' && !!x
    ),
    defaultRule:
      j.defaultRule && typeof j.defaultRule === 'object'
        ? { enabled: (j.defaultRule as { enabled?: unknown }).enabled === true }
        : undefined,
    shell: str(j.shell),
    shellOption: str(j.shellOption),
    admin: j.admin === true,
    account: accountKind(str(j.account)),
    tsAlias: str(j.tsAlias),
    defaultDistro: str(j.defaultDistro),
    config: typeof j.configB64 === 'string' ? Buffer.from(j.configB64, 'base64') : undefined,
    configError: str(j.configError),
    events: events
      .filter(
        (e): e is { at: string; message: string } =>
          !!e && typeof e.at === 'string' && typeof e.message === 'string'
      )
      .slice(0, 50),
    eventsOk: j.eventsOk === true
  }
}
