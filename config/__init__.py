#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MusicFinder 配置。
把敏感/环境相关的密钥放在这里（或改用环境变量），不要硬编码进逻辑代码。
"""
import os

# ── Discogs（唱片公司/厂牌的通用第三方源）──────────────
# 免费注册 https://www.discogs.com/settings/developers → “Generate token”
# 生成 personal access token 后，二选一填入：
#   方式一：设置环境变量  export DISCOGS_TOKEN=xxxx
#   方式二：在 ~/.musicfinder/config.json 写入 {"discogs_token": "xxxx"}
# 单个 token 服务整个程序永久使用，无需终端用户任何操作。
# ⚠️ 出于安全考虑，本仓库不再内置任何 token 明文；未配置时 Discogs 兜底源自动跳过。
DISCOGS_TOKEN = os.environ.get("DISCOGS_TOKEN", "")

# Discogs 要求的 User-Agent（随便写，但建议含联系方式）
DISCOGS_USER_AGENT = "MusicFinder/1.0"

# 有界内存缓存上限（控制内存，避免无限增长）
DISCOGS_CACHE_MAX = 5000

# ── CloudBase 云端同步（用户中心 / 邀请码 / 标记 统一后端）────────
# 默认留空；如需开启云端多人同步/账号体系，请自建 CloudBase 环境后填入：
#   优先级：~/.musicfinder/config.json 的 cloudbase 字段 > 环境变量 > 此处默认值。
#   - 环境变量：MUSICFINDER_CLOUDBASE_URL / MUSICFINDER_CLOUDBASE_TOKEN
#   - 或写入 ~/.musicfinder/config.json：
#       {"cloudbase": {"url": "https://你的环境/mark-sync", "token": "你的token"}}
# ⚠️ 出于安全考虑，本仓库不再内置任何 token 明文；未配置时云端同步相关功能自动降级为本地模式。
CLOUDBASE_URL = os.environ.get(
    "MUSICFINDER_CLOUDBASE_URL", "")
CLOUDBASE_TOKEN = os.environ.get(
    "MUSICFINDER_CLOUDBASE_TOKEN", "")

# ── 构建期密钥注入点（CI 专用，源码/仓库绝不含有任何密钥）────────
# 打包时，CI 用 GitHub Secrets 生成 config/_build_secrets.py 并写入真实 token，
# 此处自动覆盖上面的空默认值，使分发的安装包「开箱即用、团队无需任何配置」。
# 本地开发 / 无该文件时静默跳过，回落到环境变量 / 空默认值。
try:
    from config._build_secrets import (  # type: ignore
        DISCOGS_TOKEN as _DT,
        CLOUDBASE_URL as _CU,
        CLOUDBASE_TOKEN as _CT,
    )
    DISCOGS_TOKEN = _DT
    CLOUDBASE_URL = _CU
    CLOUDBASE_TOKEN = _CT
except Exception:
    pass
