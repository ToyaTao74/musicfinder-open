#!/usr/bin/env python3
"""证据监测蓝图 —— /api/evidence/*

路由前缀统一 /api/evidence/*，与主程序、monitor 模块零冲突。
长任务（监测、导入）走后台线程 + 进度轮询，绝不阻塞请求。
"""

import io
import json
import os
import tempfile
import threading
import traceback

from flask import Blueprint, jsonify, request, send_file

import sqlite3

from . import db, detect, importer
from .engine import run_task

bp = Blueprint('evidence', __name__, url_prefix='/api/evidence')

# ── 后台任务注册表（同一时刻同类型只允许一个）──────────
_jobs = {}
_jobs_lock = threading.Lock()


def _job_state(kind):
    with _jobs_lock:
        j = _jobs.get(kind)
        if not j:
            return {'running': False}
        return {'running': j['thread'].is_alive(), 'started_at': j['started_at'],
                'label': j.get('label', ''), 'error': j.get('error', '')}


def _start_job(kind, fn, label=''):
    with _jobs_lock:
        j = _jobs.get(kind)
        if j and j['thread'].is_alive():
            return False, '同类任务正在运行中'
    def wrapper():
        try:
            fn()
        except Exception as e:
            with _jobs_lock:
                if kind in _jobs:
                    _jobs[kind]['error'] = f'{e}\n{traceback.format_exc()[-800:]}'
    t = threading.Thread(target=wrapper, daemon=True)
    _jobs[kind] = {'thread': t, 'started_at': db.now_str(), 'label': label, 'error': ''}
    t.start()
    return True, ''


def _rows(cur):
    return [dict(r) for r in cur.fetchall()]


# ═══════════════════════════════════════════════════
#  概览
# ═══════════════════════════════════════════════════

@bp.route('/stats', methods=['GET'])
def api_stats():
    db.init_db()
    s = db.stats()
    s['platforms'] = detect.EVIDENCE_PLATFORMS
    s['platform_names'] = detect.PLATFORM_NAMES
    s['thresholds'] = {p: detect.threshold_label(p) for p in detect.EVIDENCE_PLATFORMS}
    s['douyin_logged_in'] = os.path.exists(os.path.join(db.DATA_DIR, 'douyin_state.json'))
    return jsonify({'ok': True, 'data': s})


# ═══════════════════════════════════════════════════
#  授权曲库导入
# ═══════════════════════════════════════════════════

@bp.route('/import/preview', methods=['POST'])
def api_import_preview():
    path, err = _save_upload()
    if err:
        return jsonify({'ok': False, 'error': err}), 400
    try:
        return jsonify({'ok': True, 'data': importer.preview(path), 'temp_path': path})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 400


@bp.route('/import/commit', methods=['POST'])
def api_import_commit():
    body = request.get_json(silent=True) or {}
    path = body.get('temp_path') or ''
    mapping_override = body.get('mapping_override') or None
    if not path:
        path, err = _save_upload()
        if err:
            return jsonify({'ok': False, 'error': err}), 400
    if not os.path.exists(path):
        return jsonify({'ok': False, 'error': '临时文件已失效，请重新上传'}), 400
    try:
        stat = importer.import_excel(path, mapping_override=mapping_override)
        return jsonify({'ok': True, 'data': stat})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 400


