"""
MusicFinder 抖音取证 · 云端 Agent 网关（独立轻量服务，单端口）
- 单端口同时提供：WebSocket(/ws/agent, 接收本地 Agent 长连接 Token 鉴权) + REST(/dispatch /agents /tasks /evidence_file)
- 证据回传：task_result 落地 evidence_inbox/<task_id>.json；截图/HTML 落地 evidence_inbox/<task_id>/
- 任务状态机：pending → running/waiting_human → done/failed（超时自动 failed）

Token：优先读环境变量 AGENT_TOKENS(JSON)，缺失回退本地 tokens.json（仅开发）。
单端口设计：CloudBase 容器型服务仅开放一个端口，WS 与 REST 共用。
"""
import asyncio
import json
import os
import threading
import time
from aiohttp import web, WSMsgType

WS_PORT = int(os.environ.get("PORT", os.environ.get("GATEWAY_WS_PORT", 8765)))
BASE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(BASE, "tokens.json")
INBOX = os.path.join(BASE, "evidence_inbox")
os.makedirs(INBOX, exist_ok=True)

RUNNING_TIMEOUT = 300     # 运行中无进展超时(秒)
WAITING_TIMEOUT = 600     # 等待人工超时(秒)

agents: dict = {}            # agent_id -> {"ws": ws, "status": {...}}
agents_lock = asyncio.Lock()
tasks: dict = {}             # task_id -> {agent_id, song_name, status, updated_at, ...}
tasks_lock = threading.Lock()


def load_tokens():
    env = os.environ.get("AGENT_TOKENS")
    if env:
        try:
            return json.loads(env)
        except Exception as e:
            print("[WARN] AGENT_TOKENS 解析失败，回退本地:", e)
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


TOKENS = load_tokens()


def auth(token, agent_id):
    t = TOKENS.get(token)
    if not t:
        return False, "unknown_token"
    if t.get("revoked"):
        return False, "revoked"
    if t.get("agent_id") and t["agent_id"] != agent_id:
        return False, "agent_mismatch"
    if "douyin:evidence" not in t.get("scopes", []):
        return False, "no_scope"
    return True, None


# ── WebSocket：本地 Agent 长连接 ──
async def wshandler(request):
    token = request.query.get("token")
    agent_id = request.query.get("agent_id")
    ok, reason = auth(token, agent_id)
    if not ok:
        return web.json_response({"type": "auth_error", "payload": {"reason": reason}}, status=401)
    ws = web.WebSocketResponse(heartbeat=30, timeout=60)
    await ws.prepare(request)
    async with agents_lock:
        agents[agent_id] = {"ws": ws, "status": {
            "online": True, "chrome_connected": False, "douyin_logged_in": None}}
    print(f"[+] Agent 上线: {agent_id}  device={TOKENS.get(token, {}).get('device')}")
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                await route(agent_id, json.loads(msg.data), ws)
            elif msg.type == WSMsgType.ERROR:
                break
    except Exception:
        pass
    finally:
        async with agents_lock:
            agents.pop(agent_id, None)
        print(f"[-] Agent 离线: {agent_id}")


async def route(agent_id, m, ws):
    t = m.get("type")
    p = m.get("payload", {})
    tid = m.get("task_id")
    if t == "agent_hello":
        async with agents_lock:
            agents[agent_id]["status"].update(p)
    elif t == "agent_status":
        async with agents_lock:
            agents[agent_id]["status"].update(p)
    elif t == "task_progress":
        set_task(tid, agent_id, status="running", message=p.get("message"), phase=p.get("phase"))
    elif t == "task_waiting_human":
        set_task(tid, agent_id, status="waiting_human", reason=p.get("reason"))
        print(f"    [{agent_id}] WAITING_HUMAN {p}")
    elif t == "task_result":
        set_task(tid, agent_id, status="done")
        with open(os.path.join(INBOX, f"{tid}.json"), "w", encoding="utf-8") as f:
            json.dump(p, f, ensure_ascii=False, indent=2)
        print(f"    [{agent_id}] 证据已落地 task={tid}")
    elif t == "task_failed":
        set_task(tid, agent_id, status="failed", reason=p.get("reason"), log=p.get("log"))
        print(f"    [{agent_id}] FAILED {p}")


