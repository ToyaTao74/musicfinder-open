#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MusicFinder 配置（脱敏模板，安全可入库）。
复制为 config.py 后填入你自己的密钥；或设置环境变量 DISCOGS_TOKEN。
⚠️ 不要把真实 config.py / cookies.json 提交到仓库（已在 .gitignore 排除）。
"""
import os

# ── Discogs（唱片公司/厂牌的通用第三方源）──────────────
# 免费注册 https://www.discogs.com/settings/developers → “Generate token”
# 生成一个 personal access token 后，二选一填入：
#   方式一：直接写在下面的引号里
#   方式二：设置环境变量  export DISCOGS_TOKEN=xxxx
# 单个 token 服务整个程序永久使用，无需终端用户任何操作。
# 默认值留空，必须自行配置（或设环境变量）才能使用 Discogs 增强功能。
DISCOGS_TOKEN = os.environ.get("DISCOGS_TOKEN", "")

# Discogs 要求的 User-Agent（随便写，但建议含联系方式）
DISCOGS_USER_AGENT = "MusicFinder/1.0"

# 有界内存缓存上限（控制内存，避免无限增长）
DISCOGS_CACHE_MAX = 5000
