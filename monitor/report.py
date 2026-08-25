#!/usr/bin/env python3
"""运营报告聚合 —— 把每日抓取的数据变成「看得懂」的看板

输入：daily_metrics（每日收藏/在听/评论）+ song_archive（歌名/歌手/曲风）
输出：get_report(period) 返回结构化报告，直接喂给前端渲染。

周期：day / week / month / quarter / year
  - 自动取数据库里「最新的那一天」作为期末，往前推 N 天作为期初
  - 期初/期末各自取区间内最早/最晚的有效数据点（允许某天缺失，不强制连续）

报告板块（都是大白话，非技术术语）：
  1. 概览：监控歌曲数、总收藏、总在听、总评论、平均涨幅
  2. 涨幅榜：区间内收藏量涨得最多的歌（单天数据则提示「多积累几天才有涨幅」）
  3. 最热歌曲：当前收藏量最高的歌
  4. 曲风分布：监控名单里的曲风占比（曲风在建档时自动识别，没识别到的会提示）
  5. 演唱者维度：哪位歌手被监控的歌最多 / 收藏量最大
  6. 榜单上榜：charts 模块上线后才有数据，当前标「即将上线」

设计原则：绝不编造数据。只有真实抓到过的才展示；单天 / 断档都优雅降级。
"""

import json
from datetime import datetime, timedelta

from . import db

PERIOD_DAYS = {'day': 1, 'week': 7, 'month': 30, 'quarter': 90, 'year': 365}
PERIOD_LABEL = {'day': '今日', 'week': '近 7 天', 'month': '近 30 天',
                'quarter': '近 90 天', 'year': '近 365 天'}


def _parse_date(s):
    try:
        return datetime.strptime(s, '%Y-%m-%d').date()
    except Exception:
        return None


def _fmt_count(n):
    """收藏/评论量级中文单位：1.2万 / 3.4亿。None → '—'。"""
    if n is None:
        return '—'
    n = int(n)
    if n >= 10_0000_0000:  # 10 亿
        return f'{n / 10_0000_0000:.1f}亿'
    if n >= 10_000:
        return f'{n / 10_000:.1f}万'
    return str(n)


