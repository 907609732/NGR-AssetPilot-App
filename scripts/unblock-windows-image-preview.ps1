#Requires -Version 5.1

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$imageExtensions = @(
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg"
)

function Select-TargetFolder {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Select the folder containing images exported by NGR AssetPilot."
  $dialog.ShowNewFolderButton = $false

  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    return $null
  }

  return $dialog.SelectedPath
}

try {
  $targetPath = $env:NGR_UNBLOCK_TARGET
  if ([string]::IsNullOrWhiteSpace($targetPath)) {
    $targetPath = Select-TargetFolder
  }

  if ([string]::IsNullOrWhiteSpace($targetPath)) {
    Write-Host "[NGR AssetPilot] No folder was selected. Nothing was changed." -ForegroundColor Yellow
    exit 0
  }

  $resolvedTarget = (Resolve-Path -LiteralPath $targetPath).Path
  if (-not (Test-Path -LiteralPath $resolvedTarget -PathType Container)) {
    throw "The selected path is not a folder: $resolvedTarget"
  }

  $images = @(
    Get-ChildItem -LiteralPath $resolvedTarget -Recurse -File -Force |
      Where-Object { $imageExtensions -contains $_.Extension.ToLowerInvariant() }
  )

  if ($images.Count -eq 0) {
    Write-Host "[NGR AssetPilot] No supported image files were found." -ForegroundColor Yellow
    exit 0
  }

  $unblockedCount = 0
  $alreadyCleanCount = 0
  $failedFiles = New-Object System.Collections.Generic.List[string]

  foreach ($image in $images) {
    $zoneStream = Get-Item -LiteralPath $image.FullName -Stream "Zone.Identifier" -ErrorAction SilentlyContinue
    if ($null -eq $zoneStream) {
      $alreadyCleanCount += 1
      continue
    }

    try {
      Unblock-File -LiteralPath $image.FullName -ErrorAction Stop
      $unblockedCount += 1
    } catch {
      $failedFiles.Add($image.FullName)
    }
  }

  Write-Host "[NGR AssetPilot] Finished." -ForegroundColor Green
  Write-Host "Folder: $resolvedTarget"
  Write-Host "Image files scanned: $($images.Count)"
  Write-Host "Internet security marks removed: $unblockedCount"
  Write-Host "Already unblocked: $alreadyCleanCount"

  if ($failedFiles.Count -gt 0) {
    Write-Host "Failed files: $($failedFiles.Count)" -ForegroundColor Red
    $failedFiles | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
  }

  exit 0
} catch {
  Write-Host "[NGR AssetPilot] Failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
