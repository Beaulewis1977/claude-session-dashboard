// The system changes the terminal-access wizard can make, as fixed PowerShell
// scripts. Each one is shown to the user before it runs (Windows then asks
// for administrator rights) and has an undo.
//
// A script's inputs (a key, a path, a start type) are never pasted into the
// script text: they travel as base64-encoded JSON that the script decodes into
// `$q`, so nothing in them can be read as PowerShell. The script writes its
// result as JSON to a file in the app's data folder.

import { win32 } from 'node:path'
import { isAbsoluteWindowsPath } from '../core/which'

export const SSH_RULE_NAME = 'CSD-SSH-Tailscale'
export const SSH_RULE_DISPLAY = 'Claude Session Dashboard - SSH (Tailscale only)'
/** Windows' own rule, added when OpenSSH Server is installed: TCP 22 from any address. */
export const DEFAULT_SSH_RULE = 'OpenSSH-Server-In-TCP'
/** Tailscale's address ranges: IPv4 CGNAT and its IPv6 ULA prefix. */
export const TAILSCALE_RANGES = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']

export const START_TYPES = ['Automatic', 'Manual', 'Disabled'] as const
export type StartType = (typeof START_TYPES)[number]

export interface ScriptPart {
  /** What this part does, in a few words (also the key for its result). */
  name: string
  body: string
  params: Record<string, unknown>
}

export interface BuiltScript {
  title: string
  /** Plain-language explanation shown above the script. */
  summary: string
  /** One part, or several for "Turn off" (each runs even if another fails). */
  parts: ScriptPart[]
  elevate: boolean
  timeoutMs: number
}

const SSHD = '"$env:SystemRoot\\System32\\OpenSSH\\sshd.exe"'
const REG = "'HKLM:\\SOFTWARE\\OpenSSH'"

// ---------------------------------------------------------------- bodies

const INSTALL = `$cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1
if (-not $cap) { throw 'OpenSSH Server is not offered for this version of Windows.' }
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null; $out.installed = $true }`

const UNINSTALL = `Stop-Service -Name sshd -ErrorAction SilentlyContinue
$cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' -and $_.State -eq 'Installed' } | Select-Object -First 1
if ($cap) { Remove-WindowsCapability -Online -Name $cap.Name | Out-Null }`

const SERVICE_ON = `Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd`

const SERVICE_SET = `Set-Service -Name sshd -StartupType $q.StartType
if ($q.Running) { Start-Service -Name sshd } else {
  Stop-Service -Name sshd -Force
  # Turn off relies on this: Windows' broad rule is only put back once sshd has stopped.
  if ((Get-Service -Name sshd).Status -ne 'Stopped') { throw 'sshd did not stop.' }
}`

const FIREWALL_ADD = `Get-NetFirewallRule -Name $q.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$rule = @{
  Name = $q.Name; DisplayName = $q.DisplayName; Description = $q.Description
  Direction = 'Inbound'; Action = 'Allow'; Protocol = 'TCP'; LocalPort = $q.Port
  RemoteAddress = [string[]]$q.Remote; Program = $q.Program; Profile = 'Any'
}
if (-not (Get-NetAdapter -Name $q.Interface -ErrorAction SilentlyContinue)) { throw "The network adapter '$($q.Interface)' isn't there." }
$rule.InterfaceAlias = $q.Interface
New-NetFirewallRule @rule | Out-Null`

const FIREWALL_REMOVE = `Get-NetFirewallRule -Name $q.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule`

const RULE_DISABLE = `Disable-NetFirewallRule -Name $q.Name`
const RULE_ENABLE = `# During Turn off: never re-open the broad rule while sshd still runs.
if ($q.RequireStopped -and (Get-Service -Name sshd -ErrorAction SilentlyContinue).Status -eq 'Running') { throw 'sshd is still running, so Windows''s "any address" rule stays off.' }
Enable-NetFirewallRule -Name $q.Name`

const SHELL_SET = `if (-not (Test-Path ${REG})) { New-Item -Path ${REG} -Force | Out-Null }
New-ItemProperty -Path ${REG} -Name DefaultShell -Value $q.Shell -PropertyType String -Force | Out-Null`

const SHELL_REMOVE = `Remove-ItemProperty -Path ${REG} -Name DefaultShell -ErrorAction SilentlyContinue`

