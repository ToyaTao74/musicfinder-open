#!/usr/bin/env python3
"""建档匹配引擎 —— 把档案里的「歌名 + 歌手 + 词曲作者」锁定到三平台真实 ID

为什么需要这一步：用户手里只有 Excel，没有平台链接。后续每天抓收藏/在听/评论
必须靠平台歌曲 ID 直连，所以要先做一次性「建档」，把 4000 首各锁定到
QQ songmid / 酷狗 hash / 网易云 song_id。

准确率保障（三道闸）：
  1. 两轮搜索：先「歌名+歌手」（压同名干扰），缺平台再用纯歌名补搜。
  2. 严格评分：歌名精确归一相等（保留括号，区分原版/伴奏/Live）+ 歌手命中 才给 high。
  3. 人工复核：只有 high 自动锁定，mid/low/none 全部进待办界面逐条确认。

工程约束：
  * 轻量搜索（light=True）：跳过详情接口，单首三平台约 1-2 秒。
  * 断点续跑：只处理 status='pending' 的档案，中断后重跑不重复。
  * 限流退避：单平台连续失败即指数退避，避免把接口打到临时封禁。
"""

import json
import os
import random
import re
import sys
import threading
import time
import concurrent.futures

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from . import db
from .normalize import (normalize_exact, normalize_match, name_similarity,
                        person_match, artist_exact, artist_close, artist_subset)

_app = None


def _get_app():
    """拿到主程序模块（复用其成熟的搜索实现）。

    ⚠️ 不能直接 `import app`：app.py 以脚本启动时模块名是 '__main__'，
    直接 import 会把 app.py 整个再跑一遍（顶层线程/初始化全部翻倍）。
    优先复用 sys.modules 里已加载的那份。
    """
    global _app
    if _app is None:
        import sys as _sys
        for _name in ('__main__', 'app'):
            _m = _sys.modules.get(_name)
            if _m is not None and hasattr(_m, 'search_qq'):
                _app = _m
                break
        else:
            import app as _a
            _app = _a
    return _app


ID_FIELD = {'qq': '_songmid', 'kugou': '_hash', 'netease': '_song_id'}
EXTRA_FIELDS = {
    'qq': ['_songid', '_albummid'],
    'kugou': ['_album_id', '_mixsongid'],
    'netease': ['_album_id'],
}

# ── 限流退避状态（按平台） ──────────────────────────
_backoff = {p: {'fail': 0, 'until': 0.0, 'empty': 0} for p in db.MONITOR_PLATFORMS}
_backoff_lock = threading.Lock()

EMPTY_STREAK_LIMIT = 5   # 连续 N 首搜不到 → 判为疑似限流，而非"平台真的都没有"
CIRCUIT_FAIL_LIMIT = 3   # 连续 N 次不可信 → 断路器打开，本平台整段跳过（不再逐首硬等）
CIRCUIT_MAX_OPEN = 900   # 断路器最长开启 15 分钟（对齐网易云 405 冷却窗口）


def _rate_limited(platform):
    """平台是否处于已知限流窗口内。

    这是建档准确率的生死线：网易云被限流时接口静默返回空列表（HTTP 200、无报错），
    若当成「平台没有这首歌」就会大面积漏锁，而且漏得悄无声息。
    """
    a = _get_app()
    if platform == 'netease':
        # app.py 检测到 code=405「操作频繁」会打时间戳，冷却窗口 15 分钟
        return (time.time() - getattr(a, '_NETEASE_BLOCKED_AT', 0)) < 900
    return False


def circuit_open(platform):
    """该平台是否处于熔断状态（外部可查，用于跳过无谓的补搜轮次）。"""
    with _backoff_lock:
        st = _backoff[platform]
        return st['fail'] >= CIRCUIT_FAIL_LIMIT and st['until'] > time.time()


def circuit_report():
    """当前熔断中的平台 → {platform: 剩余秒数}。"""
    now = time.time()
    with _backoff_lock:
        return {p: int(st['until'] - now) for p, st in _backoff.items()
                if st['fail'] >= CIRCUIT_FAIL_LIMIT and st['until'] > now}


