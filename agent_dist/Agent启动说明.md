# 抖音取证 · 本地 Agent 启动说明（v4.30.62 傻瓜版）

## 这是什么（一句话原理）

云端网站负责「下任务 + 看结果」，真正去抖音搜歌、截图取证的是**你每台电脑上的一个小助手（Agent）**。
小助手会自动开 Chrome → 连云端 → 等任务 → 搜抖音 → 把证据传回云端。

> 为什么必须这样：抖音反爬只认「真实设备 + 真实浏览器 + 真实 IP」。
> 你自己的电脑是最理想的取证环境，云端容器反而风险高。

---

## Mac（家里这台）：已经全部配好，你只需要做一件事

✅ 已完成的（不用管）：
- Agent 已做成**开机自启常驻服务**（launchd 托管，崩溃自动拉起，重启电脑也自动恢复）
- 浏览器改用**专用配置**（`~/.musicfinder/chrome-agent-profile`），和你日常用的 Chrome 互不打架
- 日志在 `~/.musicfinder/logs/agent.log`

🙋 你要做的唯一一件事（首次，一次性）：
**双击桌面上的「① 抖音扫码登录」** → 弹出 Chrome → 用手机抖音 App 扫码 → 提示登录成功后窗口自动关闭。
登录态长期有效，以后不用再扫。

改完代码要重启 Agent 时（开发场景）：
```bash
launchctl kickstart -k gui/$(id -u)/com.musicfinder.agent
```

---

## Windows（书房那台）：一键启动

1. 把 `musicfinder/agent` 文件夹整个拷到 Windows 电脑
2. 双击文件夹里的「启动Agent.bat」（内容见下）——自动装依赖并启动
3. 首次同样需要扫码：首次跑任务弹出的浏览器里扫码一次即可，或运行 `node index.js --login`

**启动Agent.bat**（放 agent 文件夹里，双击即用）：
```bat
@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
set GATEWAY_WS=wss://agent-gateway-292238-8-1463776169.sh.run.tcloudbase.com/ws/agent
set GATEWAY_HTTP=https://agent-gateway-292238-8-1463776169.sh.run.tcloudbase.com
set AGENT_TOKEN=demo-token-win
set AGENT_ID=win-study
node index.js
pause
```

**开机自启（可选）**：按 `Win + R` 输入 `shell:startup` 回车，把「启动Agent.bat」的快捷方式放进去。
注意：开机自启方式没有命令行窗口，首次排除问题时还是双击 bat 直接跑更直观。

---

## 怎么算成功？（指示灯）

打开云端网站 → 证据监测台，顶部指示灯（15 秒自动刷新）：

| 灯 | 含义 | 正常状态 |
|---|---|---|
| 网关可达 | 云端中转站正常 | 常绿（服务器侧） |
| Agent 在线 | 你电脑的小助手连上了 | Agent 启动后变绿 |
| Chrome 已连 | 浏览器被助手接管 | 跑任务时变绿（空闲时灰是正常的） |
| 抖音已登录 | Agent 每 15 分钟自动探测本机登录态 | 扫码一次后变绿 |

**前三绿 + 抖音灯绿 = 完全就绪。** 抖音灯如果显示未登录，双击「① 抖音扫码登录」即可。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 提示抖音未登录 | 双击「① 抖音扫码登录」，手机扫码一次（长期有效） |
| 跑任务时弹浏览器卡在滑块 | 手动拖过去即可，Agent 会等最长 5 分钟 |
| Windows 报 `'node' 不是内部或外部命令` | 从 https://nodejs.org 装 LTS 版后重开窗口 |
| Chrome 找不到 | 设置环境变量 CHROME_PATH 指向 chrome.exe |
| 断网/重启 | Mac 版自动重连+开机自启；Windows 版双击 bat 再开 |
| 停止 Mac 常驻服务 | `launchctl bootout gui/$(id -u)/com.musicfinder.agent` |

---

## 设备 token 对照（已配好）

| 设备 | AGENT_TOKEN | AGENT_ID |
|---|---|---|
| Mac（家里这台） | demo-token-mac | mac-home |
| Windows（书房） | demo-token-win | win-study |
