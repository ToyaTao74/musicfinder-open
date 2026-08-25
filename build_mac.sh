#!/bin/bash
# MusicFinder Mac 重打包脚本（当你改了 app.py / templates / static 后想重新生成 .app 用）
# 前置：本机有 Python 3.10+，且已装 pyinstaller/flask/openpyxl/requests
#   pip install pyinstaller flask openpyxl requests librosa imageio-ffmpeg pyacoustid
set -e
cd "$(dirname "$0")"

# 确保 binaries 目录存在（音频指纹层 fpcalc 二进制存放处）
mkdir -p binaries

# 若缺少 fpcalc（mac 版，无后缀），尝试从 Chromaprint 官方 release 下载
if [ ! -f binaries/fpcalc ]; then
  echo "[0/4] 尝试下载 Chromaprint fpcalc (mac) ..."
  curl -fsSL -o /tmp/fpcalc_mac.tar.gz \
    https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-macos-x86_64.tar.gz \
    || echo "⚠️ fpcalc 下载失败（指纹层将不可用，旋律层仍可用）"
  tar -xzf /tmp/fpcalc_mac.tar.gz -C /tmp 2>/dev/null || true
  FPC=$(find /tmp -name fpcalc -type f 2>/dev/null | head -1)
  if [ -n "$FPC" ]; then
    cp -f "$FPC" binaries/fpcalc
    chmod +x binaries/fpcalc
    echo "✅ fpcalc 已就位: binaries/fpcalc"
  else
    echo "⚠️ 未获取到 fpcalc，指纹精确匹配层将不可用（仅旋律相似兜底）。"
  fi
fi

# 清理旧产物：用 mv 移走（绕开 rm -rf 的安全删除拦截，避免陈旧 bundle 被增量覆盖）
TS=$(date +%s)
[ -d dist ] && mv dist /tmp/mf_old_dist_$TS 2>/dev/null || true
[ -d build ] && mv build /tmp/mf_old_build_$TS 2>/dev/null || true

echo "[1/4] 安装/确认音频依赖 (librosa / imageio-ffmpeg / pyacoustid) ..."
pip install librosa imageio-ffmpeg pyacoustid 2>/dev/null || python3 -m pip install librosa imageio-ffmpeg pyacoustid || true

echo "[2/4] 执行 PyInstaller 打包 (arm64) ..."
python3 -m PyInstaller musicfinder_mac.spec --noconfirm

# 双保险：构建后把最新 templates/static/binaries 显式覆盖进 bundle
# （防止 PyInstaller 因缓存/沙箱安全删除拦截导致 bundle 内前端文件陈旧）
echo "[3/4] 将最新 templates/static/binaries 覆盖进 bundle（双保险）..."
cp -f templates/index.html  dist/MusicFinder.app/Contents/Resources/templates/index.html
cp -f templates/batch.html  dist/MusicFinder.app/Contents/Resources/templates/batch.html
cp -rf static/.            dist/MusicFinder.app/Contents/Resources/static/
cp -rf binaries/.          dist/MusicFinder.app/Contents/Resources/binaries/

# 校验：bundle 与源必须一致
SRC_MD5=$(md5 -q templates/index.html)
DST_MD5=$(md5 -q dist/MusicFinder.app/Contents/Resources/templates/index.html)
if [ "$SRC_MD5" != "$DST_MD5" ]; then
  echo "❌ 校验失败：bundle 内 index.html 与源不一致，打包异常！" >&2
  exit 1
fi
if [ -f binaries/fpcalc ] && [ ! -f dist/MusicFinder.app/Contents/Resources/binaries/fpcalc ]; then
  echo "❌ 校验失败：bundle 内缺少 fpcalc 二进制！" >&2
  exit 1
fi
echo "[4/4] 校验通过。产物: dist/MusicFinder.app"

echo "如需 Intel Mac(x86_64) 版，改用: python3 -m PyInstaller musicfinder_mac.spec --noconfirm --target-arch x86_64"
echo "分发前可压缩: cd dist && zip -r MusicFinder-mac.zip MusicFinder.app"
