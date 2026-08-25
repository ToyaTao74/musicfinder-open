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

> **团队免配置**：若维护者已在仓库 `Settings → Secrets` 配置了 `CLOUDBASE_TOKEN` / `CLOUDBASE_URL` / `DISCOGS_TOKEN`，CI 打包时会自动把团队 Token 烤进安装包——下载后双击即用，无需任何设置。
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

若要让团队成员**下载后无需任何配置**即可使用 CloudBase 云端同步与 Discogs 厂牌查询，维护者只需：

1. 进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加三个密钥（值来自你自己的 CloudBase / Discogs 后台，**不要写进代码**）：
   - `CLOUDBASE_URL`：你的 CloudBase mark-sync 地址
   - `CLOUDBASE_TOKEN`：你的 CloudBase 访问令牌
   - `DISCOGS_TOKEN`：你的 Discogs personal access token
2. 推送代码或手动触发 **Build MusicFinder**。

CI 会在打包阶段用这些 Secrets 生成临时密钥文件并烤进 `MusicFinder.exe` / `MusicFinder.app`，**源码与仓库历史始终不含任何密钥**。

> ⚠️ 安全提示：烤进安装包的 Token 对拿到安装包的人是**可提取**的。仅当分发对象可信（如内部团队）时才建议开启；若对外完全公开分发，请保持 Secrets 为空，让用户各自配置。

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