def _search_platform(platform, keyword, limit=20):
    """单平台轻量搜索，带限流探测与指数退避。

    返回 None = 抓取失败 / 被限流（结论不可信，必须重试）
    返回 []   = 确实没搜到（结论可信）
    """
    # ── 断路器：某平台连续挂掉就整段跳过，绝不逐首硬等 ──────────
    # 教训：网易云限流后若每首都 sleep 退避，会把 QQ/酷狗一起拖死
    # （实测 65s/首）。正确做法是让健康的平台全速跑完，
    # 挂掉的平台整批留给之后的「重试」轮次。
    with _backoff_lock:
        st = _backoff[platform]
        wait = st['until'] - time.time()
        if wait > 0:
            if st['fail'] >= CIRCUIT_FAIL_LIMIT:
                return None                      # 熔断中 —— 立刻返回，不睡
            sleep_for = min(wait, 8)             # 轻度失败才短暂缓一下
        else:
            sleep_for = 0
    if sleep_for:
        time.sleep(sleep_for)

    a = _get_app()
    err = ''
    try:
        if platform == 'qq':
            res = a.search_qq(keyword, limit)
        elif platform == 'kugou':
            res = a.search_kugou(keyword, limit)
        elif platform == 'netease':
            res = a.search_netease(keyword, limit)
        else:
            return None
    except Exception as e:
        res, err = None, str(e)

    # 空结果不一定是「没有」—— 先问平台是不是正在限流
    if res is not None and len(res) == 0:
        if _rate_limited(platform):
            res, err = None, 'rate_limited(405)'
        else:
            with _backoff_lock:
                st = _backoff[platform]
                st['empty'] += 1
                if st['empty'] >= EMPTY_STREAK_LIMIT:
                    res, err = None, f'empty_streak x{st["empty"]}'
    elif res:
        with _backoff_lock:
            _backoff[platform]['empty'] = 0

    with _backoff_lock:
        st = _backoff[platform]
        if res is None:
            st['fail'] += 1
            delay = min(CIRCUIT_MAX_OPEN, 10 * (2 ** min(st['fail'], 7))) + random.uniform(0, 5)
            st['until'] = time.time() + delay
            if st['fail'] == CIRCUIT_FAIL_LIMIT:
                print(f'  [x] {platform} 连续 {st["fail"]} 次不可信（{err}）→ '
                      f'熔断 {int(delay)}s，本轮先跳过该平台，稍后用「重试」补齐')
            elif st['fail'] < CIRCUIT_FAIL_LIMIT:
                print(f'  [!] {platform} 结果不可信({st["fail"]}次) {err} → 退避 {int(delay)}s')
        else:
            if st['fail'] >= CIRCUIT_FAIL_LIMIT:
                print(f'  [√] {platform} 已恢复，断路器关闭')
            st['fail'] = 0
            st['until'] = 0.0
            st['empty'] = 0
    return res


