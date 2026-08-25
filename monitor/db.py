#!/usr/bin/env python3
"""
监控数据层 —— ~/.musicfinder/monitor.db

设计约束（与主程序一致）：
  1. 数据存用户目录 ~/.musicfinder/，包外，升级 app 不丢。
  2. SQLite + WAL：抓取进程写、Web 进程读，互不阻塞。
  3. 所有"每日/每次"写入都用 UNIQUE 约束 + UPSERT，重跑幂等（断点续跑安全）。
  4. schema_version 落库，后续加字段走 _migrate()，绝不手工改表。

表结构总览：
  song_archive       歌曲档案（Excel 导入的 4000 首母表）
  song_platform      每首歌在 QQ/酷狗/网易云 的锁定 ID + 匹配置信度 + 候选
  daily_metrics      每日指标（收藏 / 在听 / 评论）
  chart_snapshot     每日三平台全量榜单快照
  chart_hit          档案歌曲的上榜命中记录（含排名升降）
  derivative_version 衍生版本（翻唱/改编）
  fetch_run          每次抓取任务的运行日志（成功率 / 断档告警依据）
  app_meta           KV 元数据（schema_version 等）
"""

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime

# ═══════════════════════════════════════════════════
#  路径与常量
# ═══════════════════════════════════════════════════

DATA_DIR = os.path.expanduser(os.environ.get('MUSICFINDER_DATA_DIR', '~/.musicfinder'))
DB_PATH = os.path.join(DATA_DIR, 'monitor.db')

SCHEMA_VERSION = 1

# 监控平台（用户已确认：只要 QQ / 酷狗 / 网易云，不含酷我、汽水）
MONITOR_PLATFORMS = ['qq', 'kugou', 'netease']
PLATFORM_NAMES = {'qq': 'QQ音乐', 'kugou': '酷狗音乐', 'netease': '网易云音乐'}

# 网易云平台不提供在听人数 —— 抓取层不请求、报表层不展示
PLATFORMS_WITH_LISTENING = {'qq', 'kugou'}

# 匹配置信度
CONF_HIGH, CONF_MID, CONF_LOW, CONF_NONE = 'high', 'mid', 'low', 'none'

# 复核状态
REVIEW_AUTO, REVIEW_PENDING, REVIEW_CONFIRMED, REVIEW_REJECTED = (
    'auto_locked', 'pending_review', 'confirmed', 'rejected')

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
    """事务上下文：正常提交，异常回滚。"""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def today_str():
    return datetime.now().strftime('%Y-%m-%d')


# ═══════════════════════════════════════════════════
#  建表
# ═══════════════════════════════════════════════════

