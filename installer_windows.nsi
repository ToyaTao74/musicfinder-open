; ══════════════════════════════════════════════════════════════════
;  MusicFinder Windows 安装脚本（NSIS）
;
;  核心目的：让用户「装完即用、无需任何手动配置」即可获得提速效果。
;  安装时以管理员权限把安装目录加入 Windows Defender 排除列表——
;  这一步是 Windows 端提速的关键（否则每次启动 Chromium 都会被
;  Defender 实时逐文件扫描，单首搜索可能要数分钟）。
;
;  编译方式（CI 在仓库根目录执行）：
;    makensis /DAPP_VERSION=4.29.0 installer_windows.nsi
;  产物：dist\MusicFinder-v<版本>-Windows-Setup.exe
; ══════════════════════════════════════════════════════════════════

!include "MUI2.nsh"

; Unicode true：本脚本含大量中文，必须显式声明，否则非 ASCII 会按 ANSI 解析成乱码
Unicode true

Name "MusicFinder"
OutFile "dist\MusicFinder-v${APP_VERSION}-Windows-Setup.exe"
; 安装在机器级目录：程序本体只读（用户数据全部写在 %USERPROFILE%\.musicfinder），
; 因此放 Program Files 是安全的，也避免管理员安装时 $LOCALAPPDATA 指向错误账户的坑。
InstallDir "$PROGRAMFILES64\MusicFinder"
InstallDirRegKey HKLM "Software\MusicFinder" "InstallDir"
; 需要管理员：只为写 Windows Defender 排除列表（UAC 全程只弹这一次）
RequestExecutionLevel admin
ShowInstDetails show
SetCompressor /SOLID lzma

; 版本号由 CI 传入（/DAPP_VERSION=），本地调试未传时兜底 0.0.0
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_PUBLISHER
  !define APP_PUBLISHER "MusicFinder"
!endif

; VI* 需要 4 段版本号，APP_VERSION 是 3 段，补 .0
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "MusicFinder"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "MusicFinder 安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"

!define MUI_ABORTWARNING
; 完成后可选立即启动。用 explorer 包装启动：安装器是提权进程，
; 直接 Exec 会让程序以管理员身份跑；经 explorer 中转可降级回当前用户。
!define MUI_FINISHPAGE_RUN "$WINDIR\explorer.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "$INSTDIR\MusicFinder.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 MusicFinder"
!define MUI_FINISHPAGE_TEXT "MusicFinder v${APP_VERSION} 安装完成。$\r$\n$\r$\n已自动将安装目录加入 Windows Defender 排除列表，搜索速度已优化，无需再做任何配置。$\r$\n$\r$\n首次使用请先在「Cookie 设置」页用一键登录配置你的音乐账号。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 语言：优先简体中文；若该 NSIS 安装缺 SimpChinese 语言文件则自动退回英文。
; 用编译期文件探测兜底 —— 语言文件缺失是安装器编译失败的常见原因，不能让它拖垮构建。
!if /FileExists "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
  !insertmacro MUI_LANGUAGE "SimpChinese"
!else
  !insertmacro MUI_LANGUAGE "English"
!endif

; ── 主程序（必装）────────────────────────────────────────────────
Section "安装主程序" SEC_MAIN
  SectionIn RO
  SetShellVarContext all

  ; 旧版本可能仍在运行，先结束，避免文件占用导致覆盖失败
  ExecWait '"$SYSDIR\taskkill.exe" /F /IM "MusicFinder.exe" /T' $1

  SetOutPath "$INSTDIR"
  ; PyInstaller one-dir 产物（exe + 依赖 + templates + playwright_browsers）
  ; 用 "*" 而非 "*.*"：确保无扩展名的文件（如 Chromium 的部分二进制）也被打进安装包
  File /r "dist\MusicFinder\*"

  ; 卸载入口（机器级注册表，对应「添加/删除程序」）
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "DisplayName" "MusicFinder v${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\MusicFinder" "InstallDir" "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\MusicFinder"
  CreateShortcut "$SMPROGRAMS\MusicFinder\MusicFinder.lnk" "$INSTDIR\MusicFinder.exe"
  CreateShortcut "$SMPROGRAMS\MusicFinder\卸载 MusicFinder.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\MusicFinder.lnk" "$INSTDIR\MusicFinder.exe"
SectionEnd

; ── 提速关键：Defender 排除 ──────────────────────────────────────
Section "配置 Windows Defender 排除（提速关键）" SEC_DEFENDER
  DetailPrint "正在把程序目录加入 Windows Defender 排除列表（避免每次启动被实时扫描）…"
  ; 排除 1：安装目录——Chromium 与各依赖都在这里，是提速主要收益点
  ; 排除 2：Playwright 用户级浏览器缓存（通配覆盖所有用户，兜底用；Windows 包已自带 Chromium，通常不会走到）
  ; -ErrorAction SilentlyContinue：若本机未启用 Defender（如装了第三方杀软）也不影响安装完成
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath ''$INSTDIR'' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionPath ''C:\Users\*\AppData\Local\ms-playwright'' -ErrorAction SilentlyContinue"' $0
  DetailPrint "Defender 排除配置完成（返回码 $0）。"
SectionEnd

; ── 卸载 ────────────────────────────────────────────────────────
Section "Uninstall"
  SetShellVarContext all

  ; 移除安装时加的 Defender 排除，保持系统干净
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath ''$INSTDIR'' -ErrorAction SilentlyContinue"' $0

  ExecWait '"$SYSDIR\taskkill.exe" /F /IM "MusicFinder.exe" /T' $1

  Delete "$DESKTOP\MusicFinder.lnk"
  Delete "$SMPROGRAMS\MusicFinder\MusicFinder.lnk"
  Delete "$SMPROGRAMS\MusicFinder\卸载 MusicFinder.lnk"
  RMDir "$SMPROGRAMS\MusicFinder"

  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder"
  DeleteRegKey HKLM "Software\MusicFinder"
SectionEnd
