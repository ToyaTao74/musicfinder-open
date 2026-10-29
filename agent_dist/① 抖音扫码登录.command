#!/bin/bash
# 抖音扫码登录（双击运行）
# 弹出 Chrome 打开抖音 → 手机扫码 → 登录态保存到 Agent 专用配置，长期有效
cd /Users/toya/WorkBuddy/2026-07-30-11-09-35/musicfinder/agent
exec /usr/local/bin/node index.js --login