SCHEMA_SQL = """
-- ── 元数据 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_meta (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT
);

-- ── 歌曲档案（Excel 母表）──────────────────────────
CREATE TABLE IF NOT EXISTS song_archive (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    song_name    TEXT NOT NULL,
    artist       TEXT DEFAULT '',
    lyricist     TEXT DEFAULT '',      -- 词作者
    composer     TEXT DEFAULT '',      -- 曲作者
    album        TEXT DEFAULT '',
    match_key    TEXT NOT NULL,        -- 归一化去重键（歌名+歌手）
    genre        TEXT DEFAULT '',      -- 曲风：抓平台标签自动填
    genre_source TEXT DEFAULT '',      -- 曲风来源平台
    batch        TEXT DEFAULT '',      -- 导入批次（文件名+时间）
    source_row   INTEGER DEFAULT 0,    -- Excel 原始行号，便于回查
    status       TEXT DEFAULT 'pending',  -- pending/matched/confirmed/skipped
    enabled      INTEGER DEFAULT 1,    -- 0=暂停监控
    note         TEXT DEFAULT '',
    raw          TEXT DEFAULT '',      -- Excel 原始行 JSON
    created_at   TEXT,
    updated_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_key ON song_archive(match_key);
CREATE INDEX IF NOT EXISTS idx_archive_status ON song_archive(status);
CREATE INDEX IF NOT EXISTS idx_archive_name ON song_archive(song_name);

-- ── 平台锁定 ID ───────────────────────────────────
CREATE TABLE IF NOT EXISTS song_platform (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id     INTEGER NOT NULL REFERENCES song_archive(id) ON DELETE CASCADE,
    platform       TEXT NOT NULL,      -- qq/kugou/netease
    song_id        TEXT DEFAULT '',    -- qq=songmid  kugou=hash  netease=id
    extra          TEXT DEFAULT '',    -- JSON：酷狗 album_id/album_audio_id、QQ songid 等
    url            TEXT DEFAULT '',
    matched_name   TEXT DEFAULT '',
    matched_artist TEXT DEFAULT '',
    matched_album  TEXT DEFAULT '',
    score          REAL DEFAULT 0,
    confidence     TEXT DEFAULT 'none',       -- high/mid/low/none
    review_status  TEXT DEFAULT 'pending_review',
    candidates     TEXT DEFAULT '',    -- JSON 数组：候选列表，供复核界面改选
    last_ok_at     TEXT DEFAULT '',    -- 最近一次成功抓到数据
    fail_streak    INTEGER DEFAULT 0,  -- 连续失败次数（下架检测）
    created_at     TEXT,
    updated_at     TEXT,
    UNIQUE(archive_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_sp_platform_song ON song_platform(platform, song_id);
CREATE INDEX IF NOT EXISTS idx_sp_review ON song_platform(review_status, confidence);

-- ── 每日指标 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_metrics (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id       INTEGER NOT NULL REFERENCES song_archive(id) ON DELETE CASCADE,
    platform         TEXT NOT NULL,
    stat_date        TEXT NOT NULL,     -- YYYY-MM-DD
    collection_count INTEGER,           -- 收藏量（NULL=未取到，与 0 区分）
    listening_count  INTEGER,           -- 在听人数（网易云恒为 NULL）
    comment_count    INTEGER,           -- 评论数
    collection_capped INTEGER DEFAULT 0,-- QQ >100万 封顶假值标记
    ok               INTEGER DEFAULT 1, -- 0=本次抓取失败
    err              TEXT DEFAULT '',
    fetched_at       TEXT,
    UNIQUE(archive_id, platform, stat_date)
);
CREATE INDEX IF NOT EXISTS idx_dm_date ON daily_metrics(stat_date);
CREATE INDEX IF NOT EXISTS idx_dm_song ON daily_metrics(archive_id, platform, stat_date);

-- ── 榜单快照（三平台全量）──────────────────────────
CREATE TABLE IF NOT EXISTS chart_snapshot (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    platform    TEXT NOT NULL,
    chart_id    TEXT NOT NULL,
    chart_name  TEXT DEFAULT '',
    stat_date   TEXT NOT NULL,
    rank        INTEGER NOT NULL,
    song_id     TEXT DEFAULT '',
    song_name   TEXT DEFAULT '',
    artist      TEXT DEFAULT '',
    match_key   TEXT DEFAULT '',     -- 归一化键，供无 ID 时兜底对撞
    fetched_at  TEXT,
    UNIQUE(platform, chart_id, stat_date, rank)
);
CREATE INDEX IF NOT EXISTS idx_cs_date ON chart_snapshot(stat_date);
CREATE INDEX IF NOT EXISTS idx_cs_songid ON chart_snapshot(platform, song_id, stat_date);
CREATE INDEX IF NOT EXISTS idx_cs_key ON chart_snapshot(match_key, stat_date);

-- ── 上榜命中 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS chart_hit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id  INTEGER NOT NULL REFERENCES song_archive(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,
    chart_id    TEXT NOT NULL,
    chart_name  TEXT DEFAULT '',
    stat_date   TEXT NOT NULL,
    rank        INTEGER,
    prev_rank   INTEGER,             -- 昨日排名，NULL=昨日未上榜
    rank_delta  INTEGER,             -- 正数=上升
    is_new      INTEGER DEFAULT 0,   -- 1=今日新入榜
    hit_by      TEXT DEFAULT 'id',   -- id=ID对撞  key=歌名对撞
    created_at  TEXT,
    UNIQUE(archive_id, platform, chart_id, stat_date)
);
CREATE INDEX IF NOT EXISTS idx_ch_date ON chart_hit(stat_date);
CREATE INDEX IF NOT EXISTS idx_ch_song ON chart_hit(archive_id, stat_date);

-- ── 衍生版本（翻唱 / 改编）─────────────────────────
CREATE TABLE IF NOT EXISTS derivative_version (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id       INTEGER NOT NULL REFERENCES song_archive(id) ON DELETE CASCADE,
    platform         TEXT NOT NULL,
    song_id          TEXT NOT NULL,
    title            TEXT DEFAULT '',
    artist           TEXT DEFAULT '',
    album            TEXT DEFAULT '',
    url              TEXT DEFAULT '',
    kind             TEXT DEFAULT 'unknown',  -- cover/remix/live/instrumental/unknown
    match_reason     TEXT DEFAULT '',         -- 命中依据：词曲一致 / 歌名一致等
    collection_count INTEGER,
    comment_count    INTEGER,
    first_seen_date  TEXT,
    last_seen_date   TEXT,
    dismissed        INTEGER DEFAULT 0,       -- 人工标记"不是衍生版"
    created_at       TEXT,
    updated_at       TEXT,
    UNIQUE(archive_id, platform, song_id)
);
CREATE INDEX IF NOT EXISTS idx_dv_song ON derivative_version(archive_id);
CREATE INDEX IF NOT EXISTS idx_dv_first ON derivative_version(first_seen_date);

-- ── 抓取运行日志 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS fetch_run (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type    TEXT NOT NULL,       -- archive_match/daily_metrics/charts/derivative
    stat_date   TEXT NOT NULL,
    status      TEXT DEFAULT 'running',  -- running/success/partial/failed
    total       INTEGER DEFAULT 0,
    done        INTEGER DEFAULT 0,
    failed      INTEGER DEFAULT 0,
    started_at  TEXT,
    finished_at TEXT,
    duration_s  INTEGER DEFAULT 0,
    message     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fr_type_date ON fetch_run(run_type, stat_date);
"""


