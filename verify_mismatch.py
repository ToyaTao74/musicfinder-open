#!/usr/bin/env python3
"""核验 task26 多艺人「以为匹配成功」行的 QQ 链接是否指向错误歌手。

方法：对每个嫌疑行，从 qq_url 取 songmid，用 fcg_play_single_song.fcg 取真实歌手，
与期望 performer（多艺人拆开）做交集比对。无交集则标记疑似错配。
"""
import sqlite3, json, re, time, sys, os
import requests

DB = '/Users/toya/.musicfinder/batch_v2.db'
OUT = '/Users/toya/WorkBuddy/2026-07-30-11-09-35/musicfinder/verify_mismatch_report.json'

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
HEADERS = {'User-Agent': UA, 'Referer': 'https://y.qq.com/'}

MULTI_SPLIT = re.compile(r'[/&,，、;；|]+')

def real_singer(songmid, tries=3):
    """返回 (singers_str, raw_json_or_None)。空/限流时重试，仍失败返回 ('', None)。"""
    last = ('', None)
    for _ in range(tries):
        try:
            url = f'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid={songmid}&format=json&platform=yqq.json'
            resp = requests.get(url, headers=HEADERS, timeout=10)
            d = resp.json()
            singers = []
            data = d.get('data')
            if isinstance(data, list):
                for song in data:
                    for s in song.get('singer', []):
                        singers.append(s.get('name', ''))
            elif isinstance(data, dict):
                for song in data.get('list', []):
                    for s in song.get('singer', []):
                        singers.append(s.get('name', ''))
            s = '/'.join(singers)
            if s:
                return s, d
            last = (s, d)
        except Exception:
            last = ('', None)
        time.sleep(0.8)
    return last

def canon(s):
    s = (s or '').strip().lower()
    s = re.sub(r'[\s\-_().（）【】\[\]~]', '', s)
    return s

def intersects(expected_parts, real_str):
    """期望多艺人中任一部分（归一化）是否与真实歌手任一歌手段有包含关系（双向）。"""
    real_canon = canon(real_str)
    if not real_canon:
        return None  # 无法判断
    real_segs = [s for s in MULTI_SPLIT.split(real_canon) if s]
    for p in expected_parts:
        pc = canon(p)
        if not pc:
            continue
        # 期望段整体出现在真实串中
        if pc in real_canon:
            return True
        # 真实歌手段整体出现在期望段中（如 期望"taibian타이비언" 含 真实"taibian"）
        for rs in real_segs:
            if pc and rs and (pc in rs or rs in pc):
                return True
    return False

def main():
    # 断点续跑：读取已有报告，跳过已核验的 id
    done_ids = set()
    report = {'checked': 0, 'ok': [], 'mismatch': [], 'unknown': []}
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding='utf-8'))
            for k in ('ok', 'mismatch', 'unknown'):
                for e in old.get(k, []):
                    done_ids.add(e['id'])
                    report[k].append(e)
            report['checked'] = old.get('checked', 0)
            print(f'续跑：已载入 {len(done_ids)} 个已核验 id', flush=True)
        except Exception:
            pass

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT id, song_name, performer, qq_songid, qq_url, qq_match
        FROM task_items
        WHERE task_id=26 AND qq_url IS NOT NULL AND qq_url != ''
          AND (performer LIKE '%,%' OR performer LIKE '%/%' OR performer LIKE '%&%'
               OR performer LIKE '%、%' OR performer LIKE '%;%' OR performer LIKE '%；%')
          AND qq_match LIKE '匹配%'
        ORDER BY id
    """).fetchall()
    conn.close()
    todo = [r for r in rows if r['id'] not in done_ids]
    print(f'嫌疑行总数: {len(rows)}，待核验: {len(todo)}', flush=True)

    for i, r in enumerate(todo):
        url = r['qq_url']
        m = re.search(r'songDetail/([0-9A-Za-z]+)', url or '')
        songmid = m.group(1) if m else ''
        entry = {
            'id': r['id'],
            'song_name': r['song_name'],
            'performer': r['performer'],
            'qq_url': url,
            'qq_match': r['qq_match'],
            'real_singer': '',
        }
        if not songmid:
            entry['reason'] = 'no_songmid'
            report['unknown'].append(entry)
            continue
        real, raw = real_singer(songmid)
        entry['real_singer'] = real
        report['checked'] += 1
        parts = [p.strip() for p in MULTI_SPLIT.split(r['performer'] or '') if p.strip()]
        hit = intersects(parts, real)
        if hit is True:
            report['ok'].append(entry)
        elif hit is False:
            report['mismatch'].append(entry)
        else:
            report['unknown'].append(entry)

        if (i + 1) % 25 == 0:
            print(f'  [{i+1}/{len(todo)}] ok={len(report["ok"])} mismatch={len(report["mismatch"])} unknown={len(report["unknown"])}', flush=True)
        time.sleep(0.25)

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(f'\n完成。checked={report["checked"]} ok={len(report["ok"])} mismatch={len(report["mismatch"])} unknown={len(report["unknown"])}', flush=True)
    print(f'报告: {OUT}')

if __name__ == '__main__':
    main()
