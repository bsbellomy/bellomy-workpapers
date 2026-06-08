# sync-and-run.ps1
# Copies source files from Google Drive to local build directory, then starts the app.
# Run this from anywhere with: powershell -ExecutionPolicy Bypass -File "G:\My Drive\Firm Documents\Billy\Drivers\Taxdome Viewer\sync-and-run.ps1"

$source = "G:\My Drive\Firm Documents\Billy\Drivers\Taxdome Viewer"
$dest   = "C:\Projects\bellomy-workpapers"

Write-Host "Syncing source files..." -ForegroundColor Cyan

# Sync everything except node_modules, dist, and .claude
robocopy $source $dest /MIR /XD node_modules dist .git /XF "*.log" /NFL /NDL /NJH /NJS | Out-Null

Write-Host "Sync complete." -ForegroundColor Green

# Reload PATH so node/npm are available
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Set-Location $dest

# Install dependencies if node_modules is missing or package.json changed
$pkgChanged = (Get-Item "$source\package.json").LastWriteTime -gt (Get-Item "$dest\node_modules\.package-lock.json" -ErrorAction SilentlyContinue)?.LastWriteTime
if (-not (Test-Path "$dest\node_modules") -or $pkgChanged) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    npm install
}

Write-Host "Starting Bellomy Workpapers..." -ForegroundColor Green
npm run dev
