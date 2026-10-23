// Home Wi-Fi mode: one Windows Firewall rule that lets phones on the same
// private network reach the companion. Only this app's program, only its port
// and LAN address, only from the local subnet, only on the Private profile.
// It's added and removed only after the user confirms (Windows asks for
// administrator rights), and removing it deletes only the rule with our name.

import { execFile } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { win32 } from 'node:path'
import { isAbsoluteWindowsPath, systemExe, systemRoot } from '../core/which'

export const FIREWALL_RULE_NAME = 'Claude Session Dashboard - phone (home Wi-Fi)'

function checkInputs(port: number, address: string, program: string): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Bad port: ${port}`)
  if (!isIPv4(address)) throw new Error(`Bad address: ${address}`)
  if (!isAbsoluteWindowsPath(program) || /["\r\n]/.test(program))
    throw new Error(`Bad program path: ${program}`)
}

export function firewallAddArgs(port: number, address: string, program: string): string[] {
  checkInputs(port, address, program)
  return [
    'advfirewall',
    'firewall',
    'add',
    'rule',
    `name=${FIREWALL_RULE_NAME}`,
    'dir=in',
    'action=allow',
    'protocol=TCP',
    `localport=${port}`,
    `localip=${address}`,
    'remoteip=localsubnet',
    'profile=private',
    `program=${program}`,
    'enable=yes'
  ]
}

export function firewallDeleteArgs(): string[] {
  return ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE_NAME}`]
}

export function firewallShowArgs(): string[] {
  return ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE_NAME}`]
}

/** netsh's own quoting: `key="value with spaces"`. */
export function netshCommandLine(args: string[]): string {
  return args
    .map((a) => {
      if (!/\s/.test(a)) return a
      const eq = a.indexOf('=')
      return eq > 0 ? `${a.slice(0, eq)}="${a.slice(eq + 1)}"` : `"${a}"`
    })
    .join(' ')
}

/** Shown in the confirmation dialog: exactly what will run. */
export function firewallCommandText(args: string[]): string {
  return `netsh ${netshCommandLine(args)}`
}

/**
 * Run netsh elevated (Windows asks for administrator rights). The arguments
 * reach PowerShell only through an environment variable, never as script.
 */
export function runElevatedNetsh(args: string[]): Promise<{ ok: boolean; error?: string }> {
  const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $p = Start-Process -FilePath $env:CSD_NETSH -ArgumentList $env:CSD_NETSH_ARGS -Verb RunAs -Wait -PassThru -WindowStyle Hidden',
    '  exit $p.ExitCode',
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }'
  ].join('\n')
  return new Promise((resolve) => {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 120_000,
        env: {
          ...process.env,
          CSD_NETSH: systemExe('netsh.exe'),
          CSD_NETSH_ARGS: netshCommandLine(args)
        }
      },
      (err, _stdout, stderr) => {
        if (!err) resolve({ ok: true })
        else
          resolve({
            ok: false,
            error:
              (err as NodeJS.ErrnoException & { code?: number }).code === 1223
                ? 'Windows asked for administrator rights and it was declined.'
                : String(stderr).trim() || err.message
          })
      }
    )
  })
}

/** Is our rule there? (Reading rules doesn't need administrator rights.) */
export function firewallRuleExists(): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false)
    execFile(
      systemExe('netsh.exe'),
      firewallShowArgs(),
      { windowsHide: true, timeout: 15_000 },
      (err) => resolve(!err)
    )
  })
}
