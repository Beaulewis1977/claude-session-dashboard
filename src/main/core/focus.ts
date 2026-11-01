// "Focus terminal": bring a running session's terminal window (and its
// Windows Terminal tab, when it can be told apart) to the front.
//
// Windows only, in two steps:
//   1. A PowerShell lists the terminal windows (Windows Terminal and classic
//      consoles) with their tabs, and the window the session's own Claude
//      process belongs to (walking up its parent processes).
//   2. pickFocusTarget (pure, tested) chooses: the tab whose title is exactly
//      the session's name (Claude Code puts it there, after a status glyph).
//      Two tabs with that name is ambiguous and nothing is guessed; a name
//      that only appears inside a longer title ("foo" in "foobar") never
//      counts. Then a second PowerShell selects that tab (checking its name
//      again) and brings the window forward.
// Inputs reach PowerShell only as environment variables (names base64), never
// as script text. Nothing is typed into or changed in a terminal.

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import type { FocusResult } from '@shared/live'
import { systemRoot } from './which'

export interface FocusRequest {
  /** The Claude Code process (Windows sessions only). */
  pid?: number
  /** Names the tab or window may carry, best first. */
  titles: string[]
}

export interface TermWindow {
  hwnd: number
  /** CASCADIA_HOSTING_WINDOW_CLASS (Windows Terminal) or ConsoleWindowClass. */
  cls: string
  title: string
  /** Tab names, in order (Windows Terminal only). */
  tabs: string[]
}

export interface TermList {
  /** The window of the session's own process, if found. */
  ancestor?: number
  windows: TermWindow[]
}

export type FocusPick =
  { hwnd: number; tab?: number; tabName?: string } | { error: 'ambiguous' | 'not-found' }

const WT = 'CASCADIA_HOSTING_WINDOW_CLASS'

/**
 * A title as compared: without the status glyph Claude Code puts in front
 * ("◑ ", "✳ "), spaces collapsed, case ignored.
 */
export function normalizeTitle(s: string): string {
  return s
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Which window and tab to bring forward (exact names only; ambiguity is reported). */
export function pickFocusTarget(list: TermList, titles: string[]): FocusPick {
  const names = [...new Set(titles.map(normalizeTitle).filter((t) => t.length >= 3))]
  const tabsOf = (w: TermWindow, name: string): number[] =>
    w.tabs.map((t, i) => (normalizeTitle(t) === name ? i : -1)).filter((i) => i >= 0)

  const own = list.windows.find((w) => w.hwnd === list.ancestor)
  if (own) {
    // Its own window is certain; pick a tab only when exactly one has the name.
    if (own.cls === WT)
      for (const name of names) {
        const hits = tabsOf(own, name)
        if (hits.length === 1) return { hwnd: own.hwnd, tab: hits[0], tabName: own.tabs[hits[0]] }
        if (hits.length > 1) break
      }
    return { hwnd: own.hwnd }
  }
  for (const name of names) {
    const hits: { hwnd: number; tab?: number; tabName?: string }[] = []
    for (const w of list.windows) {
      if (w.cls === WT)
        for (const i of tabsOf(w, name)) hits.push({ hwnd: w.hwnd, tab: i, tabName: w.tabs[i] })
      else if (normalizeTitle(w.title) === name) hits.push({ hwnd: w.hwnd })
    }
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return { error: 'ambiguous' }
  }
  return { error: 'not-found' }
}

const WIN32 = String.raw`
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
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string TitleOf(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static bool Exists(IntPtr h) { return IsWindow(h); }
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
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Get-Tabs([IntPtr]$h) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem)
    return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond))
  } catch { return @() }
}
`

const LIST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# UTF-8, or tab names with an em dash or Claude's status glyph arrive mangled.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
${WIN32}
$ancestor = 0
if ($env:CSD_FOCUS_PID -match '^\d+$') {
  $parent = @{}
  foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)) {
    $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId
  }
  $cur = [int]$env:CSD_FOCUS_PID
  for ($i = 0; $i -lt 16 -and $cur -gt 0; $i++) {
    $gp = Get-Process -Id $cur -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) { $ancestor = [int64]$gp.MainWindowHandle; break }
    if (-not $parent.ContainsKey($cur)) { break }
    $cur = $parent[$cur]
  }
}
$windows = @()
foreach ($h in [CsdWin]::Terminals()) {
  $cls = [CsdWin]::ClassOf($h)
  $tabs = @()
  if ($cls -eq 'CASCADIA_HOSTING_WINDOW_CLASS') { $tabs = @(Get-Tabs $h | ForEach-Object { [string]$_.Current.Name }) }
  $windows += [pscustomobject]@{ hwnd = [int64]$h; cls = $cls; title = [CsdWin]::TitleOf($h); tabs = $tabs }
}
# The process's own window may be of another class: add it.
if ($ancestor -ne 0 -and -not ($windows | Where-Object { $_.hwnd -eq $ancestor })) {
  $h = [IntPtr]$ancestor
  $windows += [pscustomobject]@{ hwnd = $ancestor; cls = [CsdWin]::ClassOf($h); title = [CsdWin]::TitleOf($h); tabs = @() }
}
[Console]::Out.WriteLine((@{ ancestor = $ancestor; windows = @($windows) } | ConvertTo-Json -Compress -Depth 4))
`

const ACT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${WIN32}
if ($env:CSD_FOCUS_HWND -notmatch '^\d+$') { [Console]::Out.WriteLine('{"ok":false}'); exit 0 }
$h = [IntPtr][int64]$env:CSD_FOCUS_HWND
if (-not [CsdWin]::Exists($h)) { [Console]::Out.WriteLine('{"ok":false}'); exit 0 }
$how = 'window'
if ($env:CSD_FOCUS_TAB -match '^\d+$') {
  $want = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CSD_FOCUS_TABNAME))
  $tabs = Get-Tabs $h
  $i = [int]$env:CSD_FOCUS_TAB
  # Only the tab that still has the name it had a moment ago.
  if ($i -lt $tabs.Count -and [string]$tabs[$i].Current.Name -ceq $want) {
    try {
      $tabs[$i].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      $how = 'tab'
    } catch { }
  }
}
[void][CsdWin]::Focus($h)
[Console]::Out.WriteLine((@{ ok = $true; how = $how } | ConvertTo-Json -Compress))
`

