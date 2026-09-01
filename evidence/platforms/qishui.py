#!/usr/bin/env python3
"""汽水音乐抓取（复用主程序 MusicFinder 的成熟实现）

历史实现走 www.qishui.com/api/search —— 该地址实际不存在，实测恒返回 0 条，
证据台等于空跑。现改为直接复用主程序 app.search_qishui()：
  - 走 api.qishui.com/luna/pc/search/all（Mac 客户端接口，免登录免签名，实测稳定）
  - 返回 collection_count（收藏量）/ comment_count / share_count，
    其中收藏量正是本模块阈值判定所需的核心指标
  - 顺带带回 lyricist / composer，可与授权曲库的词曲作者比对定盗版

主程序模块在冻结态（PyInstaller）里名字是 __main__、开发态是 app，
因此用 sys.modules 双查 + import 兜底，三种运行方式都能拿到。
"""

import sys

from . import register


def _main_search_qishui():
    """拿到主程序的 search_qishui 函数；拿不到返回 None（本平台优雅降级）。"""
    for mod_name in ('app', '__main__'):
        mod = sys.modules.get(mod_name)
        fn = getattr(mod, 'search_qishui', None) if mod else None
        if callable(fn):
            return fn
    try:                                        # 开发态兜底：独立跑本模块时
        import app as _app
        fn = getattr(_app, 'search_qishui', None)
        return fn if callable(fn) else None
    except Exception:
        return None


def _basis(name, artists, q_name, q_artist):
    nb = (name or '').replace(' ', '').lower()
    qb = (q_name or '').replace(' ', '').lower()
    ab = (artists or '').replace(' ', '').lower()
    qab = (q_artist or '').replace(' ', '').lower()
    if qb and qb in nb and (not qab or qab in ab):
        return '歌名+歌手匹配'
    if qb and qb in nb:
        return '歌名匹配(歌手不符)'
    return '模糊相关'


def _int_or_none(v):
    try:
        return int(v) if v is not None else None
    except Exception:
        return None


@register('qishui')
def search(song_name, artist='', version='', limit=20, **_):
    fn = _main_search_qishui()
    if fn is None:
        return [{'error': '汽水搜索不可用：未取到主程序 search_qishui'}]

    keyword = f'{song_name} {artist}'.strip()
    try:
        rows = fn(keyword, limit) or []
    except Exception as e:
        return [{'error': f'汽水搜索失败: {e}'}]

    candidates = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = row.get('song_name') or ''
        performer = row.get('performer') or ''
        url = row.get('song_url') or ''

        interactions = {}
        for src, dst in (('collection_count', 'favorites'),
                         ('comment_count', 'comments'),
                         ('share_count', 'shares'),
                         ('listening_count', 'plays')):
            val = _int_or_none(row.get(src))
            if val is not None:
                interactions[dst] = val

        candidates.append({
            'song_name': name,
            'artist': performer,
            'version': '',
            'official_url': url,
            'video_url': url,
            'soda_link': url,
            'interactions': interactions,
            'match_basis': _basis(name, performer, song_name, artist),
            'uploader': performer,
            # v4.29.1：主程序 search_qishui 现在带回 release_date（专辑发布日 YYYY-MM-DD）
            'uploaded_at': row.get('release_date') or '',
            'extra': {
                'album': row.get('album') or '',
                'lyricist': row.get('lyricist') or '',
                'composer': row.get('composer') or '',
                'record_label': row.get('record_label') or '',
            },
        })
    return candidates