def score_candidate(cand, song_name, artist='', lyricist='', composer=''):
    """给单条候选打分。返回 dict（含分数、命中项、是否精确同名）。"""
    cname = cand.get('song_name', '') or ''
    cartist = cand.get('performer', '') or ''
    base, ntype = name_similarity(song_name, cname)

    exact_same = bool(cname) and normalize_exact(cname) == normalize_exact(song_name)
    artist_hit = bool(artist) and person_match(artist, cartist)
    # 反灌水四级信号（从强到弱）：
    #   严格相等（含符号） > 子集（平台只标主唱） > 宽松相等（洗掉符号） > 包含命中
    a_exact = bool(artist) and artist_exact(artist, cartist)
    a_subset = bool(artist) and not a_exact and artist_subset(artist, cartist)
    a_close = bool(artist) and artist_close(artist, cartist)
    # v4.27.28：候选歌手字段含括号(库歌手别名) → 视为同一作者
    # 覆盖「徐泽（要不要买菜）」vs「要不要买菜」、「邓寓君(等什么君)」vs「等什么君」
    # 这类「艺人括号说明真名/别名为库里已知作者」的场景。
    a_alias = bool(artist) and _artist_alias_match(artist, cartist)
    lyr_hit = bool(lyricist) and person_match(lyricist, cand.get('lyricist') or '')
    comp_hit = bool(composer) and person_match(composer, cand.get('composer') or '')
    # v4.27.29：发行方识别 —— 候选唱片公司含 HikoonMusic / 海葵音乐（自家厂牌）
    # → 视为正版信号，供 _classify 直接升 high 自动锁定。
    hikoon_label = _is_hikoon_label(cand.get('record_label') or '')

    score = base
    if a_exact or a_subset:
        score += 18
    elif a_close:
        score += 12
    elif artist_hit:
        score += 6          # 只是包含命中，权重压低，给严格相等的让路
    if lyr_hit:
        score += 14
    if comp_hit:
        score += 14
    score = min(100, score)

    # 平台上这条带版本后缀（伴奏/剪辑版/Live）—— 复核界面要显式提示
    version_suffix = bool(_RE_SUBTITLE.search(str(cname))) and not \
        bool(_RE_SUBTITLE.search(str(song_name)))

    return {
        'score': score, 'name_type': ntype, 'exact_same': exact_same,
        'artist_hit': artist_hit, 'artist_exact': a_exact, 'artist_close': a_close,
        'artist_subset': a_subset, 'artist_alias_match': a_alias, 'version_suffix': version_suffix,
        'lyricist_hit': lyr_hit, 'composer_hit': comp_hit, 'hikoon_label': hikoon_label,
    }


def _artist_alias_match(lib_artist, cand_artist):
    """候选歌手字段中若包含括号（中/英文），括号内文本归一化后与库歌手严格相等 → 视为同一作者。

    典型场景：库「要不要买菜」+ 候选「徐泽（要不要买菜）」；
              库「等什么君」+ 候选「邓寓君(等什么君)」。
    「江小白（陈硕）」对库「陈硕」也命中（华语圈艺名+真名很常见）。
    注意：只信任"括号内容 == 库歌手"，不信任主名（避免「徐泽」被当成「要不要买菜」的别名）。
    """
    if not lib_artist or not cand_artist:
        return False
    lib_n = normalize_exact(lib_artist)
    if not lib_n:
        return False
    for m in re.finditer(r'[（(]([^）)]+)[）)]', cand_artist):
        if normalize_exact(m.group(1)) == lib_n:
            return True
    return False


def _is_hikoon_label(label):
    """候选唱片公司（发行公司）是否为 HikoonMusic / 海葵音乐（自家厂牌）。

    海葵音乐即 Hikoon Music，是监测台自家厂牌；旗下发行即正版确权证据。
    厂牌字符串形态不固定（Hikoon Music / HikoonMusic / 海葵音乐 / 海葵音乐股份
    有限公司 等），归一化后做子串包含匹配，避免漏判。
    """
    if not label:
        return False
    s = normalize_exact(str(label))
    return 'hikoon' in s or '海葵' in s


