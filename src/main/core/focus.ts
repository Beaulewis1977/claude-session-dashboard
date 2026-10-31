// "Focus terminal": bring a running session's terminal window (and its
// Windows Terminal tab, when it can be found) to the front.
//
// Windows only, best effort:
//   1. From the Claude process (Windows sessions), walk up its parents to the
//      first one with a window: Windows Terminal, or a classic console.
//   2. In Windows Terminal, pick the tab whose title holds the session's name
//      (Claude Code puts it there) with UI Automation.
//   3. Otherwise (WSL sessions, or a terminal started elsewhere) look through
//      all terminal windows for that title.
// The PID and titles reach PowerShell only as environment variables (the
// titles base64-encoded), never as script text. Nothing is typed into or
// changed in the terminal.

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import type { FocusResult } from '@shared/live'
import { systemRoot } from './which'

export interface FocusRequest {
  /** The Claude Code process (Windows sessions only). */
  pid?: number
  /** Titles the tab or window may carry, best first. */
  titles: string[]
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CsdWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static IntPtr[] Terminals() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        var c = ClassOf(h);
        if (c == "CASCADIA_HOSTING_WINDOW_CLASS" || c == "ConsoleWindowClass") list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    // A tap of Alt lets this process hand the focus over (Windows' foreground rules).
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(h);
  }
}
'@

function Out-Result($ok, $how, $why) {
  [Console]::Out.WriteLine((@{ ok = $ok; how = $how; why = $why } | ConvertTo-Json -Compress))
  exit 0
}

$titles = @()
if ($env:CSD_FOCUS_TITLES) {
  $titles = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CSD_FOCUS_TITLES)) -split "\n" |
    Where-Object { $_.Trim().Length -ge 3 } | ForEach-Object { $_.Trim() }
}
function Test-Title([string]$t) {
  foreach ($c in $titles) { if ($t.IndexOf($c, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true } }
  return $false
}

function Select-Tab([IntPtr]$h) {
  if (-not $titles.Count) { return $false }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem)
    foreach ($tab in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
      if (Test-Title $tab.Current.Name) {
        $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        return $true
      }
    }
  } catch { }
  return $false
}

# 1. Up from the Claude process to the first parent with a window.
$start = 0
if ($env:CSD_FOCUS_PID -match '^\d+$') { $start = [int]$env:CSD_FOCUS_PID }
if ($start -gt 0) {
  $parent = @{}
  foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)) {
    $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId
  }
  $cur = $start
  for ($i = 0; $i -lt 16 -and $cur -gt 0; $i++) {
    $gp = Get-Process -Id $cur -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
      $h = $gp.MainWindowHandle
      $tab = $false
      if ([CsdWin]::ClassOf($h) -eq 'CASCADIA_HOSTING_WINDOW_CLASS') { $tab = Select-Tab $h }
      [void][CsdWin]::Focus($h)
      Out-Result $true ($(if ($tab) { 'tab' } else { 'window' })) $null
    }
    if (-not $parent.ContainsKey($cur)) { break }
    $cur = $parent[$cur]
  }
}

# 2. Any terminal window with the session's title (or a tab with it).
foreach ($h in [CsdWin]::Terminals()) {
  if ([CsdWin]::ClassOf($h) -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
    if (Select-Tab $h) { [void][CsdWin]::Focus($h); Out-Result $true 'tab' $null }
  } elseif (Test-Title ([CsdWin]::TitleOf($h))) {
    [void][CsdWin]::Focus($h); Out-Result $true 'window' $null
  }
}
Out-Result $false $null 'not-found'
`

const NOT_FOUND =
  "Couldn't find its terminal window. It may run in VS Code, an IDE or a terminal the app can't see (for a WSL session, give it a name with /rename so its tab can be found). Copy the resume command or open it on your phone instead."

/** Bring the session's terminal forward. Windows only; elsewhere it says so. */
export function focusTerminal(
  req: FocusRequest,
  opts: { simulate?: boolean } = {}
): Promise<FocusResult> {
  if (opts.simulate)
    return Promise.resolve({
      ok: false,
      simulated: true,
      error: 'Fixtures mode: no terminal to focus.'
    })
  if (process.platform !== 'win32')
    return Promise.resolve({ ok: false, error: 'Focusing a terminal works on Windows only.' })
  const titles = [
    ...new Set(
      req.titles.map((t) => t.replace(/[\r\n]+/g, ' ').trim()).filter((t) => t.length >= 3)
    )
  ]
  const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        windowsHide: true,
        timeout: 20_000,
        env: {
          ...process.env,
          CSD_FOCUS_PID: req.pid && Number.isInteger(req.pid) ? String(req.pid) : '',
          CSD_FOCUS_TITLES: Buffer.from(titles.slice(0, 5).join('\n'), 'utf8').toString('base64')
        }
      },
      (err, stdout) => {
        const line = String(stdout ?? '')
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.trim().startsWith('{'))
        try {
          const r = JSON.parse(line ?? '') as { ok?: boolean; how?: string }
          if (r.ok) return resolve({ ok: true, how: r.how === 'tab' ? 'tab' : 'window' })
          return resolve({ ok: false, error: NOT_FOUND })
        } catch {
          resolve({
            ok: false,
            error: err ? `Couldn't focus the terminal: ${err.message}` : NOT_FOUND
          })
        }
      }
    )
  })
}
