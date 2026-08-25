#!/usr/bin/env python3
"""归一化工具 —— 与主程序 app.py 的两套 normalize 严格对齐

口诀（项目铁律，勿破）：
    搜索要模糊（搜得到）—— normalize_match：剥括号，用于搜索评分 / 候选匹配
    建档要精确（分得开）—— normalize_exact：保留括号内容，用于档案唯一键 / 结果聚合

字符白名单必须包含韩文与日文假名，否则韩日歌曲匹配全失效（历史踩坑）。

本文件刻意不 import app.py：抓取脚本要能脱离 Flask 独立跑（launchd 定时任务）。
若 app.py 的 _normalize_match/_normalize_exact 有改动，这里必须同步改。
"""

import html as html_mod
import json as _json
import os as _os
import re
import unicodedata

# ASCII 字母数字 + CJK 汉字 + 日文平假名/片假名 + 韩文 Hangul 音节
_KEEP = r'\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7afa-zA-Z0-9'

_RE_BRACKET_CONTENT = re.compile(r'[\(（\[【].*?[\)）\]】]')
_RE_STRIP_MATCH = re.compile(rf'[^{_KEEP}]')
_RE_STRIP_EXACT = re.compile(rf'[^{_KEEP}()]')
_RE_OPEN = re.compile(r'[\(（\[【〔｛]')
_RE_CLOSE = re.compile(r'[\)）\]】〕｝]')


def normalize_match(text):
    """模糊归一：去括号内容、标点、空格，大小写统一。用于搜索评分与候选匹配。"""
    if not text:
        return ''
    text = html_mod.unescape(str(text))
    text = _RE_BRACKET_CONTENT.sub('', text)
    text = text.replace('·', '').replace('•', '').replace(' ', '').replace('\u3000', '')
    return _RE_STRIP_MATCH.sub('', text).lower().strip()


def normalize_exact(text):
    """精确归一：保留括号及其内容（伴奏/DJ版/粤语版），只吃格式差异。"""
    if not text:
        return ''
    text = html_mod.unescape(str(text))
    text = _RE_OPEN.sub('(', text)
    text = _RE_CLOSE.sub(')', text)
    text = text.replace('·', '').replace('•', '').replace(' ', '').replace('\u3000', '')
    return _RE_STRIP_EXACT.sub('', text).lower().strip()


def archive_key(song_name, artist=''):
    """档案唯一键：精确归一的 歌名|歌手。

    用 exact 而非 match —— 「笑柄」和「笑柄(伴奏)」是两首要分开监控的歌。
    """
    return f'{normalize_exact(song_name)}|{normalize_exact(artist)}'


def chart_key(song_name, artist=''):
    """榜单对撞用的兜底键：模糊归一（榜单接口歌名写法常带版本后缀差异）。"""
    return f'{normalize_match(song_name)}|{normalize_match(artist)}'


def split_persons(value):
    """拆分多演唱者 / 多作者：'A/B、C & D' -> ['A','B','C','D']"""
    if not value:
        return []
    parts = re.split(r'[/&,，、;；\|]+', str(value))
    return [p.strip() for p in parts if p and p.strip()]


# ── 艺人别名知识库 ──────────────────────────────
# 作用：en ↔ 王翊恩、王靖雯 ↔ 王靖雯不胖 等同一艺人的不同署名，
#  在归一化后仍然不同——靠别名表补齐。仅单曲独唱场景生效。
_alias_map = None  # lazy load

def _load_aliases():
    global _alias_map
    if _alias_map is not None:
        return _alias_map
    path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'alias.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = _json.load(f)
        _alias_map = {normalize_match(k): v for k, v in raw.items()
                      if not k.startswith('_')}
    except Exception:
        _alias_map = {}
    return _alias_map

def _alias_canonical(name):
    """返回 name 在别名表中的规范名；不在表中返回 None。"""
    if not name:
        return None
    return _load_aliases().get(normalize_match(name))


def strict_token(s):
    """严格归一：只吃「格式差异」，保留一切实义符号。

    与 normalize_match 的关键区别：**不删除符号**。
    平台上大量山寨账号叫「周杰伦♚」「周杰伦.」「周杰伦-」，
    它们在 normalize_match 下会被洗成「周杰伦」，与原版无法区分 —— 这是
    建档误锁的头号原因。strict_token 保留 ♚ / . / - ，让山寨露出原形。

    仍然吃掉的：HTML 转义、全角半角（NFKC）、所有空白、英文大小写。
    """
    if not s:
        return ''
    s = html_mod.unescape(str(s))
    s = unicodedata.normalize('NFKC', s)
    s = re.sub(r'\s+', '', s)
    return s.lower().strip()