def init_db(verbose=False):
    """建库建表（幂等）。返回 DB 路径。"""
    _ensure_dir()
    conn = get_conn()
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    _migrate(conn, verbose=verbose)
    set_meta('schema_version', str(SCHEMA_VERSION))
    if verbose:
        print(f'[monitor.db] ready -> {DB_PATH}')
    return DB_PATH


def _migrate(conn, verbose=False):
    """未来加字段走这里。当前 v1 无需迁移。"""
    cur = conn.execute("SELECT value FROM app_meta WHERE key='schema_version'")
    row = cur.fetchone()
    old = int(row['value']) if row and str(row['value']).isdigit() else 0
    if old and old < SCHEMA_VERSION:
        # 示例：if old < 2: conn.execute('ALTER TABLE ... ADD COLUMN ...')
        if verbose:
            print(f'[monitor.db] migrate {old} -> {SCHEMA_VERSION}')
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
#  通用写入（全部 UPSERT，重跑幂等）
# ═══════════════════════════════════════════════════

def upsert_archive(song_name, artist='', lyricist='', composer='', album='',
                   match_key=None, batch='', source_row=0, raw=None):
    """写入/更新档案，返回 archive_id。match_key 冲突即视为同一首。"""
    from .normalize import archive_key
    key = match_key or archive_key(song_name, artist)
    ts = now_str()
    raw_s = json.dumps(raw, ensure_ascii=False) if raw is not None else ''
    with tx() as conn:
        conn.execute("""
            INSERT INTO song_archive
                (song_name, artist, lyricist, composer, album, match_key,
                 batch, source_row, raw, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(match_key) DO UPDATE SET
                lyricist   = CASE WHEN excluded.lyricist   != '' THEN excluded.lyricist   ELSE song_archive.lyricist   END,
                composer   = CASE WHEN excluded.composer   != '' THEN excluded.composer   ELSE song_archive.composer   END,
                album      = CASE WHEN excluded.album      != '' THEN excluded.album      ELSE song_archive.album      END,
                updated_at = excluded.updated_at
        """, (song_name, artist, lyricist, composer, album, key,
              batch, source_row, raw_s, ts, ts))
        row = conn.execute('SELECT id FROM song_archive WHERE match_key=?', (key,)).fetchone()
    return row['id'] if row else None


