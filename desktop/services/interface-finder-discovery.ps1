$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$finderPaths = [System.Collections.Generic.List[string]]::new()
Get-CimInstance Win32_Process -Filter "Name='快速找界面.exe'" | ForEach-Object { if ($_.ExecutablePath) { $finderPaths.Add($_.ExecutablePath) } }
$finderRegistryRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion', 'HKLM:\Software\Microsoft\Windows\CurrentVersion', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion')
foreach ($finderRegistryRoot in $finderRegistryRoots) {
  $finderAppPath = Get-ItemProperty -LiteralPath "$finderRegistryRoot\App Paths\快速找界面.exe"
  if ($finderAppPath.'(default)') { $finderPaths.Add($finderAppPath.'(default)'.Trim('"')) }
  Get-ChildItem -LiteralPath "$finderRegistryRoot\Uninstall" | ForEach-Object {
    $finderInstalled = Get-ItemProperty -LiteralPath $_.PSPath
    if ($finderInstalled.DisplayName -like '*快速找界面*' -and $finderInstalled.InstallLocation) {
      $finderPaths.Add((Join-Path $finderInstalled.InstallLocation '快速找界面.exe'))
      $finderPaths.Add((Join-Path $finderInstalled.InstallLocation '桌面端\快速找界面.exe'))
    }
  }
}
$finderShortcutRoots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'))
$finderShell = New-Object -ComObject WScript.Shell
foreach ($finderShortcutRoot in $finderShortcutRoots) {
  if (!$finderShortcutRoot) { continue }
  Get-ChildItem -LiteralPath $finderShortcutRoot -Filter '*.lnk' -Recurse -File | Select-Object -First 2000 | ForEach-Object {
    $finderTarget = $finderShell.CreateShortcut($_.FullName).TargetPath
    if ([IO.Path]::GetFileName($finderTarget) -eq '快速找界面.exe') { $finderPaths.Add($finderTarget) }
  }
}
$finderRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'), (Join-Path $env:USERPROFILE 'Downloads'), [Environment]::GetFolderPath('Desktop'))
foreach ($finderDrive in @('C:\', 'D:\', 'E:\', 'F:\')) {
  if (Test-Path -LiteralPath $finderDrive) { $finderRoots += $finderDrive; $finderRoots += (Join-Path $finderDrive '软件'); $finderRoots += (Join-Path $finderDrive 'Program Files') }
}
foreach ($finderRoot in ($finderRoots | Select-Object -Unique)) {
  if (!$finderRoot -or !(Test-Path -LiteralPath $finderRoot)) { continue }
  Get-ChildItem -LiteralPath $finderRoot -Directory | Where-Object { $_.Name -match '快速找界面|quick.interface|团队便携版' } | Select-Object -First 30 | ForEach-Object {
    foreach ($finderRelative in @('快速找界面.exe', '桌面端\快速找界面.exe', '团队便携版\桌面端\快速找界面.exe')) { $finderPaths.Add((Join-Path $_.FullName $finderRelative)) }
  }
}
ConvertTo-Json -InputObject @($finderPaths | Select-Object -Unique) -Compress
