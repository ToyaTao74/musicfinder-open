#!/usr/bin/env python3
"""每日指标抓取 —— 遍历已锁定的平台 ID，去三平台取「收藏 / 在听 / 评论」

为什么单独成模块：
  建档（matcher）一次性把每首歌锁定到 QQ/酷狗/网易云 的真实歌曲 ID，
  之后每天只需拿 ID 直连取数，不再搜索。本模块就是「每天跑一次」的那一步。

复用策略（不重写平台 API，避免重复踩坑）：
  直接调用 app.py 里已经验证过、抗限流的取数函数：
    QQ     → _fetch_qq_details        （收藏 + 评论 + 在听，批量、免签名）
    Kugou  → _fetch_kugou_collection_counts + _fetch_kugou_listening （免登录）
    Netease→ _fetch_netease_details   （收藏=红心数 + 评论，免登录）
  这些函数认「结果字典列表」形状（_songmid/_songid、_mixsongid、_song_id 等），
  所以本模块把数据库里的锁定行「拼装」成它们要的字典，喂进去，再读出填好的字段。

数据落地：
  daily_metrics 表按 (archive_id, platform, stat_date) UNIQUE，重跑幂等；
  某平台整体抓取失败 → 该平台所有行记 ok=0（下次可单独补跑，不污染其他平台）。

限流/容错：
  平台间串行、间隔 0.5s，单平台崩溃不影响其他平台；
  单首取不到（接口成功但无该曲）留 NULL —— 不写成 0，避免误导。
"""

import json
import time

from . import db


def _get_app():
    """复用主程序模块（与 matcher 同款，避免把 app.py 再跑一遍）。"""
    import sys as _sys
    for _name in ('__main__', 'app'):
        _m = _sys.modules.get(_name)
        if _m is not None and hasattr(_m, 'search_qq'):
            return _m
    import app as _a
    return _a


# 锁定的判定条件：高把握自动锁定 或 人工已确认，且有真实歌曲 ID
_LOCKED_WHERE = (
    "sp.song_id != '' AND sp.review_status IN ('auto_locked','confirmed') "
    "AND a.enabled = 1"
)


def _load_locked(platforms):
    """取所有已锁定行，按平台分组。返回 {platform: [row_dict,...]}。"""
    conn = db.get_conn()
    ph = ','.join('?' * len(platforms))
    rows = conn.execute(
        f"""SELECT sp.archive_id, sp.platform, sp.song_id, sp.extra,
                   a.song_name, a.artist
            FROM song_platform sp
            JOIN song_archive a ON a.id = sp.archive_id
            WHERE sp.platform IN ({ph}) AND {_LOCKED_WHERE}
            ORDER BY sp.platform, sp.archive_id""",
        list(platforms)).fetchall()
    out = {p: [] for p in platforms}
    for r in rows:
        out[r['platform']].append(dict(r))
    return out


def _build_results(platform, row):
    """把一条锁定行拼成 app.py 取数函数认识的「结果字典」。

    关键：archive_id 带进字典，抓完原样带回，用来回写 daily_metrics。
    各平台要的 ID 字段不同：
      QQ      → _songmid（主列 song_id）+ _songid（取数用，来自 extra）
      Kugou   → _mixsongid（取数用，来自 extra）+ _hash（主列 song_id，备用）
      Netease → _song_id（主列 song_id）+ _album_id（来自 extra）
    """
    extra = {}
    try:
        extra = json.loads(row.get('extra') or '{}') or {}
    except Exception:
        extra = {}
    rd = {'_archive_id': row['archive_id']}
    if platform == 'qq':
        rd['_songmid'] = row['song_id']
        sid = extra.get('songid') or extra.get('_songid')
        if sid is not None:
            rd['_songid'] = str(sid)
    elif platform == 'kugou':
        rd['_hash'] = row['song_id']
        mid = extra.get('mixsongid') or extra.get('_mixsongid')
        if mid is not None:
            rd['_mixsongid'] = str(mid)
    elif platform == 'netease':
        rd['_song_id'] = row['song_id']
        if extra.get('album_id') or extra.get('_album_id'):
            rd['_album_id'] = str(extra.get('album_id') or extra.get('_album_id'))
    return rd