def _classify(best, has_artist):
    """置信度分级。high 才自动锁定，其余全部进人工复核。"""
    if not best:
        return db.CONF_NONE
    s = best['_m']
    strong_name = s['exact_same'] or s['name_type'] == 'exact'
    aux_hit = s['artist_hit'] or s['lyricist_hit'] or s['composer_hit']
    artist_solid = s['artist_exact'] or s['artist_subset']

    # high 的硬门槛：歌名精确同名 + 歌手严格相等（或平台只标了主唱的子集情况）。
    # 只"包含"歌手名的一律降到 mid 进人工复核 —— 平台山寨条目就是靠包含蒙混。
    if strong_name and artist_solid:
        return db.CONF_HIGH
    # v4.27.29：发行方为 HikoonMusic / 海葵音乐（自家厂牌）→ 直接算正版。
    # 只要歌名精确同名（原版形态）即升 high，无需歌手/词曲再确认——
    # 厂牌即确权证据，比歌手/词曲更硬（曲库词曲元数据常有噪声，且 Hikoon
    # 发行的合作/拼盘可能挂在别人名下，但厂牌已证明是正版发行）。
    # 约束：① strong_name（精确同名，挡掉同名蹭歌）② 不要求歌手命中。
    if strong_name and s.get('hikoon_label'):
        return db.CONF_HIGH
    # v4.27.17：原版优先自动锁定
    # 当 best 是「精确同名 + 无版本后缀 + 歌手是宽松匹配(artist_close=True)」时，
    # 升 high 自动锁定。覆盖「曲库『小乐哥』+ 候选『小乐哥（王唯乐）』」这种
    # 同人带装饰括号的常见漏网情况 —— 装饰括号（说明性真名/副标）严格集合比较
    # 会被挡掉，但归一化剥括号后实际是同人，原版候选应该自动锁定。
    # 风险控制：① strong_name=True（精确同名，挡掉「同名蹭名」）② score>=90
    # ③ artist_close=True（必须归一化后同人，挡掉真正的同名他唱）。
    if strong_name and not s['version_suffix'] and s['score'] >= 90 and s.get('artist_close'):
        return db.CONF_HIGH
    # v4.27.28：候选歌手括号内文本与库歌手严格相等 → 升 high
    # 覆盖「库『要不要买菜』+ 候选『徐泽（要不要买菜）』」「库『等什么君』+ 候选
    # 『邓寓君(等什么君)』『江小白(陈硕)』」这种主流艺名+括号真名/原名的场景。
    # 风险控制：① strong_name=True（精确同名）② not version_suffix（挡掉「(Live 版)」）
    # ③ alias_match=True（必须是"括号内文本 == 库歌手"，不信任主名）。
    if strong_name and not s['version_suffix'] and s['score'] >= 90 and s.get('artist_alias_match'):
        return db.CONF_HIGH
    # v4.27.24：同名带版本后缀 + 歌手严格相等 → 升 high
    # 覆盖「徐怀钰 / 心中的遗憾」+「心中的遗憾 (2026光致蜕变Light It Up巡回演唱会深圳站) / 徐怀钰」
    # 这种平台数据库里只有"主歌名+发行版/演唱会场次"格式、库里没有原始录音版的情况。
    # 强信号：artist_exact（候选歌手与库严格相等）挡住同名翻唱（Cover 标注、不同歌手）。
    # 若库 lyricist/composer 命中候选词曲，则更有把握；仅无词曲信息时走强 artist 也 OK。
    if s['name_type'] == 'exact_with_suffix' and s['artist_exact']:
        return db.CONF_HIGH
    # Excel 没给歌手时，词曲命中也可以顶上
    if strong_name and not has_artist and (s['lyricist_hit'] or s['composer_hit']):
        return db.CONF_HIGH
    if s['score'] >= 70 or (strong_name and aux_hit):
        return db.CONF_MID
    if s['score'] > 0:
        return db.CONF_LOW
    return db.CONF_NONE


