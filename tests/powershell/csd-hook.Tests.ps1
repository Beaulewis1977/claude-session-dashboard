# Pester 5 tests for the Windows hook bridge (session alerts).
# Run on Windows:  Invoke-Pester .\tests\powershell
# (Not part of `npm test`, which runs on any OS; see README → Testing the bridge.)

BeforeAll {
  $script = Join-Path $PSScriptRoot '..\..\resources\bridge\csd-hook.ps1'
  function Invoke-Hook([string]$dir, [string]$inputText) {
    $env:CSD_BRIDGE_DIR = $dir
    try { $inputText | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script }
    finally { Remove-Item Env:\CSD_BRIDGE_DIR }
  }
}

Describe 'csd-hook.ps1' {
  BeforeEach { $dir = Join-Path $TestDrive ([guid]::NewGuid()) }

  It 'saves each event under its session and name, and prints nothing' {
    $payload = '{"session_id":"abc-123","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}'
    $out = Invoke-Hook $dir $payload
    $out | Should -BeNullOrEmpty
    Invoke-Hook $dir '{"session_id":"abc-123","hook_event_name":"Stop"}' | Should -BeNullOrEmpty
    (Get-ChildItem (Join-Path $dir 'events')).Name | Sort-Object | Should -Be @('abc-123.Notification.json', 'abc-123.Stop.json')
    (Get-Content (Join-Path $dir 'events\abc-123.Notification.json') -Raw).Trim() | Should -Be $payload
  }

  It 'replaces an event of the same kind and leaves no temp files' {
    Invoke-Hook $dir '{"session_id":"s1","hook_event_name":"Stop","n":1}' | Out-Null
    Invoke-Hook $dir '{"session_id":"s1","hook_event_name":"Stop","n":2}' | Out-Null
    (Get-ChildItem -Force (Join-Path $dir 'events')).Name | Should -Be @('s1.Stop.json')
    (Get-Content (Join-Path $dir 'events\s1.Stop.json') -Raw) | Should -Match '"n":2'
  }

  It 'reads only top-level fields, never the same names nested in tool input' {
    $p = '{"tool_input":{"session_id":"evil","hook_event_name":"Stop"},"session_id":"real-1","hook_event_name":"PermissionRequest"}'
    Invoke-Hook $dir $p | Should -BeNullOrEmpty
    (Get-ChildItem (Join-Path $dir 'events')).Name | Should -Be @('real-1.PermissionRequest.json')
  }

  It 'ignores a top-level array and oversized input' {
    Invoke-Hook $dir '[{"session_id":"a","hook_event_name":"Stop"}]' | Should -BeNullOrEmpty
    $big = '{"session_id":"big","hook_event_name":"Stop","m":"' + ('x' * 1100000) + '"}'
    Invoke-Hook $dir $big | Should -BeNullOrEmpty
    Test-Path (Join-Path $dir 'events') | Should -BeFalse
  }

  It 'ignores unsafe or incomplete input and always exits 0' {
    Invoke-Hook $dir '' | Should -BeNullOrEmpty
    Invoke-Hook $dir '{"session_id":"../../evil","hook_event_name":"Stop"}' | Should -BeNullOrEmpty
    Invoke-Hook $dir '{"session_id":"ok","hook_event_name":"../x"}' | Should -BeNullOrEmpty
    Invoke-Hook $dir 'not json' | Should -BeNullOrEmpty
    $LASTEXITCODE | Should -Be 0
    Test-Path (Join-Path $dir 'events') | Should -BeFalse
  }
}
