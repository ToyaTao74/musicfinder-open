#!/usr/bin/env python3
"""
证据数据层 —— ~/.musicfinder/evidence.db

设计约束（与主程序 monitor 模块一致）：
  1. 数据存用户目录 ~/.musicfinder/，包外，升级 app 不丢。
  2. SQLite + WAL：抓取进程写、Web 进程读，互不阻塞。
  3. 所有写入用 UNIQUE 约束 + UPSERT，重跑幂等（断点续跑安全）。
  4. schema_version 落库，后续加字段走 _migrate()。

表结构总览：
  catalog      授权曲库（用户导入的受保护作品母表）
  tasks        监测任务（单曲/批量提交一次一首歌）
  evidence     监测结果（每条候选 = 一条证据，含平台/链接/互动/盗版状态）
  app_meta     KV 元数据
"""

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta

# ═══════════════════════════════════════════════════
#  路径与常量
# ═══════════════════════════════════════════════════

DATA_DIR = os.path.expanduser(os.environ.get('MUSICFINDER_DATA_DIR', '~/.musicfinder'))
DB_PATH = os.path.join(DATA_DIR, 'evidence.db')

SCHEMA_VERSION = 1

# 复核状态
REVIEW_PENDING, REVIEW_CONFIRMED, REVIEW_IGNORED, REVIEW_CLAIMED = '待复核', '已确认', '已忽略', '已认领'
# 批量复核时可用的 status 取值（前端批量按钮映射到这些字符串）
#   新增 '待复核' 用于"撤销判断"：把 review_status 重置回待复核，同时把 piracy_status 也回到 '待复核'
REVIEW_STATUS_OPTIONS = (REVIEW_PENDING, REVIEW_CONFIRMED, REVIEW_IGNORED, REVIEW_CLAIMED, '盗版', '确认正版')
# 盗版状态
PIRACY_PENDING, PIRACY_YES, PIRACY_NO = '待复核', '是', '否'
# 任务状态
TASK_QUEUED, TASK_RUNNING, TASK_DONE, TASK_PARTIAL, TASK_EMPTY, TASK_FAILED, \
    TASK_CANCELLED, TASK_NEEDS_LOGIN = ('queued', 'running', 'completed',
                                        'partial', 'empty', 'failed',
                                        'cancelled', 'needs_login')

_local = threading.local()


# ═══════════════════════════════════════════════════
#  连接管理
# ═══════════════════════════════════════════════════

def _ensure_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def get_conn():
    """线程内复用连接。WAL + busy_timeout，抓取与网页并发安全。"""
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        return conn
    _ensure_dir()
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('PRAGMA busy_timeout=30000')
    conn.execute('PRAGMA foreign_keys=ON')
    _local.conn = conn
    return conn


def close_conn():
    conn = getattr(_local, 'conn', None)
    if conn is not None:
        try:
            conn.close()
        finally:
            _local.conn = None


@contextmanager
def tx():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# ═══════════════════════════════════════════════════
#  建表
# ═══════════════════════════════════════════════════

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS app_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT
);

