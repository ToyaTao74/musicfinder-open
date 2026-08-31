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
;
;  注意：本脚本刻意只保留最小可用指令集。Section 名、快捷方式名一律用
;  ASCII，中文只出现在注释与 DetailPrint/完成页静态文本里（配合
;  Unicode true + UTF-8 BOM 显示正常）。此前版本带的 VIProductVersion /
;  VIAddVersionKey / MUI_FINISHPAGE_RUN 等已在排障中移除，勿轻易加回。
; ══════════════════════════════════════════════════════════════════

!include "MUI2.nsh"

; 必须显式声明（本脚本含中文）；放在 include 之后无副作用，NSIS 3 默认即 Unicode
Unicode true

Name "MusicFinder"
OutFile "dist\MusicFinder-v${APP_VERSION}-Windows-Setup.exe"
; 装在机器级目录：程序本体只读（用户数据全部写在 %USERPROFILE%\.musicfinder），
; 放 Program Files 安全，也避开管理员安装时 $LOCALAPPDATA 指向错误账户的坑。
InstallDir "$PROGRAMFILES64\MusicFinder"
InstallDirRegKey HKLM "Software\MusicFinder" "InstallDir"
; 需要管理员：只为写 Windows Defender 排除列表（UAC 全程只弹这一次）
RequestExecutionLevel admin
ShowInstDetails show
SetCompressor /SOLID lzma

; 版本号由 CI 传入（/DAPP_VERSION=），本地调试未传时兜底
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_PUBLISHER
  !define APP_PUBLISHER "MusicFinder"
!endif

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TEXT "MusicFinder v${APP_VERSION} 安装完成。$\r$\n$\r$\n已自动将安装目录加入 Windows Defender 排除列表，搜索速度已优化，无需再做任何配置。$\r$\n$\r$\n请从桌面或开始菜单启动 MusicFinder；首次使用先在「Cookie 设置」页用一键登录配置你的音乐账号。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 语言：优先简体中文；缺 SimpChinese 语言文件时自动退回英文，
; 用编译期文件探测兜底，避免语言文件缺失导致整个编译失败。
!if /FileExists "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
  !insertmacro MUI_LANGUAGE "SimpChinese"
!else
  !insertmacro MUI_LANGUAGE "English"
!endif

; ── 主程序（必装）────────────────────────────────────────────────
Section "MainProgram" SEC_MAIN
  SectionIn RO
  SetShellVarContext all

  SetOutPath "$INSTDIR"
  ; PyInstaller one-dir 产物（exe + 依赖 + templates + playwright_browsers）
  ; 用 "*" 而非 "*.*"，确保无扩展名的文件（Chromium 部分二进制）也进包
  File /r "dist\MusicFinder\*"
  ; Defender 排除脚本：随程序一起安装，安装/卸载时由下方 Section 调用
  File "installer_defender.ps1"

  ; 卸载入口（机器级注册表 →「添加/删除程序」可见）
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "DisplayName" "MusicFinder v${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\MusicFinder" "InstallDir" "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\MusicFinder"
  CreateShortcut "$SMPROGRAMS\MusicFinder\MusicFinder.lnk" "$INSTDIR\MusicFinder.exe"
  CreateShortcut "$SMPROGRAMS\MusicFinder\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\MusicFinder.lnk" "$INSTDIR\MusicFinder.exe"
SectionEnd

; ── 提速关键：Defender 排除 ──────────────────────────────────────
Section "DefenderExclusions" SEC_DEFENDER
  DetailPrint "正在把程序目录加入 Windows Defender 排除列表（避免每次启动被实时扫描）…"
  ; 整条命令先拼进变量再交给 ExecWait。
  ; 不能直接写成 ExecWait '"..." -Command "..."' 那种嵌套引号：NSIS 解析命令行时会把 ''
  ; 当作「关闭引号+重新打开」，整条命令被切成多个参数 →
  ; "ExecWait expects 1-2 parameters, got 6" 直接编译失败（本地 makensis 实测）。
  ; 用变量传参可彻底规避：ExecWait 只会收到 1 个参数。
  StrCpy $1 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\installer_defender.ps1" -Mode exclude'
  ExecWait $1 $0
  DetailPrint "Defender 排除配置完成（返回码 $0）。"
SectionEnd

; ── 卸载 ────────────────────────────────────────────────────────
Section "Uninstall"
  SetShellVarContext all

  ; 移除安装时加的 Defender 排除，保持系统干净（同样用变量传参规避引号嵌套）
  StrCpy $1 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\installer_defender.ps1" -Mode unexclude'
  ExecWait $1 $0

  Delete "$DESKTOP\MusicFinder.lnk"
  Delete "$SMPROGRAMS\MusicFinder\MusicFinder.lnk"
  Delete "$SMPROGRAMS\MusicFinder\Uninstall.lnk"
  RMDir "$SMPROGRAMS\MusicFinder"

  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\MusicFinder"
  DeleteRegKey HKLM "Software\MusicFinder"
SectionEnd
