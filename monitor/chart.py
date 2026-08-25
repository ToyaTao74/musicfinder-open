#!/usr/bin/env python3
"""榜单快照 + 上榜命中检测。

每天抓一遍「QQ音乐 + 酷狗 + 网易云」的公开榜单 → 写 chart_snapshot；
对照 song_platform.song_id (命中) / 归一化键(兜底) → 把命中写到 chart_hit。

不含鉴权要求的接口（汽水/抖音榜需登录，先不接）。
"""
import json
import re
import urllib.parse
import logging
from datetime import datetime
from typing import Dict, List
import requests

from . import db

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════
#  平台榜单定义（公开、不需登录）
# ═══════════════════════════════════════════════════

# QQ音乐公开榜单：u.y.qq.com/cgi-bin/musicu.fcg（v2026 仍在用，免签名/免登录）
#   - topId=26 热歌榜  27 新歌榜  28 飙升榜  4 流行指数榜  32 抖音榜  36 欧美榜
# QQ 数据库存的是 songmid 字符串，但本接口只回 numeric songId —— 命中走「歌名+歌手」归一键兜底
QQ_CHARTS = [
    {'id': 'qq_hot',  'name': 'QQ音乐热歌榜', 'topId': 26},
    {'id': 'qq_new',  'name': 'QQ音乐新歌榜', 'topId': 27},
    {'id': 'qq_soar', 'name': 'QQ音乐飙升榜', 'topId': 28},
]

# 酷狗音乐公开榜单：mobilecdnbj.kugou.com/api/v3/rank/song（移动端官方接口，免登录）
#   - rankid=8888 TOP500（翻 5 页抓满 500 首）；rankid=6666 飙升榜
# 响应包在 <!--KG_TAG_RES_START-->...JSON... 外面；用 hash 作 song_id 精确命中
KUGOU_CHARTS = [
    {'id': 'kg_top500', 'name': '酷狗TOP500', 'rankid': 8888, 'pages': 5},
    {'id': 'kg_soar',   'name': '酷狗飙升榜', 'rankid': 6666, 'pages': 1},
]

# 网易云官方榜单 playlist 接口（免登录）
NETEASE_CHARTS = [
    {'id': 'netease_hot', 'name': '网易云热歌榜', 'url': 'https://music.163.com/api/playlist/detail?id=3778678', 'playlist_id': 3778678},
    {'id': 'netease_new', 'name': '网易云新歌榜', 'url': 'https://music.163.com/api/playlist/detail?id=3779629', 'playlist_id': 3779629},
    {'id': 'netease_soar', 'name': '网易云飙升榜', 'url': 'https://music.163.com/api/playlist/detail?id=19723756', 'playlist_id': 19723756},
]


def _normalize_key(song_name: str, artist: str = '') -> str:
    """粗略归一化键（用于无 song_id 的命中兜底）。"""
    s = (song_name or '').strip().lower()
    a = (artist or '').strip().lower()
    s = re.sub(r'[\s\(\)（）【】\[\]\-\—\·\.·,，:：/／!！?？&+]+', '', s)
    a = re.sub(r'[\s\(\)（）【】\[\]\-\—\·\.·,，:：/／!！?？&+]+', '', a)
    return f"{s}|{a}" if a else s