def _candidate_tier(c):
    """候选分级：用于 _rank 与显示过滤。0=必中, 9=完全无关(过滤掉)。

    关键修复 (v4.27.18)：
      ① name_type 为 None 或 fuzzy_low/medium 一律 tier 9 → 不进候选项列表。
        「歌名完全不对 + 歌手沾边」的候选（如「我想」找「焚书」「和你」）
        对人工复核没有任何帮助，纯干扰。即使 artist_exact 也救不回来——
        同一歌手的别的歌曲不是当前歌的匹配。
        英文歌常见的字符巧合（"love" 与 "tell" 共享 l/e，触发 fuzzy_medium
        50% 重合）也属于此类，必须过滤。
      ② exact_same 升到 tier 0，优先于 artist_close。
      ③ 歌名有真实形态匹配（exact/contains/fuzzy_high）时，按艺术家强度细分。
    """
    m = c['_m']
    if m['name_type'] is None or m['name_type'] in ('fuzzy_low', 'fuzzy_medium'):
        return 9                          # 歌名无显著重合 → 过滤
    if m['exact_same']:
        # v4.27.21：「歌名一字不差 + 歌手完全无关 + 词曲也无关」→ 99% 同名他唱，
        # 直接过滤。任一信号命中（歌手部件 / 别名 / 词曲作者 / 作曲作者）
        # 都保留 —— 让 _classify 走"原版优先"逻辑判定。
        # 歌手命中用 m['artist_hit']（person_match 部件包含+别名）覆盖
        # 「库里『张齐山DanieL』+ 候选『张齐山』」「库里『周杰伦』+ 候选『Jay Chou』」
        # 这类场景（artist_close 太严苛会被挡掉，但这种其实就是同一首歌）；
        # 词曲命中覆盖「另一歌手翻唱或同词曲多版本」场景。
        # 典型同名他唱：「谦让」/王靖雯 库的 5 个候选（小可/林知微…）全是另外的人
        # 唱 + 词曲也不是李艺皓/郑志宏；「我想」/童显昱 同上；love love/金润吉 同上。
        artist_related = (m.get('artist_exact') or m.get('artist_subset')
                          or m.get('artist_close') or m.get('artist_hit')
                          or m.get('artist_alias_match'))
        lyric_related = (m.get('lyricist_hit') or m.get('composer_hit'))
        if not artist_related and not lyric_related:
            return 9                      # 歌手+词曲都无关联 → 同名他唱，过滤
        # v4.27.25：精确同名 + 歌手命中即视为同一首歌，词曲库元数据（常为噪声/
        # 录入错误）不能否决。例：库「徐怀钰/心中的遗憾/陈国华」实际正版
        # (QQ 7223749《Bad girl》2007) 词曲是「小米」，若先跑词曲过滤会误 tier9，
        # 反而让带括号的 live 版胜出。故词曲过滤只放"非精确同名"分支。
        return 0                          # 任一信号命中 → 必中（_classify 再细分）
    # v4.27.19 + v4.27.27：词曲作者完全不一致 → 过滤（仅作用于"非精确同名"
    # 且「歌手无关联」的真正同名他歌）。同一作者(artist_exact/subset/close)
    # 的衍生版本（live/清新/DJ/cover/伴奏）词曲库元数据常错录或平台不一致，
    # 不能因「小米≠陈国华」否决「手牵手 (清新版)」「心中的遗憾 (Live)」这种。
    # QQ/酷狗等不抓词曲作者的平台，候选的 lyricist/composer 恒为 None，
    # (cand_ly or cand_co) 为 False，此处不触发 → 行为不变。
    lib_ly = c.get('_lib_lyricist') or ''
    lib_co = c.get('_lib_composer') or ''
    cand_ly = c.get('lyricist') or ''
    cand_co = c.get('composer') or ''
    artist_related = (m.get('artist_exact') or m.get('artist_subset')
                      or m.get('artist_close') or m.get('artist_hit')
                      or m.get('artist_alias_match'))
    if not artist_related \
            and (lib_ly or lib_co) and (cand_ly or cand_co) \
            and not m['lyricist_hit'] and not m['composer_hit']:
        return 9
    if m['artist_exact'] or m['artist_subset']:
        return 1                          # 歌名沾边 + 歌手严格相等
    if (m.get('artist_close') or m.get('artist_alias_match')) and m['score'] >= 30:
        return 2                          # 歌名沾边 + 歌手宽松匹配/括号别名
    return 3                              # 歌名沾边，歌手无关


def _rank(cands):
    """候选排序：歌名精确同名 > 歌名沾边+歌手严 > 歌名沾边+歌手宽 > 仅歌名沾边。

    歌名零重叠的候选（tier 9）被 _candidate_tier 过滤掉，不进显示列表。

    v4.27.25：同名同分（如「心中的遗憾」原版 vs 「心中的遗憾 (2026演唱会)」）
    时，优先无版本后缀的干净原版——曲库存档的是标准曲名，应锁定到原版而非
    live/DJ/cover 等衍生版本。version_suffix=False(0) 排在前，True(1) 排在后。

    v4.27.28：同名同分且都无版本后缀时（如「下山」/徐泽（要不要买菜）vs
    「下山」/胡文博BOY、王建豪use580），括号别名候选应优先。artist_alias_match
    比 artist_exact/subset 更弱（依赖括号内文本等于库歌手）但比纯 _idx 更可信。
    """
    return sorted(
        cands,
        key=lambda c: (_candidate_tier(c), -c['_m']['score'],
                       -int(bool(c['_m'].get('artist_alias_match'))),  # 括号别名优先
                       -int(bool(c['_m'].get('hikoon_label'))),        # 自家厂牌优先（正版）
                       int(c['_m']['version_suffix']), c.get('_idx', 99))
    )