const NOT_FOUND =
  "Couldn't find its terminal window. It may run in VS Code, an IDE or a terminal the app can't see (for a WSL session, give it a name with /rename so its tab can be found). Copy the resume command or open it on your phone instead."
const AMBIGUOUS =
  "More than one terminal tab has this session's name, so the app won't guess. Give the session its own name with /rename, or switch to it yourself."

function runPs(script: string, env: Record<string, string>): Promise<string> {
  const ps = win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...env }
      },
      (err, stdout) => {
        const line = String(stdout ?? '')
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.trim().startsWith('{'))
        if (line) resolve(line)
        else reject(err ?? new Error('No answer from PowerShell'))
      }
    )
  })
}

/** PowerShell's JSON for a one-item list may be the item itself. */
const asArray = <T>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v ? [v] : [])

export function parseTermList(json: string): TermList {
  const o = JSON.parse(json) as { ancestor?: number; windows?: unknown }
  const windows = asArray(o.windows as TermWindow | TermWindow[]).map((w) => ({
    hwnd: Number(w.hwnd),
    cls: String(w.cls ?? ''),
    title: String(w.title ?? ''),
    tabs: asArray(w.tabs as string | string[]).map(String)
  }))
  return { ancestor: o.ancestor ? Number(o.ancestor) : undefined, windows }
}

/** Bring the session's terminal forward. Windows only; elsewhere it says so. */
export async function focusTerminal(
  req: FocusRequest,
  opts: { simulate?: boolean } = {}
): Promise<FocusResult> {
  if (opts.simulate)
    return { ok: false, simulated: true, error: 'Fixtures mode: no terminal to focus.' }
  if (process.platform !== 'win32')
    return { ok: false, error: 'Focusing a terminal works on Windows only.' }
  try {
    const list = parseTermList(
      await runPs(LIST, {
        CSD_FOCUS_PID: req.pid && Number.isInteger(req.pid) ? String(req.pid) : ''
      })
    )
    const pick = pickFocusTarget(list, req.titles)
    if ('error' in pick)
      return { ok: false, error: pick.error === 'ambiguous' ? AMBIGUOUS : NOT_FOUND }
    const r = JSON.parse(
      await runPs(ACT, {
        CSD_FOCUS_HWND: String(pick.hwnd),
        CSD_FOCUS_TAB: pick.tab !== undefined ? String(pick.tab) : '',
        CSD_FOCUS_TABNAME: Buffer.from(pick.tabName ?? '', 'utf8').toString('base64')
      })
    ) as { ok?: boolean; how?: string }
    if (!r.ok) return { ok: false, error: NOT_FOUND }
    return { ok: true, how: r.how === 'tab' ? 'tab' : 'window' }
  } catch (err) {
    return { ok: false, error: `Couldn't focus the terminal: ${(err as Error).message}` }
  }
}