def get_report(period='day', stat_date=None):
    """生成运营报告。返回 dict，结构见各板块。"""
    if period not in PERIOD_DAYS:
        period = 'day'
    db.init_db()
    conn = db.get_conn()

    # ── 期末日期：默认取数据库里最新的一天数据 ──
    last = stat_date or conn.execute(
        'SELECT MAX(stat_date) FROM daily_metrics').fetchone()[0]
    if not last:
        return _empty_report(period, reason='no_metrics')
    end_d = _parse_date(last)
    span = PERIOD_DAYS[period]
    start_d = end_d - timedelta(days=span - 1)
    start_s, end_s = start_d.strftime('%Y-%m-%d'), end_d.strftime('%Y-%m-%d')

    # ── 区间内的所有每日数据点，拉到内存聚合（量小，简单可靠）──
    rows = conn.execute(
        """SELECT archive_id, platform, stat_date, collection_count,
                  listening_count, comment_count, ok
           FROM daily_metrics
           WHERE stat_date BETWEEN ? AND ? AND ok = 1
           ORDER BY archive_id, platform, stat_date""",
        (start_s, end_s)).fetchall()

    # 歌名 / 歌手 / 曲风映射
    arch = {r['id']: dict(r) for r in conn.execute(
        "SELECT id, song_name, artist, lyricist, composer, album, genre, enabled "
        "FROM song_archive").fetchall()}
    enabled_ids = {aid for aid, a in arch.items() if a['enabled']}

    # 按 (archive_id, platform) 分组，记录 earliest / latest 数据点
    series = {}
    dates_covered = set()
    for r in rows:
        dates_covered.add(r['stat_date'])
        key = (r['archive_id'], r['platform'])
        bucket = series.setdefault(key, [])
        bucket.append(r)

    def _val(r, col):
        return r[col] if r and r[col] is not None else None

    # 每首每平台：期初(最早) / 期末(最晚)
    per_sp = []  # list of dict
    for (aid, p), bucket in series.items():
        if aid not in enabled_ids:
            continue
        first, last_r = bucket[0], bucket[-1]
        cur_coll = _val(last_r, 'collection_count')
        prev_coll = _val(first, 'collection_count')
        cur_listen = _val(last_r, 'listening_count')
        cur_comm = _val(last_r, 'comment_count')
        delta = None
        if cur_coll is not None and prev_coll is not None:
            delta = cur_coll - prev_coll
        per_sp.append({
            'archive_id': aid, 'platform': p,
            'prev_collection': prev_coll, 'cur_collection': cur_coll,
            'cur_listening': cur_listen, 'cur_comment': cur_comm,
            'delta': delta,
        })

    # ── 概览总量（期末最新值，按平台汇总）──
    totals = {'collection': 0, 'listening': 0, 'comment': 0,
              'per_platform': {p: {'collection': 0, 'listening': 0,
                                   'comment': 0, 'locked': 0} for p in db.MONITOR_PLATFORMS}}
    for s in per_sp:
        p = s['platform']
        pd = totals['per_platform'][p]
        if s['cur_collection']:
            totals['collection'] += s['cur_collection']
            pd['collection'] += s['cur_collection']
        if s['cur_listening']:
            totals['listening'] += s['cur_listening']
            pd['listening'] += s['cur_listening']
        if s['cur_comment']:
            totals['comment'] += s['cur_comment']
            pd['comment'] += s['cur_comment']
    for p in db.MONITOR_PLATFORMS:
        totals['per_platform'][p]['locked'] = sum(
            1 for s in per_sp if s['platform'] == p)

    songs_monitored = len(enabled_ids)

    # ── 涨幅榜 ──
    gainers = [s for s in per_sp if s['delta'] is not None and s['delta'] > 0]
    gainers.sort(key=lambda x: x['delta'], reverse=True)
    top_gainers = [_song_view(s, arch) for s in gainers[:20]]

    # ── 最热歌曲（按期末各平台收藏量之和）──
    by_song = {}
    for s in per_sp:
        d = by_song.setdefault(s['archive_id'], {'collection': 0, 'per': {}})
        if s['cur_collection']:
            d['collection'] += s['cur_collection']
        d['per'][s['platform']] = s['cur_collection'] or 0
    hot = sorted(by_song.items(), key=lambda kv: kv[1]['collection'], reverse=True)
    top_songs = [{
        'archive_id': aid,
        'song_name': arch.get(aid, {}).get('song_name', ''),
        'artist': arch.get(aid, {}).get('artist', ''),
        'collection': v['collection'],
        'collection_by_platform': {db.PLATFORM_NAMES.get(p, p): c
                                   for p, c in v['per'].items()},
    } for aid, v in hot[:20] if v['collection'] > 0]

    # ── 曲风分布 ──
    genres = {}
    no_genre = 0
    for a in arch.values():
        if not a['enabled']:
            continue
        g = (a['genre'] or '').strip()
        if g:
            genres[g] = genres.get(g, 0) + 1
        else:
            no_genre += 1
    genre_list = sorted(genres.items(), key=lambda kv: kv[1], reverse=True)

    # ── 演唱者维度 ──
    artist_map = {}
    for a in arch.values():
        if not a['enabled']:
            continue
        ar = (a['artist'] or '').strip()
        if not ar:
            continue
        d = artist_map.setdefault(ar, {'songs': 0, 'collection': 0})
        d['songs'] += 1
        d['collection'] += by_song.get(a['id'], {}).get('collection', 0) or 0
    artist_list = sorted(artist_map.items(),
                         key=lambda kv: (kv[1]['songs'], kv[1]['collection']),
                         reverse=True)
    top_artists = [{'artist': ar, 'songs': d['songs'],
                    'collection': d['collection']} for ar, d in artist_list[:20]]

    # ── 跨平台覆盖（业务视角：每首歌在几个平台找到原版）──
    cov = {'three': 0, 'two': 0, 'one': 0, 'zero': 0}
    for aid in enabled_ids:
        n = sum(1 for p in db.MONITOR_PLATFORMS
                if conn.execute(
                    "SELECT 1 FROM song_platform WHERE archive_id=? AND platform=? "
                    "AND song_id!=''", (aid, p)).fetchone())
        cov[{0: 'zero', 1: 'one', 2: 'two', 3: 'three'}.get(n, 'zero')] += 1

    # ── 状态预警（需要老板留意的事）──
    pending_ids = {r['archive_id'] for r in conn.execute(
        "SELECT DISTINCT archive_id FROM song_platform WHERE review_status='pending_review'"
    ).fetchall()}
    paused = conn.execute(
        "SELECT COUNT(*) c FROM song_archive WHERE enabled=0").fetchone()['c']
    # 7 天内没采到数据的在监控歌（含完全没采过的）
    stale_ids = {r['id'] for r in conn.execute(
        "SELECT id FROM song_archive WHERE enabled=1 AND id NOT IN ("
        "SELECT archive_id FROM daily_metrics WHERE stat_date >= date('now','-7 day'))"
    ).fetchall()}
    alerts = {
        'pending': len(pending_ids),
        'paused': paused,
        'stale': len(stale_ids),
    }

    # ── 最近一次榜单抓取实况（透明展示命中/失败）──
    last_chart = conn.execute(
        "SELECT status, message, finished_at FROM fetch_run "
        "WHERE run_type='chart' ORDER BY id DESC LIMIT 1").fetchone()
    last_chart_run = dict(last_chart) if last_chart else None

    # ── 榜单上榜 ──
    chart_hits_total = conn.execute(
        'SELECT COUNT(*) c FROM chart_hit').fetchone()['c']
    # 期间内的命中明细（最多 30 条，按时间倒序）
    chart_hits_recent = []
    try:
        recent_rows = conn.execute("""
            SELECT ch.archive_id, ch.platform, ch.chart_id, ch.chart_name,
                   ch.stat_date, ch.rank, ch.prev_rank,
                   sa.song_name, sa.artist,
                   CASE WHEN sp.song_id IS NOT NULL AND sp.song_id != ''
                             AND sp.confidence IN ('high','mid','low')
                        THEN 1 ELSE 0 END AS platform_locked
            FROM chart_hit ch
            JOIN song_archive sa ON sa.id = ch.archive_id
            LEFT JOIN song_platform sp
                   ON sp.archive_id = ch.archive_id AND sp.platform = ch.platform
            WHERE ch.stat_date BETWEEN ? AND ?
            ORDER BY ch.stat_date DESC, ch.rank ASC
            LIMIT 30
        """, (start_s, end_s)).fetchall()
        chart_hits_recent = [dict(r) for r in recent_rows]
    except Exception:
        chart_hits_recent = []

    # 期间内的命中分布（按榜单+日 期 维度，用于"哪些歌最近冲榜"）
    chart_hits_by_chart = []
    try:
        bc_rows = conn.execute("""
            SELECT chart_id, chart_name, platform, COUNT(*) c,
                   MIN(rank) best_rank, MAX(rank) worst_rank
            FROM chart_hit
            WHERE stat_date BETWEEN ? AND ?
            GROUP BY chart_id
            ORDER BY c DESC, best_rank ASC
        """, (start_s, end_s)).fetchall()
        chart_hits_by_chart = [dict(r) for r in bc_rows]
    except Exception:
        pass

    has_growth = len(dates_covered) >= 2

    return {
        'period': period,
        'period_label': PERIOD_LABEL[period],
        'start_date': start_s,
        'end_date': end_s,
        'days_covered': len(dates_covered),
        'has_growth': has_growth,
        'songs_monitored': songs_monitored,
        'totals': totals,
        'top_gainers': top_gainers,
        'top_songs': top_songs,
        'genres': [{'genre': g, 'count': c} for g, c in genre_list],
        'genres_no_label': no_genre,
        'top_artists': top_artists,
        'chart_hits': chart_hits_total,
        'chart_hits_recent': chart_hits_recent,
        'chart_hits_by_chart': chart_hits_by_chart,
        'platform_coverage': cov,
        'alerts': alerts,
        'last_chart_run': last_chart_run,
        'fmt_count': None,  # 前端用统一函数，这里不塞函数
    }