_RE_SUBTITLE = re.compile(r'[\(（\[【].*?[\)）\]】]')


def _has_solid(lst, song_name, artist, lyricist='', composer=''):
    """该平台是否已拿到「可自动锁定」级别的结果 —— 是则不再补搜，省请求。"""
    if not lst:
        return False
    for c in lst:
        m = score_candidate(c, song_name, artist, lyricist, composer)
        strong_name = m['exact_same'] or m['name_type'] == 'exact'
        if strong_name and (m['artist_exact'] or m['artist_subset'] or
                            (not artist and (m['lyricist_hit'] or m['composer_hit']))):
            return True
        # v4.27.29：自家厂牌（Hikoon/海葵）精确同名即正版，无需再补搜其他轮次
        if strong_name and m.get('hikoon_label'):
            return True
    return False


def _slim(cand, platform):
    """候选精简存库（复核界面展示用）。"""
    extra = {f.lstrip('_'): cand.get(f) for f in EXTRA_FIELDS.get(platform, [])}
    m = cand['_m']
    return {
        'song_id': str(cand.get(ID_FIELD[platform], '') or ''),
        'name': cand.get('song_name', ''),
        'artist': cand.get('performer', ''),
        'album': cand.get('album', ''),
        'url': cand.get('song_url', ''),
        'availability': cand.get('availability', ''),
        'score': m['score'],
        'exact_same': m['exact_same'],
        'artist_hit': m['artist_hit'],
        'artist_exact': m['artist_exact'],
        'artist_close': m['artist_close'],
        'artist_subset': m['artist_subset'],
        'version_suffix': m['version_suffix'],
        'lyricist': cand.get('lyricist') or '',
        'composer': cand.get('composer') or '',
        'record_label': cand.get('record_label') or '',
        'hikoon_label': m['hikoon_label'],
        'collection_count': cand.get('collection_count'),  # v4.27.30 复核卡展示
        'extra': extra,
    }


