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

    def run_all():
        for tid in created:
            t = db.get_task(tid)
            if not t:
                continue
            run_task(tid, t['song_name'], artist=t['artist'], version=t['version'],
                     platforms=json.loads(t['platforms']) if isinstance(t['platforms'], str) else t['platforms'],
                     opts=opts)

    ok, err = _start_job('evidence_monitor', run_all, label=f'监测 {len(created)} 首')
    return jsonify({'ok': ok, 'error': err, 'task_ids': created})


@bp.route('/tasks', methods=['GET'])
def api_tasks():
    db.init_db()
    return jsonify({'ok': True, 'data': {'tasks': db.list_tasks(50)}})


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
    d = db.dashboard(task_id)
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
    if status not in (db.REVIEW_CONFIRMED, db.REVIEW_IGNORED):
        return jsonify({'ok': False, 'error': 'status 只能是 已确认/已忽略'}), 400
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
        info = parse_video_url(url, headless=True)
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
    db.init_db()
    task_id = request.args.get('task_id')
    task_id = int(task_id) if task_id and task_id.isdigit() else None
    review = request.args.get('review_status', 'all')
    qualified_only = request.args.get('qualified_only') == '1'
    ev = db.list_evidence(task_id=task_id, review=review)
    if qualified_only:
        ev = [e for e in ev if e['qualified']]

    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = '音乐证据'
    headers = ['歌曲', '歌手', '版本', '平台', '官方链接', '视频/作品链接',
               '汽水挂链', '互动数据', '命中依据', '是否盗版', '审核状态', '上传者']
    ws.append(headers)
    for e in ev:
        inter = e.get('interactions') or {}
        inter_s = ' / '.join(f'{k}={v}' for k, v in inter.items() if v not in (None, ''))
        ws.append([
            e['song_name'], e['artist'], e['version'],
            detect.PLATFORM_NAMES.get(e['platform'], e['platform']),
            e['official_url'], e['video_url'], e['soda_link'], inter_s,
            e['match_basis'], e['piracy_status'], e['review_status'], e['uploader'],
        ])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f'evidence_task{task_id}.xlsx' if task_id else 'evidence_all.xlsx'
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
