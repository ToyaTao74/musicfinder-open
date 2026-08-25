#!/usr/bin/env python3
"""盗版判定（默认待复核 + 授权艺人自动提示）

策略（用户拍板：默认待复核、人工确认，自动提示官方账号）：
  - 每条证据初始 piracy_status='待复核'。
  - 若上传者(uploader)命中授权曲库里的艺人，piracy_suggest 提示「授权版」(否)；
    否则 piracy_suggest 留空，等待人工确认。
  - 我们**从不自动判定为盗版(是)**——是否盗版由用户点「确认」时落库。

这样合规稳妥：机器只提示，最终定性权在人。
"""

from . import db


def suggest(song_name='', artist='', uploader='', version='', original_author=''):
    """返回 (piracy_status, piracy_suggest)。

    默认返回 ('待复核', '')；若上传者/原声账号命中授权艺人，suggest='授权版'。
    优先用 original_author（原声账号=歌曲作者），更准；video_blogger 仅作辅助。
    """
    status = db.PIRACY_PENDING
    suggest = ''
    # 候选授权来源：原声账号优先，其次视频博主
    candidates = [original_author, uploader]
    artists = db.authorized_artists()
    for raw in candidates:
        up = (raw or '').strip().lower()
        if not up:
            continue
        for art in artists:
            if not art:
                continue
            if art in up or up in art:
                suggest = '授权版'
                break
        if suggest:
            break
    return status, suggest


def apply_suggestion(ev_kwargs):
    """给定一条证据的字段，补全 piracy_status / piracy_suggest。"""
    extra = ev_kwargs.get('extra') or {}
    st, sg = suggest(
        song_name=ev_kwargs.get('song_name', ''),
        artist=ev_kwargs.get('artist', ''),
        uploader=ev_kwargs.get('uploader', ''),
        original_author=extra.get('original_author', ''),
    )
    ev_kwargs.setdefault('piracy_status', st)
    ev_kwargs.setdefault('piracy_suggest', sg)
    return ev_kwargs
