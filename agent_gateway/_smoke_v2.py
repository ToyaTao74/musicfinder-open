"""P1+P2+P3 网关侧联调（单文件双模式）
- `python _smoke_v2.py agent`  : 作为模拟 Agent（被主进程 subprocess 启动）
- `python _smoke_v2.py`         : 编排：起网关 + 起 agent + dispatch + 校验
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
import websockets

BASE = os.path.dirname(os.path.abspath(__file__))
VENV = "/Users/toya/WorkBuddy/2026-07-30-11-09-35/musicfinder/venv/bin/python"
TOKEN = "demo-token-mac"
AGENT_ID = "mac-home"
PORT = os.environ.get("GATEWAY_PORT", "8765")
WS = f"ws://127.0.0.1:{PORT}/ws/agent"
HTTP = f"http://127.0.0.1:{PORT}"


async def agent_listen():
    ws = None
    for attempt in range(10):
        try:
            ws = await websockets.connect(f"{WS}?token={TOKEN}&agent_id={AGENT_ID}")
            break
        except Exception:
            if attempt == 9:
                raise
            await asyncio.sleep(1)
    await ws.send(json.dumps({"type": "agent_hello", "task_id": None, "ts": time.time(),
                              "payload": {"os": "darwin", "chrome_version": "130", "douyin_logged_in": True}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg["type"] == "task_assign":
            tid = msg["task_id"]
            print(f"[模拟Agent] 收到任务 {tid} -> {msg['payload']['song_name']}")
            boundary = "----mftest"
            body = b"--" + boundary.encode() + b'\r\nContent-Disposition: form-data; name="task_id"\r\n\r\n' + tid.encode() + b"\r\n"
            body += b"--" + boundary.encode() + b'\r\nContent-Disposition: form-data; name="file_name"\r\n\r\nev_01.png\r\n'
            body += b"--" + boundary.encode() + b'\r\nContent-Disposition: form-data; name="file"; filename="ev_01.png"\r\nContent-Type: application/octet-stream\r\n\r\n'
            body += b"FAKEPNGDATA"
            body += b"\r\n--" + boundary.encode() + b"--\r\n"
            req = urllib.request.Request(f"{HTTP}/evidence_file", data=body,
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
            with urllib.request.urlopen(req, timeout=5) as r:
                print("  上传证据文件:", r.read().decode().strip())
            await ws.send(json.dumps({"type": "task_result", "task_id": tid, "ts": time.time(),
                                      "payload": {"evidence": [{"url": "http://x", "title": "凉夜横塘",
                                                                "screenshot": "ev_01.png",
                                                                "env": {"browser": "130", "ip_type": "家庭宽带", "login_state": "有效"}}]}}))
            print("[模拟Agent] 回传完成")
            await asyncio.sleep(3)
            break
    await ws.close()


def http_post(path, obj):
    req = urllib.request.Request(f"{HTTP}{path}", data=json.dumps(obj).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.read().decode().strip()


def http_get(path):
    with urllib.request.urlopen(f"{HTTP}{path}", timeout=5) as r:
        return json.loads(r.read())


def main():
    log = open("/tmp/gw_smoke.log", "w")
    gw = subprocess.Popen([VENV, os.path.join(BASE, "server.py")], stdout=log, stderr=log)
    env = dict(os.environ, GATEWAY_PORT=PORT)
    agent = subprocess.Popen([VENV, __file__, "agent"], env=env)
    time.sleep(1.5)
    try:
        print("dispatch:", http_post("/dispatch", {"agent_id": AGENT_ID, "task_id": "SMOKE-2",
                                                    "song_name": "凉夜横塘", "platform": "douyin", "limit": 10}))
        time.sleep(2)
        st = http_get("/agents")
        ag = st["agents"].get(AGENT_ID, {})
        assert ag.get("douyin_logged_in") is True, f"登录态应为 true，实际: {ag}"
        print("=== /agents 三状态 ===", json.dumps(st, ensure_ascii=False))
        tasks = http_get("/tasks")
        t = next((x for x in tasks["tasks"] if x["task_id"] == "SMOKE-2"), {})
        assert t.get("status") == "done", f"任务状态应为 done: {t}"
        print("=== /tasks ===", json.dumps(tasks, ensure_ascii=False))
        inbox = os.path.join(BASE, "evidence_inbox")
        ev_json = os.path.exists(os.path.join(inbox, "SMOKE-2.json"))
        ev_png = os.path.exists(os.path.join(inbox, "SMOKE-2", "ev_01.png"))
        print(f"证据落地: json={ev_json} png={ev_png}")
        assert ev_json and ev_png
        print("\n✅ 联调全部通过：三状态 / 任务状态机 / 证据文件上传 均正常")
    finally:
        agent.terminate()
        gw.terminate()
        log.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "agent":
        asyncio.run(agent_listen())
    else:
        main()
