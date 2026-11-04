# Smoke test for ClaudeWorkbench portable exe. ASCII-only by design (PS 5.1 GBK pitfall).
# Contract: exe with CLAUDE_WORKBENCH_SMOKE=1 writes %TEMP%/claude-workbench-smoke-result.json and exits 0 on success.
param(
    [string]$Exe = '',
    [string]$BaseUrl = '',
    [string]$AuthToken = '',
    [string]$Model = '',
    # 指定供应商 id（如 deepseek/glm/kimi）：配合 -AuthToken 直接测该家真实 Key
    [string]$Provider = '',
    [int]$TimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
$resultFile = Join-Path $env:TEMP 'claude-workbench-smoke-result.json'

# PS 5.1 Start-Process -Redirect* crashes on case-duplicate env keys (http_proxy/HTTP_PROXY).
foreach ($n in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY')) {
    if ($null -ne [Environment]::GetEnvironmentVariable($n, 'Process')) {
        [Environment]::SetEnvironmentVariable($n, $null, 'Process')
    }
}

$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) {
    $candidates = Get-ChildItem -Path (Join-Path $root 'release') -Filter '*portable*.exe' -File -ErrorAction SilentlyContinue
    if (-not $candidates) {
        Write-Error 'No portable exe found under release/. Run npm run dist first.'
        exit 10
    }
    $Exe = ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

Write-Output "smoke_exe=$Exe"
if (Test-Path $resultFile) { Remove-Item $resultFile -Force }

# Some sandboxed sessions set ELECTRON_RUN_AS_NODE=1 which would turn the app into plain node.
$env:ELECTRON_RUN_AS_NODE = $null
$env:CLAUDE_WORKBENCH_SMOKE = '1'

if ($Provider) { $env:SMOKE_PROVIDER = $Provider }
if ($BaseUrl) { $env:SMOKE_BASE_URL = $BaseUrl }
if ($AuthToken) { $env:SMOKE_AUTH_TOKEN = $AuthToken }
if ($Model) { $env:SMOKE_MODEL = $Model }

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden
$deadline = $sw.Elapsed.TotalSeconds + $TimeoutSec
while (-not (Test-Path $resultFile) -and -not $proc.HasExited -and $sw.Elapsed.TotalSeconds -lt $deadline) {
    Start-Sleep -Milliseconds 500
}
$sw.Stop()

if (-not (Test-Path $resultFile)) {
    $code = -1
    if ($proc.HasExited) { $code = $proc.ExitCode }
    Write-Output "exit_code=$code"
    Write-Output "elapsed_ms=$($sw.ElapsedMilliseconds)"
    Write-Error 'SMOKE_TEST_FAIL: result file not created (exe crashed before writing result?)'
    exit 1
}

$json = Get-Content $resultFile -Raw | ConvertFrom-Json
Write-Output "ok=$($json.ok)"
Write-Output "exit_code=$($proc.ExitCode)"
Write-Output "elapsed_ms=$($sw.ElapsedMilliseconds)"
Write-Output "executable=$($json.executable)"
Write-Output "base_url=$($json.baseUrl)"
Write-Output "model=$($json.model)"
Write-Output "session_id=$($json.sessionId)"
Write-Output "text=$($json.text)"
if ($json.error) { Write-Output "error=$($json.error)" }

if ($json.ok -eq $true) {
    Write-Output 'SMOKE_TEST_PASS'
    exit 0
}
Write-Error 'SMOKE_TEST_FAIL'
exit 1
