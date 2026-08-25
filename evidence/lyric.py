#!/usr/bin/env python3
"""歌词核验核心算法（迭代 1）

功能：
  - normalize_lyric：去标点/空格/通用版权声明，得到纯净可比对文本
  - extract_snippets：从全歌词提取最有辨识度的连续句段（用于反向搜歌）
  - similarity：最长连续相同子串占比（对方 v2.3.4 的「最长连续相同字数占比」）

这些函数纯算法、不依赖网络，可独立单测。
"""

import re

# 硬跳过（含即整行跳过，纯版权声明）
_HARD_SKIP = [
    r'版权所有', r'未经许可', r'不得翻唱', r'翻唱必究', r'翻唱违', r'OP', r'SP',
    r'录音制作者', r'制作公司', r'本歌词', r'歌词来自', r'LRC', r'歌词编辑',
    r'版权方', r'All Rights Reserved', r'®', r'™',
]
# 软跳过（含冒号且短才跳，避免误删歌词里偶现的词）
_SOFT_SKIP = [
    r'作词', r'作曲', r'编曲', r'混音', r'母带', r'出品', r'发行',
    r'策划', r'监制', r'统筹', r'宣发', r'原唱', r'演唱',
]

_PUNCT = r'[^\w一-鿿]'
_WORD = re.compile(r'[\w一-鿿]+')


def normalize_lyric(text):
    """返回纯净可比对文本：去标点、去空格、转小写、过滤制作名单/版权声明行。"""
    if not text:
        return ''
    out_lines = []
    for line in str(text).splitlines():
        raw = line.strip()
        # 去掉 [00:12.34] 之类时间轴
        raw = re.sub(r'\[\d+:\d+(\.\d+)?\]', '', raw)
        if not raw:
            continue
        # 硬跳过：纯版权声明
        hard = any(re.search(p, raw) for p in _HARD_SKIP)
        # 软跳过：含冒号且较短的制作信息行
        clean_len = len(re.sub(_PUNCT, '', raw))
        soft = ((':' in raw or '：' in raw) and clean_len <= 18
                and any(re.search(p, raw) for p in _SOFT_SKIP))
        if hard or soft:
            continue
        # 去标点、转小写
        clean = re.sub(_PUNCT, '', raw).lower()
        if clean:
            out_lines.append(clean)
    return '\n'.join(out_lines)


def _longest_common_substring_len(a, b):
    """返回 a, b 最长公共连续子串长度（经典 DP）。"""
    if not a or not b:
        return 0
    # 用较短串做行，省内存
    if len(a) < len(b):
        a, b = b, a
    prev = [0] * (len(b) + 1)
    best = 0
    for ch in a:
        cur = [0] * (len(b) + 1)
        for j, ch2 in enumerate(b, 1):
            if ch == ch2:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def similarity(lyric_a, lyric_b):
    """最长连续相同字数占比（对方的核心指标）。

    返回 0~1：最长连续相同子串长度 / max(len_a, len_b)。
    用于「正版歌词 vs 平台搜到的歌词片段」比对。
    """
    a = normalize_lyric(lyric_a)
    b = normalize_lyric(lyric_b)
    if not a or not b:
        return 0.0
    lcs = _longest_common_substring_len(a, b)
    denom = max(len(a), len(b))
    return round(lcs / denom, 4) if denom else 0.0


def extract_snippets(lyric, min_len=8, max_len=22, top_n=5):
    """从全歌词提取最有辨识度的连续句段（用于反向搜歌/生成平台 query）。

    规则：跳过太短行；取长度在 [min_len, max_len] 之间的连续中文/英文词串；
          优先返回出现位置靠前的若干段。
    """
    norm = normalize_lyric(lyric)
    if not norm:
        return []
    snippets = []
    for line in norm.split('\n'):
        # 在长行内按 max_len 切分，保留连续片段
        if len(line) < min_len:
            continue
        # 切词再拼回连续串
        for i in range(0, max(1, len(line) - min_len + 1)):
            seg = line[i:i + max_len]
            if min_len <= len(seg) <= max_len and _WORD.search(seg):
                snippets.append(seg)
                if len(snippets) >= 200:  # 上限保护
                    break
        if len(snippets) >= 200:
            break
    # 去重 + 取前 top_n（按长度降序优先保留信息量大的）
    seen = set()
    uniq = []
    for s in sorted(set(snippets), key=len, reverse=True):
        if s in seen:
            continue
        seen.add(s)
        uniq.append(s)
        if len(uniq) >= top_n:
            break
    return uniq


def coverage_stats(lyric_a, lyric_b):
    """匹配行数 + 覆盖百分比（对方 v2.3.0 的辅助指标）。"""
    a_lines = [l for l in normalize_lyric(lyric_a).split('\n') if l]
    b_lines = [l for l in normalize_lyric(lyric_b).split('\n') if l]
    if not a_lines or not b_lines:
        return {'matched_lines': 0, 'coverage': 0.0}
    matched = 0
    for la in a_lines:
        for lb in b_lines:
            if la and lb and _longest_common_substring_len(la, lb) >= min(len(la), len(lb)) * 0.6:
                matched += 1
                break
    return {'matched_lines': matched,
            'coverage': round(matched / max(len(a_lines), len(b_lines)), 4)}


if __name__ == '__main__':
    demo_a = """[00:12.00] 作词：张三 作曲：李四
    窗外的麻雀 在电线杆上多嘴
    你说这一句 很有夏天的感觉
    [版权所有 未经许可 不得翻唱]"""
    demo_b = "窗外的麻雀在电线杆上多嘴你说这一句很有夏天的感觉"
    print("normalize_a:", repr(normalize_lyric(demo_a)))
    print("similarity:", similarity(demo_a, demo_b))
    print("snippets:", extract_snippets(demo_a))
    print("coverage:", coverage_stats(demo_a, demo_b))