def _fetch_qq_chart(chart: dict, headers: dict, timeout=8) -> List[dict]:
    """抓 QQ 榜单 → 排名字典列表。

    新接口 musicu.fcg + ToplistInfoServer.GetDetail 直接返回 JSON（无 JSONP 包裹）。
    数据路径：detail.data.data.song[]，每首含 rank/songId(数字)/title/singerName。
    songId 与用户档案里存的 songmid 不是同一套 —— 不做 ID 对撞，靠 by_key 兜底。
    """
    data = json.dumps({
        "detail": {
            "module": "musicToplist.ToplistInfoServer",
            "method": "GetDetail",
            "param": {"topId": chart['topId'], "offset": 0, "num": 300},
        }
    }, ensure_ascii=False)
    url = (
        'https://u.y.qq.com/cgi-bin/musicu.fcg'
        '?format=json&inCharset=utf8&outCharset=utf-8'
        '&platform=yqq.json&needNewCode=0'
        '&data=' + urllib.parse.quote(data, safe='')
    )
    try:
        r = requests.get(url, headers=headers, timeout=timeout)
        payload = r.json()
    except Exception as e:
        logger.warning(f"[chart] QQ {chart['id']} fetch fail: {e}")
        return []
    song_arr = (((payload.get('detail') or {}).get('data') or {}).get('data') or {}).get('song') or []
    songs = []
    for s in song_arr[:300]:
        rank = s.get('rank')
        title = (s.get('title') or '').strip()
        singer = (s.get('singerName') or '').strip()
        if not title:
            continue
        songs.append({
            'rank': rank or (len(songs) + 1),
            # songId 留作参考字段，但 by_id 对撞 songmid 不会命中 → 用 by_key 兜底
            'song_id': str(s.get('songId') or ''),
            'song_name': title,
            'artist': singer,
            'match_key': _normalize_key(title, singer),
        })
    return songs


def _fetch_kugou_chart(chart: dict, headers: dict, timeout=8) -> List[dict]:
    """抓酷狗榜单 → 排名字典列表。

    响应是 <!--KG_TAG_RES_START-->...JSON...<!--KG_TAG_RES_END--> 包裹；
    JSON 后还有 KG_TAG_RES_END 注释，普通 json.loads 会报「Extra data」——
    用 raw_decode 跳过尾部注释。
    pages>1 时翻页抓满（TOP500 翻 5 页 = 500 首）。
    """
    pages = int(chart.get('pages', 1))
    songs = []
    global_rank = 0
    for page in range(1, pages + 1):
        url = (
            'http://mobilecdnbj.kugou.com/api/v3/rank/song'
            '?version=9108&ranktype=2&plat=0&pagesize=100'
            '&area_code=1&page=' + str(page) + '&rankid=' + str(chart['rankid'])
        )
        try:
            r = requests.get(url, headers=headers, timeout=timeout)
            text = r.text
            m = re.search(r'<!--KG_TAG_RES_START-->(.*?)(<!--KG_TAG_RES_END-->|$)', text, re.DOTALL)
            if m:
                raw = m.group(1)
            elif text.lstrip().startswith('{'):
                raw = text
            else:
                logger.warning(f"[chart] kugou {chart['id']} p{page} unexpected format, first 80: {text[:80]!r}")
                continue
            payload, _ = json.JSONDecoder().raw_decode(raw)
        except Exception as e:
            logger.warning(f"[chart] kugou {chart['id']} p{page} fetch fail: {e}")
            continue
        info = (payload.get('data') or {}).get('info') or []
        if not info:
            break  # 这页空了，后面也没数据
        for s in info:
            global_rank += 1
            title = (s.get('songname') or '').strip()
            authors = s.get('authors') or []
            if isinstance(authors, dict):
                singer = (authors.get('author_name') or '').strip()
            else:
                singer = ', '.join(
                    (a.get('author_name') or '').strip() for a in authors if isinstance(a, dict)
                ).strip(', ')
            if not title:
                continue
            songs.append({
                'rank': global_rank,
                'song_id': (s.get('hash') or '').upper(),  # 酷狗档案统一存大写 hash
                'song_name': title,
                'artist': singer,
                'match_key': _normalize_key(title, singer),
            })
    return songs


def _fetch_netease_chart(chart: dict, headers: dict, timeout=8) -> List[dict]:
    """抓网易云榜单 → 排名字典列表。

    网易云官方 playlist 接口（免登录）：/api/playlist/detail?id=xxx
    返回 result.tracks[]（部分版本为 playlist.tracks[]）。
    """
    try:
        r = requests.get(chart['url'], headers=headers, timeout=timeout)
        data = r.json()
    except Exception as e:
        logger.warning(f"[chart] netease {chart['id']} fetch fail: {e}")
        return []
    playlist = data.get('result') or data.get('playlist') or {}
    tracks = playlist.get('tracks') or []
    songs = []
    for i, t in enumerate(tracks[:100], start=1):
        title = (t.get('name') or '').strip()
        ar = t.get('artists') or t.get('ar') or []
        singer = ', '.join(
            (a.get('name') or '') for a in ar if isinstance(a, dict)
        ).strip(', ')
        if not title:
            continue
        songs.append({
            'rank': i,
            'song_id': str(t.get('id') or ''),
            'song_name': title,
            'artist': singer,
            'match_key': _normalize_key(title, singer),
        })
    return songs