def artist_set(value, strict=False):
    """歌手字符串 -> 人名集合（忽略顺序与分隔符）。

    strict=False: '周杰伦♚' -> {'周杰伦'}      （宽松，容错格式差异）
    strict=True : '周杰伦♚' -> {'周杰伦♚'}     （严格，识破山寨）
    """
    norm = strict_token if strict else normalize_match
    out = {n for n in (norm(p) for p in split_persons(value)) if n}
    if not out:
        n = norm(value)
        if n:
            out.add(n)
    return out


def artist_exact(query, result_val):
    """歌手集合【严格】相等 —— 反灌水的核心闸门，high 置信度的硬门槛。

    平台搜索里充斥「周杰伦./Asasblue」「周杰伦♚」这类蹭名字的条目，
    包含式匹配和宽松归一都拦不住，只有保留符号的严格集合比较才能拦住。
    宁可漏判进人工复核，也不能错锁到山寨版。

    别名例外：en ↔ 王翊恩 等已知同一艺人的不同署名，经 alias.json 判定为相等。
    """
    if not query or not result_val:
        return False
    a, b = artist_set(query, strict=True), artist_set(result_val, strict=True)
    if bool(a) and a == b:
        return True
    # 已知别名对（单曲独唱场景）
    if len(a) == 1 and len(b) == 1:
        ca, cb = _alias_canonical(next(iter(a))), _alias_canonical(next(iter(b)))
        if ca and cb and ca == cb:
            return True
    return False


def artist_subset(query, result_val):
    """平台歌手集合 ⊆ 档案歌手集合 —— 处理「平台只标主唱」的常见情况。

    档案「小久Nirvana/藤竹京/Icareu」，平台只写「小久Nirvana」→ 判定成立。

    方向是单向的，绝不能反过来：档案「周杰伦」vs 平台「周杰伦/Asasblue」
    属于山寨蹭名，若允许 E ⊆ P 就会被放行。档案是权威源，
    只接受「平台标得比档案少」，不接受「平台标得比档案多」。
    """
    if not query or not result_val:
        return False
    e = artist_set(query, strict=True)
    p = artist_set(result_val, strict=True)
    return bool(p) and bool(e) and p < e   # 真子集（相等由 artist_exact 负责）


def artist_close(query, result_val):
    """歌手集合【宽松】相等：归一化后一致，但可能带装饰符号。

    用作次优先信号 —— 命中只给 mid（进人工复核），不自动锁定。
    别名例外同 artist_exact。
    """
    if not query or not result_val:
        return False
    a, b = artist_set(query), artist_set(result_val)
    if bool(a) and a == b:
        return True
    if len(a) == 1 and len(b) == 1:
        ca, cb = _alias_canonical(next(iter(a))), _alias_canonical(next(iter(b)))
        if ca and cb and ca == cb:
            return True
    return False


def person_match(query, result_val):
    """人名匹配：支持组合形式，任一子项命中即算匹配。"""
    if not query or not result_val:
        return False
    a, b = normalize_match(query), normalize_match(result_val)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    # 已知别名（en ↔ 王翊恩 等）
    ca, cb = _alias_canonical(query), _alias_canonical(result_val)
    if ca and cb and ca == cb:
        return True
    for part in split_persons(query):
        p = normalize_match(part)
        if p and (p in b or b in p):
            return True
    for part in split_persons(result_val):
        p = normalize_match(part)
        if p and (p in a or a in p):
            return True
    return False


def name_similarity(query, result_name):
    """歌名相似度 0-100 + 匹配类型。与 app.py 的 _song_name_score 保持一致。"""
    q, r = normalize_match(query), normalize_match(result_name)
    if not q or not r:
        return 0, None
    if q == r:
        if _RE_BRACKET_CONTENT.search(str(result_name)):
            return 92, 'exact_with_suffix'
        return 100, 'exact'
    if q in r:
        return (95, 'exact_with_suffix') if len(q) >= 4 else (85, 'contains')
    if r in q:
        return 35, 'contained'
    qs, rs = set(q), set(r)
    if qs and rs:
        cover = len(qs & rs) / max(len(qs), len(rs))
        if cover >= 0.8:
            return 60, 'fuzzy_high'
        if cover >= 0.5:
            return 40, 'fuzzy_medium'
        if cover >= 0.3:
            return 20, 'fuzzy_low'
    return 0, None