@bp.route('/import/from-monitor', methods=['POST'])
def api_import_from_monitor():
    """把「数据监控」页已筛选的歌单一键导入授权曲库（免去 Excel 中转）。

    直接读取 monitor.db 的 song_archive 表，批量 upsert 到 evidence 的 catalog 表。
    - only_enabled=true（默认）：只导 enabled=1 的（即用户筛选过、在监控的歌）。
    - only_enabled=false：导全部。
    字段映射：song_archive(song_name/artist/album/lyricist/composer) -> catalog 同名字段。
    """
    body = request.get_json(silent=True) or {}
    only_enabled = body.get('only_enabled', True)
    monitor_db = os.path.join(db.DATA_DIR, 'monitor.db')
    if not os.path.exists(monitor_db):
        return jsonify({'ok': False,
                        'error': '未找到数据监控库（monitor.db），请先在「数据监控」页导入并筛选歌单'}), 400
    try:
        src = sqlite3.connect(monitor_db, timeout=10)
        src.row_factory = sqlite3.Row
        where = 'WHERE enabled=1' if only_enabled else ''
        rows = src.execute(
            f'SELECT song_name, artist, album, lyricist, composer '
            f'FROM song_archive {where} ORDER BY id').fetchall()
        src.close()
    except Exception as e:
        return jsonify({'ok': False, 'error': f'读取数据监控库失败：{e}'}), 500

    imported, skipped = 0, 0
    for r in rows:
        name = (r['song_name'] or '').strip()
        if not name:
            skipped += 1
            continue
        db.upsert_catalog(
            song_name=name,
            artist=(r['artist'] or '').strip(),
            album=(r['album'] or '').strip(),
            version='',
            copyright_company='',
            lyricist=(r['lyricist'] or '').strip(),
            composer=(r['composer'] or '').strip(),
            batch='from_monitor',
        )
        imported += 1

    db.init_db()
    return jsonify({'ok': True, 'data': {
        'imported': imported,
        'skipped': skipped,
        'monitor_total': imported + skipped,
        'catalog_total': db.catalog_count(),
    }})


def _save_upload():
    f = request.files.get('file')
    if not f or not f.filename:
        return '', '未收到文件'
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ('.xlsx', '.xlsm', '.xls', '.csv', '.txt', '.tsv'):
        return '', f'不支持的文件类型：{ext}'
    fd, path = tempfile.mkstemp(suffix=ext, prefix='mf_evidence_')
    os.close(fd)
    f.save(path)
    return path, ''


# ═══════════════════════════════════════════════════
#  监测任务
# ═══════════════════════════════════════════════════

@bp.route('/task/start', methods=['POST'])
def api_task_start():
    body = request.get_json(silent=True) or {}
    songs = body.get('songs') or []
    if not songs and body.get('song'):
        songs = [{'song': body.get('song'), 'artist': body.get('artist', ''),
                  'version': body.get('version', '')}]
    if not songs:
        return jsonify({'ok': False, 'error': '未提供歌曲'}), 400
    if len(songs) > 20:
        return jsonify({'ok': False, 'error': '一次最多 20 首'}), 400

    platforms = body.get('platforms') or detect.EVIDENCE_PLATFORMS
    search_mode = body.get('search_mode', 'auto')
    opts = {}
    if 'douyinTarget' in body:
        opts['target_count'] = int(body['douyinTarget'])
    if 'douyinSource' in body:
        opts['source'] = body['douyinSource']

    db.init_db()
    created = []
    for s in songs:
        tid = db.create_task(
            song_name=s.get('song') or s.get('song_name') or '',
            artist=s.get('artist', ''),
            version=s.get('version', ''),
            platforms=platforms,
            search_mode=search_mode,
        )
        created.append(tid)

    def _run_ids(tids, run_opts):
        for tid in tids:
            t = db.get_task(tid)
            if not t:
                continue
            run_task(tid, t['song_name'], artist=t['artist'], version=t['version'],
                     platforms=json.loads(t['platforms']) if isinstance(t['platforms'], str) else t['platforms'],
                     opts=run_opts)

    def run_all():
        _run_ids(created, opts)
        # 接续消费：若本批提交时同类任务正在跑（_start_job 返回 ok:false），
        # 期间入库的新任务会停留在 queued 且无人执行。job 收尾时统一补跑，
        # 兑现「新任务已加入队列，将在当前任务结束后执行」的承诺；
        # 最多补跑 5 轮，防止极端情况下反复扫到新任务导致 job 不退出。
        for _ in range(5):
            leftover = [t['id'] for t in db.list_tasks(200) if t['status'] == 'queued']
            if not leftover:
                break
            _run_ids(leftover, opts)

    ok, err = _start_job('evidence_monitor', run_all, label=f'监测 {len(created)} 首')
    return jsonify({'ok': ok, 'error': err, 'task_ids': created})


@bp.route('/tasks', methods=['GET'])
def api_tasks():
    db.init_db()
    # v4.30.29：管理弹窗用 ?include_hidden=1 拿含已隐藏（前台删除）的全量列表
    include_hidden = request.args.get('include_hidden') in ('1', 'true')
    return jsonify({'ok': True, 'data': {'tasks': db.list_tasks(50, include_hidden=include_hidden)}})


