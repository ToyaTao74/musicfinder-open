#!/usr/bin/env python3
"""证据监测执行引擎

run_task：对一首歌，依次跑各平台 search → 阈值判定合格 → 盗版自动提示 → 写 evidence。
后台线程调用，实时刷 tasks 计数。douyin 无登录态则标 needs_login，不阻塞其它平台。
"""

from . import db, detect, classify
from .platforms import run_platform


def _run_via_extension(task_id, song_name, artist, opts):
    """v4.30.34：douyin 优先派给在线的浏览器扩展（真实指纹+家庭IP+滑块真人过）。

    返回候选列表 = 扩展抓取成功；None = 无扩展在线/超时/报错（回退服务端 Xvfb 抓取）。
    """
    try:
        from . import ext_jobs
        from .platforms.douyin import _parse_aweme_bodies
    except Exception:
        return None
    if not ext_jobs.worker_online():
        return None
    target = int((opts or {}).get('target_count') or 300)
    info = ext_jobs.assign(task_id, song_name, artist, target)
    if not info:
        return None
    db.update_task(task_id, message=f'已派给扩展[{info["worker"]}]，在你的浏览器里抓取中…')
    status, payload = ext_jobs.wait_result(task_id, timeout=ext_jobs.EXT_TIMEOUT)
    ext_jobs.release(task_id)
    if status != 'ok':
        # 回退服务端抓取（超时/扩展报错），如实记录原因
        reason = payload or '扩展超时'
        db.update_task(task_id, message=f'扩展抓取未完成（{reason}），转云端抓取…')
        return None
    try:
        return _parse_aweme_bodies(payload, song_name, artist, target)
    except Exception as e:
        db.update_task(task_id, message=f'扩展数据解析失败: {e}，转云端抓取…')
        return None


