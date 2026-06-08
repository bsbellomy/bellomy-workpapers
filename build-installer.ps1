# build-installer.ps1
# Builds Bellomy Workpapers and produces a Windows installer.
# Run from anywhere: powershell -ExecutionPolicy Bypass -File "G:\My Drive\Firm Documents\Billy\Drivers\Taxdome Viewer\build-installer.ps1"

$source = "G:\My Drive\Firm Documents\Billy\Drivers\Taxdome Viewer"
$build  = "C:\Projects\bellomy-workpapers"

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host ""
Write-Host "=== Bellomy Workpapers — Build Installer ===" -ForegroundColor Cyan
Write-Host ""

# 1. Sync source files
Write-Host "[ 1/4 ] Syncing source files..." -ForegroundColor Yellow
robocopy $source $build /MIR /XD node_modules dist .git /XF "*.log" /NFL /NDL /NJH /NJS | Out-Null
Set-Location $build

# 2. Install / update dependencies
Write-Host "[ 2/5 ] Checking dependencies..." -ForegroundColor Yellow
npm install --silent 2>&1 | Out-Null

# 3. Regenerate icon
Write-Host "[ 3/5 ] Generating icon..." -ForegroundColor Yellow
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 26, 22, 18))
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 168, 119, 31))
$g.FillRectangle($brush, 18, 18, 220, 220)
$font = New-Object System.Drawing.Font("Georgia", 160, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 26, 22, 18))
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("B", $font, $textBrush, (New-Object System.Drawing.RectangleF(0,0,256,256)), $sf)
$g.Dispose()
New-Item -ItemType Directory -Force -Path "assets" | Out-Null
$bmp.Save("$build\assets\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
node -e "const {default:p}=require('png-to-ico'),fs=require('fs');p('assets/icon.png').then(b=>{fs.writeFileSync('assets/icon.ico',b);console.log('icon.ico ready')})" 2>&1 | Out-Null

# 4. Build renderer + main process
Write-Host "[ 4/5 ] Building app..." -ForegroundColor Yellow
npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Check output above." -ForegroundColor Red
    exit 1
}

# 5. Package into installer
Write-Host "[ 5/5 ] Packaging installer..." -ForegroundColor Yellow
npx electron-builder --win 2>&1 | Select-String -NotMatch "^\s*$"

# Find the installer
$installer = Get-ChildItem "$build\release\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$installer) {
    $installer = Get-ChildItem "$build\dist\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($installer) {
    Write-Host ""
    Write-Host "=== Done! ===" -ForegroundColor Green
    Write-Host "Installer: $($installer.FullName)" -ForegroundColor Green
    Write-Host "Size: $([math]::Round($installer.Length/1MB, 1)) MB" -ForegroundColor Green
    Write-Host ""
    Write-Host "To deploy to a staff PC:" -ForegroundColor Cyan
    Write-Host "  1. Copy the installer to their machine (USB, shared drive, Teams, etc.)"
    Write-Host "  2. Double-click to install — no admin required for user install"
    Write-Host "  3. A 'Bellomy Workpapers' shortcut appears on their Desktop and Start Menu"
    Write-Host "  4. First launch: click the gear icon to point it at Z:\"
    Write-Host ""
    Write-Host "To push an update later:"
    Write-Host "  Re-run this script, then send the new installer to staff. Installing over"
    Write-Host "  an existing version updates it in place — settings and Z:\ path are preserved."
    Write-Host ""

    # Offer to open the folder
    $open = Read-Host "Open the output folder? (y/n)"
    if ($open -eq 'y') { explorer.exe (Split-Path $installer.FullName) }
} else {
    Write-Host "Installer not found — check electron-builder output above." -ForegroundColor Red
}
