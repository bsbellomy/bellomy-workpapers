# smoke.ps1 - pre-release sanity checks on the built output.
#
# Runs as a gate inside `npm run release` (between build and publish) and is
# also runnable standalone via `npm run smoke`. Exits 1 if the build is
# incomplete or the scanner binary won't run, so nothing gets published to
# firm machines from a broken build. Side-effect-free and fast (~4s).

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$failures = @()

# 1. Required build artifacts must exist and be non-empty. Catches an
#    incomplete build (renderer/main/preload) or a scanner that didn't compile.
$artifacts = @(
    "dist\main\main\main.js",
    "dist\main\preload\preload.js",
    "dist\renderer\index.html",
    "scanner\ScanHelper\bin\publish\ScanHelper.exe"
)
foreach ($a in $artifacts) {
    if (-not (Test-Path $a)) {
        $failures += "missing artifact: $a"
    } elseif ((Get-Item $a).Length -eq 0) {
        $failures += "empty artifact: $a"
    }
}

# 2. The bundled scanner binary must actually run on this machine. Catches a
#    broken / mis-targeted .NET publish -- the class of scanner-crash incidents
#    noted in HANDOVER.md (exit 0xE0434352). `list` needs no hardware and
#    returns {"ok":true,"devices":[...]} in a few seconds. A hang is bounded by
#    the caller's hook timeout and fails safe (no publish).
$scanner = "scanner\ScanHelper\bin\publish\ScanHelper.exe"
if (Test-Path $scanner) {
    $out = & $scanner list
    if ($LASTEXITCODE -ne 0) {
        $failures += "ScanHelper list exited $LASTEXITCODE"
    } else {
        try {
            $json = ($out | Out-String) | ConvertFrom-Json
            if ($null -eq $json.ok) {
                $failures += "ScanHelper list output missing 'ok' field: $out"
            } elseif (-not $json.ok) {
                $failures += "ScanHelper list reported not-ok: $out"
            }
        } catch {
            $failures += "ScanHelper list output not valid JSON: $out"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host "smoke: FAILED"
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}

Write-Host "smoke: OK (build artifacts present, scanner runs)"
exit 0
