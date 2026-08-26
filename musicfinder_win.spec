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
    ],
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
    ],
    # Playwright 为可选增强（登录/酷我词曲/汽水搜索），运行时 try/except 兜底；
    # 打包环境不收集浏览器二进制，故整体排除，避免体积膨胀与无用依赖
    excludes=['playwright', 'playwright.sync_api', 'playwright._impl'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name='MusicFinder',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
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
