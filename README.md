# MusicFinder

跨平台音乐作品监测与版权取证工具。一次性聚合 **QQ音乐 / 网易云 / 酷狗 / 酷我 / 汽水音乐** 五大平台的歌曲数据（收藏量、词曲作者、发行公司、上下架状态），帮助音乐人、版权方与运营快速发现盗版翻唱、山寨歌手与数据异常。

> 纯本地运行的 Flask Web 应用，数据抓取自各平台公开页面，不上传任何第三方。

---

## ✨ 功能

- **五平台聚合搜索**：一首歌一次搜索，并排展示五大平台的收藏量、词曲、发行方与状态差异。
- **跨平台精准匹配**：自动归一化歌名/歌手（含别名、分隔符、多艺人组合），把同一首歌在各平台的版本聚合到一行。
- **盗版 / 翻唱识别**：歌词识别、音频指纹比对、衍生版本扫描，标记疑似盗版并记录证据。
- **歌单与红心管理**：导入平台歌单链接、浏览器登录自动抓取红心歌单，按歌维度跨平台比对。
- **批量任务**：支持「歌名 + 表演者」两级策略批量检索，进度实时可见、可断点续跑。
- **运营监控看板**：每日指标抓取、榜单上榜播报、涨幅榜、歌手监控。
- **账号与云端同步**（可选）：邀请/审批制注册、按人隔离的标记与歌单、团队共享空间。

---

## 🚀 快速开始

### 方式一：下载现成安装包（推荐普通用户）

本仓库通过 GitHub Actions 自动产出安装包：

1. 打开仓库 **Actions → Build MusicFinder**，或从最近一次成功的构建进入。
2. 在 **Artifacts** 中下载：
   - `MF-<版本>-Windows`（解压即得 `MusicFinder.exe`）
   - `MF-<版本>-Mac`（解压得 `MusicFinder.app`）
3. 双击运行，浏览器自动打开本地管理页面（默认 `http://127.0.0.1:57074`）。

> **团队免配置（除音乐平台登录态外）**：维护者若在仓库 `Settings → Secrets` 配置了 `CLOUDBASE_TOKEN` / `CLOUDBASE_URL` / `DISCOGS_TOKEN`，CI 会把这三个 Token 烤进安装包——下载后 **CloudBase 云端同步** 与 **Discogs 厂牌查询** 双击即用。而 **音乐平台的登录 Cookie（搜索/收藏量等所需）不会烤进包**，由各成员在自己机器上登录自己的音乐账号、粘贴一次 Cookie 即可（见下方「音乐平台登录」），避免把个人账号凭证散发给全队。
> 若未配置 Secrets，则安装包内不含密钥，Discogs 与云端同步需自行配置（见下文）。

### 方式二：从源码运行（开发者）

```bash
# 1. 准备 Python 3.11+ 环境
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate

# 2. 安装依赖
pip install flask openpyxl requests pypinyin pycryptodome

# 3. 启动
python app.py
# 浏览器访问 http://127.0.0.1:57074
```

### 方式三：自行打包（可选）

```bash
pip install pyinstaller
# Windows
python -m PyInstaller musicfinder_win.spec --noconfirm
# macOS
python -m PyInstaller musicfinder_mac.spec --noconfirm
```

打包配置已声明全部 `hiddenimports`（含 `Crypto`、`pypinyin`、`evidence.*`、`monitor.*`），无需额外操作。

### 维护者：生成「团队免配置」安装包

若要让团队成员下载后**无需配置即可使用 CloudBase 云端同步与 Discogs 厂牌查询**，维护者只需：

1. 进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加三个密钥（值来自你自己的 CloudBase / Discogs 后台，**不要写进代码**）：
   - `CLOUDBASE_URL`：你的 CloudBase mark-sync 地址
   - `CLOUDBASE_TOKEN`：你的 CloudBase 访问令牌
   - `DISCOGS_TOKEN`：你的 Discogs personal access token
2. 推送代码或手动触发 **Build MusicFinder**。