def fetch_charts_for_date(stat_date: str) -> dict:
    """抓取所有榜单并写入 chart_snapshot + chart_hit。

    返回 {qq: n, kugou: n, netease: n, hits: n, errors: [...]}
    """
    errors = []
    qq_headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0',
        'Referer': 'https://y.qq.com/',
    }
    kg_headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0',
        'Referer': 'http://m.kugou.com/',
    }
    ne_headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0',
        'Referer': 'https://music.163.com/',
    }

    # 1) 抓
    snap_rows = []  # for chart_snapshot
    qq_total = 0
    for chart in QQ_CHARTS:
        try:
            songs = _fetch_qq_chart(chart, qq_headers)
        except Exception as e:
            errors.append(f"qq/{chart['id']}: {e}")
            songs = []
        qq_total += len(songs)
        for s in songs:
            snap_rows.append({
                'platform': 'qq', 'chart_id': chart['id'], 'chart_name': chart['name'],
                'stat_date': stat_date, **s,
                'fetched_at': datetime.now().isoformat(timespec='seconds'),
            })

    kg_total = 0
    for chart in KUGOU_CHARTS:
        try:
            songs = _fetch_kugou_chart(chart, kg_headers)
        except Exception as e:
            errors.append(f"kugou/{chart['id']}: {e}")
            songs = []
        kg_total += len(songs)
        for s in songs:
            snap_rows.append({
                'platform': 'kugou', 'chart_id': chart['id'], 'chart_name': chart['name'],
                'stat_date': stat_date, **s,
                'fetched_at': datetime.now().isoformat(timespec='seconds'),
            })

    ne_total = 0
    for chart in NETEASE_CHARTS:
        try:
            songs = _fetch_netease_chart(chart, ne_headers)
        except Exception as e:
            errors.append(f"netease/{chart['id']}: {e}")
            songs = []
        ne_total += len(songs)
        for s in songs:
            snap_rows.append({
                'platform': 'netease', 'chart_id': chart['id'], 'chart_name': chart['name'],
                'stat_date': stat_date, **s,
                'fetched_at': datetime.now().isoformat(timespec='seconds'),
            })

    # 2) 写 chart_snapshot（UPSERT）
    db.upsert_chart_snapshots(snap_rows)

    # 3) 求命中 — 用 song_platform 已锁定的 song_id（任意平台都行）
    #    命中 = chart_snapshot.song_id 出现在 song_platform.song_id 或
    #    chart_snapshot.match_key 出现在 archive.title+artist (粗匹配)
    hits_rows = []
    try:
        with db.get_conn() as conn:
            plat_rows = conn.execute(
                "SELECT archive_id, platform, song_id FROM song_platform "
                "WHERE song_id IS NOT NULL AND song_id != ''"
            ).fetchall()
            # 建索引 (platform, song_id) → archive_id
            by_id = {(r['platform'], str(r['song_id'])): r['archive_id'] for r in plat_rows if r['song_id']}
            # 另外补：根据 song_archive 的 title+artist 归一化（无 ID）
            arch = conn.execute("SELECT id, song_name, artist FROM song_archive").fetchall()
            by_key = {}
            for r in arch:
                key = _normalize_key(r['song_name'], r['artist'])
                if key:
                    by_key[key] = r['id']
            # 关联命中
            seen_hit = set()  # (archive_id, chart_id)
            for row in snap_rows:
                hit = None
                # 优先按 song_id 精确命中
                if row.get('song_id'):
                    hit = by_id.get((row['platform'], str(row['song_id'])))
                # 兜底按 key
                if not hit:
                    hit = by_key.get(row['match_key'])
                if hit is None:
                    continue
                key2 = (hit, row['chart_id'])
                if key2 in seen_hit:
                    continue
                seen_hit.add(key2)
                # 找昨日同 chart 同 archive 的 rank（chart_hit）
                prev = conn.execute(
                    "SELECT rank FROM chart_hit "
                    "WHERE archive_id=? AND chart_id=? AND stat_date < ? "
                    "ORDER BY stat_date DESC LIMIT 1",
                    (hit, row['chart_id'], stat_date),
                ).fetchone()
                hits_rows.append({
                    'archive_id': hit,
                    'platform': row['platform'],
                    'chart_id': row['chart_id'],
                    'chart_name': row['chart_name'],
                    'stat_date': stat_date,
                    'rank': row['rank'],
                    'prev_rank': prev['rank'] if prev else None,
                })
            # 批量 UPSERT
            db.upsert_chart_hits(hits_rows)

            # ── 掉榜清理（v4.27.22 修源头 bug）──
            # 旧逻辑只在「本次抓到」时写入 chart_hit，榜单刷新掉榜后旧记录永不删除，
            # 前端会一直显示「上榜」误导用户（如「缺氧/苏星婕」某次 #80，下次抓取已掉榜，旧 #80 留存）。
            # 修复：本次抓取覆盖的 stat_date 内，凡不在本次命中集合的 chart_hit 一律删除（掉榜即失效）。
            keep = {(h['archive_id'], h['platform'], h['chart_id']) for h in hits_rows}
            stale = conn.execute(
                "SELECT archive_id, platform, chart_id FROM chart_hit WHERE stat_date = ?",
                (stat_date,)
            ).fetchall()
            cleaned = 0
            for r in stale:
                if (r['archive_id'], r['platform'], r['chart_id']) not in keep:
                    conn.execute(
                        "DELETE FROM chart_hit "
                        "WHERE archive_id=? AND platform=? AND chart_id=? AND stat_date=?",
                        (r['archive_id'], r['platform'], r['chart_id'], stat_date)
                    )
                    cleaned += 1
            if cleaned:
                logger.info(f"[chart] {stat_date} 清理掉榜残留 chart_hit {cleaned} 条")
    except Exception as e:
        errors.append(f"hits compute: {e}")
        logger.exception("chart hits compute failed")

    return {
        'qq_count': qq_total,
        'kugou_count': kg_total,
        'netease_count': ne_total,
        'hits': len(hits_rows),
        'errors': errors,
    }