@bp.route('/task/<int:task_id>/hide', methods=['POST'])
def api_task_hide(task_id):
    """前台删除任务（软删除）：hidden=1，任务与证据数据后台全保留。"""
    db.init_db()
    t = db.get_task(task_id)
    if not t:
        return jsonify({'ok': False, 'error': '任务不存在'}), 404
    if t['status'] in ('queued', 'running'):
        return jsonify({'ok': False, 'error': '任务正在执行中，不能删除；可先停止再删'})
    db.set_task_hidden(task_id, 1)
    return jsonify({'ok': True, 'data': {'task_id': task_id, 'hidden': 1}})


@bp.route('/task/<int:task_id>/restore', methods=['POST'])
def api_task_restore(task_id):
    """管理弹窗里恢复被删除（隐藏）的任务。"""
    db.init_db()
    t = db.get_task(task_id)
    if not t:
        return jsonify({'ok': False, 'error': '任务不存在'}), 404
    db.set_task_hidden(task_id, 0)
    return jsonify({'ok': True, 'data': {'task_id': task_id, 'hidden': 0}})


@bp.route('/tasks/batch-hide', methods=['POST'])
def api_tasks_batch_hide():
    """v4.30.31 批量删除/恢复：{task_ids:[...], hidden:1|0}。

    删除（hidden=1）时若有执行中/排队中的任务，整批拒绝并列出阻塞项，
    避免用户以为全删了实际漏掉几个。
    """
    db.init_db()
    body = request.get_json(silent=True) or {}
    ids = [int(i) for i in (body.get('task_ids') or []) if str(i).isdigit()]
    hidden = 1 if body.get('hidden', 1) else 0
    if not ids:
        return jsonify({'ok': False, 'error': '未选择任务'}), 400
    if hidden:
        blocking = []
        for i in ids:
            t = db.get_task(i)
            if t and t['status'] in ('queued', 'running'):
                blocking.append(i)
        if blocking:
            return jsonify({'ok': False,
                            'error': f'任务 {blocking} 正在执行/排队中，不能删除'})
    for i in ids:
        db.set_task_hidden(i, hidden)
    return jsonify({'ok': True, 'data': {'updated': len(ids), 'hidden': hidden}})


# ── v4.30.34 浏览器扩展辅助抓取 ──────────────────────────────
# 扩展取件 → 用户真实浏览器开抖音搜索页抓取 → 回传签名接口响应原文 →
# 云端复用 _parse_aweme_bodies 解析入库。鉴权同 db_export（部署密钥）。
# 引擎是唯一派单方（engine._run_via_extension → ext_jobs.assign），
# 扩展只通过 /ext/poll 取件 + /ext/report 回传，无竞争。

def _ext_key_ok():
    key = (request.args.get('key') or request.headers.get('X-MF-Key') or '').strip()
    expect = (os.environ.get('MUSICFINDER_CLOUDBASE_TOKEN') or '').strip() \
        or (getattr(__import__('config'), 'CLOUDBASE_TOKEN', '') or '').strip()
    return bool(expect) and key == expect


@bp.route('/ext/poll', methods=['GET'])
def api_ext_poll():
    """扩展轮询取件：返回最早一个未投递的任务；没有则 data=null。"""
    if not _ext_key_ok():
        return jsonify({'ok': False, 'error': '密钥无效'}), 403
    from . import ext_jobs
    worker = (request.args.get('worker') or 'ext').strip()[:40] or 'ext'
    info = ext_jobs.pick(worker)
    if info:
        db.update_task(info['task_id'], status=db.TASK_RUNNING,
                       message=f'已派给扩展[{worker}]，在你的浏览器里抓取中…')
    return jsonify({'ok': True, 'data': info})


@bp.route('/ext/report', methods=['POST'])
def api_ext_report():
    """扩展回传：{task_id, bodies:[签名接口响应原文...], done:bool, error:str}"""
    if not _ext_key_ok():
        return jsonify({'ok': False, 'error': '密钥无效'}), 403
    from . import ext_jobs
    body = request.get_json(silent=True) or {}
    task_id = body.get('task_id')
    if not task_id:
        return jsonify({'ok': False, 'error': '缺少 task_id'}), 400
    ok = ext_jobs.report(int(task_id), bodies=body.get('bodies') or [],
                         done=bool(body.get('done')), error=body.get('error') or '')
    return jsonify({'ok': ok, 'data': {'received': True}})