CI 会在打包阶段用这些 Secrets 生成临时密钥文件并烤进 `MusicFinder.exe` / `MusicFinder.app`，**源码与仓库历史始终不含任何密钥**。

> ⚠️ 安全提示：烤进安装包的 Token 对拿到安装包的人是**可提取**的。仅当分发对象可信（如内部团队）时才建议开启；若对外完全公开分发，请保持 Secrets 为空，让用户各自配置。

#### 音乐平台登录态：由各成员自行粘贴，**不烤进包**

搜索歌曲、抓取收藏量等依赖**音乐平台的登录 Cookie**。刻意**不**把它烤进安装包，原因有二：

- 它等于你的**个人音乐账号凭证**，散发给全队既泄露隐私、又让所有人共用你一个账号会话（cookie 过期/被风控会全队一起挂）；
- 团队各成员本就该用**各自的**音乐账号。

因此团队流程是：每人下载安装包后，只需在「Cookie 设置」页**登录一次自己的音乐账号并保存 Cookie**。之后搜索即正常，无需再碰配置。

> **一键浏览器登录**：点击「浏览器登录」按钮即可启用。若本机未装 Chrome、亦未缓存 Playwright Chromium，应用会**自动下载 Chromium**（约 180MB，仅首次需要约 1–2 分钟），下载完成即弹浏览器登录。本机已装 Chrome 的会自动用系统 Chrome，无需下载。

**搜索前的 Cookie 提示**：应用会在搜索歌曲前自动检测是否已配置任一平台的登录 Cookie。若检测不到，会弹出提示引导成员先到「Cookie 设置」登录，避免"搜索一直转却无结果"的困惑。已配置 Cookie 的用户不受任何影响。

> 维护者若确有"连这步也要免"的需求（如全队共用一个专用音乐账号），可临时把 Cookie 放进仓库同级的 `cookies.json` 再本地打包——但**切勿提交该文件**（已被 `.gitignore` 排除），也请知悉这会把账号凭证交给每位下载者。

---

## ⚙️ 配置（可选功能）

所有密钥均通过 **环境变量** 或 **`~/.musicfinder/config.json`** 提供，**绝不写进源码**。

| 功能 | 环境变量 | config.json 字段 |
| --- | --- | --- |
| Discogs 兜底源（厂牌信息） | `DISCOGS_TOKEN` | `discogs_token` |
| 云端同步 URL | `MUSICFINDER_CLOUDBASE_URL` | `cloudbase.url` |
| 云端同步 Token | `MUSICFINDER_CLOUDBASE_TOKEN` | `cloudbase.token` |

未配置时，相关功能自动降级（Discogs 跳过、云端同步退化为本地模式），不影响核心搜索。

示例 `~/.musicfinder/config.json`：

```json
{
  "discogs_token": "你的_Discogs_personal_access_token",
  "cloudbase": {
    "url": "https://你的环境/mark-sync",
    "token": "你的_token"
  }
}
```

---

## 🔒 安全须知（贡献者与部署者必读）

本程序会**在本地保存你的平台登录 Cookie** 以提供红心抓取等需要登录的能力。

- 请勿将 `cookies.json`、`config.py`、`*.db`、`*.log`、`.musicfinder/` 提交到任何仓库或对外分享——它们已被 `.gitignore` 排除。
- 仓库内 `config/__init__.py` **不含任何明文密钥**，默认值均为空，必须由使用者自行配置。
- 若你 fork 后自行部署，请同样避免在 CI 日志或 Issue 中泄露个人 Cookie 与 Token。

---

## 🤝 贡献

欢迎 Issue 与 PR。提交前请确保：

- 不引入任何硬编码密钥；
- 新增的懒加载（函数内 `import`）第三方库，需在 `musicfinder_*.spec` 的 `hiddenimports` 中显式声明，否则打包运行会 `ModuleNotFoundError`。

---

## 📄 许可证

[MIT](./LICENSE) © MusicFinder contributors
