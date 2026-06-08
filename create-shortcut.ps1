# Run once to create a desktop shortcut for Bellomy Workpapers
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\Bellomy Workpapers.lnk")
$Shortcut.TargetPath = "G:\My Drive\Firm Documents\Billy\Drivers\Taxdome Viewer\Bellomy Workpapers.bat"
$Shortcut.WorkingDirectory = "C:\Projects\bellomy-workpapers"
$Shortcut.Description = "Bellomy Workpapers tax document viewer"
$Shortcut.Save()
Write-Host "Shortcut created on Desktop." -ForegroundColor Green
