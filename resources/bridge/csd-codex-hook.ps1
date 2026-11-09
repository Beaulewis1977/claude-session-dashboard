# Claude Session Dashboard: Codex hook for session alerts (installed by the app).
#
# Codex runs this when a session is about to ask for approval
# (PermissionRequest) and pipes the event's JSON to it. It saves only the
# session id, the event name and the tool's name, atomically, as
# codex-events\<session>.<event>.json, where the dashboard reads it. Nothing
# else: no command text or tool input is kept. It prints nothing (so it never
# answers the approval: Codex asks you as usual), never blocks Codex, and on
# any error it silently exits 0.

$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $utf8
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw -or $raw.Length -gt 4194304) { exit 0 }

  # Top-level fields only (the same names inside tool input never count).
  $j = $raw | ConvertFrom-Json
  if (-not ($j -is [System.Management.Automation.PSCustomObject])) { exit 0 }
  $sid = [string]$j.session_id
  $ev = [string]$j.hook_event_name
  if ($sid -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or $ev -cnotmatch '^[A-Za-z]{1,40}$') { exit 0 }
  $out = [ordered]@{ session_id = $sid; hook_event_name = $ev }
  $tool = [string]$j.tool_name
  if ($tool -cmatch '^[A-Za-z0-9_.:-]{1,100}$') { $out.tool_name = $tool }
  $json = ConvertTo-Json -InputObject $out -Compress

  $dir = if ($env:CSD_BRIDGE_DIR) { $env:CSD_BRIDGE_DIR } else { Join-Path $HOME '.claude-session-dashboard' }
  $events = Join-Path $dir 'codex-events'
  [void][System.IO.Directory]::CreateDirectory($events)

  $name = "$sid.$ev.json"
  $dest = Join-Path $events $name
  $tmp = Join-Path $events (".tmp.$PID.$name")
  try {
    [System.IO.File]::WriteAllText($tmp, $json, $utf8)
    if ([System.IO.File]::Exists($dest)) {
      # [NullString]: a plain $null reaches .NET as "", which Replace rejects.
      [System.IO.File]::Replace($tmp, $dest, [NullString]::Value)
    } else {
      [System.IO.File]::Move($tmp, $dest)
    }
  } finally {
    if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) }
  }
} catch { }
exit 0
