# ship.ps1 — release pipeline used by BOTH the Stop hook and `npm run ship`.
#
# A single-ship mutex ensures only ONE release runs at a time. If a manual or
# background ship is in flight when the Stop hook fires (the version bump makes
# the tree dirty, which the hook treats as "something to ship"), the second
# invocation SKIPS instead of colliding on electron-builder's win-unpacked —
# concurrent builds corrupted a release on 2026-08-19 (app.asar ENOENT).
#
# Modes:
#   (no flag)  Stop-hook mode — release ONLY if the working tree is dirty.
#   -Force     `npm run ship` — also release committed-but-unreleased work on a
#              clean tree. Bumps the patch version either way.
#
# Flow once shipping: bump patch -> delete stale win-unpacked (HANDOVER) ->
# npm run release (build + smoke gate + publish; needs GH_TOKEN) ->
# commit + tag + push, ONLY after a successful publish.
param([switch]$Force)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Assert-LastExit($msg) {
    if ($LASTEXITCODE -ne 0) { throw "ship: $msg (exit $LASTEXITCODE)" }
}

# ── Single-ship lock (non-blocking): skip if another release already holds it ──
$mutex = New-Object System.Threading.Mutex($false, 'BellomyWorkpapersShip')
$held = $false
try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
if (-not $held) {
    Write-Host "ship: another release is already in progress - skipping"
    $mutex.Dispose()
    exit 0
}

try {
    # 1. Stop-hook mode does nothing unless there are uncommitted changes.
    if (-not $Force) {
        $changes = git status --porcelain
        if ([string]::IsNullOrWhiteSpace($changes)) {
            Write-Host "ship: working tree clean - nothing to release"
            exit 0
        }
    }

    # 2. Ensure a publish token is available for electron-builder.
    if (-not $env:GH_TOKEN) {
        $env:GH_TOKEN = [System.Environment]::GetEnvironmentVariable("GH_TOKEN", "User")
    }
    if (-not $env:GH_TOKEN) {
        throw "ship: GH_TOKEN not set (User env var missing) - cannot publish release"
    }

    # 3. Bump patch version in package.json / package-lock.json (no commit, no tag).
    $raw = npm version patch --no-git-tag-version
    Assert-LastExit "npm version bump failed"
    $version = ($raw | Select-Object -Last 1).Trim().TrimStart('v')
    Write-Host "ship: preparing release v$version"

    # 4. CRITICAL (HANDOVER.md): remove stale win-unpacked before packaging.
    if (Test-Path "dist\win-unpacked") {
        Remove-Item -Recurse -Force "dist\win-unpacked"
        Write-Host "ship: removed stale dist\win-unpacked"
    }

    # 5. Build + publish. Bail BEFORE committing/tagging if it fails, leaving the
    #    version bump uncommitted for inspection/retry.
    npm run release
    Assert-LastExit "npm run release failed - nothing committed or pushed"

    # 6. Publish succeeded: commit everything, tag, and push.
    git add -A
    Assert-LastExit "git add failed"
    git commit -m "v${version}: auto-release"
    Assert-LastExit "git commit failed"
    # electron-builder's GitHub publish already creates the v$version tag (local
    # AND remote). A plain `git tag` here would fail "already exists" and abort
    # the ship AFTER the release is out, leaving the bump commit unpushed
    # (happened on 2026-08-19). Only create the tag if it's missing.
    if (-not (git tag -l "v$version")) {
        git tag "v$version"
        Assert-LastExit "git tag failed"
    }
    # electron-builder's GitHub release already creates the tag on the remote
    # (a release requires one), so pushing the branch is enough. Don't redirect
    # git's stderr here — under PowerShell 5.1 `2>$null` wraps git's normal push
    # output as a terminating error and fails the ship after it already shipped.
    git push origin main
    Assert-LastExit "git push failed"

    Write-Host "ship: published v$version and pushed to origin/main"
}
finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