const KEY_ADD = `$enc = New-Object System.Text.UTF8Encoding $false
$dir = Split-Path -Parent $q.File
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$text = if (Test-Path -LiteralPath $q.File) { [IO.File]::ReadAllText($q.File) } else { '' }
$have = @($text -split "\`r?\`n" | Where-Object { $_.Contains(' ' + $q.Blob) }).Count -gt 0
if (-not $have) {
  $sep = if ($text.Length -gt 0 -and -not $text.EndsWith("\`n")) { "\`r\`n" } else { '' }
  [IO.File]::AppendAllText($q.File, $sep + $q.Line + "\`r\`n", $enc)
  $out.appended = $true
}
$out.already = $have
if ($q.Admin) {
  # Exactly what OpenSSH requires: SYSTEM and Administrators, full control, nothing inherited or extra.
  $acl = Get-Acl -LiteralPath $q.File
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($r in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($r) }
  foreach ($sid in 'S-1-5-32-544', 'S-1-5-18') {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', 'Allow')))
  }
  Set-Acl -LiteralPath $q.File -AclObject $acl
}`

const KEY_REMOVE = `$enc = New-Object System.Text.UTF8Encoding $false
$out.removed = 0
if (Test-Path -LiteralPath $q.File) {
  $parts = [IO.File]::ReadAllText($q.File) -split "(?<=\`n)"
  $kept = @($parts | Where-Object { $_.Trim() -ne $q.Line })
  $out.removed = $parts.Count - $kept.Count
  if ($out.removed -gt 0) { [IO.File]::WriteAllText($q.File, (-join $kept), $enc) }
}`

const CONFIG_WRITE = `$cfg = Join-Path $env:ProgramData 'ssh\\sshd_config'
$cur = [IO.File]::ReadAllBytes($cfg)
$hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($cur)) -replace '-', '').ToLower()
if ($hash -ne $q.Expect) { throw 'sshd_config changed since it was read, so nothing was changed. Try again.' }
$new = [Convert]::FromBase64String($q.Content)
$tmp = "$cfg.csd-check"
[IO.File]::WriteAllBytes($tmp, $new)
$check = & ${SSHD} -t -f $tmp 2>&1
$code = $LASTEXITCODE
Remove-Item -LiteralPath $tmp -Force
if ($code -ne 0) { throw "sshd rejected the new settings: $check" }
[IO.File]::WriteAllBytes($cfg, $new)
$out.written = $true
# The file is changed now: a failed restart is reported, not treated as "nothing changed".
# If sshd can't restart, its old settings may still be in force: that's a failure (the Undo record stays).
try { if ((Get-Service -Name sshd).Status -eq 'Running') { Restart-Service -Name sshd } } catch { $out.restartError = $_.Exception.Message; throw "The file was changed, but sshd didn't restart: $($_.Exception.Message)" }`

// ---------------------------------------------------------------- builders

function one(
  title: string,
  summary: string,
  name: string,
  body: string,
  params: Record<string, unknown> = {},
  timeoutMs = 120_000
): BuiltScript {
  return { title, summary, parts: [{ name, body, params }], elevate: true, timeoutMs }
}

export function installScript(): BuiltScript {
  return one(
    'Install OpenSSH Server?',
    'Installs Windows’ own OpenSSH Server (an optional Windows feature from Microsoft). It can take a few minutes. Installing it also adds a Windows Firewall rule that allows SSH from any address; the next steps limit SSH to Tailscale.',
    'install',
    INSTALL,
    {},
    15 * 60_000
  )
}

export function uninstallScript(): BuiltScript {
  return one(
    'Uninstall OpenSSH Server?',
    'Stops sshd and removes the OpenSSH Server Windows feature that the wizard installed. Your keys and sshd_config in C:\\ProgramData\\ssh stay where they are.',
    'uninstall',
    UNINSTALL,
    {},
    15 * 60_000
  )
}

export function serviceOnScript(): BuiltScript {
  return one(
    'Start OpenSSH Server?',
    'Starts the sshd service and sets it to start automatically with Windows. Undo puts the start type back to what it was and stops it.',
    'service',
    SERVICE_ON
  )
}

/** Put the sshd service to a start type, running or stopped (Undo, Turn off). */
export function serviceSetScript(startType: StartType, running: boolean, why: string): BuiltScript {
  if (!START_TYPES.includes(startType)) throw new Error(`Bad start type: ${startType}`)
  if (running && startType === 'Disabled') throw new Error("A disabled service can't run.")
  const what = running
    ? `Sets the sshd service's start type back to ${startType} and leaves it running, as it was.`
    : `Stops the sshd service and sets its start type to ${startType}.`
  return one(
    why === 'undo'
      ? 'Undo: put the OpenSSH Server service back?'
      : running
        ? 'Put the OpenSSH Server service back?'
        : 'Stop OpenSSH Server?',
    what,
    'service',
    SERVICE_SET,
    { StartType: startType, Running: running }
  )
}

