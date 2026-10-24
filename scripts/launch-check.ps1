# Launch health check: starts the app and reports how long until the window appears.
# ASCII-only content (PS 5.1 GBK pitfall). Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch-check.ps1 [-Exe <path>]
param(
  [string]$Exe = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Exe) {
  $candidates = @(
    (Join-Path $root 'release-v3/win-unpacked/ClaudeWorkbench.exe'),
    (Join-Path $root 'release-fresh2/win-unpacked/ClaudeWorkbench.exe'),
    (Join-Path $root 'release/win-unpacked/ClaudeWorkbench.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $Exe = $c; break } }
}
if (-not $Exe -or -not (Test-Path $Exe)) { Write-Output 'NO_EXE_FOUND'; exit 3 }

# Sandbox leftovers can force Electron into plain-Node mode; clear for the child.
$env:ELECTRON_RUN_AS_NODE = $null
$env:CLAUDE_WORKBENCH_SMOKE = $null

Write-Output "EXE=$Exe"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $Exe -PassThru
Write-Output "LAUNCHED pid=$($p.Id)"

$windowFound = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1000
  if ($p.HasExited) { Write-Output "EXITED ms=$($sw.ElapsedMilliseconds) code=$($p.ExitCode)"; break }
  $all = Get-Process | Where-Object { $_.ProcessName -match 'Claude' }
  $hit = $all | Where-Object { $_.MainWindowHandle -ne 0 }
  if ($hit) {
    $w = $hit | Select-Object -First 1
    Write-Output "WINDOW_OK ms=$($sw.ElapsedMilliseconds) pid=$($w.Id) title=$($w.MainWindowTitle)"
    $windowFound = $true
    break
  }
  if ($i -eq 9 -or $i -eq 19) { Write-Output "WAITING ms=$($sw.ElapsedMilliseconds) procs=$($all.Count)" }
}

if (-not $windowFound -and -not $p.HasExited) { Write-Output "TIMEOUT_NO_WINDOW ms=$($sw.ElapsedMilliseconds)" }

$logDir = Join-Path $env:APPDATA 'ClaudeWorkbench/logs'
if (Test-Path $logDir) {
  $lf = Get-ChildItem $logDir -File -Filter 'main.log' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lf) {
    Write-Output '--- main.log tail ---'
    Get-Content $lf.FullName -Tail 8
  }
}

Get-Process | Where-Object { $_.ProcessName -match 'Claude' } | Stop-Process -Force -ErrorAction SilentlyContinue
if ($windowFound) { Write-Output 'LAUNCH_CHECK_PASS'; exit 0 }
Write-Output 'LAUNCH_CHECK_FAIL'; exit 1