def match_one(song_name, artist='', lyricist='', composer='', platforms=None,
              limit=20, keep_candidates=5):
    """匹配单首歌 → {platform: {...}}。不写库，便于单测与试跑。"""
    platforms = platforms or db.MONITOR_PLATFORMS

    def run(kw, targets):
        out = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(targets))) as ex:
            futs = {ex.submit(_search_platform, p, kw, limit): p for p in targets}
            for fut in concurrent.futures.as_completed(futs):
                p = futs[fut]
                try:
                    out[p] = fut.result()
                except Exception:
                    out[p] = None
        return out

    # 关键词递进策略：越靠后越宽松，只对「还没拿到好结果」的平台补搜。
    #   1) 歌名 + 歌手      —— 最具体，压同名干扰
    #   2) 纯歌名           —— 有些平台对长关键词分词差
    #   3) 主歌名 + 歌手    —— 剥掉「（忘记你是女人）」这类副标题，副标题会让搜索命中率骤降
    #   4) 主歌名           —— 最后兜底
    bare = _RE_SUBTITLE.sub('', song_name).strip()
    keywords = []
    for kw in (f'{song_name} {artist}'.strip() if artist else song_name,
               song_name,
               (f'{bare} {artist}'.strip() if artist else bare) if bare and bare != song_name else None,
               bare if bare and bare != song_name else None):
        if kw and kw not in keywords:
            keywords.append(kw)

    raw = {}
    failed = set()
    pending = list(platforms)
    for round_i, kw in enumerate(keywords):
        if not pending:
            break
        got = run(kw, pending)
        for p in pending:
            new = got.get(p)
            if new is None:
                failed.add(p)          # 这一轮不可信，记下来
                if p not in raw:
                    raw[p] = None
                continue
            failed.discard(p)          # 后续轮次拿到了可信结果，撤销标记
            merged = list(raw.get(p) or [])
            seen = {str(c.get(ID_FIELD[p], '')) for c in merged}
            for c in new:
                sid = str(c.get(ID_FIELD[p], ''))
                if sid and sid not in seen:
                    seen.add(sid)
                    merged.append(c)
            raw[p] = merged
        # 已经拿到「歌名精确 + 歌手严格相等」的平台不再补搜；
        # 熔断中的平台也直接踢出本首的补搜队列（再搜也只是白跑）
        pending = [p for p in pending
                   if not _has_solid(raw.get(p), song_name, artist, lyricist, composer)
                   and not circuit_open(p)]

    result = {}
    has_artist = bool(artist)
    for p in platforms:
        lst = raw.get(p)
        # 失败/限流：结论不可信，标 error 让上层跳过写库并留待重试，
        # 绝不能写成「平台没有这首歌」——那会把限流悄悄变成永久漏锁。
        if lst is None or (p in failed and not lst):
            result[p] = {'confidence': db.CONF_NONE, 'best': None, 'candidates': [],
                         'error': 'search_failed'}
            continue
        scored = []
        for i, c in enumerate(lst):
            if not c.get(ID_FIELD[p]):
                continue
            c = dict(c)
            c['_idx'] = i
            # v4.27.19：把曲库词曲作者挂到候选上，供 _candidate_tier 判定词曲一致性
            c['_lib_lyricist'] = lyricist
            c['_lib_composer'] = composer
            c['_m'] = score_candidate(c, song_name, artist, lyricist, composer)
            scored.append(c)
        scored = _rank(scored)
        best = scored[0] if scored else None
        conf = _classify(best, has_artist)
        result[p] = {
            'confidence': conf,
            'best': _slim(best, p) if best else None,
            # 过滤 tier 9（歌名零重叠）：这些是同一歌手的别的歌曲，对人工复核没帮助。
            # 保留 best 仍可能为 tier 9（即平台真的没有同名歌曲，但有这个歌手别的歌），
            # 这种情况下 confidence 已被 _classify 压到 mid/low，正常进复核。
            'candidates': [_slim(c, p) for c in scored[:keep_candidates] if _candidate_tier(c) < 9],
            'error': '',
        }
    return result


