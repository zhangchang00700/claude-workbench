# Shared smoke exe discovery. ASCII-only by design (PS 5.1 GBK pitfall).
# Why: legacy scripts looked only in release/*portable*.exe, but the ship channel
# emits release-v<version>/ and clean-releases removes the legacy release/ dir.
# Order:
#   1. newest release-v<semver>/win-unpacked/ClaudeWorkbench.exe
#   2. newest release-v<semver>/ClaudeWorkbench-*-win.exe (portable)
#   3. legacy release/win-unpacked/ClaudeWorkbench.exe
#   4. legacy release/*portable*.exe
# Returns '' when nothing is found; callers decide the error message.
function Find-SmokeExe([string]$Root) {
    $dirs = Get-ChildItem -Path $Root -Directory -Filter 'release-v*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^release-v\d+\.\d+\.\d+$' }
    if ($dirs) {
        $sorted = $dirs | Sort-Object { [version]($_.Name -replace '^release-v', '') } -Descending
        foreach ($d in $sorted) {
            $unpacked = Join-Path $d.FullName 'win-unpacked\ClaudeWorkbench.exe'
            if (Test-Path $unpacked) { return $unpacked }
            $portable = Get-ChildItem -Path $d.FullName -Filter 'ClaudeWorkbench-*-win.exe' -File -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($portable) { return $portable.FullName }
        }
    }
    $legacy = Join-Path $Root 'release\win-unpacked\ClaudeWorkbench.exe'
    if (Test-Path $legacy) { return $legacy }
    $candidates = Get-ChildItem -Path (Join-Path $Root 'release') -Filter '*portable*.exe' -File -ErrorAction SilentlyContinue
    if ($candidates) {
        return (($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName)
    }
    return ''
}
