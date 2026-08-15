# ship.ps1 — auto-commit + release on every change.
#
# Invoked by the Claude Code Stop hook (see .claude/settings.local.json) and
# also runnable manually via `npm run ship`. Flow:
#   1. Skip entirely if the working tree is clean (nothing to ship).
#   2. Bump the patch version in package.json (no git commit/tag yet).
#   3. Delete dist/win-unpacked  -- CRITICAL per HANDOVER.md: a stale
#      win-unpacked gets packaged into the new asar and doubles build size
#      each release until NSIS fails.
#   4. Build + publish to GitHub Releases (npm run release, needs GH_TOKEN).
#   5. ONLY after a successful publish: commit all changes, tag, and push.
#      Nothing is committed or pushed if the build/publish fails.

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Assert-LastExit($msg) {
    if ($LASTEXITCODE -ne 0) { throw "ship: $msg (exit $LASTEXITCODE)" }
}

# 1. Nothing to do if the tree is clean.
$changes = git status --porcelain
if ([string]::IsNullOrWhiteSpace($changes)) {
    Write-Host "ship: working tree clean - nothing to release"
    exit 0
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

# 5. Build + publish. If this fails we bail out BEFORE committing/tagging,
#    leaving the version bump uncommitted for inspection/retry.
npm run release
Assert-LastExit "npm run release failed - nothing committed or pushed"

# 6. Publish succeeded: commit everything, tag, and push.
git add -A
Assert-LastExit "git add failed"
git commit -m "v${version}: auto-release"
Assert-LastExit "git commit failed"
git tag "v$version"
Assert-LastExit "git tag failed"
git push --follow-tags origin main
Assert-LastExit "git push failed"

Write-Host "ship: published v$version and pushed to origin/main"