def upsert_platform(archive_id, platform, song_id='', url='', extra=None,
                    matched_name='', matched_artist='', matched_album='',
                    score=0.0, confidence=CONF_NONE, review_status=REVIEW_PENDING,
                    candidates=None):
    ts = now_str()
    with tx() as conn:
        conn.execute("""
            INSERT INTO song_platform
                (archive_id, platform, song_id, extra, url, matched_name, matched_artist,
                 matched_album, score, confidence, review_status, candidates, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(archive_id, platform) DO UPDATE SET
                song_id=excluded.song_id, extra=excluded.extra, url=excluded.url,
                matched_name=excluded.matched_name, matched_artist=excluded.matched_artist,
                matched_album=excluded.matched_album, score=excluded.score,
                confidence=excluded.confidence, review_status=excluded.review_status,
                candidates=excluded.candidates, updated_at=excluded.updated_at
        """, (archive_id, platform, song_id,
              json.dumps(extra, ensure_ascii=False) if extra else '',
              url, matched_name, matched_artist, matched_album, float(score or 0),
              confidence, review_status,
              json.dumps(candidates, ensure_ascii=False) if candidates else '',
              ts, ts))


def save_metrics(archive_id, platform, stat_date, collection=None, listening=None,
                 comment=None, capped=False, ok=True, err=''):
    with tx() as conn:
        conn.execute("""
            INSERT INTO daily_metrics
                (archive_id, platform, stat_date, collection_count, listening_count,
                 comment_count, collection_capped, ok, err, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(archive_id, platform, stat_date) DO UPDATE SET
                collection_count = COALESCE(excluded.collection_count, daily_metrics.collection_count),
                listening_count  = COALESCE(excluded.listening_count,  daily_metrics.listening_count),
                comment_count    = COALESCE(excluded.comment_count,    daily_metrics.comment_count),
                collection_capped= excluded.collection_capped,
                ok=excluded.ok, err=excluded.err, fetched_at=excluded.fetched_at
        """, (archive_id, platform, stat_date, collection, listening, comment,
              1 if capped else 0, 1 if ok else 0, err, now_str()))


def start_run(run_type, stat_date=None, total=0):
    stat_date = stat_date or today_str()
    with tx() as conn:
        cur = conn.execute(
            'INSERT INTO fetch_run(run_type, stat_date, status, total, started_at) '
            'VALUES(?,?,?,?,?)', (run_type, stat_date, 'running', total, now_str()))
        return cur.lastrowid


def finish_run(run_id, status='success', done=0, failed=0, message=''):
    with tx() as conn:
        row = conn.execute('SELECT started_at FROM fetch_run WHERE id=?', (run_id,)).fetchone()
        dur = 0
        if row and row['started_at']:
            try:
                t0 = datetime.strptime(row['started_at'], '%Y-%m-%d %H:%M:%S')
                dur = int((datetime.now() - t0).total_seconds())
            except Exception:
                dur = 0
        conn.execute(
            'UPDATE fetch_run SET status=?, done=?, failed=?, finished_at=?, '
            'duration_s=?, message=? WHERE id=?',
            (status, done, failed, now_str(), dur, message, run_id))


def bump_run(run_id, done_delta=0, failed_delta=0):
    """抓取过程中实时刷进度，供前端进度条读取。"""
    with tx() as conn:
        conn.execute('UPDATE fetch_run SET done=done+?, failed=failed+? WHERE id=?',
                     (done_delta, failed_delta, run_id))


def upsert_chart_snapshots(rows: list):
    """批量 UPSERT chart_snapshot。

    rows: [{platform, chart_id, chart_name, stat_date, rank, song_id, song_name,
            artist, match_key, fetched_at}, ...]
    重跑同日不重复落库。
    """
    if not rows:
        return 0
    with tx() as conn:
        for r in rows:
            conn.execute("""
                INSERT INTO chart_snapshot
                    (platform, chart_id, chart_name, stat_date, rank,
                     song_id, song_name, artist, match_key, fetched_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(platform, chart_id, stat_date, rank) DO UPDATE SET
                    song_name=excluded.song_name,
                    artist=excluded.artist,
                    match_key=excluded.match_key,
                    song_id=excluded.song_id,
                    fetched_at=excluded.fetched_at
            """, (r.get('platform'), r['chart_id'], r.get('chart_name', ''),
                  r['stat_date'], r['rank'], r.get('song_id', ''),
                  r.get('song_name', ''), r.get('artist', ''),
                  r.get('match_key', ''), r.get('fetched_at', '')))
    return len(rows)


