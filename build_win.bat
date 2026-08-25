@echo off
chcp 65001 >nul
REM ============================================================
REM  MusicFinder Windows 一键打包脚本
REM  前置条件：本机已安装 Python 3.10+ 并勾选 "Add Python to PATH"
REM  用法：把本文件与 app.py / musicfinder_win.spec / templates / static
REM        放在同一目录，双击本文件即可
REM  产物：dist\MusicFinder.exe （单文件，可单独拷贝到任意 Windows 使用）
REM
REM  音频模块需要：
REM    - pip 安装 librosa / imageio-ffmpeg / pyacoustid
REM    - binaries\fpcalc.exe 存在（Chromaprint 官方二进制，用于指纹精确匹配层）
REM      若缺失，旋律相似兜底层仍可用，仅「精确命中」判定不可用。
REM ============================================================

REM 先清理旧产物，避免 PyInstaller 缓存导致 bundle 内前端文件陈旧
if exist dist rmdir /s /q dist
if exist build rmdir /s /q build

echo [1/3] 安装依赖 (pyinstaller / flask / openpyxl / requests / librosa / imageio-ffmpeg / pyacoustid) ...
python -m pip install --upgrade pip
pip install pyinstaller flask openpyxl requests
pip install librosa imageio-ffmpeg pyacoustid

echo [2/3] 执行 PyInstaller 打包 (one-file) ...
python -m PyInstaller musicfinder_win.spec --noconfirm

echo [3/3] 完成。产物位于 dist\MusicFinder.exe
echo 把 dist\MusicFinder.exe 拷到新电脑，双击即可使用（首次可能被 SmartScreen 拦截，点"仍要运行"）。
if not exist binaries\fpcalc.exe (
  echo.
  echo [提醒] binaries\fpcalc.exe 缺失：指纹精确匹配层将不可用，仅旋律相似兜底。
  echo         请从 https://github.com/acoustid/chromaprint/releases 下载 fpcalc.exe 放入 binaries\ 后重新打包。
)
pause