def match_archive(limit=None, only_status=('pending', 'partial'), platforms=None,
                  workers=2, sleep_range=(0.6, 1.4), verbose=True, archive_ids=None,
                  skip_locked=True):
    """批量建档匹配。

    断点续跑：默认只处理 status ∈ (pending, partial)。
      pending  = 从没匹配过
      partial  = 匹过但有平台因限流/失败没拿到可信结果，需要补
    skip_locked=True 时，已 high 自动锁定或人工确认的平台不再重复搜，省请求。
    """
    db.init_db()
    platforms = platforms or db.MONITOR_PLATFORMS
    conn = db.get_conn()

    if archive_ids:
        qmark = ','.join('?' * len(archive_ids))
        rows = conn.execute(
            f'SELECT * FROM song_archive WHERE id IN ({qmark}) ORDER BY id',
            archive_ids).fetchall()
    else:
        sql = 'SELECT * FROM song_archive WHERE enabled=1'
        args = []
        if only_status:
            st = [only_status] if isinstance(only_status, str) else list(only_status)
            sql += f' AND status IN ({",".join("?" * len(st))})'
            args.extend(st)
        sql += ' ORDER BY id'
        if limit:
            sql += f' LIMIT {int(limit)}'
        rows = conn.execute(sql, args).fetchall()

    total = len(rows)
    if verbose:
        print(f'[match] 待匹配 {total} 首，平台={platforms}')
    if not total:
        return {'total': 0}

    run_id = db.start_run('archive_match', total=total)
    stat = {'total': total, 'done': 0, 'failed': 0, 'partial': 0,
            'high': 0, 'mid': 0, 'low': 0, 'none': 0}
    lock = threading.Lock()

    def _locked_platforms(archive_id):
        rs = conn.execute(
            "SELECT platform FROM song_platform WHERE archive_id=? AND song_id!='' "
            "AND review_status IN ('auto_locked','confirmed')", (archive_id,)).fetchall()
        return {r['platform'] for r in rs}

    def work(row):
        todo = list(platforms)
        if skip_locked:
            done_p = _locked_platforms(row['id'])
            todo = [p for p in platforms if p not in done_p]
        if not todo:
            with db.tx() as c:
                c.execute("UPDATE song_archive SET status='matched', updated_at=? WHERE id=?",
                          (db.now_str(), row['id']))
            with lock:
                stat['done'] += 1
            db.bump_run(run_id, done_delta=1)
            return

        try:
            res = match_one(row['song_name'], row['artist'], row['lyricist'],
                            row['composer'], platforms=todo)
        except Exception as e:
            with lock:
                stat['failed'] += 1
            db.bump_run(run_id, failed_delta=1)
            if verbose:
                print(f'  [x] #{row["id"]} {row["song_name"]} 异常: {e}')
            return

        best_conf = db.CONF_NONE
        unreliable = []
        for p in todo:
            r = res[p]
            # 搜索不可信（限流/超时）：跳过写库，保留上次结果，本首留待重跑
            if r.get('error'):
                unreliable.append(p)
                continue
            best = r['best'] or {}
            conf = r['confidence']
            review = db.REVIEW_AUTO if conf == db.CONF_HIGH else db.REVIEW_PENDING
            db.upsert_platform(
                archive_id=row['id'], platform=p,
                song_id=best.get('song_id', ''), url=best.get('url', ''),
                extra=best.get('extra') or None,
                matched_name=best.get('name', ''), matched_artist=best.get('artist', ''),
                matched_album=best.get('album', ''), score=best.get('score', 0),
                confidence=conf, review_status=review, candidates=r['candidates'])
            order = {db.CONF_HIGH: 3, db.CONF_MID: 2, db.CONF_LOW: 1, db.CONF_NONE: 0}
            if order[conf] > order[best_conf]:
                best_conf = conf

        new_status = 'partial' if unreliable else 'matched'
        with db.tx() as c:
            c.execute('UPDATE song_archive SET status=?, updated_at=? WHERE id=?',
                      (new_status, db.now_str(), row['id']))
        with lock:
            stat['done'] += 1
            if unreliable:
                stat['partial'] += 1
            stat[best_conf if best_conf != db.CONF_NONE else 'none'] += 1
            n = stat['done'] + stat['failed']
        db.bump_run(run_id, done_delta=1)
        if verbose:
            tags = ' '.join(
                (f'{p}:限流待重试' if res[p].get('error')
                 else f'{p}:{res[p]["confidence"][:1].upper()}'
                      f'{"✓" if res[p]["best"] else "✗"}')
                for p in todo)
            print(f'  [{n}/{total}] {row["song_name"]} - {row["artist"]}  {tags}')
        time.sleep(random.uniform(*sleep_range))

    if workers <= 1:
        for row in rows:
            work(row)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(work, rows))

    status = ('failed' if not stat['done']
              else 'partial' if (stat['failed'] or stat['partial'])
              else 'success')
    cir = circuit_report()
    if cir:
        stat['circuit'] = cir
    db.finish_run(run_id, status=status, done=stat['done'], failed=stat['failed'],
                  message=json.dumps(stat, ensure_ascii=False))
    if verbose:
        print(f'[match] 完成 {stat}')
        if cir:
            names = '、'.join(f'{p}（还需冷却 {s // 60 + 1} 分钟）' for p, s in cir.items())
            print(f'[match] ⚠ {names} 本轮被限流跳过 —— 冷却后跑「重试」即可补齐，'
                  f'共 {stat["partial"]} 首待补')
    return stat


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='建档匹配')
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--all', action='store_true', help='忽略 status，全量重匹配')
    ap.add_argument('--retry', action='store_true', help='只补跑限流未完成的(partial)')
    ap.add_argument('--test', metavar='SONG', help='单曲试匹配，格式：歌名|歌手')
    args = ap.parse_args()

    if args.test:
        parts = (args.test.split('|') + ['', '', ''])[:4]
        r = match_one(parts[0], parts[1], parts[2], parts[3])
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        st = None if args.all else (('partial',) if args.retry else ('pending', 'partial'))
        match_archive(limit=args.limit, only_status=st, workers=args.workers)
