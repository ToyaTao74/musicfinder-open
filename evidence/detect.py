#!/usr/bin/env python3
"""官方证据阈值判定

参照海葵「音乐证据监测台」公开的检测规则（我们独立实现，不复制其代码）：
  - 网易云：收藏量 > 1,000
  - 汽水音乐：收藏量 > 1,000
  - 抖音近期（半年内）：点赞 > 10,000
  - 抖音长尾（不限时间）：点赞 >= 30,000

达标即视为「合格证据」。
"""

# 平台标识与中文名
EVIDENCE_PLATFORMS = ['netease', 'qishui', 'douyin']
PLATFORM_NAMES = {'netease': '网易云', 'qishui': '汽水音乐', 'douyin': '抖音'}

# 阈值
NETEASE_FAVORITES_MIN = 1000
QISHUI_FAVORITES_MIN = 1000
DOUYIN_RECENT_LIKES_MIN = 10000     # 近半年
DOUYIN_LONGTAIL_LIKES_MIN = 30000   # 长尾（不限时间）

# 抖音"近期"窗口：半年
DOUYIN_RECENT_DAYS = 180

import re
from datetime import datetime, timedelta


def _to_int(v):
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    s = re.sub(r'[^\d]', '', str(v))
    return int(s) if s else 0


def is_qualified(platform, interactions):
    """按平台阈值判断一条证据是否合格。interactions 为 {likes,favorites,...}。"""
    if not isinstance(interactions, dict):
        interactions = {}
    if platform == 'netease':
        return _to_int(interactions.get('favorites')) > NETEASE_FAVORITES_MIN
    if platform == 'qishui':
        return _to_int(interactions.get('favorites')) > QISHUI_FAVORITES_MIN
    if platform == 'douyin':
        likes = _to_int(interactions.get('likes'))
        if likes >= DOUYIN_LONGTAIL_LIKES_MIN:
            return True
        # 近期：需有发布时间且落在半年内
        uploaded = interactions.get('uploaded_at') or interactions.get('published_at') or ''
        if likes > DOUYIN_RECENT_LIKES_MIN and _within_recent(uploaded):
            return True
        return False
    return False


def _within_recent(uploaded_at):
    if not uploaded_at:
        return False
    for fmt in ('%Y-%m-%d', '%Y-%m-%d %H:%M:%S', '%Y/%m/%d'):
        try:
            dt = datetime.strptime(uploaded_at.strip(), fmt)
            return (datetime.now() - dt).days <= DOUYIN_RECENT_DAYS
        except Exception:
            continue
    return False


def threshold_label(platform):
    if platform == 'netease':
        return f'收藏量 > {NETEASE_FAVORITES_MIN}'
    if platform == 'qishui':
        return f'收藏量 > {QISHUI_FAVORITES_MIN}'
    if platform == 'douyin':
        return (f'近半年点赞 > {DOUYIN_RECENT_LIKES_MIN}；'
                f'或长尾点赞 >= {DOUYIN_LONGTAIL_LIKES_MIN}')
    return ''
