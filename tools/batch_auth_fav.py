#!/usr/bin/env python3
"""授权表批量查三平台收藏量（严格精准匹配：歌名 + 歌手双要素）。

用法：
    ./venv/bin/python3 tools/batch_auth_fav.py [输入xlsx] [输出xlsx]

匹配口径（严格）：
    复用 app._pick_best_for_batch —— 歌名分(ns) + 歌手分(asc) 双要素，并启用：
      · 歌手写法变体归一（dollyy / dollyy99 这类账号序号/大小写变体）
      · 艺人变体白名单（钦觉 / 钦觉呀 这类人工确认的多账号）
      · 装饰尾缀折叠（呀/啊/呢 等固定白名单尾缀）
      · 作者铁证认回（改艺名场景，需歌名强匹配 + 词曲一致）
      · 超级大艺人智能排除（防同名撞车把大艺人收藏量算到小艺人头上）
    只有 label 含「精准匹配」才写入收藏量；否则记「未收录/无精准匹配」，绝不凑数。

输出列：歌名 / 翻唱歌手 / 三平台各自(收藏量, 链接, 匹配结论)

断点续跑：输出文件已存在时，跳过其中「已跑过且成功」的行。
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

from app import (_load_performer_aliases, search_qq, search_netease,
                 search_kugou, _pick_best_for_batch)

IN = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/toya/Desktop/宜昌汇报/0902 AI会/02-工具/授权表查询.xlsx"
OUT = sys.argv[2] if len(sys.argv) > 2 else \
    "/Users/toya/Desktop/宜昌汇报/0902 AI会/02-工具/授权表查询_三平台收藏量.xlsx"
# 分片参数（可选）：START/END 为【数据行号】（1-based，跳过表头），只处理该区间。
# 用途：多进程并行跑批（各写各的输出文件，最后合并），规避单后台进程会话超时。
START = int(sys.argv[3]) if len(sys.argv) > 3 else 1
END = int(sys.argv[4]) if len(sys.argv) > 4 else 10**9
if START > 1:
    OUT = OUT.replace('.xlsx', f'_part{START}-{END}.xlsx')

PLATFORMS = [
    ('QQ音乐', 'qq', search_qq),
    ('网易云', 'netease', search_netease),
    ('酷狗', 'kugou', search_kugou),
]

# 平台请求间隔（秒）：2600+ 次请求，适度放慢降低风控概率
GAP = 0.4


def load_rows(path):
    ws = openpyxl.load_workbook(path, data_only=True).active
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r or not r[0]:
            continue
        rows.append(((str(r[0]) or '').strip(), (str(r[1]) or '').strip() if len(r) > 1 and r[1] else ''))
    return rows


def load_done(path):
    """读已有输出，返回 {(歌名, 歌手): 行数据}，用于断点续跑。"""
    if not os.path.exists(path):
        return {}
    try:
        ws = openpyxl.load_workbook(path, data_only=True).active
        done = {}
        for r in ws.iter_rows(min_row=2, values_only=True):
            if not r or not r[0]:
                continue
            done[(str(r[0]).strip(), str(r[1]).strip() if len(r) > 1 and r[1] else '')] = list(r)
        return done
    except Exception as e:
        print(f'[续跑] 读取已有结果失败({e})，将全量重跑')
        return {}


def query(name, singer):
    """返回 {平台: (收藏量, 链接, 结论)}"""
    out = {}
    for label, code, fn in PLATFORMS:
        fav, url, concl = None, '', '未收录/无精准匹配'
        res = None
        for attempt in range(2):          # 失败重试 1 次
            try:
                res = fn(f'{name} {singer}'.strip(), 10)
                break
            except Exception as e:
                if attempt == 1:
                    print(f'   [{label}] 搜索异常: {e}')
                time.sleep(1.5 * (attempt + 1))
        if res:
            best, tag = _pick_best_for_batch(res, code, name, singer)
            if best:
                fav = best.get('collection_count')
                url = best.get('song_url', '') or ''
                if '精准匹配' in (tag or ''):
                    concl = tag
                else:
                    concl = f'存疑({tag})' if tag else '存疑'
        time.sleep(GAP)
        out[label] = (fav, url, concl)
    return out


def main():
    _load_performer_aliases()
    rows = load_rows(IN)
    rows = rows[START - 1:END]      # 分片区间（数据行号 START..END，含头含尾）
    print(f'本分片负责数据行 {START}..{min(END, len(load_rows(IN)))}（共 {len(rows)} 首）')
    done = load_done(OUT)
    print(f'输入 {len(rows)} 行；已有结果 {len(done)} 行（断点续跑）')

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '三平台收藏量'
    headers = ['歌名', '翻唱歌手']
    for label, _, _ in PLATFORMS:
        headers += [f'{label}收藏量', f'{label}链接', f'{label}匹配结论']
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor='4F6EF7')
        c.alignment = Alignment(horizontal='center', vertical='center')
    ws.freeze_panes = 'A2'

    t0 = time.time()
    for i, (name, singer) in enumerate(rows, 1):
        key = (name, singer)
        if key in done and any(done[key][j] not in (None, '') for j in (2, 5, 8)):
            ws.append(done[key])
        else:
            r = query(name, singer)
            row = [name, singer]
            for label, _, _ in PLATFORMS:
                fav, url, concl = r[label]
                row += [fav, url, concl]
            ws.append(row)
        if i % 20 == 0:
            el = time.time() - t0
            print(f'[{i}/{len(rows)}] 已用 {el/60:.1f} 分钟，预计剩余 {el/i*(len(rows)-i)/60:.1f} 分钟')
            wb.save(OUT)          # 每 20 首落盘一次
    wb.save(OUT)
    print(f'\n完成 → {OUT}  （总耗时 {(time.time()-t0)/60:.1f} 分钟）')


if __name__ == '__main__':
    main()
