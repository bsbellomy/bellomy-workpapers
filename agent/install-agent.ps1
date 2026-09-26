# Register (or refresh) the Bellomy Workpapers job agent as a scheduled task that
# starts at logon and stays up, restarting itself if it ever stops.
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File agent\install-agent.ps1
#
# Run this once on the DEV BOX only (the machine that runs the jobs). Uninstall
# with:  Unregister-ScheduledTask -TaskName 'BellomyWorkpapersAgent' -Confirm:$false
#
# This changes a system setting (a scheduled task), so run it yourself - the app
# never registers it for you.

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here 'job-runner.ps1'
$taskName = 'BellomyWorkpapersAgent'

if (-not (Test-Path $runner)) { throw "job-runner.ps1 not found next to this script ($runner)" }

# Prefer pwsh (PowerShell 7) if installed; fall back to Windows PowerShell.
$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = 'powershell.exe' }

$action  = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Keep it alive: no time limit, and restart a few times if it exits.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed existing '$taskName' task." -ForegroundColor DarkGray
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Write-Host "Registered scheduled task '$taskName' (starts at logon)." -ForegroundColor Green
Write-Host "Starting it now..." -ForegroundColor DarkGray
Start-ScheduledTask -TaskName $taskName
Write-Host "Done. Tail the log at: $(Join-Path $here '.state\agent.log')" -ForegroundColor Green
