#!/bin/bash
# MusicFinder 启动脚本
cd "$(dirname "$0")"
PYTHON=/Users/toya/.workbuddy/binaries/python/envs/default/bin/python
exec "$PYTHON" app.py