def run_chart(stat_date: str = None, verbose: bool = True):
    """抓取今日（默认）榜单。"""
    if not stat_date:
        stat_date = datetime.now().strftime('%Y-%m-%d')
    # 把这次抓取登记到 fetch_run 表，方便前端轮询进度
    total_charts = len(QQ_CHARTS) + len(KUGOU_CHARTS) + len(NETEASE_CHARTS)
    run_id = db.start_run('chart', stat_date=stat_date, total=total_charts)
    try:
        res = fetch_charts_for_date(stat_date)
        if verbose:
            logger.info(
                f"[chart] {stat_date} QQ={res['qq_count']} 酷狗={res['kugou_count']} 网易云={res['netease_count']} 命中={res['hits']} errors={len(res['errors'])}"
            )
        # done = 实际成功的平台数（按整平台口径，不再按子榜单）
        done = (1 if res['qq_count'] else 0) + (1 if res['kugou_count'] else 0) + (1 if res['netease_count'] else 0)
        db.finish_run(
            run_id, status='success' if not res['errors'] else 'partial',
            done=done, failed=0,
            message=f"qq={res['qq_count']} kg={res['kugou_count']} ne={res['netease_count']} hits={res['hits']}"
        )
        return res
    except Exception as e:
        logger.exception("chart run failed")
        try:
            db.finish_run(run_id, status='failed', done=0, failed=1, message=str(e)[:200])
        except Exception:
            pass
        raise