-- ── 授权曲库（用户导入的受保护作品）────────────────
CREATE TABLE IF NOT EXISTS catalog (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id           TEXT DEFAULT '',       -- 曲库原始歌曲ID（可选）
    song_name         TEXT NOT NULL,
    artist            TEXT DEFAULT '',
    album             TEXT DEFAULT '',
    version            TEXT DEFAULT '',       -- 版本：完整版/粤语版/...
    copyright_company TEXT DEFAULT '',       -- 版权公司
    lyricist          TEXT DEFAULT '',       -- 词作者
    composer           TEXT DEFAULT '',       -- 曲作者
    match_key         TEXT NOT NULL,         -- 归一化去重键（歌名+歌手+版本）
    batch             TEXT DEFAULT '',
    source_row        INTEGER DEFAULT 0,
    raw               TEXT DEFAULT '',
    created_at        TEXT,
    updated_at        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_key ON catalog(match_key);
CREATE INDEX IF NOT EXISTS idx_catalog_name ON catalog(song_name);

-- ── 监测任务 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    song_name   TEXT NOT NULL,
    artist      TEXT DEFAULT '',
    version      TEXT DEFAULT '',
    platforms   TEXT DEFAULT '["netease","qishui","douyin"]',  -- JSON 数组
    search_mode TEXT DEFAULT 'auto',
    status      TEXT DEFAULT 'queued',  -- queued/running/completed/partial/empty/failed/cancelled/needs_login
    discovered  INTEGER DEFAULT 0,
    verified    INTEGER DEFAULT 0,
    qualified   INTEGER DEFAULT 0,
    message     TEXT DEFAULT '',
    error       TEXT DEFAULT '',
    created_at  TEXT,
    updated_at  TEXT,
    finished_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

-- ── 监测结果（证据）────────────────────────────────
CREATE TABLE IF NOT EXISTS evidence (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    catalog_id     INTEGER DEFAULT 0,       -- 命中的授权曲库歌曲（如有）
    platform       TEXT NOT NULL,          -- netease/qishui/douyin
    song_name      TEXT DEFAULT '',
    artist         TEXT DEFAULT '',
    version         TEXT DEFAULT '',
    official_url   TEXT DEFAULT '',        -- 平台官方链接
    video_url      TEXT DEFAULT '',        -- 视频/作品链接
    soda_link      TEXT DEFAULT '',        -- 汽水音乐挂链（抖音视频上）
    interactions   TEXT DEFAULT '',        -- JSON：{likes,favorites,comments,plays,...}
    match_basis    TEXT DEFAULT '',        -- 命中依据
    qualified      INTEGER DEFAULT 0,      -- 1=达阈值（合格证据）
    piracy_status  TEXT DEFAULT '待复核',   -- 是/否/待复核
    piracy_suggest TEXT DEFAULT '',        -- 自动提示：授权版 / 空
    review_status  TEXT DEFAULT '待复核',   -- 待复核/已确认/已忽略
    uploader       TEXT DEFAULT '',        -- 上传者/账号
    uploaded_at    TEXT DEFAULT '',        -- 发布时间
    extra          TEXT DEFAULT '',        -- JSON 兜底字段
    created_at     TEXT,
    updated_at     TEXT,
    UNIQUE(task_id, platform, official_url, video_url)
);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
CREATE INDEX IF NOT EXISTS idx_evidence_platform ON evidence(platform);
CREATE INDEX IF NOT EXISTS idx_evidence_review ON evidence(review_status);
CREATE INDEX IF NOT EXISTS idx_evidence_piracy ON evidence(piracy_status);
"""


def init_db(verbose=False):
    _ensure_dir()
    conn = get_conn()
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    _migrate(conn, verbose=verbose)
    set_meta('schema_version', str(SCHEMA_VERSION))
    if verbose:
        print(f'[evidence.db] ready -> {DB_PATH}')
    return DB_PATH


def _migrate(conn, verbose=False):
    cur = conn.execute("SELECT value FROM app_meta WHERE key='schema_version'")
    row = cur.fetchone()
    old = int(row['value']) if row and str(row['value']).isdigit() else 0
    if old and old < SCHEMA_VERSION:
        if verbose:
            print(f'[evidence.db] migrate {old} -> {SCHEMA_VERSION}')
        conn.commit()


# ═══════════════════════════════════════════════════
#  元数据 KV
# ═══════════════════════════════════════════════════

def set_meta(key, value):
    with tx() as conn:
        conn.execute(
            'INSERT INTO app_meta(key, value, updated_at) VALUES(?,?,?) '
            'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
            (key, str(value), now_str()))


def get_meta(key, default=None):
    row = get_conn().execute('SELECT value FROM app_meta WHERE key=?', (key,)).fetchone()
    return row['value'] if row else default


# ═══════════════════════════════════════════════════
#  授权曲库写入
# ═══════════════════════════════════════════════════

def _catalog_key(song_name, artist, version=''):
    s = (song_name or '').strip().lower()
    a = (artist or '').strip().lower()
    v = (version or '').strip().lower()
    return '|'.join([s, a, v])


def upsert_catalog(song_id='', song_name='', artist='', album='', version='',
                   copyright_company='', lyricist='', composer='', batch='',
                   source_row=0, raw=None):
    key = _catalog_key(song_name, artist, version)
    ts = now_str()
    raw_s = json.dumps(raw, ensure_ascii=False) if raw is not None else ''
    with tx() as conn:
        conn.execute("""
            INSERT INTO catalog
                (song_id, song_name, artist, album, version, copyright_company,
                 lyricist, composer, match_key, batch, source_row, raw, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(match_key) DO UPDATE SET
                song_id     = CASE WHEN excluded.song_id!='' THEN excluded.song_id ELSE catalog.song_id END,
                album       = CASE WHEN excluded.album!='' THEN excluded.album ELSE catalog.album END,
                copyright_company = CASE WHEN excluded.copyright_company!='' THEN excluded.copyright_company ELSE catalog.copyright_company END,
                lyricist    = CASE WHEN excluded.lyricist!='' THEN excluded.lyricist ELSE catalog.lyricist END,
                composer    = CASE WHEN excluded.composer!='' THEN excluded.composer ELSE catalog.composer END,
                updated_at  = excluded.updated_at
        """, (song_id, song_name, artist, album, version, copyright_company,
              lyricist, composer, key, batch, source_row, raw_s, ts, ts))
        row = conn.execute('SELECT id FROM catalog WHERE match_key=?', (key,)).fetchone()
    return row['id'] if row else None


def catalog_count():
    return get_conn().execute('SELECT COUNT(*) c FROM catalog').fetchone()['c']


def authorized_artists():
    """返回授权曲库里出现过的艺人集合（用于盗版自动提示）。"""
    rows = get_conn().execute(
        "SELECT DISTINCT artist FROM catalog WHERE artist!=''").fetchall()
    return {r['artist'].strip().lower() for r in rows}


# ═══════════════════════════════════════════════════
#  任务写入
# ═══════════════════════════════════════════════════

def create_task(song_name, artist='', version='', platforms=None, search_mode='auto'):
    ts = now_str()
    platforms = platforms or ['netease', 'qishui', 'douyin']
    with tx() as conn:
        cur = conn.execute(
            'INSERT INTO tasks(song_name, artist, version, platforms, search_mode, '
            'status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
            (song_name, artist, version, json.dumps(platforms), search_mode,
             TASK_QUEUED, ts, ts))
        return cur.lastrowid


def update_task(task_id, **kw):
    kw['updated_at'] = now_str()
    cols = ', '.join(f'{k}=?' for k in kw)
    with tx() as conn:
        conn.execute(f'UPDATE tasks SET {cols} WHERE id=?',
                     list(kw.values()) + [task_id])


def finish_task(task_id, status, message=''):
    update_task(task_id, status=status, message=message, finished_at=now_str())


# ═══════════════════════════════════════════════════
#  证据写入
# ═══════════════════════════════════════════════════

def add_evidence(task_id, platform, song_name='', artist='', version='',
                 official_url='', video_url='', soda_link='', interactions=None,
                 match_basis='', qualified=0, piracy_status=PIRACY_PENDING,
                 piracy_suggest='', uploader='', uploaded_at='', extra=None,
                 catalog_id=0):
    ts = now_str()
    with tx() as conn:
        conn.execute("""
            INSERT INTO evidence
                (task_id, catalog_id, platform, song_name, artist, version,
                 official_url, video_url, soda_link, interactions, match_basis,
                 qualified, piracy_status, piracy_suggest, review_status,
                 uploader, uploaded_at, extra, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(task_id, platform, official_url, video_url) DO UPDATE SET
                soda_link=excluded.soda_link,
                interactions=excluded.interactions,
                match_basis=excluded.match_basis,
                qualified=excluded.qualified,
                piracy_status=CASE WHEN evidence.review_status='待复核' THEN excluded.piracy_status ELSE evidence.piracy_status END,
                piracy_suggest=excluded.piracy_suggest,
                uploader=excluded.uploader,
                uploaded_at=excluded.uploaded_at,
                extra=excluded.extra,
                updated_at=excluded.updated_at
        """, (task_id, catalog_id, platform, song_name, artist, version,
              official_url, video_url, soda_link,
              json.dumps(interactions or {}, ensure_ascii=False), match_basis,
              1 if qualified else 0, piracy_status, piracy_suggest, REVIEW_PENDING,
              uploader, uploaded_at,
              json.dumps(extra or {}, ensure_ascii=False), ts, ts))


def set_review(evidence_ids, review_status):
    """批量人工复核。

    review_status 取值（前端 4 个批量按钮对应）：
      - '已确认'    → review_status=已确认（保留原 piracy_status）
      - '已忽略'    → review_status=已忽略（不看）
      - '已认领'    → review_status=已认领（已向平台发起认领/投诉）
      - '盗版'      → review_status=已确认 + piracy_status=是（一键标盗版）
      - '确认正版'  → review_status=已确认 + piracy_status=否（一键标正版）
    """
    ids = [int(i) for i in evidence_ids if str(i).strip()]
    if not ids:
        return 0
    if review_status not in REVIEW_STATUS_OPTIONS:
        raise ValueError(f'unknown review_status: {review_status!r}')
    placeholders = ','.join('?' * len(ids))
    with tx() as conn:
        if review_status == '盗版':
            conn.execute(
                f'UPDATE evidence SET review_status=?, piracy_status=?, updated_at=? '
                f'WHERE id IN ({placeholders})',
                [REVIEW_CONFIRMED, PIRACY_YES, now_str()] + ids)
        elif review_status == '确认正版':
            conn.execute(
                f'UPDATE evidence SET review_status=?, piracy_status=?, updated_at=? '
                f'WHERE id IN ({placeholders})',
                [REVIEW_CONFIRMED, PIRACY_NO, now_str()] + ids)
        elif review_status == REVIEW_CLAIMED:
            conn.execute(
                f'UPDATE evidence SET review_status=?, updated_at=? '
                f'WHERE id IN ({placeholders})',
                [REVIEW_CLAIMED, now_str()] + ids)
        elif review_status == REVIEW_PENDING:
            # 撤销判断：review_status 与 piracy_status 一起回到待复核，原判定作废
            conn.execute(
                f'UPDATE evidence SET review_status=?, piracy_status=?, updated_at=? '
                f'WHERE id IN ({placeholders})',
                [REVIEW_PENDING, PIRACY_PENDING, now_str()] + ids)
        else:  # REVIEW_CONFIRMED / REVIEW_IGNORED：仅改 review_status，保留 piracy_status
            conn.execute(
                f'UPDATE evidence SET review_status=?, updated_at=? '
                f'WHERE id IN ({placeholders})',
                [review_status, now_str()] + ids)
        return conn.execute(
            f'SELECT COUNT(*) c FROM evidence WHERE id IN ({placeholders})', ids).fetchone()['c']


# ═══════════════════════════════════════════════════
#  读取
# ═══════════════════════════════════════════════════

def get_task(task_id):
    row = get_conn().execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()
    return dict(row) if row else None


def list_tasks(limit=50):
    rows = get_conn().execute(
        'SELECT * FROM tasks ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
    return [dict(r) for r in rows]


def list_evidence(task_id=None, platform='all', threshold='all',
                  piracy='all', review='all', time_range='all', pub_range='all'):
    where, args = ['1=1'], []
    if task_id:
        where.append('task_id=?')
        args.append(task_id)
    if platform != 'all':
        where.append('platform=?')
        args.append(platform)
    if threshold == 'qualified':
        where.append('qualified=1')
    elif threshold == 'unqualified':
        where.append('qualified=0')
    if piracy != 'all':
        where.append('piracy_status=?')
        args.append(piracy)
    if review != 'all':
        where.append('review_status=?')
        args.append(review)
    # 抓取时间筛选：created_at 为 'YYYY-MM-DD HH:MM:SS' 字符串，按字典序比较即可
    if time_range in ('week', 'month'):
        days = 7 if time_range == 'week' else 30
        cutoff = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
        where.append('created_at >= ?')
        args.append(cutoff)
    # 发布时间筛选：uploaded_at 为 'YYYY-MM-DD' 字符串，按字典序比较即可
    if pub_range in ('week', 'month'):
        days = 7 if pub_range == 'week' else 30
        cutoff = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
        where.append('uploaded_at >= ? AND uploaded_at != ""')
        args.append(cutoff)
    w = ' AND '.join(where)
    rows = get_conn().execute(
        f'SELECT * FROM evidence WHERE {w} ORDER BY qualified DESC, id DESC', args).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d['interactions'] = json.loads(d['interactions']) if d['interactions'] else {}
        except Exception:
            d['interactions'] = {}
        # 把 extra 里的三分类（监测歌手/原声账号/视频博主）提升到行级，方便前端直接展示
        try:
            ex = json.loads(d['extra']) if d['extra'] else {}
        except Exception:
            ex = {}
        d['original_author'] = ex.get('original_author', '') or ''
        d['monitor_artist'] = ex.get('monitor_artist', '') or ''
        d['video_blogger'] = ex.get('video_blogger', '') or ''
        out.append(d)
    return out


def dashboard(task_id=None, time_range='all'):
    ev = list_evidence(task_id=task_id, time_range=time_range)
    total = len(ev)
    qualified = sum(1 for e in ev if e['qualified'])
    piracy_pending = sum(1 for e in ev if e['piracy_status'] == PIRACY_PENDING)
    piracy_yes = sum(1 for e in ev if e['piracy_status'] == PIRACY_YES)
    piracy_no = sum(1 for e in ev if e['piracy_status'] == PIRACY_NO)
    review_pending = sum(1 for e in ev if e['review_status'] == REVIEW_PENDING)
    per_platform = {}
    for e in ev:
        p = per_platform.setdefault(e['platform'], {'discovered': 0, 'qualified': 0})
        p['discovered'] += 1
        if e['qualified']:
            p['qualified'] += 1
    return {
        'evidence_total': total,
        'qualified': qualified,
        'piracy': {'待复核': piracy_pending, '是': piracy_yes, '否': piracy_no},
        'review_pending': review_pending,
        'per_platform': per_platform,
        'evidence': ev,
    }


def stats():
    conn = get_conn()

    def one(sql, *a):
        r = conn.execute(sql, a).fetchone()
        return r[0] if r else 0

    out = {
        'db_path': DB_PATH,
        'db_size_mb': round(os.path.getsize(DB_PATH) / 1048576, 2) if os.path.exists(DB_PATH) else 0,
        'catalog_total': one('SELECT COUNT(*) FROM catalog'),
        'task_total': one('SELECT COUNT(*) FROM tasks'),
        'evidence_total': one('SELECT COUNT(*) FROM evidence'),
        'qualified_total': one('SELECT COUNT(*) FROM evidence WHERE qualified=1'),
        'review_pending': one("SELECT COUNT(*) FROM evidence WHERE review_status='待复核'"),
        'piracy_yes': one("SELECT COUNT(*) FROM evidence WHERE piracy_status='是'"),
        'review_claimed': one("SELECT COUNT(*) FROM evidence WHERE review_status='已认领'"),
        'schema_version': get_meta('schema_version', '0'),
    }
    return out


if __name__ == '__main__':
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'init'
    if cmd == 'init':
        init_db(verbose=True)
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    elif cmd == 'stats':
        init_db()
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    else:
        print('usage: python -m evidence.db [init|stats]')
