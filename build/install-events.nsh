!ifndef BUILD_UNINSTALLER
  Var previousUserInstallLocation
  Var previousUserInstallVersion
  Var previousMachineInstallLocation
  Var previousMachineInstallVersion

  !macro customInit
    # Capture the existing registration before electron-builder runs the old uninstaller.
    ReadRegStr $previousUserInstallLocation HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $previousUserInstallVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ReadRegStr $previousMachineInstallLocation HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ReadRegStr $previousMachineInstallVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ClearErrors
  !macroend

  !macro customHeader
    Function WriteInstallationEvent
      # This hook also precedes the silent updater's immediate application launch.
      ${IfNot} ${FileExists} "$appExe"
      ${OrIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
      ${OrIfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
        Return
      ${EndIf}
      ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      ReadRegStr $1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
      ${If} $0 != $INSTDIR
      ${OrIf} $1 != "${VERSION}"
        ClearErrors
        Return
      ${EndIf}

      # All-users installs can replace an existing current-user installation too.
      StrCpy $2 $previousUserInstallVersion
      StrCpy $3 $previousUserInstallLocation
      ${If} $installMode == "all"
        ${If} $previousMachineInstallLocation != ""
        ${OrIf} $previousMachineInstallVersion != ""
          StrCpy $2 $previousMachineInstallVersion
          StrCpy $3 $previousMachineInstallLocation
        ${EndIf}
      ${EndIf}

      ${If} ${isUpdated}
        StrCpy $3 "update"
      ${ElseIf} $2 != ""
      ${AndIf} $2 != "${VERSION}"
        StrCpy $3 "update"
      ${ElseIf} $3 != ""
      ${OrIf} $2 != ""
        StrCpy $3 "reinstall"
      ${Else}
        StrCpy $3 "first"
      ${EndIf}

      System::Call 'ole32::CoCreateGuid(g .r0) i.r1'
      ${If} $1 != 0
        DetailPrint "Could not create an installation event ID."
        Return
      ${EndIf}
      StrCpy $0 $0 36 1
      StrCpy $4 "$INSTDIR\resources\installation-event.$0.tmp"
      ClearErrors
      FileOpen $1 "$4" w
      ${IfNot} ${Errors}
        FileWrite $1 "[installation]$\r$\nid=$0$\r$\nkind=$3$\r$\nversion=${VERSION}$\r$\npreviousVersion=$2$\r$\n"
        FileClose $1
        ${IfNot} ${Errors}
          # Replace the previous marker only after the new INI file is complete.
          System::Call 'kernel32::MoveFileExW(w r4, w "$INSTDIR\resources\installation-event.ini", i 9) i.r1'
          ${If} $1 != 0
            Return
          ${EndIf}
        ${EndIf}
      ${EndIf}

      Delete "$4"
      DetailPrint "Could not record the completed installation."
      ClearErrors
    FunctionEnd
  !macroend

  !macro customInstall
    Call WriteInstallationEvent
  !macroend
!endif
