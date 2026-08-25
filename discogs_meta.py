#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Discogs 厂牌抓取（通用程序的「唱片公司/发行公司」源）。

为什么用 Discogs：
  - 酷狗网关需 per-user 过期 token，不适配可分发的通用程序；
  - 酷狗网页版不渲染发行公司（仅 Mac 客户端 XHR 有），无头浏览器白嫖不可行；
  - Discogs 免费、覆盖广，单个 personal access token 服务整个程序永久——
    正是「给一次、永不二次操作」的通道。
  - 返回的是「原始发行厂牌」，可能与酷狗自记的「发行公司(数字发行方)」不同，
    业务上需确认是否可接受（通常即是标准唱片公司）。

设计要点：
  - token 缺失时优雅跳过（不影响其他功能）；
  - 有界 LRU 内存缓存（config.DISCOGS_CACHE_MAX），控制内存，重启即清空；
  - 尊重 429 限流，失败即返回 None，不抛异常。
"""
import os
import re
import threading
import time
import concurrent.futures

try:
    import requests
except ImportError:
    requests = None

try:
    from config import DISCOGS_TOKEN, DISCOGS_USER_AGENT, DISCOGS_CACHE_MAX
except Exception:
    DISCOGS_TOKEN = os.environ.get("DISCOGS_TOKEN", "")
    DISCOGS_USER_AGENT = "MusicFinder/1.0"
    DISCOGS_CACHE_MAX = 5000


# ── 有界缓存（LRU 近似：满了弹最旧）──────────────────
_CACHE = {}
_CACHE_LOCK = threading.Lock()


def _cache_get(key):
    with _CACHE_LOCK:
        return _CACHE.get(key)


def _cache_put(key, val):
    with _CACHE_LOCK:
        if len(_CACHE) >= DISCOGS_CACHE_MAX:
            try:
                _CACHE.pop(next(iter(_CACHE)))
            except Exception:
                pass
        _CACHE[key] = val


def _norm(s):
    if not s:
        return ""
    s = re.sub(r'[\(（\[【].*?[\)）\]】]', '', str(s))
    s = re.sub(r'[\s\-_/&＆·•,，、;；:：.。]+', '', s)
    return s.lower().strip()


def _pick_best(results, song, artist):
    """在 Discogs 搜索结果里挑与 (歌名,艺人) 最匹配的一条。"""
    sn = _norm(song)
    an = _norm(artist)
    best, best_score = None, -1
    for res in results:
        title = res.get("title", "") or ""
        # Discogs 搜索结果的 title 常为 "Artist - Song"
        if " - " in title:
            t_artist, t_song = title.split(" - ", 1)
        else:
            t_artist, t_song = "", title
        s1 = 1.0 if _norm(t_song) == sn else (0.6 if (sn and _norm(t_song) and sn in _norm(t_song)) else 0)
        s2 = 1.0 if _norm(t_artist) == an else (0.6 if (an and _norm(t_artist) and an in _norm(t_artist)) else 0)
        score = s1 * 0.6 + s2 * 0.4
        if score > best_score:
            best_score, best = score, res
    return best, best_score


def get_label(song, artist, token=None):
    """返回 (厂牌字符串 or None, 来源标识 or None)。

    来源标识：'discogs'（实时查到）/ 'discogs_cache'（命中本次进程缓存）/ None（未查到或跳过）。
    """
    if requests is None:
        return None, None
    tok = token if token is not None else DISCOGS_TOKEN
    if not tok:
        return None, None
    key = (song, artist)
    cached = _cache_get(key)
    if cached is not None:
        return cached, "discogs_cache"

    try:
        headers = {
            "User-Agent": DISCOGS_USER_AGENT,
            "Authorization": f"Discogs token={tok}",
        }
        params = {"q": song or "", "type": "release", "per_page": 5}
        if artist:
            params["artist"] = artist
        resp = requests.get("https://api.discogs.com/database/search",
                            params=params, headers=headers, timeout=4)
        if resp.status_code == 429:
            _cache_put(key, None)
            return None, None
        if resp.status_code != 200:
            _cache_put(key, None)
            return None, None
        results = resp.json().get("results", [])
        if not results:
            _cache_put(key, None)
            return None, None

        best, score = _pick_best(results, song, artist)
        if not best or score <= 0:
            _cache_put(key, None)
            return None, None

        # 搜索结果里常直接带 label 字段；没有再查 release 详情
        lab = best.get("label")
        if isinstance(lab, list) and lab:
            lab = lab[0]
        elif not isinstance(lab, str):
            lab = None

        if not lab and best.get("id"):
            try:
                rr = requests.get(f"https://api.discogs.com/releases/{best['id']}",
                                  headers=headers, timeout=4)
                if rr.status_code == 200:
                    lis = rr.json().get("labels", [])
                    if lis:
                        lab = lis[0].get("name")
            except Exception:
                pass

        if lab:
            _cache_put(key, lab)
            return lab, "discogs"
        _cache_put(key, None)
        return None, None
    except Exception:
        return None, None


def enrich(results, token=None):
    """就地补全 results 里缺失 record_label 的条目（每个平台补首条，控制调用量）。

    并发抓取各平台首条缺失项，避免串行等待拖慢 search_all（Discogs 网络延迟高时尤甚）。
    返回被补全的条数。
    """
    todo = []          # [(result, code)]
    done_platforms = set()
    for r in results:
        if r.get("record_label"):
            continue
        code = r.get("platform_code")
        if code in done_platforms:
            continue  # 每平台只补一条
        done_platforms.add(code)
        todo.append((r, code))
    if not todo:
        return 0

    def work(item):
        r, code = item
        lab, src = get_label(r.get("song_name", ""), r.get("performer", ""), token)
        return r, lab, src

    filled = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(todo), 5)) as ex:
        for r, lab, src in ex.map(work, todo):
            if lab:
                r["record_label"] = lab
                r["record_label_source"] = src or "discogs"
                filled += 1
    return filled
