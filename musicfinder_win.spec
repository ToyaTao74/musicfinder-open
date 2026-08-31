# -*- mode: python ; coding: utf-8 -*-
# MusicFinder Windows 打包配置（产出 MusicFinder.exe，单文件）
# 用法(在 Windows 上): python -m PyInstaller musicfinder_win.spec --noconfirm
import os

SPEC_DIR = os.path.dirname(os.path.abspath(SPEC)) if 'SPEC' in globals() else os.path.dirname(os.path.abspath(__file__))
APP_DIR = SPEC_DIR

# 版本号单一来源：从 app.py 的 APP_VERSION 读取，避免包名/内部版本号不同步
import re as _re
_src = open(os.path.join(APP_DIR, 'app.py'), encoding='utf-8').read()
_m = _re.search(r"^APP_VERSION\s*=\s*['\"]([^'\"]+)['\"]", _src, _re.M)
APP_VERSION = _m.group(1) if _m else '0.0.0'

a = Analysis(
    [os.path.join(APP_DIR, 'app.py')],
    pathex=[APP_DIR],
    binaries=[],
    datas=[
        (os.path.join(APP_DIR, 'templates'), 'templates'),
        (os.path.join(APP_DIR, 'static'), 'static'),
        (os.path.join(APP_DIR, 'evidence'), 'evidence'),
        (os.path.join(APP_DIR, 'monitor'), 'monitor'),
        # 单文件的目标写 '.'（bundle 根目录）。若写成同名字符串，PyInstaller 会
        # 当成目录名，产出 port.txt/port.txt 这种嵌套，运行时 open() 直接 IsADirectoryError。
        (os.path.join(APP_DIR, '使用说明.md'), '.'),
        (os.path.join(APP_DIR, 'port.txt'), '.'),
    ] + (
        # Windows 把 Chromium 烤进安装包（CI 先用 PLAYWRIGHT_BROWSERS_PATH 把浏览器下到
        # 仓库 pw_browsers/，再随包分发），团队用户双击即用、零下载。
        # macOS 不做这一步（PyInstaller 给嵌套 Chromium.app 重签会失败），改为运行时按需下载。
        [(os.path.join(APP_DIR, 'pw_browsers'), 'playwright_browsers')]
        if os.path.exists(os.path.join(APP_DIR, 'pw_browsers')) else []
    ),
    hiddenimports=[
        'flask', 'jinja2', 'markupsafe', 'werkzeug', 'itsdangerous',
        'click', 'openpyxl', 'et_xmlfile',
        'requests', 'urllib3', 'certifi', 'charset_normalizer',
        'pypinyin',
        # 加密模块（app.py 在函数内懒加载：from Crypto.Cipher import AES），
        # PyInstaller 静态分析抓不到，必须显式声明，否则打包运行后 ModuleNotFoundError
        'Crypto', 'Crypto.Cipher', 'Crypto.Util.Padding',
        # app.py 顶层 import config（云端配置兜底），PyInstaller 静态分析可能漏收，显式声明
        'config',
        # 音乐证据监测台（版权取证）后端包：模块级 import 在 try/except 内，
        # PyInstaller 静态分析可能漏收，这里显式声明保证打进包
        'evidence', 'evidence.db', 'evidence.importer', 'evidence.detect',
        'evidence.classify', 'evidence.engine', 'evidence.routes',
        'evidence.platforms', 'evidence.platforms.netease',
        'evidence.platforms.qishui', 'evidence.platforms.douyin',
        # 平台监控模块（反山寨/歌手监控）后端包，同样显式声明
        'monitor', 'monitor.db', 'monitor.importer', 'monitor.matcher',
        'monitor.normalize', 'monitor.routes',
        'sqlite3',
        # Playwright 一键浏览器登录：Python 包显式声明以打进包；Windows 的 Chromium 浏览器
        # 二进制通过上方 datas 烤进安装包（零下载），macOS 则在运行时按需下载规避重签失败
        'playwright', 'playwright.sync_api', 'playwright.async_api', 'greenlet',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

# ── v4.29：Windows 由 one-file 改为 one-dir（产出 dist/MusicFinder/ 目录）──
# 为什么改：one-file 每次启动都要把整个 bundle（含几百 MB 的 Chromium）解压到
# %TEMP%\_MEIxxxx 随机临时目录，这个解压过程会被 Windows Defender 实时逐文件扫描，
# 是「Windows 搜索比 Mac 慢一个数量级」的主要元凶之一。改成 one-dir 后文件固定躺在
# 安装目录、只读一次不重解压，且排除目录变成固定路径（安装时一次性加好即可）。
exe = EXE(
    pyz,
    a.scripts,
    [],                     # one-dir：二进制与数据不塞进 exe，改由下方 COLLECT 收集
    exclude_binaries=True,
    name='MusicFinder',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # upx=False（原为 True）：UPX 加壳的二进制启动时需先解压到内存，且更容易触发
    # 杀软启发式误报与扫描。本版目标就是提速，故关闭压缩，让文件被直接加载。
    upx=False,
    runtime_tmpdir=None,
    # console=False: 双击 .exe 不弹黑色命令行窗口（纯后台本地 server + 自动开浏览器）
    # 若需查看运行日志，把下面改成 console=True 重新打包
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # 版本元数据：右键 exe → 属性 → 详细信息里显示版本号（与 APP_VERSION 同步）
    version_info={
        'version': APP_VERSION,
        'company_name': 'MusicFinder',
        'file_description': 'MusicFinder 音乐匹配器',
        'internal_name': 'MusicFinder',
        'legal_copyright': 'MusicFinder',
        'original_filename': 'MusicFinder.exe',
        'product_name': 'MusicFinder',
        'product_version': APP_VERSION,
    },
)

# PyInstaller ≥ 6.0 的 one-dir 默认把依赖与数据放进 `_internal/` 子目录，会导致
# app.py 里「资源在 exe 同目录」的假设失效（templates / playwright_browsers 找不到）。
# 这里显式指定 contents_directory='.' 平铺到 exe 同目录，保持资源定位简单可靠；
# 同时按版本条件传参，兼容 PyInstaller 5.x（该版本无此参数）。
try:
    import PyInstaller as _PI
    _PI_VER = tuple(int(_x) for _x in str(getattr(_PI, '__version__', '0')).split('.')[:2] if _x.isdigit())
except Exception:
    _PI_VER = (0, 0)
_collect_kwargs = {'contents_directory': '.'} if _PI_VER >= (6, 0) else {}

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='MusicFinder',
    **_collect_kwargs,
)