def set_task(tid, agent_id, **kw):
    if not tid:
        return
    with tasks_lock:
        rec = tasks.setdefault(tid, {"task_id": tid, "agent_id": agent_id})
        rec.update(kw)
        rec["updated_at"] = time.time()
        if agent_id:
            rec["agent_id"] = agent_id


async def dispatch(request):
    body = await request.json()
    agent_id = body.get("agent_id")
    async with agents_lock:
        a = agents.get(agent_id)
        if not a:
            return web.json_response({"ok": False, "reason": "agent_offline"})
        ws = a["ws"]
    set_task(body.get("task_id"), agent_id, status="running",
             song_name=body.get("song_name"), platform=body.get("platform", "douyin"),
             limit=body.get("limit", 20), message="已下发")
    await ws.send_str(json.dumps({
        "type": "task_assign", "task_id": body.get("task_id"), "ts": time.time(),
        "payload": {"song_name": body["song_name"], "platform": body.get("platform", "douyin"),
                    "limit": body.get("limit", 20)}}))
    return web.json_response({"ok": True})


async def agents_handler(request):
    async with agents_lock:
        data = {k: dict(v["status"]) for k, v in agents.items()}
    return web.json_response({"ok": True, "agents": data})


async def tasks_handler(request):
    with tasks_lock:
        data = [dict(v) for v in tasks.values()]
    return web.json_response({"ok": True, "tasks": data})


async def result_handler(request):
    """v4.30.63：云端主程序轮询任务结果用——读 evidence_inbox/<task_id>.json。"""
    tid = request.match_info["task_id"]
    fp = os.path.join(INBOX, f"{tid}.json")
    if not os.path.exists(fp):
        return web.json_response({"ok": False, "reason": "not_ready"}, status=404)
    with open(fp, encoding="utf-8") as f:
        return web.json_response({"ok": True, "result": json.load(f)})


async def evidence_file_handler(request):
    reader = await request.multipart()
    tid = None
    saved = []
    while True:
        field = await reader.next()
        if field is None:
            break
        if field.name == "task_id":
            tid = await field.text()
        elif field.name == "file":
            fn = field.filename
            data = await field.read()
            d = os.path.join(INBOX, str(tid))
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, fn), "wb") as f:
                f.write(data)
            saved.append(fn)
    set_task(tid, None, status="done", has_files=True)
    return web.json_response({"ok": True, "saved": saved})


def timeout_watchdog():
    while True:
        time.sleep(30)
        now = time.time()
        with tasks_lock:
            for tid, rec in tasks.items():
                if rec.get("status") in ("pending", "running") and now - rec.get("updated_at", now) > RUNNING_TIMEOUT:
                    rec["status"] = "failed"
                    rec["reason"] = "timeout"
                    rec["updated_at"] = now
                    print(f"    [watchdog] 任务 {tid} 超时 -> failed")
                elif rec.get("status") == "waiting_human" and now - rec.get("updated_at", now) > WAITING_TIMEOUT:
                    rec["status"] = "failed"
                    rec["reason"] = "waiting_timeout"
                    rec["updated_at"] = now
                    print(f"    [watchdog] 任务 {tid} 等待人工超时 -> failed")


def main():
    threading.Thread(target=timeout_watchdog, daemon=True).start()
    app = web.Application()
    app.router.add_get("/ws/agent", wshandler)
    app.router.add_post("/dispatch", dispatch)
    app.router.add_get("/agents", agents_handler)
    app.router.add_get("/tasks", tasks_handler)
    app.router.add_get("/result/{task_id}", result_handler)
    app.router.add_post("/evidence_file", evidence_file_handler)
    print(f"网关启动(单端口): {WS_PORT}  tokens={len(TOKENS)}")
    web.run_app(app, host="0.0.0.0", port=WS_PORT)


if __name__ == "__main__":
    main()
