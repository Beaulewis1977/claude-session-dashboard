# Claude Session Dashboard: status line bridge (installed by the app).
#
# Claude Code pipes a JSON payload to the status line command on every update.
# This script saves it (atomically) for the dashboard, then either passes it
# to your previous status line command or prints a short line itself.
# Never fails loudly: on any error it prints nothing and exits 0.

$ErrorActionPreference = 'Stop'
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
  $dir = if ($env:CSD_BRIDGE_DIR) { $env:CSD_BRIDGE_DIR } else { Join-Path $HOME '.claude-session-dashboard' }
  $live = Join-Path $dir 'live'
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw) { exit 0 }
  [void][System.IO.Directory]::CreateDirectory($live)

  function Save-Atomic([string]$name) {
    $dest = Join-Path $live $name
    $tmp = Join-Path $live (".tmp.$PID.$name")
    try {
      [System.IO.File]::WriteAllText($tmp, $raw, $utf8)
      if ([System.IO.File]::Exists($dest)) {
        # [NullString]: PowerShell passes a plain $null to a .NET string as "",
        # and Replace rejects "" as a backup path, so every update would fail.
        [System.IO.File]::Replace($tmp, $dest, [NullString]::Value)
      } else {
        [System.IO.File]::Move($tmp, $dest)
      }
    } finally {
      # Never leave a temp file behind, whatever happened above.
      if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) }
    }
  }

  $j = $null
  try { $j = $raw | ConvertFrom-Json } catch { }
  $sid = if ($j) { [string]$j.session_id } else { '' }
  if ($sid -match '^[A-Za-z0-9_-]+$') { try { Save-Atomic "$sid.json" } catch { } }
  try { Save-Atomic 'latest.json' } catch { }

  # Chain to the status line command you had before (saved by the app).
  $chainFile = Join-Path $dir 'chain.json'
  if (Test-Path -LiteralPath $chainFile) {
    $chain = Get-Content -LiteralPath $chainFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $cmd = [string]$chain.command
    if ($cmd) {
      if ($chain.shell -and (Test-Path -LiteralPath $chain.shell)) {
        $out = $raw | & $chain.shell -c $cmd
      } else {
        $out = $raw | & powershell.exe -NoProfile -NonInteractive -Command $cmd
      }
      foreach ($l in @($out)) { [Console]::Out.WriteLine([string]$l) }
    }
    exit 0
  }

  $parts = @()
  $model = if ($j -and $j.model.display_name) { [string]$j.model.display_name } else { 'Claude' }
  $parts += $model
  if ($j -and $null -ne $j.rate_limits.five_hour.used_percentage) {
    $parts += ('5h {0}%' -f [math]::Floor([double]$j.rate_limits.five_hour.used_percentage))
  }
  if ($j -and $null -ne $j.rate_limits.seven_day.used_percentage) {
    $parts += ('week {0}%' -f [math]::Floor([double]$j.rate_limits.seven_day.used_percentage))
  }
  if ($j -and $null -ne $j.context_window.used_percentage) {
    $parts += ('ctx {0}%' -f [math]::Floor([double]$j.context_window.used_percentage))
  }
  [Console]::Out.WriteLine(($parts -join ' · '))
} catch { }
exit 0
