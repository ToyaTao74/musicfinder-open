#!/usr/bin/env python3
"""网易云音乐抓取

走官方 Web API 搜索 + 歌曲页兜底取收藏量。无需登录（收藏量公开可见）。
注：网易云有反爬，若返回空多半是接口风控，需在 Windows 端用本机 IP / 加 cookie 调。
"""

import re

from . import register

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
REFERER = 'https://music.163.com/'


def _session():
    import requests
    s = requests.Session()
    s.headers.update({'User-Agent': UA, 'Referer': REFERER,
                      'Accept': 'application/json'})
    return s


def _basis(name, artists, q_name, q_artist):
    nb = (name or '').replace(' ', '').lower()
    qb = (q_name or '').replace(' ', '').lower()
    ab = (artists or '').replace(' ', '').lower()
    qab = (q_artist or '').replace(' ', '').lower()
    if qb and qb in nb:
        if not qab or qab in ab:
            return '歌名+歌手匹配'
        return '歌名匹配(歌手不符)'
    return '模糊相关'


def _fetch_counts(s, sid):
    """取一首歌的互动数据。

    现状（2026-08 实测）：网易云 api/song/detail 已下线
    favoriteCount / playCount / commentCount 三个字段（恒为 None），
    因此改走两个仍然可用的口径：
      - popularity：detail 里的热度值（0-100 浮点），可作为传播广度代理指标
      - comments  ：api/v1/resource/comments/R_SO_4_{id} 的 total（真实评论总数）
    收藏量目前无公开接口可取（歌曲页为 JS 渲染），保留正则兜底但通常抓不到。
    """
    interactions = {}
    # ① detail：热度 + 兜底老字段
    try:
        r = s.post('https://music.163.com/api/song/detail/',
                   data={'id': sid, 'ids': f'[{sid}]'}, timeout=15)
        song = (r.json().get('songs') or [{}])[0]
        pop = song.get('popularity')
        if pop is not None:
            interactions['popularity'] = round(float(pop), 1)
        # 下面三个字段目前恒为 None，保留以便官方哪天恢复时自动生效
        if song.get('commentCount') is not None:
            interactions['comments'] = song['commentCount']
        if song.get('playCount') is not None:
            interactions['plays'] = song['playCount']
        fav = song.get('favoriteCount')
        if fav is None:
            fav = (song.get('info') or {}).get('favoriteCount')
        if fav is not None:
            interactions['favorites'] = fav
    except Exception:
        pass
    # ② 评论总数（独立接口，实测可用）
    if 'comments' not in interactions:
        try:
            c = s.get(f'https://music.163.com/api/v1/resource/comments/R_SO_4_{sid}',
                      params={'limit': 1, 'offset': 0}, timeout=15).json()
            total = c.get('total')
            if total is not None:
                interactions['comments'] = int(total)
        except Exception:
            pass
    # ③ 收藏量兜底（多半抓不到，留着不亏）
    if 'favorites' not in interactions:
        try:
            html = s.get(f'https://music.163.com/song?id={sid}', timeout=15).text
            m = re.search(r'收藏</span>\s*<span[^>]*>([\d,]+)', html)
            if not m:
                m = re.search(r'([\d,]+)\s*次收藏', html)
            if m:
                interactions['favorites'] = int(m.group(1).replace(',', ''))
        except Exception:
            pass
    return interactions


@register('netease')
def search(song_name, artist='', version='', limit=20, **_):
    import requests
    s = _session()
    candidates = []
    try:
        resp = s.post('https://music.163.com/api/search/get',
                      data={'s': f'{song_name} {artist}'.strip(), 'type': 1,
                            'limit': limit, 'offset': 0}, timeout=15)
        songs = (resp.json().get('result') or {}).get('songs') or []
    except Exception as e:
        return [{'error': f'网易云搜索失败: {e}'}]

    for song in songs:
        sid = song.get('id')
        if not sid:
            continue
        name = song.get('name', '')
        artists = '/'.join(a.get('name', '') for a in song.get('artists', []))
        album_obj = song.get('album') or {}
        album = album_obj.get('name', '')
        url = f'https://music.163.com/song?id={sid}'
        # v4.29.1：发布时间 = 专辑发行日（album.publishTime 毫秒时间戳 → 北京时间 YYYY-MM-DD）
        uploaded_at = ''
        try:
            pt = album_obj.get('publishTime')
            if pt:
                import datetime as _dt
                uploaded_at = _dt.datetime.fromtimestamp(
                    int(pt) / 1000,
                    _dt.timezone(_dt.timedelta(hours=8)),
                ).strftime('%Y-%m-%d')
        except Exception:
            uploaded_at = ''
        candidates.append({
            'song_name': name, 'artist': artists, 'version': '',
            'official_url': url, 'video_url': url, 'soda_link': '',
            'interactions': _fetch_counts(s, sid),
            'match_basis': _basis(name, artists, song_name, artist),
            'uploader': artists, 'uploaded_at': uploaded_at,
            'extra': {'netease_id': sid, 'album': album},
        })
    return candidates
