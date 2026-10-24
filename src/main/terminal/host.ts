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
import { systemRoot } from '../core/which'
import { encodedCommand, scriptText, type BuiltScript } from './scripts'

export interface RunOutcome {
  ok: boolean
  cancelled?: boolean
  error?: string
  /** Each part's result (`ok`, `error` and whatever the part reported). */
  parts: Record<string, unknown>[]
}

export type ScriptRunner = (s: BuiltScript) => Promise<RunOutcome>

/** What the probe reports (all optional: anything unreadable is left out). */
export interface ProbeResult {
  sshdService?: { status: string; startType: string }
  sshdExe: boolean
  sshdVersion?: string
  oursRule: boolean
  defaultRule?: { enabled: boolean }
  shell?: string
  admin: boolean
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
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      powershellExe(),
      args,
      { windowsHide: true, timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
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
          s.timeoutMs
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

const PROBE = `$ErrorActionPreference = 'SilentlyContinue'
$o = @{ events = @(); eventsOk = $false }
$svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
if ($svc) { $o.sshdService = @{ status = [string]$svc.Status; startType = [string]$svc.StartType } }
$exe = Join-Path $env:SystemRoot 'System32\\OpenSSH\\sshd.exe'
$o.sshdExe = Test-Path -LiteralPath $exe
if ($o.sshdExe) { $o.sshdVersion = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion }
$o.oursRule = [bool](Get-NetFirewallRule -Name 'CSD-SSH-Tailscale' -ErrorAction SilentlyContinue)
$d = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($d) { $o.defaultRule = @{ enabled = ([string]$d.Enabled -eq 'True') } }
$o.shell = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
$o.admin = [bool]((& (Join-Path $env:SystemRoot 'System32\\whoami.exe') /groups /fo csv /nh) -match 'S-1-5-32-544')
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
    oursRule: j.oursRule === true,
    defaultRule:
      j.defaultRule && typeof j.defaultRule === 'object'
        ? { enabled: (j.defaultRule as { enabled?: unknown }).enabled === true }
        : undefined,
    shell: str(j.shell),
    admin: j.admin === true,
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