@bp.route('/ext/status', methods=['GET'])
def api_ext_status():
    """扩展设置页连通性测试 + 云端扩展在线状态。"""
    if not _ext_key_ok():
        return jsonify({'ok': False, 'error': '密钥无效'}), 403
    from . import ext_jobs
    worker = (request.args.get('worker') or 'ext').strip()[:40] or 'ext'
    ext_jobs.touch_worker(worker)
    return jsonify({'ok': True, 'data': ext_jobs.status()})


@bp.route('/task/<int:task_id>/progress', methods=['GET'])
def api_task_progress(task_id):
    db.init_db()
    t = db.get_task(task_id)
    if not t:
        return jsonify({'ok': False, 'error': '任务不存在'}), 404
    return jsonify({'ok': True, 'data': {'task': dict(t), 'job': _job_state('evidence_monitor')}})


@bp.route('/dashboard', methods=['GET'])
def api_dashboard():
    db.init_db()
    task_id = request.args.get('task_id')
    task_id = int(task_id) if task_id and task_id.isdigit() else None
    time_range = request.args.get('time_range', 'all')
    d = db.dashboard(task_id, time_range=time_range)
    return jsonify({'ok': True, 'data': d})


# ═══════════════════════════════════════════════════
#  人工复核
# ═══════════════════════════════════════════════════

@bp.route('/review', methods=['POST'])
def api_review():
    body = request.get_json(silent=True) or {}
    ids = body.get('ids') or []
    status = body.get('status')
    if not ids:
        return jsonify({'ok': False, 'error': '未选择证据'}), 400
    if status not in db.REVIEW_STATUS_OPTIONS:
        return jsonify({
            'ok': False,
            'error': f'status 必须是 {" / ".join(db.REVIEW_STATUS_OPTIONS)} 之一'
        }), 400
    n = db.set_review(ids, status)
    return jsonify({'ok': True, 'data': {'updated': n}})


# ═══════════════════════════════════════════════════
#  抖音登录态
# ═══════════════════════════════════════════════════

@bp.route('/douyin/status', methods=['GET'])
def api_douyin_status():
    state = os.path.join(db.DATA_DIR, 'douyin_state.json')
    return jsonify({'ok': True, 'data': {'logged_in': os.path.exists(state),
                                          'note': '未登录时运行 `python -m evidence.platforms.douyin login` 扫码登录一次'}})


@bp.route('/douyin/preflight', methods=['GET'])
def api_douyin_preflight():
    """检测 patchright + chromium 是否就绪（弹窗第一步用）"""
    patchright_ok = False
    chromium_ok = False
    err = ''
    try:
        from patchright.sync_api import sync_playwright  # noqa: F401
        patchright_ok = True
        from pathlib import Path
        cdir = Path.home() / '.cache' / 'ms-playwright'
        chromium_ok = cdir.exists() and any(cdir.glob('chromium-*'))
    except Exception as e:
        err = str(e)
    state_file = os.path.join(db.DATA_DIR, 'douyin_state.json')
    return jsonify({'ok': True, 'data': {
        'patchright_ok': patchright_ok,
        'chromium_ok': chromium_ok,
        'logged_in': os.path.exists(state_file),
        'err': err,
        'install_cmd': 'cd /Users/toya/WorkBuddy/2026-07-30-11-09-35/musicfinder && ./venv/bin/python3 -m pip install patchright && ./venv/bin/python3 -m patchright install chromium',
        'login_cmd': './venv/bin/python3 -m evidence.platforms.douyin login',
    }})


@bp.route('/douyin/check', methods=['GET'])
def api_douyin_check():
    """扫码完成后，前端调这个看登录态是否生效"""
    state_file = os.path.join(db.DATA_DIR, 'douyin_state.json')
    logged_in = os.path.exists(state_file)
    age_min = None
    if logged_in:
        try:
            import time
            age_min = round((time.time() - os.path.getmtime(state_file)) / 60, 1)
        except Exception:
            pass
    return jsonify({'ok': True, 'data': {
        'logged_in': logged_in,
        'age_minutes': age_min,
        'state_path': state_file,
    }})


