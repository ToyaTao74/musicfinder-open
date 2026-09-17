#!/bin/bash
# ═══════════════════════════════════════════════════════════
# 部署前刷新云端快照（v4.30.30）
#
# 背景：CloudRun 每次发新版 = 全新实例，启动时 _init_data_from_snapshot()
# 会用镜像内 snapshot/ 里的旧库恢复 ~/.musicfinder/ —— 部署间隙在云端
# 新建的任务/证据/批量任务会被旧快照覆盖丢失（2026-09-17 #17 事故）。
#
# 用法：每次 manageCloudRun deploy 之前先跑本脚本：
#   bash tools/refresh_cloud_snapshot.sh
# 从线上实例把最新数据文件拉回部署暂存目录的 snapshot/，再触发部署。
# ═══════════════════════════════════════════════════════════
set -u

CLOUD_URL="${CLOUD_URL:-https://musicfinder-292238-8-1463776169.sh.run.tcloudbase.com}"
STG="${STG:-$HOME/.workbuddy/logs/mcp-runtime/connector_cloudbase-23ff5e2c/cloudrun}"
CFG="$HOME/.musicfinder/config.json"

TOKEN=$(python3 -c "import json;print(json.load(open('$CFG'))['cloudbase']['token'])" 2>/dev/null)
if [ -z "${TOKEN:-}" ]; then
    echo "[X] 读不到部署密钥 ($CFG 的 cloudbase.token)"; exit 1
fi

FILES="batch_v2.db monitor.db evidence.db performer_alias_suggestions.json merge_map.json douyin_state.json"
mkdir -p "$STG/snapshot"
for f in $FILES; do
    if curl -sf -m 120 "$CLOUD_URL/api/admin/db_export?name=$f&key=$TOKEN" -o "$STG/snapshot/$f"; then
        sz=$(du -h "$STG/snapshot/$f" | cut -f1)
        echo "[OK] $f ($sz)"
    else
        echo "[SKIP] $f (线上不存在或拉取失败, 保留旧快照)"
    fi
done
echo "快照刷新完成 -> $STG/snapshot"
# 三个 .db 全部缺失/为空视为异常（服务没起或密钥不对），非 0 退出阻止部署
db_ok=0
for f in batch_v2.db monitor.db evidence.db; do
    if [ -s "$STG/snapshot/$f" ]; then db_ok=$((db_ok+1)); fi
done
if [ "$db_ok" -eq 0 ]; then
    echo "[X] 三个数据库全部拉取失败，禁止部署，请人工检查"
    exit 1
fi
exit 0