export function sshdExe(systemRoot: string): string {
  return win32.join(systemRoot, 'System32', 'OpenSSH', 'sshd.exe')
}

/** Adapter names are free text; only what Windows itself allows in one is accepted. */
export function validAdapterName(name: string | undefined): name is string {
  return !!name && /^[\p{L}\p{N} ._()#-]{1,64}$/u.test(name)
}

export function firewallAddScript(opts: {
  program: string
  interfaceAlias: string
  port?: number
}): BuiltScript {
  const port = opts.port ?? 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Bad port: ${port}`)
  if (!isAbsoluteWindowsPath(opts.program) || /["\r\n]/.test(opts.program))
    throw new Error(`Bad program path: ${opts.program}`)
  // Without the adapter, another network using 100.64.0.0/10 (carrier NAT) could reach SSH.
  if (!validAdapterName(opts.interfaceAlias))
    throw new Error('The Tailscale network adapter wasn’t found, so no rule was added.')
  const iface = opts.interfaceAlias
  return one(
    'Allow SSH from Tailscale only?',
    `Adds one inbound Windows Firewall rule, “${SSH_RULE_DISPLAY}”: only sshd.exe, only TCP port ${port}, only from Tailscale addresses (${TAILSCALE_RANGES.join(', ')}), only on the “${iface}” network adapter. Undo removes just this rule.`,
    'firewall',
    FIREWALL_ADD,
    {
      Name: SSH_RULE_NAME,
      DisplayName: SSH_RULE_DISPLAY,
      Description: 'Added by Claude Session Dashboard (Settings → Phone → Terminal access).',
      Port: String(port),
      Remote: TAILSCALE_RANGES,
      Program: opts.program,
      Interface: iface
    }
  )
}

export function firewallRemoveScript(): BuiltScript {
  return one(
    'Remove the Tailscale SSH rule?',
    `Removes only the rule the app added (“${SSH_RULE_DISPLAY}”). Other rules stay as they are.`,
    'firewall',
    FIREWALL_REMOVE,
    { Name: SSH_RULE_NAME }
  )
}

export function defaultRuleScript(enable: boolean, requireStopped = false): BuiltScript {
  return enable
    ? one(
        'Turn Windows’ default SSH rule back on?',
        `Turns the rule “OpenSSH SSH Server (sshd)” (${DEFAULT_SSH_RULE}) back on, as it was before. It allows SSH from any address.`,
        'default-rule',
        RULE_ENABLE,
        { Name: DEFAULT_SSH_RULE, RequireStopped: requireStopped }
      )
    : one(
        'Turn off Windows’ default SSH rule?',
        `Windows added “OpenSSH SSH Server (sshd)” (${DEFAULT_SSH_RULE}) when OpenSSH was installed. It allows SSH from any address, so other devices on your network could try to log in. This turns it off (it isn’t deleted); Undo turns it back on.`,
        'default-rule',
        RULE_DISABLE,
        { Name: DEFAULT_SSH_RULE }
      )
}

export function shellSetScript(
  shell: string,
  label: string,
  prev: string | undefined
): BuiltScript {
  if (!isAbsoluteWindowsPath(shell) || /["\r\n]/.test(shell))
    throw new Error(`Bad shell path: ${shell}`)
  return one(
    `Use ${label} for SSH logins?`,
    `Sets the registry value HKLM\\SOFTWARE\\OpenSSH\\DefaultShell to ${shell}. It is ${prev ? `now ${prev}` : 'not set now (so SSH logins get cmd.exe)'}; Undo puts that back.`,
    'shell',
    SHELL_SET,
    { Shell: shell }
  )
}

export function shellRestoreScript(prev: string | undefined): BuiltScript {
  if (prev !== undefined && (!isAbsoluteWindowsPath(prev) || /["\r\n]/.test(prev)))
    throw new Error(`Bad shell path: ${prev}`)
  return prev
    ? one(
        'Put the previous SSH shell back?',
        `Sets HKLM\\SOFTWARE\\OpenSSH\\DefaultShell back to ${prev}.`,
        'shell',
        SHELL_SET,
        { Shell: prev }
      )
    : one(
        'Put the previous SSH shell back?',
        'Removes HKLM\\SOFTWARE\\OpenSSH\\DefaultShell (it wasn’t set before), so SSH logins get cmd.exe again.',
        'shell',
        SHELL_REMOVE
      )
}

export function keyAddScript(opts: {
  file: string
  line: string
  blob: string
  admin: boolean
  fingerprint: string
}): BuiltScript {
  if (!isAbsoluteWindowsPath(opts.file)) throw new Error(`Bad key file: ${opts.file}`)
  const s = one(
    'Add this SSH key?',
    `Adds one line to ${opts.file} so the device with this key can log in:\n${opts.fingerprint}\n\nExisting keys are kept.${opts.admin ? ' The file’s permissions are set to Administrators and SYSTEM only, as OpenSSH requires for administrator accounts.' : ''}`,
    'key',
    KEY_ADD,
    {
      File: opts.file,
      Line: opts.line,
      Blob: opts.blob,
      Admin: opts.admin,
      Fingerprint: opts.fingerprint
    }
  )
  return { ...s, elevate: opts.admin }
}

export function keyRemoveScript(opts: {
  file: string
  line: string
  admin: boolean
  fingerprint: string
}): BuiltScript {
  if (!isAbsoluteWindowsPath(opts.file)) throw new Error(`Bad key file: ${opts.file}`)
  const s = one(
    'Remove this SSH key?',
    `Removes only the line the app added to ${opts.file}:\n${opts.fingerprint}\n\nEvery other key stays.`,
    'key',
    KEY_REMOVE,
    { File: opts.file, Line: opts.line }
  )
  return { ...s, elevate: opts.admin }
}

/** Replace sshd_config with `content`, only if it still is what was read (hash `expect`). */
export function configWriteScript(opts: {
  title: string
  summary: string
  content: Buffer
  expect: string
}): BuiltScript {
  if (!/^[0-9a-f]{64}$/.test(opts.expect)) throw new Error('Bad hash')
  return one(opts.title, opts.summary, 'sshd-config', CONFIG_WRITE, {
    Content: opts.content.toString('base64'),
    Expect: opts.expect
  })
}

/** "Turn off": several parts in one elevated run; each runs even if another fails. */
export function combine(title: string, summary: string, scripts: BuiltScript[]): BuiltScript {
  return {
    title,
    summary,
    parts: scripts.flatMap((s) => s.parts),
    elevate: scripts.some((s) => s.elevate),
    timeoutMs: Math.max(120_000, ...scripts.map((s) => s.timeoutMs))
  }
}

// ---------------------------------------------------------------- the script

function b64json(v: unknown): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64')
}

/** The full script that runs. `resultFile` must be in the app's data folder. */
export function scriptText(s: BuiltScript, resultFile: string): string {
  const head = [
    "$ErrorActionPreference = 'Stop'",
    // Only Windows' own modules: an elevated script must not auto-load a command from the user's
    // module folder (which a program running as the user could write to).
    "$env:PSModulePath = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules'",
    `$all = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64json({ resultFile, parts: s.parts.map((p) => p.params) })}')) | ConvertFrom-Json`,
    '$res = @{ ok = $true; parts = @{} }'
  ]
  const parts = s.parts.map((p, i) =>
    [
      `# ---- ${p.name}`,
      `$q = $all.parts[${i}]; $out = @{ ok = $true }`,
      'try {',
      p.body.replace(/^/gm, '  '),
      '} catch { $out.ok = $false; $out.error = $_.Exception.Message; $res.ok = $false }',
      `$res.parts['${i}'] = $out`
    ].join('\n')
  )
  const tail = [
    '$enc = New-Object System.Text.UTF8Encoding $false',
    '[IO.File]::WriteAllText($all.resultFile, ($res | ConvertTo-Json -Compress -Depth 6), $enc)',
    'if (-not $res.ok) { exit 1 }'
  ]
  return [...head, ...parts, ...tail].join('\n')
}

/** What the confirmation dialog shows: the inputs, then exactly the commands that run. */
export function shownText(s: BuiltScript): string {
  const blocks = s.parts.map((p) => {
    const inputs = Object.entries(p.params)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => {
        const val = Array.isArray(v) ? v.join(', ') : String(v)
        return `$q.${k} = ${k === 'Content' ? '(the new sshd_config: the changed lines are listed above)' : val.length > 90 ? `${val.slice(0, 60)}…${val.slice(-20)}` : val}`
      })
    return [`# ${p.name}`, ...inputs, p.body].join('\n')
  })
  return `${s.elevate ? 'Runs as administrator (Windows asks first):' : 'Runs as you:'}\n\n${blocks.join('\n\n')}`
}

/** -EncodedCommand: the script as base64 UTF-16LE (nothing in it is parsed by another shell). */
export function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}
