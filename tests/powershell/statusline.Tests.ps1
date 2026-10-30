# Pester 5 tests for the Windows status line bridge.
# Run on Windows:  Invoke-Pester .\tests\powershell
# (Not part of `npm test`, which runs on any OS; see README → Testing the bridge.)

BeforeAll {
  $script = Join-Path $PSScriptRoot '..\..\resources\bridge\statusline.ps1'
  $payload = '{"session_id":"sess-1","model":{"id":"claude-opus-5-5","display_name":"Opus"},"context_window":{"used_percentage":8.4,"current_usage":{"input_tokens":1}},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41.2,"resets_at":1738857600}}}'
  function Invoke-Bridge([string]$dir, [string]$inputText) {
    $env:CSD_BRIDGE_DIR = $dir
    try { $inputText | powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script }
    finally { Remove-Item Env:\CSD_BRIDGE_DIR }
  }
}

Describe 'statusline.ps1' {
  BeforeEach { $dir = Join-Path $TestDrive ([guid]::NewGuid()) }

  It 'saves the payload and prints a short line' {
    $out = Invoke-Bridge $dir $payload
    $out | Should -Be 'Opus · 5h 23% · week 41% · ctx 8%'
    (Get-Content (Join-Path $dir 'live\latest.json') -Raw).Trim() | Should -Be $payload
    (Get-Content (Join-Path $dir 'live\sess-1.json') -Raw).Trim() | Should -Be $payload
    (Get-ChildItem (Join-Path $dir 'live')).Name | Sort-Object | Should -Be @('latest.json', 'sess-1.json')
  }

  It 'replaces the saved files on later updates and leaves no temp files' {
    Invoke-Bridge $dir '{"session_id":"sess-1"}' | Out-Null
    Invoke-Bridge $dir $payload | Out-Null
    (Get-Content (Join-Path $dir 'live\latest.json') -Raw).Trim() | Should -Be $payload
    (Get-Content (Join-Path $dir 'live\sess-1.json') -Raw).Trim() | Should -Be $payload
    (Get-ChildItem -Force (Join-Path $dir 'live')).Name | Sort-Object | Should -Be @('latest.json', 'sess-1.json')
  }

  It 'works without rate_limits and never fails' {
    Invoke-Bridge $dir '{"model":{"display_name":"Sonnet"}}' | Should -Be 'Sonnet'
    Invoke-Bridge $dir 'not json' | Should -Be 'Claude'
    $LASTEXITCODE | Should -Be 0
  }

  It 'ignores unsafe session ids' {
    Invoke-Bridge $dir '{"session_id":"..\\..\\evil"}' | Out-Null
    Test-Path (Join-Path $dir 'live\evil.json') | Should -BeFalse
  }

  It 'chains to the previous status line command' {
    New-Item -ItemType Directory -Force $dir | Out-Null
    '{"command":"Write-Output chained","shell":null}' | Set-Content (Join-Path $dir 'chain.json')
    Invoke-Bridge $dir $payload | Should -Be 'chained'
  }
}