@bp.route('/douyin/parse-link', methods=['POST'])
def api_douyin_parse_link():
    """贴一个抖音视频链接，反查原曲信息（歌名/歌手/上传者）。"""
    url = ((request.get_json(silent=True) or {}).get('url') or '').strip()
    if not url:
        return jsonify({'ok': False, 'error': '请提供抖音视频链接'}), 400
    if 'douyin.com' not in url.lower():
        return jsonify({'ok': False, 'error': '不是抖音链接（需含 douyin.com）'}), 400
    try:
        from .platforms.douyin import parse_video_url
        info = parse_video_url(url, headless=False)   # v4.30.26：headless 会触发抖音滑块，统一 headful（云端由 Xvfb 提供虚拟显示）
    except Exception as e:
        return jsonify({'ok': False, 'error': f'解析失败: {e}'}), 500
    if info.get('needs_login'):
        return jsonify({'ok': False, 'error': '请先登录抖音（证据页右上角点「📱 立即扫码登录抖音」）', 'needs_login': True}), 200
    if info.get('error'):
        return jsonify({'ok': False, 'error': info['error']}), 200
    if not info.get('music_name'):
        return jsonify({'ok': False, 'error': '未能识别原曲名（可能不是 BGM 视频，或页面结构变化）', 'info': info}), 200
    return jsonify({'ok': True, 'data': info})


# ═══════════════════════════════════════════════════
#  导出 Excel
# ═══════════════════════════════════════════════════

@bp.route('/export.xlsx', methods=['GET'])
def api_export():
    """导出「维权清单」：与页面筛选联动（任务/平台/阈值/盗版/审核/时间）。

    列：歌名、歌手、平台、抖音视频链接、汽水音频链接、互动量、命中依据、抓取时间、状态
    """
    db.init_db()
    task_id = request.args.get('task_id')
    task_id = int(task_id) if task_id and task_id.isdigit() else None
    platform = request.args.get('platform', 'all')
    threshold = request.args.get('threshold', 'all')
    piracy = request.args.get('piracy', 'all')
    review = request.args.get('review_status', 'all')
    time_range = request.args.get('time_range', 'all')
    pub_range = request.args.get('pub_range', 'all')
    ev = db.list_evidence(task_id=task_id, platform=platform, threshold=threshold,
                          piracy=piracy, review=review, time_range=time_range, pub_range=pub_range)

    def inter_summary(e):
        it = e.get('interactions') or {}
        parts = []
        if e['platform'] == 'douyin':
            for k, zh in (('likes', '赞'), ('collect', '藏'), ('comments', '评'),
                          ('shares', '分享'), ('plays', '使用')):
                if it.get(k) not in (None, '', 0):
                    parts.append(f'{zh}{it[k]}')
        else:
            for k, zh in (('favorites', '收藏'), ('comments', '评'),
                          ('plays', '播放'), ('shares', '分享')):
                if it.get(k) not in (None, '', 0):
                    parts.append(f'{zh}{it[k]}')
        return ' / '.join(parts)

    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = '维权清单'
    headers = ['歌名', '歌手', '平台', '抖音视频链接', '汽水音频链接',
               '互动量', '命中依据', '抓取时间', '状态']
    ws.append(headers)
    for e in ev:
        ws.append([
            e['song_name'], e['artist'],
            detect.PLATFORM_NAMES.get(e['platform'], e['platform']),
            e['video_url'] or e['official_url'],
            e['soda_link'],
            inter_summary(e),
            e['match_basis'],
            e['created_at'] or '',
            e['review_status'],
        ])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f'维权清单_task{task_id}.xlsx' if task_id else '维权清单_全部.xlsx'
    return send_file(buf, mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     as_attachment=True, download_name=fname)


# ═══════════════════════════════════════════════════
#  蓝图挂载
# ═══════════════════════════════════════════════════

def register(app):
    """在主程序里调用：evidence.routes.register(app)

    与 monitor.routes.register 同构。顺带做一次 init_db()，
    保证首次运行（含打包版首次启动）就有 ~/.musicfinder/evidence.db 表结构，
    避免前端一进页面就因为「表不存在」报 500。
    """
    try:
        db.init_db()
    except Exception:                                        # pragma: no cover
        # 建库失败不阻断蓝图挂载：让接口自己报错，比整块功能消失更好排查
        traceback.print_exc()
    app.register_blueprint(bp)
    return bp