def _run_local_direct(task_id, song_name, artist, opts):
    """v4.30.73：云端网关隔离期间，Flask 直连本机 Agent 控制口(127.0.0.1:57080)派单。

    返回候选列表 = 成功；None = 控制口不可达/未登录/失败（回退原网关链路）。
    """
    import json as _json
    import time as _time
    import urllib.request

    base = 'http://127.0.0.1:57080'

    def _get(path, timeout=8):
        with urllib.request.urlopen(f'{base}{path}', timeout=timeout) as r:
            return _json.loads(r.read())

    def _post(path, body, timeout=10):
        req = urllib.request.Request(
            f'{base}{path}', data=_json.dumps(body).encode('utf-8'),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return _json.loads(r.read())

    try:
        st = _get('/status', timeout=3)
    except Exception:
        return None
    if not st.get('ok'):
        return None
    if st.get('douyin_logged_in') is False:
        db.update_task(task_id, message='本机 Agent 抖音未登录，请先在取证页扫码登录')
        return None

    try:
        r = _post('/dispatch', {'task_id': str(task_id), 'song_name': song_name,
                                'platform': 'douyin',
                                'limit': int((opts or {}).get('target_count') or 20)})
        if not r.get('ok'):
            return None
    except Exception:
        return None

    db.update_task(task_id, message='已派给本机 Agent，在你电脑的真实浏览器里抓取中…')
    deadline = _time.time() + 720          # Agent 纯执行预算 12 分钟
    while _time.time() < deadline:
        _time.sleep(3)
        try:
            rec = _get(f'/task/{task_id}', timeout=6)
        except Exception:
            continue
        if not rec.get('ok'):
            continue
        stt = rec.get('status')
        if stt == 'done':
            break
        if stt == 'failed':
            db.update_task(task_id, message=f'本机 Agent 抓取失败（{rec.get("reason", "unknown")}），转下一通道…')
            return None
        if stt == 'waiting_human':
            # 等人工（滑块/扫码）：顺延 2 分钟，不倒扣执行预算（与云端网关分支一致）
            deadline = max(deadline, _time.time() + 120)
            db.update_task(task_id, message='本机 Agent 等待人工处理（滑块/扫码）——请在弹出的 Chrome 窗口操作…')
    else:
        db.update_task(task_id, message='本机 Agent 超时，转下一通道…')
        return None

    try:
        rec = _get(f'/task/{task_id}', timeout=15)
        evs = rec.get('evidence') or []
    except Exception as e:
        db.update_task(task_id, message=f'本机 Agent 结果读取失败: {e}，转下一通道…')
        return None

    cands = []
    for ev in evs:
        if not isinstance(ev, dict) or not ev.get('url'):
            continue
        cands.append({
            'song_name': song_name,
            'artist': artist,
            'video_url': ev.get('url', ''),
            'uploader': ev.get('author', ''),
            'uploaded_at': ev.get('uploaded_at', ''),
            'interactions': {'likes': ev.get('like_count') or 0,
                             'favorites': ev.get('collect_count') or 0,
                             'comments': ev.get('comment_count') or 0,
                             'shares': ev.get('share_count') or 0,
                             'plays': ev.get('play_count') or 0},
            'match_basis': '本机Agent直连·真实浏览器抓取',
            'extra': {'agent_evidence': True,
                      'screenshot': ev.get('screenshot', ''),
                      'html_snapshot': ev.get('html_snapshot', ''),
                      'captured_at': ev.get('captured_at', ''),
                      'env': ev.get('env', {})},
        })
    if not cands:
        db.update_task(task_id, message='本机 Agent 未采到结果，转下一通道…')
        return None
    return cands


def _run_via_agent(task_id, song_name, artist, opts):
    """v4.30.63：douyin 派给本地 Agent（真实 Chrome + 家庭 IP + 真实登录态），经网关 dispatch。

    执行链优先级：浏览器扩展 → 本地 Agent → 云端 Xvfb 抓取。
    v4.30.73：本地 Agent 先试控制口直连（不经网关），失败再走云端网关。
    返回候选列表 = 成功；None = 网关不可达/无在线 Agent/失败（回退下一级）。
    """
    import json as _json
    import os as _os
    import time as _time
    import urllib.request

    # v4.30.73：云端网关隔离（503）期间先试本机控制口直连
    direct = _run_local_direct(task_id, song_name, artist, opts)
    if direct is not None:
        return direct

    gw = (_os.environ.get('AGENT_GATEWAY_HTTP') or '').rstrip('/')
    if not gw:
        return None

    def _get(path, timeout=8):
        with urllib.request.urlopen(f'{gw}{path}', timeout=timeout) as r:
            return _json.loads(r.read())

    def _post(path, body, timeout=10):
        req = urllib.request.Request(
            f'{gw}{path}', data=_json.dumps(body).encode('utf-8'),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return _json.loads(r.read())

    try:
        agents = _get('/agents').get('agents') or {}
    except Exception:
        return None
    online = [(aid, st) for aid, st in agents.items() if st.get('online')]
    if not online:
        db.update_task(task_id, message='无在线本地 Agent，转云端抓取…')
        return None
    logged = [aid for aid, st in online if st.get('douyin_logged_in')]
    agent_id = (logged or [aid for aid, _ in online])[0]

    try:
        r = _post('/dispatch', {'agent_id': agent_id, 'task_id': str(task_id),
                                'song_name': song_name, 'platform': 'douyin',
                                'limit': int((opts or {}).get('target_count') or 20)})
        if not r.get('ok'):
            return None
    except Exception:
        return None

    db.update_task(task_id, message=f'已派给本地 Agent[{agent_id}]，在你电脑的真实浏览器里抓取中…')
    deadline = _time.time() + 720          # Agent 纯执行预算 12 分钟；waiting_human 期间另行顺延
    status_rec = None
    while _time.time() < deadline:
        _time.sleep(3)
        try:
            tasks = {t.get('task_id'): t for t in (_get('/tasks', timeout=6).get('tasks') or [])}
            status_rec = tasks.get(str(task_id))
        except Exception:
            continue
        if not status_rec:
            continue
        st = status_rec.get('status')
        if st == 'done':
            break
        if st == 'failed':
            db.update_task(task_id, message=f'本地 Agent 抓取失败（{status_rec.get("reason", "unknown")}），转云端抓取…')
            return None
        if st == 'waiting_human':
            # 等人工（滑块/扫码）：本次顺延 2 分钟，不倒扣执行预算
            deadline = max(deadline, _time.time() + 120)
    else:
        db.update_task(task_id, message='本地 Agent 超时，转云端抓取…')
        return None

    try:
        res = _get(f'/result/{task_id}', timeout=15)
        evs = (res.get('result') or {}).get('evidence') or []
    except Exception as e:
        db.update_task(task_id, message=f'本地 Agent 结果读取失败: {e}，转云端抓取…')
        return None

    cands = []
    for ev in evs:
        if not isinstance(ev, dict) or not ev.get('url'):
            continue
        cands.append({
            'song_name': song_name,
            'artist': artist,
            'video_url': ev.get('url', ''),
            'uploader': ev.get('author', ''),
            'uploaded_at': ev.get('uploaded_at', ''),
            'interactions': {'likes': ev.get('like_count') or 0,
                             'favorites': ev.get('collect_count') or 0,
                             'comments': ev.get('comment_count') or 0,
                             'shares': ev.get('share_count') or 0,
                             'plays': ev.get('play_count') or 0},
            'match_basis': f'本地Agent[{agent_id}]真实浏览器抓取',
            'extra': {'agent_evidence': True,
                      'screenshot': ev.get('screenshot', ''),
                      'html_snapshot': ev.get('html_snapshot', ''),
                      'captured_at': ev.get('captured_at', ''),
                      'env': ev.get('env', {})},
        })
    if not cands:
        db.update_task(task_id, message='本地 Agent 未采到结果，转云端抓取…')
        return None
    return cands


def run_task(task_id, song_name, artist='', version='', platforms=None, opts=None):
    from . import detect as D
    platforms = platforms or D.EVIDENCE_PLATFORMS
    opts = opts or {}
    db.init_db()
    db.update_task(task_id, status=db.TASK_RUNNING, message='开始监测')
    discovered = verified = qualified = 0
    need_login = False
    plat_errors = []   # v4.30.32：收集平台级错误——之前被静默跳过，任务误报「未发现相关作品」

    for plat in platforms:
        try:
            cands = None
            if plat == 'douyin':
                cands = _run_via_extension(task_id, song_name, artist, opts)
                if cands is None:
                    cands = _run_via_agent(task_id, song_name, artist, opts)
            if cands is None:
                cands = run_platform(plat, song_name, artist=artist, version=version, opts=opts)
        except Exception as e:
            plat_errors.append(f'{D.PLATFORM_NAMES.get(plat, plat)} 异常: {e}')
            db.update_task(task_id, message=f'{D.PLATFORM_NAMES.get(plat, plat)} 异常: {e}')
            continue

        if cands and isinstance(cands[0], dict) and cands[0].get('needs_login'):
            need_login = True
            continue

        for c in cands:
            if not isinstance(c, dict) or 'error' in c:
                if isinstance(c, dict) and c.get('error'):
                    plat_errors.append(f'{D.PLATFORM_NAMES.get(plat, plat)}: {c["error"]}')
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
    elif discovered == 0 and plat_errors:
        # v4.30.32：有明确报错就如实标 failed 并展示首条错误，不再伪装「未发现」
        db.finish_task(task_id, db.TASK_FAILED, message=plat_errors[0][:200])
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
        msg = '已发现作品，但均未达证据阈值'
        if plat_errors:
            msg += '；' + plat_errors[0][:120]
        db.finish_task(task_id, db.TASK_PARTIAL, message=msg)
    else:
        db.finish_task(task_id, db.TASK_DONE,
                       message=f'完成：发现 {discovered} 条，合格 {qualified} 条')
