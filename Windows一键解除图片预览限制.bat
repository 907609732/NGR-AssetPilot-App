@echo off
setlocal
chcp 65001 >nul

set "NGR_UNBLOCK_TARGET=%~1"
set "NGR_HELPER_SCRIPT=%~dp0scripts\unblock-windows-image-preview.ps1"

if not exist "%NGR_HELPER_SCRIPT%" (
  echo [NGR AssetPilot] Helper script was not found:
  echo %NGR_HELPER_SCRIPT%
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%NGR_HELPER_SCRIPT%"
set "NGR_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%NGR_EXIT_CODE%"=="0" (
  echo [NGR AssetPilot] The operation did not complete successfully.
)
pause
exit /b %NGR_EXIT_CODE%
