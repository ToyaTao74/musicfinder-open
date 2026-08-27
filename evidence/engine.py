#!/usr/bin/env python3
"""证据监测执行引擎

run_task：对一首歌，依次跑各平台 search → 阈值判定合格 → 盗版自动提示 → 写 evidence。
后台线程调用，实时刷 tasks 计数。douyin 无登录态则标 needs_login，不阻塞其它平台。
"""

from . import db, detect, classify
from .platforms import run_platform


def run_task(task_id, song_name, artist='', version='', platforms=None, opts=None):
    from . import detect as D
    platforms = platforms or D.EVIDENCE_PLATFORMS
    opts = opts or {}
    db.init_db()
    db.update_task(task_id, status=db.TASK_RUNNING, message='开始监测')
    discovered = verified = qualified = 0
    need_login = False

    for plat in platforms:
        try:
            cands = run_platform(plat, song_name, artist=artist, version=version, opts=opts)
        except Exception as e:
            db.update_task(task_id, message=f'{D.PLATFORM_NAMES.get(plat, plat)} 异常: {e}')
            continue

        if cands and isinstance(cands[0], dict) and cands[0].get('needs_login'):
            need_login = True
            continue

        for c in cands:
            if not isinstance(c, dict) or 'error' in c:
                continue
            discovered += 1
            verified += 1
            interactions = c.get('interactions') or {}
            is_q = detect.is_qualified(plat, interactions)
            if is_q:
                qualified += 1
            ev = dict(
                task_id=task_id,
                platform=plat,
                song_name=c.get('song_name', song_name),
                artist=c.get('artist', artist),
                version=c.get('version', ''),
                official_url=c.get('official_url', ''),
                video_url=c.get('video_url', ''),
                soda_link=c.get('soda_link', ''),
                interactions=interactions,
                match_basis=c.get('match_basis', ''),
                uploader=c.get('video_blogger', c.get('uploader', '')),
                uploaded_at=c.get('uploaded_at', ''),
                # 抖音三分类(v2.3.2)：监测歌手/原声账号/视频博主 一起存证，便于展示与判定
                extra={**(c.get('extra') or {}),
                       'monitor_artist': c.get('monitor_artist', ''),
                       'original_author': c.get('original_author', ''),
                       'video_blogger': c.get('video_blogger', '')},
                qualified=1 if is_q else 0,
                catalog_id=0,
            )
            ev = classify.apply_suggestion(ev)
            db.add_evidence(**ev)

    db.update_task(task_id, discovered=discovered, verified=verified, qualified=qualified)
    if need_login and discovered == 0:
        db.finish_task(task_id, db.TASK_NEEDS_LOGIN, message='抖音需登录后才能抓取（CLI 登录一次即可）')
    elif discovered == 0:
        # 动态按实际查询的平台数生成消息（之前写死"三个平台"，勾 1 个时误导）
        names = [D.PLATFORM_NAMES.get(p, p) for p in platforms]
        if len(names) == 1:
            msg = f'{names[0]} 未发现相关作品'
        elif len(names) == 2:
            msg = f'{names[0]}、{names[1]} 均未发现相关作品'
        else:
            joined = '、'.join(names[:-1]) + f'和{names[-1]}'
            msg = f'{joined} 均未发现相关作品'
        db.finish_task(task_id, db.TASK_EMPTY, message=msg)
    elif qualified == 0:
        db.finish_task(task_id, db.TASK_PARTIAL, message='已发现作品，但均未达证据阈值')
    else:
        db.finish_task(task_id, db.TASK_DONE,
                       message=f'完成：发现 {discovered} 条，合格 {qualified} 条')
