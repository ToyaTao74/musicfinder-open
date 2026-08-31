# MusicFinder 安装时调用：把程序目录加入 Windows Defender 排除列表。
#
# 为什么要单独成一个 ps1：NSIS 的 ExecWait 在解析命令行时，会把 '' 当成
# 「关闭引号 + 重新打开引号」，导致含 '' 的整条命令被拆成多个参数而编译失败
# （实测报 "ExecWait expects 1-2 parameters, got 6"）。把 PowerShell 逻辑外置成
# 文件后，NSIS 侧只需传文件名，彻底避开引号嵌套问题。
#
# 由 installer_windows.nsi 随程序安装到 $INSTDIR，通过 -Mode 区分安装/卸载。
param(
    [string]$Mode = 'exclude'
)

# 自身所在目录即程序安装目录 —— 无需外部传路径，进一步简化命令行
$Path = $PSScriptRoot

if ($Mode -eq 'exclude') {
    # 排除 1：安装目录。Chromium 与各依赖都在这里，是提速的主要收益点。
    Add-MpPreference -ExclusionPath $Path -ErrorAction SilentlyContinue
    # 排除 2：Playwright 用户级浏览器缓存（通配覆盖所有用户，仅作兜底；
    #          Windows 包已自带 Chromium，通常不会用到这里）
    Add-MpPreference -ExclusionPath 'C:\Users\*\AppData\Local\ms-playwright' -ErrorAction SilentlyContinue
} else {
    # 卸载时移除安装时加的排除项，保持系统干净
    Remove-MpPreference -ExclusionPath $Path -ErrorAction SilentlyContinue
}

exit 0
