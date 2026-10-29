# MusicFinder 抖音取证 · 云端↔本地 Agent 通信协议（已固化 v1）

> 状态：用户于 2026-10-13 确认 4 个选型，协议正式固化，不再变更。
> 选型：Agent=Node.js+Puppeteer ｜ Chrome=Agent 自起并加载用户目录 ｜ 网关=独立 CloudRun 常驻 ｜ 鉴权=每设备独立可撤销 Token（最小权限 douyin:evidence）

## 1. 连接

```
wss://<GATEWAY_HOST>/ws/agent?token=<AGENT_TOKEN>&agent_id=<本机UUID>
```
- 网关支持 `ws://`（本地调试）与 `wss://`（云端）。
- 鉴权失败：网关立即下发 `auth_error` 并关闭连接，payload `{reason}` ∈ {unknown_token, revoked, agent_mismatch, no_scope}。
- Agent 断线后指数退避重连（5s→10s→…上限 60s）。

## 2. 保活
- Agent 每 30s 发 `agent_status`（含 online/chrome_connected/douyin_logged_in）。
- 网关 ping_interval=30 / ping_timeout=60，断连即标记离线。

## 3. 消息信封
```json
{ "type": "<消息类型>", "task_id": "<任务ID|null>", "ts": <毫秒时间戳>, "payload": {} }
```

## 4. 云端 → Agent

| type | payload | 说明 |
|---|---|---|
| `task_assign` | `{song_name, platform:"douyin", limit:20}` | 下发取证任务 |
| `task_cancel` | `{}` | 取消当前任务 |

## 5. Agent → 云端

| type | payload | 说明 |
|---|---|---|
| `agent_hello` | `{os, chrome_version, douyin_logged_in}` | 连上自报家门（首包） |
| `agent_status` | `{online, chrome_connected, douyin_logged_in}` | 周期心跳 + 状态变化 |
| `task_progress` | `{phase, progress:0-100, message}` | 进度 |
| `task_waiting_human` | `{reason:"slider"\|"login_expired"}` | 需人工干预（暂停） |
| `task_result` | `{evidence:[...]}` | 完成回传 |
| `task_failed` | `{reason, log}` | 失败 |

## 6. 单条证据（evidence 元素）

```json
{
  "url": "视频链接",
  "title": "标题",
  "author": "作者",
  "collect_count": 0, "like_count": 0, "comment_count": 0, "share_count": 0,
  "screenshot": "截图文件名(存于 evidence_inbox/<task_id>/)",
  "html_snapshot": "HTML快照文件名",
  "captured_at": "ISO时间戳",
  "env": { "browser": "Chrome 130.x", "ip_type": "家庭宽带", "login_state": "有效" }
}
```

## 7. 任务状态机（云端网关侧）
```
dispatch → pending → (下发) → running
  running → progress / waiting_human → result → done
  running → failed
  waiting_human → (人工处理后 Agent 继续) → running
```
- 超时：下发后 300s 无任何 progress/waiting_human/result 上报 → 标记 failed（reason=timeout）。
- 多任务：Agent 本地队列顺序执行（busy 时入队，前一个完成取下一个）。

## 8. 云端 HTTP 接口
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/dispatch` | 下发任务 `{agent_id, task_id, song_name, platform, limit}` → `{ok, reason?}` |
| GET | `/agents` | 在线 Agent 及其三状态 `{ok, agents:{id:{...}}}` |
| GET | `/tasks` | 任务状态列表 `{ok, tasks:[{task_id, agent_id, status, ...}]}` |
| POST | `/evidence_file` | 上传截图/HTML（multipart，字段 task_id/file_name/file） |