def upsert_chart_hits(rows: list):
    """批量 UPSERT chart_hit。

    rows: [{archive_id, platform, chart_id, chart_name, stat_date, rank, prev_rank}]
    """
    if not rows:
        return 0
    # v4.25.20 修 bug：原来 ON CONFLICT 目标写成 (archive_id, chart_id, stat_date)
    # 且 SET 了不存在的 updated_at 列 —— 只要有歌上榜就整批写入失败（异常被 chart.py
    # 吞进 errors 列表），导致 chart_hit 永远是空表、上榜播报一直没数据。
    with tx() as conn:
        for r in rows:
            prev = r.get('prev_rank')
            rank = r.get('rank')
            delta = (prev - rank) if (prev is not None and rank is not None) else None
            conn.execute("""
                INSERT INTO chart_hit
                    (archive_id, platform, chart_id, chart_name, stat_date,
                     rank, prev_rank, rank_delta, is_new, hit_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(archive_id, platform, chart_id, stat_date) DO UPDATE SET
                    rank=excluded.rank,
                    prev_rank=excluded.prev_rank,
                    rank_delta=excluded.rank_delta,
                    is_new=excluded.is_new,
                    chart_name=excluded.chart_name,
                    hit_by=excluded.hit_by
            """, (r['archive_id'], r['platform'], r['chart_id'],
                  r.get('chart_name', ''), r['stat_date'], rank, prev, delta,
                  1 if prev is None else 0, r.get('hit_by', 'id'), now_str()))
    return len(rows)


# ═══════════════════════════════════════════════════
#  统计概览
# ═══════════════════════════════════════════════════

def stats():
    conn = get_conn()

    def one(sql, *a):
        r = conn.execute(sql, a).fetchone()
        return r[0] if r else 0

    out = {
        'db_path': DB_PATH,
        'db_size_mb': round(os.path.getsize(DB_PATH) / 1048576, 2) if os.path.exists(DB_PATH) else 0,
        'archive_total': one('SELECT COUNT(*) FROM song_archive'),
        'archive_enabled': one('SELECT COUNT(*) FROM song_archive WHERE enabled=1'),
        'platform_locked': one("SELECT COUNT(*) FROM song_platform WHERE review_status IN ('auto_locked','confirmed') AND song_id!=''"),
        'platform_pending': one("SELECT COUNT(*) FROM song_platform WHERE review_status='pending_review'"),
        'metrics_rows': one('SELECT COUNT(*) FROM daily_metrics'),
        'metrics_days': one('SELECT COUNT(DISTINCT stat_date) FROM daily_metrics'),
        'metrics_today': one('SELECT COUNT(*) FROM daily_metrics WHERE stat_date=?',
                             today_str()),
        'chart_hits': one('SELECT COUNT(*) FROM chart_hit'),
        'derivatives': one('SELECT COUNT(*) FROM derivative_version WHERE dismissed=0'),
        'last_metric_date': one('SELECT MAX(stat_date) FROM daily_metrics') or '',
        'schema_version': get_meta('schema_version', '0'),
    }
    per = {}
    for p in MONITOR_PLATFORMS:
        per[p] = {
            'locked': one("SELECT COUNT(*) FROM song_platform WHERE platform=? AND song_id!='' "
                          "AND review_status IN ('auto_locked','confirmed')", p),
            'pending': one("SELECT COUNT(*) FROM song_platform WHERE platform=? AND review_status='pending_review'", p),
        }
    out['per_platform'] = per
    return out


# ═══════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════

if __name__ == '__main__':
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'init'
    if cmd == 'init':
        init_db(verbose=True)
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    elif cmd == 'stats':
        init_db()
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    elif cmd == 'tables':
        init_db()
        for r in get_conn().execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            cnt = get_conn().execute(f'SELECT COUNT(*) c FROM "{r["name"]}"').fetchone()['c']
            print(f'{r["name"]:<20} {cnt}')
    else:
        print('usage: python -m monitor.db [init|stats|tables]')