def _song_view(s, arch):
    a = arch.get(s['archive_id'], {})
    return {
        'archive_id': s['archive_id'],
        'song_name': a.get('song_name', ''),
        'artist': a.get('artist', ''),
        'platform': s['platform'],
        'platform_name': db.PLATFORM_NAMES.get(s['platform'], s['platform']),
        'delta': s['delta'],
        'cur_collection': s['cur_collection'],
        'prev_collection': s['prev_collection'],
        'cur_comment': s['cur_comment'],
    }


def _empty_report(period, reason='no_metrics'):
    return {
        'period': period,
        'period_label': PERIOD_LABEL.get(period, period),
        'start_date': '', 'end_date': '', 'days_covered': 0,
        'has_growth': False,
        'songs_monitored': 0,
        'totals': {'collection': 0, 'listening': 0, 'comment': 0,
                   'per_platform': {p: {'collection': 0, 'listening': 0,
                                        'comment': 0, 'locked': 0}
                                    for p in db.MONITOR_PLATFORMS}},
        'top_gainers': [], 'top_songs': [], 'genres': [],
        'genres_no_label': 0, 'top_artists': [],
        'chart_hits': 0, 'chart_hits_recent': [], 'chart_hits_by_chart': [],
        'empty_reason': reason,
    }


if __name__ == '__main__':
    import sys
    p = sys.argv[1] if len(sys.argv) > 1 else 'day'
    print(json.dumps(get_report(p), ensure_ascii=False, indent=2, default=str))
