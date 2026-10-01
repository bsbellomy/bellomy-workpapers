# install-doorbell-service.ps1
# Installs (or reinstalls) the BellomyJobDoorbell Windows service using NSSM.
#
# The doorbell holds the Worker's WebSocket so a queued job is picked up in about
# a second, WITHOUT depending on a Claude session being open. That is the whole
# point: when the desktop session restarted, nothing was listening and a real job
# sat queued for 10.8 minutes.
#
# What it is allowed to run on its own (Billy, 2026-10-01):
#   guide   -> runs headless, end to end (internal preparer document)
#   request -> left queued; it publishes a client-facing worksheet, so a human starts it
#   return  -> left queued; the UltraTax RPA needs computer-use, i.e. the desktop app
#
# Must be run as Administrator. Modelled on taxdome-api\scripts\install-daemon-service.ps1.

$ErrorActionPreference = "Stop"

$ServiceName = "BellomyJobDoorbell"
$RepoDir     = $PSScriptRoot | Split-Path
$NodeExe     = (Get-Command node -ErrorAction Stop).Source
$ServiceArgs = "agent/doorbell-daemon.mjs"
$LogDir      = "$RepoDir\logs"
$StdoutLog   = "$LogDir\doorbell-stdout.log"
$StderrLog   = "$LogDir\doorbell-stderr.log"

Write-Host "=== Installing $ServiceName ==="

# The daemon shells out to the Claude CLI for guide jobs, so it must exist.
$ClaudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $ClaudeCmd) {
    Write-Warning "claude CLI not found on PATH for this account."
    Write-Warning "The service account must be able to run it, or guide jobs will fail to start."
}

# node >= 22 for the global WebSocket the daemon relies on.
$NodeMajor = [int]((& $NodeExe --version) -replace '^v(\d+).*', '$1')
if ($NodeMajor -lt 22) { throw "node $NodeMajor is too old; the daemon needs a global WebSocket (node >= 22)" }

if (-not (Test-Path "$RepoDir\agent\config.local.json")) {
    throw "Missing agent\config.local.json — the daemon needs workerUrl + uploadSecret."
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -eq "Running") { Stop-Service $ServiceName -Force }
    nssm remove $ServiceName confirm
    Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

nssm install $ServiceName $NodeExe $ServiceArgs
nssm set $ServiceName AppDirectory $RepoDir
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 10000
nssm set $ServiceName AppStdout $StdoutLog
nssm set $ServiceName AppStderr $StderrLog
nssm set $ServiceName AppStdoutCreationDisposition 4
nssm set $ServiceName AppStderrCreationDisposition 4
nssm set $ServiceName Start SERVICE_AUTO_START

# Run as the interactive account, not LocalSystem: the Claude CLI needs that
# profile's credentials, PATH and MCP config to do any real work.
$Account = "HSV\Administrator"
$Password = Read-Host "Enter password for $Account" -AsSecureString
$PlainPw  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))
nssm set $ServiceName ObjectName $Account $PlainPw

nssm start $ServiceName

Write-Host ""
Write-Host "=== Done. Watch it with: ==="
Write-Host "  Get-Content $LogDir\doorbell.log -Tail 20 -Wait"
(Get-Service $ServiceName).Status