def _save_results(platform, results, stat_date, run_id):
    """读回取数结果，逐首写 daily_metrics。"""
    done = 0
    for rd in results:
        aid = rd.get('_archive_id')
        if aid is None:
            continue
        coll = rd.get('collection_count')
        comm = rd.get('comment_count')
        # 网易云不返在听（接口无此数据）；QQ/酷狗若没取到则留 NULL
        listen = rd.get('listening_count') if platform in db.PLATFORMS_WITH_LISTENING else None
        db.save_metrics(aid, platform, stat_date,
                        collection=coll, listening=listen, comment=comm,
                        capped=False, ok=True)
        done += 1
    if run_id:
        db.bump_run(run_id, done_delta=1)
    return done


def run_daily(stat_date=None, platforms=None, sleep_between=0.5,
              only_missing=True, verbose=True):
    """跑一次每日抓取。

    stat_date     : 数据日期（默认今天）
    platforms     : 限定平台，默认全平台
    only_missing  : True 时跳过「今天已经抓到过」的歌（续跑/补跑更快）
    """
    db.init_db()
    platforms = list(platforms or db.MONITOR_PLATFORMS)
    stat_date = stat_date or db.today_str()
    grouped = _load_locked(platforms)

    # only_missing：剔除今天已有成功数据点的歌
    if only_missing:
        conn = db.get_conn()
        have = {(r['archive_id'], r['platform']) for r in conn.execute(
            "SELECT archive_id, platform FROM daily_metrics "
            "WHERE stat_date=? AND ok=1", (stat_date,)).fetchall()}
        for p in platforms:
            grouped[p] = [r for r in grouped[p]
                          if (r['archive_id'], p) not in have]

    total = sum(len(v) for v in grouped.values())
    if verbose:
        print(f'[daily] 待抓取 {total} 条（{stat_date}）'
              + ''.join(f'  {p}:{len(grouped[p])}' for p in platforms))
    if not total:
        if verbose:
            print('[daily] 没有需要抓取的条目')
        return {'total': 0, 'done': 0, 'failed_platforms': []}

    run_id = db.start_run('daily_metrics', stat_date=stat_date, total=total)
    a = _get_app()
    done = 0
    failed_platforms = []

    for p in platforms:
        rows = grouped[p]
        if not rows:
            continue
        results = [_build_results(p, r) for r in rows]
        try:
            if p == 'qq':
                a._fetch_qq_details(results, cookie_str='', only_fav=False,
                                    skip_comments=False)
            elif p == 'kugou':
                a._fetch_kugou_collection_counts(results)
                a._fetch_kugou_listening(results)
            elif p == 'netease':
                a._fetch_netease_details(results, cookie_str='')
            else:
                continue
            d = _save_results(p, results, stat_date, run_id)
            done += d
            if verbose:
                got = sum(1 for r in results
                          if r.get('collection_count') is not None)
                print(f'  [√] {p}: 抓取 {len(results)} 条，其中 {got} 条取到收藏量')
        except Exception as e:
            failed_platforms.append(p)
            # 整平台失败：这些歌今天记 ok=0，下次补跑
            for r in rows:
                db.save_metrics(r['archive_id'], p, stat_date, ok=False,
                                err=str(e)[:200])
                db.bump_run(run_id, failed_delta=1)
            if verbose:
                print(f'  [x] {p}: 抓取异常 {e}')
        time.sleep(sleep_between)

    status = 'failed' if (done == 0 and failed_platforms) else (
        'partial' if failed_platforms else 'success')
    db.finish_run(run_id, status=status, done=done,
                  failed=sum(len(grouped[p]) for p in failed_platforms),
                  message=json.dumps({'failed_platforms': failed_platforms},
                                     ensure_ascii=False))
    if verbose:
        print(f'[daily] 完成：成功 {done} 条，失败平台 {failed_platforms or "无"}')
    return {'total': total, 'done': done, 'failed_platforms': failed_platforms}


if __name__ == '__main__':
    import sys
    sd = sys.argv[1] if len(sys.argv) > 1 else None
    print(json.dumps(run_daily(stat_date=sd), ensure_ascii=False, indent=2))
