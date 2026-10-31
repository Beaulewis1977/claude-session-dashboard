# Claude Session Dashboard: hook bridge for session alerts (installed by the app).
#
# Claude Code runs this for a few hook events (Notification, Stop,
# UserPromptSubmit, SessionStart/End, ...) and pipes the event's JSON to it.
# It saves the payload atomically as events\<session>.<event>.json, where the
# dashboard reads it, and nothing else: it prints nothing (some events would
# add printed text to Claude's context), never blocks Claude, and on any
# error it silently exits 0.

$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $utf8
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw -or $raw.Length -gt 1048576) { exit 0 }

  # Only the two fields that name the file; both must be plain identifiers.
  $sid = ''
  $ev = ''
  if ($raw -match '"session_id"\s*:\s*"([A-Za-z0-9_-]{1,128})"') { $sid = $Matches[1] }
  if ($raw -match '"hook_event_name"\s*:\s*"([A-Za-z]{1,40})"') { $ev = $Matches[1] }
  if (-not $sid -or -not $ev) { exit 0 }

  $dir = if ($env:CSD_BRIDGE_DIR) { $env:CSD_BRIDGE_DIR } else { Join-Path $HOME '.claude-session-dashboard' }
  $events = Join-Path $dir 'events'
  [void][System.IO.Directory]::CreateDirectory($events)

  $name = "$sid.$ev.json"
  $dest = Join-Path $events $name
  $tmp = Join-Path $events (".tmp.$PID.$name")
  try {
    [System.IO.File]::WriteAllText($tmp, $raw, $utf8)
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
