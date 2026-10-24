# Deterministic smoke test via local mock upstream (no external API quota needed).
# Verifies the full chain: exe -> router -> upstream -> result file, without any real provider.
# ASCII-only by design (PS 5.1 GBK pitfall).
param(
    [string]$Exe = '',
    [int]$MockPort = 8787,
    [int]$TimeoutSec = 120,
    [ValidateSet('anthropic', 'openai')]
    [string]$MockMode = 'anthropic',
    # dev-run support: pass "." so plain electron.exe loads this project folder
    [string]$ExeArgs = '',
    # failover drill: first upstream fails on purpose, second must take over
    [ValidateSet('none', 'quota402', 'http429', 'stream-error')]
    [string]$FailoverMode = 'none'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$resultFile = Join-Path $env:TEMP 'claude-workbench-smoke-result.json'
$mockLog = Join-Path $env:TEMP 'cw-mock-server.log'

# PS 5.1 Start-Process -Redirect* crashes on case-duplicate env keys (http_proxy/HTTP_PROXY).
foreach ($n in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY')) {
    if ($null -ne [Environment]::GetEnvironmentVariable($n, 'Process')) {
        [Environment]::SetEnvironmentVariable($n, $null, 'Process')
    }
}

function Wait-Port([int]$Port, [int]$MaxSec) {
    for ($i = 0; $i -lt ($MaxSec * 4); $i++) {
        Start-Sleep -Milliseconds 250
        $tcp = New-Object System.Net.Sockets.TcpClient
        try {
            $tcp.Connect('127.0.0.1', $Port)
            return $true
        } catch {
            # not ready yet
        } finally {
            $tcp.Close()
        }
    }
    return $false
}

if (-not $Exe) {
    $unpacked = Join-Path $root 'release\win-unpacked\ClaudeWorkbench.exe'
    if (Test-Path $unpacked) {
        $Exe = $unpacked
    } else {
        $candidates = Get-ChildItem -Path (Join-Path $root 'release') -Filter '*portable*.exe' -File -ErrorAction SilentlyContinue
        if (-not $candidates) {
            Write-Error 'No exe found. Run npm run dist first.'
            exit 10
        }
        $Exe = ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    }
}

Write-Output "mock_smoke_exe=$Exe"

# 1. start mock upstream(s) (no -Redirect: PS 5.1 env-dictionary bug; mock writes its own log)
if (Test-Path $mockLog) { Remove-Item $mockLog -Force }
$mocks = @()

if ($FailoverMode -eq 'none') {
    $env:MOCK_PORT = "$MockPort"
    $env:MOCK_MODE = "$MockMode"
    $env:MOCK_FAIL_MODE = $null
    $mocks += Start-Process -FilePath 'node' -ArgumentList "$root\scripts\mock-anthropic-server.mjs" -PassThru -WindowStyle Hidden
    if (-not (Wait-Port $MockPort 10)) {
        foreach ($m in $mocks) { if (-not $m.HasExited) { $m.Kill() } }
        Write-Error "mock upstream failed to start; log: $(if (Test-Path $mockLog) { Get-Content $mockLog -Raw } else { 'n/a' })"
        exit 1
    }
    Write-Output "mock_upstream=ready port=$MockPort mode=$MockMode"
} else {
    $failPort = $MockPort
    $okPort = $MockPort + 1
    $env:MOCK_MODE = "$MockMode"
    # upstream A: always fails
    $env:MOCK_PORT = "$failPort"
    $env:MOCK_FAIL_MODE = "$FailoverMode"
    $mocks += Start-Process -FilePath 'node' -ArgumentList "$root\scripts\mock-anthropic-server.mjs" -PassThru -WindowStyle Hidden
    # upstream B: healthy
    $env:MOCK_PORT = "$okPort"
    $env:MOCK_FAIL_MODE = $null
    $mocks += Start-Process -FilePath 'node' -ArgumentList "$root\scripts\mock-anthropic-server.mjs" -PassThru -WindowStyle Hidden

    if (-not ((Wait-Port $failPort 10) -and (Wait-Port $okPort 10))) {
        foreach ($m in $mocks) { if (-not $m.HasExited) { $m.Kill() } }
        Write-Error "mock upstreams failed to start; log: $(if (Test-Path $mockLog) { Get-Content $mockLog -Raw } else { 'n/a' })"
        exit 1
    }
    Write-Output "mock_upstream=ready fail=$failPort($FailoverMode) ok=$okPort"
}

# 2. run smoke against mock
if (Test-Path $resultFile) { Remove-Item $resultFile -Force }
$env:ELECTRON_RUN_AS_NODE = $null
$env:CLAUDE_WORKBENCH_SMOKE = '1'

if ($FailoverMode -eq 'none') {
    $env:SMOKE_FAILOVER = $null
    $env:SMOKE_PROVIDER = 'glm'
    $env:SMOKE_BASE_URL = "http://127.0.0.1:$MockPort"
    $env:SMOKE_AUTH_TOKEN = 'mock-key-not-a-real-secret'
    $env:SMOKE_MODEL = 'mock-flash'
    $env:SMOKE_PROTOCOL = "$MockMode"
} else {
    $env:SMOKE_PROVIDER = $null
    $env:SMOKE_BASE_URL = $null
    $env:SMOKE_MODEL = $null
    $env:SMOKE_FAILOVER = '1'
    $env:SMOKE_FAIL_URL = "http://127.0.0.1:$failPort"
    $env:SMOKE_OK_URL = "http://127.0.0.1:$okPort"
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($ExeArgs) {
    $proc = Start-Process -FilePath $Exe -ArgumentList @($ExeArgs) -PassThru -WindowStyle Hidden
} else {
    $proc = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden
}
$deadline = $sw.Elapsed.TotalSeconds + $TimeoutSec
while (-not (Test-Path $resultFile) -and -not $proc.HasExited -and $sw.Elapsed.TotalSeconds -lt $deadline) {
    Start-Sleep -Milliseconds 500
}
$sw.Stop()

# 3. cleanup mocks
foreach ($m in $mocks) { if (-not $m.HasExited) { $m.Kill() } }

if (-not (Test-Path $resultFile)) {
    Write-Output "exit_code=$(if ($proc.HasExited) { $proc.ExitCode } else { 'running' })"
    Write-Output "elapsed_ms=$($sw.ElapsedMilliseconds)"
    Write-Error 'MOCK_SMOKE_FAIL: result file not created'
    exit 1
}

$json = Get-Content $resultFile -Raw | ConvertFrom-Json
Write-Output "ok=$($json.ok)"
Write-Output "router_port=$($json.routerPort)"
Write-Output "session_id=$($json.sessionId)"
Write-Output "text=$($json.text)"
if ($json.failover) {
    foreach ($f in $json.failover) { Write-Output "failover=$($f.from) -> $($f.to) reason=$($f.reason)" }
}
Write-Output "elapsed_ms=$($sw.ElapsedMilliseconds)"
if ($json.error) { Write-Output "error=$($json.error)" }
Write-Output '--- mock upstream log ---'
if (Test-Path $mockLog) { Get-Content $mockLog | Out-String -Width 200 }

if ($json.ok -eq $true) {
    Write-Output 'MOCK_SMOKE_PASS'
    exit 0
}
Write-Error 'MOCK_SMOKE_FAIL'
exit 1
