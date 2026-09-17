#!/bin/bash
# ══════════════════════════════════════════════════════════════
#  授权表三平台收藏量查询 —— 实时进度监控
#  用法：bash tools/batch_watch.sh
#  每 5 秒刷新一次；Ctrl+C 退出监控【不影响】后台正在跑的查询
# ══════════════════════════════════════════════════════════════
XLSX="/Users/toya/Desktop/宜昌汇报/0902 AI会/02-工具/授权表查询_三平台收藏量.xlsx"
TOTAL=869
PY=/Users/toya/WorkBuddy/2026-07-30-11-09-35/musicfinder/venv/bin/python3

while true; do
  clear
  echo "══════════════════════════════════════════════════════"
  echo "  授权表 · 三平台收藏量查询进度   $(date '+%H:%M:%S')"
  echo "══════════════════════════════════════════════════════"
  if [ -f "$XLSX" ]; then
    "$PY" - "$XLSX" "$TOTAL" <<'PY'
import sys, os, time
import openpyxl
xlsx, total = sys.argv[1], int(sys.argv[2])
try:
    ws = openpyxl.load_workbook(xlsx, data_only=True).active
except Exception as e:
    print(f'结果文件读取中…({e})'); sys.exit(0)
rows = list(ws.iter_rows(min_row=2, values_only=True))
n = len(rows)
# 列: 0歌名 1歌手 2QQ收藏 3QQ链接 4QQ结论 5网易收藏 6网易链接 7网易结论 8酷狗收藏 9酷狗链接 10酷狗结论
qq_hit = sum(1 for r in rows if r[4] and '精准' in str(r[4]))
wy_hit = sum(1 for r in rows if r[7] and '精准' in str(r[7]))
kg_hit = sum(1 for r in rows if r[10] and '精准' in str(r[10]))
miss  = sum(1 for r in rows if (not r[4] or '未收录' in str(r[4])) and (not r[7] or '未收录' in str(r[7])) and (not r[10] or '未收录' in str(r[10])))
doubt = sum(1 for r in rows if any('存疑' in str(r[i]) for i in (4, 7, 10)))
pct = n / total * 100 if total else 0
bar_n = int(pct / 4)
bar = '█' * bar_n + '░' * (25 - bar_n)
mtime = time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(xlsx)))
print(f'\n  [{bar}] {n}/{total}  ({pct:.1f}%)')
print(f'\n  QQ音乐 精准命中: {qq_hit}')
print(f'  网易云 精准命中: {wy_hit}')
print(f'  酷狗   精准命中: {kg_hit}')
print(f'  三平台全未收录: {miss}   存疑: {doubt}')
if rows:
    print(f'\n  最近落盘: {rows[-1][0]} — {rows[-1][1]}')
print(f'  数据更新于: {mtime}（每 20 首落盘一次）')
PY
  else
    echo "  结果文件尚未生成（首批 20 首完成前正常）"
  fi
  echo ""
  echo "  Ctrl+C 退出监控（不影响后台查询）；间隔 5 秒自动刷新"
  sleep 5
done
