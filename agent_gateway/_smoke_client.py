"""P1 冒烟测试：模拟本地 Agent，验证网关端 WS 协议闭环（不依赖 puppeteer/Chrome）。"""
import asyncio
import json
import time
import websockets

GATEWAY = "ws://127.0.0.1:8765/ws/agent"
TOKEN = "demo-token-mac"
AGENT_ID = "mac-home"


async def main():
    async with websockets.connect(f"{GATEWAY}?token={TOKEN}&agent_id={AGENT_ID}") as ws:
        await ws.send(json.dumps({"type": "agent_hello", "task_id": None, "ts": time.time(),
                                  "payload": {"os": "test", "chrome_version": "x", "douyin_logged_in": None}}))
        async for raw in ws:
            msg = json.loads(raw)
            print("[模拟Agent] 收到:", msg["type"], "task=", msg.get("task_id"))
            if msg["type"] == "task_assign":
                await ws.send(json.dumps({"type": "task_progress", "task_id": msg["task_id"],
                                          "ts": time.time(), "payload": {"phase": "mock采集", "progress": 50}}))
                await ws.send(json.dumps({"type": "task_result", "task_id": msg["task_id"],
                                          "ts": time.time(),
                                          "payload": {"evidence": [{
                                              "url": "https://example.com/v/1",
                                              "title": msg["payload"]["song_name"],
                                              "author": "mock", "collect_count": 0,
                                              "like_count": 0, "comment_count": 0, "share_count": 0,
                                              "screenshot": "", "html_snapshot": "",
                                              "captured_at": time.time(), "env": {"note": "smoke"}}]}}))
                print("[模拟Agent] 回传完成，断开")
                break


asyncio.run(main())
