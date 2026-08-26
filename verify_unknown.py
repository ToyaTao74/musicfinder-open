#!/usr/bin/env python3
"""只核验上轮 unknown 行 + 单艺人别名/多艺人匹配行，消解限流导致的未知项。"""
import sqlite3, json, re, time, os
import requests
import verify_mismatch as v

DB = v.DB
OUT = '/Users/toya/WorkBuddy/2026-07-30-11-09-35/musicfinder/verify_unknown_report.json'

def main():
    # 1. 取上轮 unknown 的 id
    unknown_ids = set()
    if os.path.exists(v.OUT):
        old = json.load(open(v.OUT, encoding='utf-8'))
        for e in old.get('unknown', []):
            unknown_ids.add(e['id'])

    # 2. 取单艺人但 qq_match 标称别名/多艺人的 id
    conn = sqlite3.connect(DB); conn.row_factory = sqlite3.Row
    single_alias = conn.execute("""
        SELECT id FROM task_items
        WHERE task_id=26 AND qq_url IS NOT NULL AND qq_url != ''
          AND qq_match LIKE '匹配%'
          AND NOT (performer LIKE '%,%' OR performer LIKE '%/%' OR performer LIKE '%&%'
                   OR performer LIKE '%、%' OR performer LIKE '%;%' OR performer LIKE '%；%')
          AND (qq_match LIKE '%别名%' OR qq_match LIKE '%多艺人%')
    """).fetchall()
    conn.close()
    single_ids = {r['id'] for r in single_alias}

    target_ids = unknown_ids | single_ids
    print(f'unknown={len(unknown_ids)} 单艺人别名={len(single_ids)} 合并去重={len(target_ids)}', flush=True)

    conn = sqlite3.connect(DB); conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT id, song_name, performer, qq_url, qq_match
        FROM task_items WHERE id IN (%s)
    """ % ','.join(str(i) for i in target_ids)).fetchall()
    conn.close()

    report = {'ok': [], 'mismatch': [], 'unknown': []}
    # 断点续跑：若已有报告，载入已核验 id
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding='utf-8'))
            for k in ('ok', 'mismatch', 'unknown'):
                report[k].extend(old.get(k, []))
            done = {e['id'] for e in report['ok'] + report['mismatch'] + report['unknown']}
            rows = [r for r in rows if r['id'] not in done]
            print(f'续跑：跳过已核验 {len(done)} 个', flush=True)
        except Exception:
            pass

    for i, r in enumerate(rows):
        url = r['qq_url']
        m = re.search(r'songDetail/([0-9A-Za-z]+)', url or '')
        songmid = m.group(1) if m else ''
        entry = {'id': r['id'], 'song_name': r['song_name'], 'performer': r['performer'],
                 'qq_url': url, 'qq_match': r['qq_match'], 'real_singer': ''}
        if not songmid:
            entry['reason'] = 'no_songmid'; report['unknown'].append(entry); continue
        real, _ = v.real_singer(songmid, tries=4)
        entry['real_singer'] = real
        parts = [p.strip() for p in v.MULTI_SPLIT.split(r['performer'] or '') if p.strip()]
        # 也把 qq_match 里标称的别名/艺人名纳入比对
        mm = re.search(r'[：:](.+?)[）)]', r['qq_match'] or '')
        if mm:
            for nm in re.split(r'[/&,，、;；|]+', mm.group(1)):
                nm = nm.strip()
                if nm and nm not in parts:
                    parts.append(nm)
        hit = v.intersects(parts, real)
        if hit is True:
            report['ok'].append(entry)
        elif hit is False:
            report['mismatch'].append(entry)
        else:
            report['unknown'].append(entry)
        # 每 10 行增量落盘，防止被中段丢进度
        if (i + 1) % 10 == 0:
            with open(OUT, 'w', encoding='utf-8') as f:
                json.dump(report, f, ensure_ascii=False, indent=1)
        if (i + 1) % 25 == 0:
            print(f'  [{i+1}/{len(rows)}] ok={len(report["ok"])} mismatch={len(report["mismatch"])} unknown={len(report["unknown"])}', flush=True)
        time.sleep(0.3)

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(f'\n完成。ok={len(report["ok"])} mismatch={len(report["mismatch"])} unknown={len(report["unknown"])}', flush=True)
    print(f'报告: {OUT}')

if __name__ == '__main__':
    main()
