#!/usr/bin/env python3
"""各平台抓取器统一入口

每个平台模块暴露 search(song_name, artist='', version='', **opts) -> [candidate,...]
candidate 字段：
  song_name, artist, version, official_url, video_url, soda_link,
  interactions{likes,favorites,comments,plays,...}, match_basis,
  uploader, uploaded_at, extra{...}

run_platform 统一调度，返回候选列表；douyin 无登录态时返回 {'needs_login': True}。
"""

from .. import db

PLATFORM_SEARCHERS = {}


def register(platform):
    def deco(fn):
        PLATFORM_SEARCHERS[platform] = fn
        return fn
    return deco


def run_platform(platform, song_name, artist='', version='', opts=None):
    opts = opts or {}
    fn = PLATFORM_SEARCHERS.get(platform)
    if not fn:
        return []
    return fn(song_name, artist=artist, version=version, **opts)


def needs_login(platform):
    return platform == 'douyin'


def _autoload():
    """导入各平台模块，触发 @register 把 search 注册进 PLATFORM_SEARCHERS。

    没有这一步，PLATFORM_SEARCHERS 恒为空字典 —— run_platform 一律返回 []，
    任务永远报「三个平台均未发现相关作品」。这是证据台此前从未产出过
    任何一条结果的根因（装饰器只在模块被 import 时才执行）。
    单个平台 import 失败（如 douyin 缺 patchright）不影响其它平台。
    """
    from importlib import import_module
    for name in ('netease', 'qishui', 'douyin'):
        try:
            import_module(f'{__name__}.{name}')
        except Exception as e:                    # pragma: no cover
            print(f'[evidence] 平台 {name} 加载失败（其它平台不受影响）: {e}')


_autoload()
