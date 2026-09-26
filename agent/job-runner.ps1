# Bellomy Workpapers - dev-box job agent
#
# Polls the Cloudflare Worker for queued jobs and runs them one at a time in an
# INTERACTIVE Claude session, so a human on the box keeps oversight of each run.
# The queue is drained serially: the next job is not claimed until the current
# session's window is closed.
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File agent\job-runner.ps1
#
# Normally you don't run this by hand - install-agent.ps1 registers it as a
# scheduled task that starts at logon and stays up. See agent\README.md.
#
# Config resolution (first hit wins per value):
#   1. environment: BW_WORKER_URL, BW_UPLOAD_SECRET
#   2. agent\config.local.json  { workerUrl, uploadSecret, repos:{request,guide,return}, pollSeconds }
#
# The upload secret is the SAME one the app uses (wrangler secret UPLOAD_SECRET).
# config.local.json is gitignored - never commit the secret.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# -- Single instance -----------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, 'Global\BellomyWorkpapersAgent')
if (-not $mutex.WaitOne(0)) { Write-Host 'Another agent is already running. Exiting.'; exit 0 }

# -- Config --------------------------------------------------------------------
$cfg = @{}
$cfgPath = Join-Path $here 'config.local.json'
if (Test-Path $cfgPath) { $cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json }

function CfgVal($envName, $cfgName, $default) {
  $e = [Environment]::GetEnvironmentVariable($envName)
  if ($e) { return $e }
  if ($cfg.$cfgName) { return $cfg.$cfgName }
  return $default
}

$workerUrl = (CfgVal 'BW_WORKER_URL' 'workerUrl' 'https://share.bellomycpa.com').TrimEnd('/')
$secret    = CfgVal 'BW_UPLOAD_SECRET' 'uploadSecret' ''
$pollSecs  = [int](CfgVal 'BW_POLL_SECONDS' 'pollSeconds' 15)

# Home repo per process. request -> request-builder; guide + return -> taxguide-builder.
$repos = @{
  request = 'D:\Projects\request-builder'
  guide   = 'D:\Projects\taxguide-builder'
  return  = 'D:\Projects\taxguide-builder'
}
if ($cfg.repos) {
  foreach ($k in 'request','guide','return') { if ($cfg.repos.$k) { $repos[$k] = $cfg.repos.$k } }
}

if (-not $secret) {
  Write-Host 'No upload secret configured. Set BW_UPLOAD_SECRET or agent\config.local.json.' -ForegroundColor Red
  exit 1
}

$agentId = "$env:USERNAME@$env:COMPUTERNAME"
$headers = @{ Authorization = "Bearer $secret" }
$logDir = Join-Path $here '.state'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'agent.log'

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

function SetStatus($id, $status, $note) {
  try {
    $body = @{ status = $status; note = $note } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$workerUrl/job/$id/status" -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
  } catch { Log "  ! could not report status '$status' for $id : $($_.Exception.Message)" }
}

# Open an interactive Claude session in the process's home repo, seeded with the
# job prompt, and BLOCK until the window is closed. Returns the claude exit code.
function RunJob($job) {
  $repo = $repos[$job.process]
  if (-not $repo -or -not (Test-Path $repo)) { throw "No repo for process '$($job.process)' (looked for '$repo')" }

  # Pass the prompt via a file, not the command line: it can be multi-line and
  # contain quotes. The bootstrap reads it whole and hands it to claude as one arg.
  $stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
  $promptFile = Join-Path $logDir "job-$($job.id).prompt.txt"
  $resultFile = Join-Path $logDir "job-$($job.id).exit.txt"
  $bootFile   = Join-Path $logDir "job-$($job.id).boot.ps1"
  Set-Content -Path $promptFile -Value $job.prompt -Encoding utf8 -NoNewline
  if (Test-Path $resultFile) { Remove-Item $resultFile -Force }

  $boot = @"
Set-Location -LiteralPath '$repo'
Write-Host '=== Bellomy Workpapers job $($job.id) : $($job.process) : $($job.client) $($job.year) ===' -ForegroundColor Yellow
Write-Host 'Repo: $repo' -ForegroundColor DarkGray
Write-Host ''
`$p = Get-Content -Raw -LiteralPath '$promptFile'
claude `$p
Set-Content -Path '$resultFile' -Value `$LASTEXITCODE -Encoding ascii
Write-Host ''
Write-Host '=== Session ended (exit' `$LASTEXITCODE ') - close this window to release the queue ===' -ForegroundColor Yellow
Read-Host 'Press Enter to close'
"@
  Set-Content -Path $bootFile -Value $boot -Encoding utf8

  # Prefer Windows Terminal if present (nicer), else a plain PowerShell console.
  $shell = 'powershell.exe'
  $args  = @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File', $bootFile)
  $proc  = Start-Process -FilePath $shell -ArgumentList $args -PassThru
  Log "  window opened (pid $($proc.Id)); waiting for it to close..."
  Wait-Process -Id $proc.Id

  $code = 0
  if (Test-Path $resultFile) { try { $code = [int](Get-Content -Raw $resultFile).Trim() } catch { $code = 0 } }
  # Tidy the per-job scratch files.
  foreach ($f in $promptFile,$resultFile,$bootFile) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
  return $code
}

Log "Agent up as '$agentId'. Worker $workerUrl. Poll ${pollSecs}s. Repos: request='$($repos.request)', guide/return='$($repos.guide)'."

while ($true) {
  try {
    $claim = Invoke-RestMethod -Method Post -Uri "$workerUrl/claim-job" -Headers $headers -ContentType 'application/json' -Body (@{ agent = $agentId } | ConvertTo-Json -Compress)
    if ($claim.ok -and $claim.job) {
      $job = $claim.job
      Log "Claimed $($job.id): $($job.process) for '$($job.client)' ($($job.year)) - queued by $($job.requester)"
      try {
        $code = RunJob $job
        if ($code -eq 0) { SetStatus $job.id 'done'  "completed on $agentId"; Log "  done ($($job.id))" }
        else            { SetStatus $job.id 'error' "claude exited $code on $agentId"; Log "  error exit $code ($($job.id))" }
      } catch {
        SetStatus $job.id 'error' "$($_.Exception.Message)"
        Log "  ! run failed ($($job.id)): $($_.Exception.Message)"
      }
      continue   # immediately check for the next job
    }
  } catch {
    Log "poll error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $pollSecs
}
