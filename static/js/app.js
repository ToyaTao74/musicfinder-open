/* ═══════════════════════════════════════════════
   MusicFinder v3 — Frontend Logic
   ═══════════════════════════════════════════════ */

// ── 平台配置 ──
const PLATFORM_COLORS = {
    qq:      { accent: '#31c27c', soft: 'rgba(49,194,124,0.12)' },
    kugou:   { accent: '#2ca2f9', soft: 'rgba(44,162,249,0.12)' },
    kuwo:    { accent: '#ff9a00', soft: 'rgba(255,154,0,0.12)' },
    netease: { accent: '#e60026', soft: 'rgba(230,0,38,0.12)' },
    qishui:  { accent: '#00d4d4', soft: 'rgba(0,212,212,0.12)' },
};

const PLATFORM_NAMES = {
    qq: 'QQ音乐', kugou: '酷狗音乐', kuwo: '酷我音乐', netease: '网易云音乐', qishui: '汽水音乐',
};

// 平台简称（用于单元格品牌头部 / 骨架屏，避免全名过长挤占列宽）
function shortPlatformName(code) {
    return ({ qq: 'QQ', kugou: '酷狗', kuwo: '酷我', netease: '网易', qishui: '汽水' })[code] || code;
}

const PLATFORM_ORDER = ['qq', 'kugou', 'kuwo', 'netease', 'qishui'];

// 各平台红心徽章样式（与后端 HEART_PLATFORMS 对应，先上 QQ）
const HEART_META = {
    qq: { name: 'QQ音乐', badge: 'Q音红心', cls: 'qq' },
    netease: { name: '网易云', badge: '云村红心', cls: 'netease' },
    kugou: { name: '酷狗', badge: '酷狗红心', cls: 'kugou' },
    kuwo: { name: '酷我', badge: '酷我红心', cls: 'kuwo' },
    qishui: { name: '汽水', badge: '汽水红心', cls: 'qishui' },
};

const PLATFORM_COOKIE_HELP = {
    qq: '从 y.qq.com 获取',
    kugou: '从 kugou.com 获取',
    kuwo: '从 kuwo.cn 获取',
    netease: '从 music.163.com 获取',
    qishui: '从 douyin.com 获取',
};

// 配置登录态后"可能"解锁的计数类数据（部分平台接口即便登录也受限）
const PLATFORM_COOKIE_UNLOCKS = {
    qq: '播放/收藏量（接口需签名，可能受限）',
    kugou: '播放/收藏量（接口已限制访问）',
    kuwo: '收藏量 / 播放量 / 评论 / 唱片公司',
    netease: '播放量 / 收藏量 / 唱片公司',
    qishui: '使用次数（收藏）',
};

// ── 本地 Cookie 存储（per-device，每台设备独立）──
const CLIENT_COOKIE_KEY = 'musicfinder_cookies_v2';

function loadClientCookies() {
    try {
        const raw = localStorage.getItem(CLIENT_COOKIE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (e) {
        console.error('load client cookies error', e);
        return {};
    }
}

function saveClientCookies(cookies) {
    localStorage.setItem(CLIENT_COOKIE_KEY, JSON.stringify(cookies || {}));
}

function setClientCookie(platform, value) {
    const cookies = loadClientCookies();
    if (value && value.trim()) {
        cookies[platform] = value.trim();
    } else {
        delete cookies[platform];
    }
    saveClientCookies(cookies);
}

function getClientCookiesForRequest() {
    return loadClientCookies();
}

// 运行环境信息（由 /api/env 填充）
let APP_ENV = { show_browser_login: false, playwright_available: false, login_home: {}, _loaded: false };

async function loadAppEnv() {
    try {
        const resp = await fetch('/api/env');
        if (resp.ok) {
            APP_ENV = await resp.json();
            APP_ENV._loaded = true;
        }
    } catch (e) {
        console.error('load env error', e);
    }
}

// ── DOM ──
const $ = (sel) => document.querySelector(sel);
const songNameInput = $('#songName');
const lyricistInput = $('#lyricist');
const composerInput = $('#composer');
const performerInput = $('#performer');
const searchBtn = $('#searchBtn');
const resultsSection = $('#resultsSection');
// v2 表格回归：优先取模板里的 #resultsBody；旧模板（容器仍是卡片 div）时动态构建表格头兜底
function ensureResultsTable() {
    let tb = document.getElementById('resultsBody');
    if (tb) return tb;
    const wrap = document.getElementById('tableWrap');
    if (!wrap) return null;
    const old = document.getElementById('resultsCards');
    if (old) old.remove();
    const tbl = document.createElement('table');
    tbl.className = 'results-table grouped';
    tbl.id = 'resultsTable';
    tbl.innerHTML =
        '<colgroup>' +
        '<col class="col-song"><col class="col-artist"><col class="col-album"><col class="col-release">' +
        '<col class="col-lyricist"><col class="col-composer"><col class="col-source"><col class="col-mark">' +
        '<col class="col-platform"><col class="col-platform"><col class="col-platform"><col class="col-platform"><col class="col-platform">' +
        '</colgroup>' +
        '<thead><tr>' +
        '<th class="th-song sortable" data-sort="song_name">歌曲名</th>' +
        '<th class="th-artist sortable" data-sort="performer">歌手</th>' +
        '<th class="th-album sortable" data-sort="album">专辑</th>' +
        '<th class="th-release sortable" data-sort="release_date">发行时间</th>' +
        '<th class="th-lyricist sortable" data-sort="lyricist">词作者</th>' +
        '<th class="th-composer sortable" data-sort="composer">曲作者</th>' +
        '<th class="th-source">匹配来源</th>' +
        '<th class="th-mark">标记</th>' +
        '<th class="th-platform" data-code="qq"><span class="plat-th-dot" style="background:#31c27c"></span>Q音</th>' +
        '<th class="th-platform" data-code="kugou"><span class="plat-th-dot" style="background:#2ca2f9"></span>酷狗</th>' +
        '<th class="th-platform" data-code="kuwo"><span class="plat-th-dot" style="background:#ff9a00"></span>酷我</th>' +
        '<th class="th-platform" data-code="netease"><span class="plat-th-dot" style="background:#e60026"></span>网易</th>' +
        '<th class="th-platform" data-code="qishui"><span class="plat-th-dot" style="background:#00d4d4"></span>汽水</th>' +
        '</tr></thead>' +
        '<tbody id="resultsBody"></tbody>';
    wrap.insertBefore(tbl, wrap.firstChild);
    return document.getElementById('resultsBody');
}
const resultsBody = ensureResultsTable();
const toast = $('#toast');
const themeToggle = $('#themeToggle');

let allResults = [];          // 聚合后的歌曲行
let flatResults = [];         // 原始平台行（用于导出/统计）
let irrelevantResults = [];   // v4.23：被折叠的「完全无匹配」结果（兜底推荐），默认不展示
let irrelevantExpanded = false; // 用户是否展开了"低相关结果"
let activeFilter = 'all';
let markOnly = false;        // 只看已标记
let heartOnly = false;        // 只看红心
let piracyFilter = 'all';     // 盗版筛选：all | suspect | unprocessed | processed
let perPlatformLimit = 30;
let currentSort = { key: 'collection_count', dir: 'desc' };
let sortScope = 'max';   // 'max' 或平台 code（仅对「收藏量/在听/评论」这类多平台计数有意义）
let selectedMergeKeys = new Set();   // v4.22：当前勾选参与合并的歌曲 mark_key 集合

// 可排序列定义：num 按数值、text 按中文 localeCompare；agg 表示聚合指标（各平台各一个值）
const SORTABLE = {
    match_score:  { type: 'num' },
    platform_count:{ type: 'num' },
    song_name:    { type: 'text' },
    performer:    { type: 'text' },
    album:        { type: 'text' },
    release_date: { type: 'text' },
    lyricist:     { type: 'text' },
    composer:     { type: 'text' },
    record_label: { type: 'text' },
    collection_count: { type: 'num', agg: true },
    listening_count:  { type: 'num', agg: true },
    comment_count:    { type: 'num', agg: true },
};

// 列宽已改为自适应布局，不再使用固定列宽/拖拽
let _suppressSort = false;

// ── 主题切换（light / dark / system 三态循环）──
// data-theme 存「解析后的实际配色」（light/dark，供 CSS 用）；
// data-theme-mode 存「用户意图」（light/dark/system，供图标与逻辑用）。
const _themeMq = window.matchMedia('(prefers-color-scheme: dark)');
function _resolveTheme(mode) {
    if (mode === 'system') return _themeMq.matches ? 'dark' : 'light';
    return mode; // 'light' | 'dark'
}
function _applyTheme(mode) {
    mode = mode || 'system';
    const resolved = _resolveTheme(mode);
    const html = document.documentElement;
    html.setAttribute('data-theme', resolved);
    html.setAttribute('data-theme-mode', mode);
    localStorage.setItem('theme', mode);
    themeToggle.title = '当前主题：' + (mode === 'system' ? '跟随系统' : (mode === 'dark' ? '暗色' : '亮色'));
}
// v4.27.12：只两态切换 light ↔ dark（去掉旧的 system→light 中转）。
// 默认值仍可保留 system（用户首次访问时不强行覆盖系统偏好），但点过按钮后
// 不再回到 system —— 用户反馈「电脑图标是啥意思」，system 状态已用图标表达不清。
themeToggle.addEventListener('click', () => {
    const mode = document.documentElement.getAttribute('data-theme-mode') || 'light';
    const next = mode === 'dark' ? 'light' : 'dark';
    _applyTheme(next);
});
// 初始化：默认跟随系统（首屏即贴合用户系统配色）
_applyTheme(localStorage.getItem('theme') || 'system');
// system 态下，系统配色变化时实时跟随
_themeMq.addEventListener('change', () => {
    if ((document.documentElement.getAttribute('data-theme-mode') || 'system') === 'system') {
        _applyTheme('system');
    }
});

// ── 标签页切换 ──
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        // 外部跳转链接（如音频自检页入口）直接放行，不做页内切换
        if (btn.tagName === 'A') return;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const tabId = btn.getAttribute('data-tab');
        document.getElementById('tab-' + tabId).classList.add('active');
        // 切换到设置页时加载 Cookie；切换到红心管理页时渲染各平台卡片
        if (tabId === 'settings') loadCookies();
        if (tabId === 'hearts') renderHeartsPage();
        if (tabId === 'marks') loadMarksPage();
        if (tabId === 'playlist') loadPlaylistPage();
        if (tabId === 'monitor' && window.loadMonitorPage) window.loadMonitorPage();
        if (tabId === 'report' && window.loadReportPage) window.loadReportPage();
        if (tabId === 'evidence' && window.loadEvidencePage) window.loadEvidencePage();
    });
});

// ── 默认标签页兜底：音乐搜索是「我的第一页」──
// 服务端 HTML 已经把 search 标为 .active；如果页面初始状态丢失（例如旧的 SPA 缓存
// 渲染），强制回退到「音乐搜索」，避免打开后跳到陌生标签页。
(function enforceDefaultTab() {
    function isAnyActive() {
        return document.querySelector('.tab-btn.active') && document.querySelector('.tab-content.active');
    }
    if (isAnyActive()) return;  // 正常情况：HTML 默认 search 标签已 active
    const searchBtn = document.querySelector('.tab-btn[data-tab="search"]');
    if (searchBtn) searchBtn.click();
})();

// ── v4：标记同步状态指示 ──
(function updateSyncBadge(){
    fetch('/api/env').then(r=>r.json()).then(d=>{
        const badge=document.getElementById('syncBadge');
        const txt=document.getElementById('syncText');
        if(!badge||!txt)return;
        if(d.marks_backend==='cloudbase'){
            txt.textContent='标记·全网同步';
            badge.classList.add('synced');
        }else{
            txt.textContent='标记·仅本机';
            badge.classList.remove('synced');
        }
    }).catch(()=>{});
})();

// ── 每平台数量选择器 ──
document.querySelectorAll('.limit-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('.limit-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        perPlatformLimit = parseInt(chip.getAttribute('data-limit'));
    });
});

// ── 搜索模式切换：歌名 / 歌词 ──
let searchMode = 'song'; // 'song' | 'lyric'
const searchHeroTitle = document.getElementById('searchHeroTitle');
const searchHeroSub = document.getElementById('searchHeroSub');
const searchModeTabs = document.getElementById('searchModeTabs');

function setSearchMode(mode) {
    searchMode = mode;
    if (!searchModeTabs) return;
    searchModeTabs.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.getAttribute('data-mode') === mode));
    document.querySelectorAll('.mode-panel').forEach(p => {
        const active = p.getAttribute('data-mode') === mode;
        p.classList.toggle('active', active);
        p.style.display = active ? 'block' : 'none';
    });
    if (searchHeroTitle) {
        const titles = { song: '多平台音乐搜索', lyric: '歌词段落识别歌曲' };
        searchHeroTitle.textContent = titles[mode] || titles.song;
    }
    if (searchHeroSub) {
        const subs = {
            song: '以歌名为核心匹配，一键聚合 QQ音乐 · 酷狗 · 酷我 · 网易云 · 汽水音乐',
            lyric: '粘贴一段段歌词，自动反查所有相关版本——正版、翻唱、盗版一起列出来',
        };
        searchHeroSub.textContent = subs[mode] || subs.song;
    }
}

if (searchModeTabs) {
    searchModeTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.mode-tab');
        if (!tab) return;
        setSearchMode(tab.getAttribute('data-mode'));
    });
}

// ── 搜索 ──
// v4.27.8：搜索实际要 15~40 秒（5 平台并发 + 每首歌详情补全），以前按钮只写「约 15 秒」且全程黑盒，
// 用户等不到就刷新 → 触发 catch 的「搜索失败」toast。现在：① 进度横幅持续反馈 ② 按钮文案诚实
// ③ 用户可主动取消(AbortController) ④ 超时/错误区分具体原因，不再一律「检查网络」。
let _searchAbort = null;
let _searchProgressTimer = null;
let _searchProgressSid = null;   // v4.27.34：本次搜索的进度标识（与后端 /api/search_progress 对应）

// v4.27.34：把后端进度快照渲染成一句人话。
// stage：search=各平台抓取中 / enrich=补全词曲发行方等详情 / group=评分聚合 / done=收尾
function _fmtSearchProgress(p) {
    const total = p.total || 0;
    const detail = (p.platforms || [])
        .filter(x => x.count > 0)
        .slice(0, 5)
        .map(x => x.platform + ' ' + x.count)
        .join(' · ');
    if (p.stage === 'search') {
        const head = '已抓到 ' + total + ' 条'
            + (p.total_tasks ? '（平台任务 ' + p.done_tasks + '/' + p.total_tasks + '）' : '');
        return head + (detail ? '：' + detail : '') + ' · 正在抓取剩余平台…';
    }
    // unique = 去重后条数（补全/聚合阶段才有）；没有就退回原始累加值
    const shown = p.unique ? ('去重后 ' + p.unique + ' 条') : ('已抓到 ' + total + ' 条');
    if (p.stage === 'enrich') {
        return shown + (detail ? '（' + detail + '）' : '')
            + ' · 正在补全词曲作者 / 发行方 / 收藏量详情（前 100 条）…';
    }
    if (p.stage === 'group') {
        return shown + ' · 正在评分并跨平台聚合成同一首歌…';
    }
    return shown + ' · 正在生成结果…';
}

// ── 搜索前 Cookie 检测（v4.28.x）：未配置任何平台登录态时，提示用户先去登录 ──
async function _ensureSearchCookies() {
    // 返回 true=允许继续搜索；false=用户选择去登录（应放弃本次搜索）
    try {
        const resp = await fetch('/api/cookies');
        if (!resp.ok) return true;            // 接口异常不拦搜索，避免误伤
        const data = await resp.json();
        const cookies = (data && data.cookies) || {};
        const hasAny = Object.values(cookies).some(c => c && c.has_cookie);
        if (hasAny) return true;              // 已有任一平台 Cookie，放行
        return await _showCookieLoginModal();
    } catch (e) {
        return true;                          // 异常兜底放行
    }
}

function _showCookieLoginModal() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99998;display:flex;align-items:center;justify-content:center;padding:16px;';
        overlay.innerHTML = `
          <div style="background:#fff;max-width:460px;width:100%;border-radius:14px;padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,.25);font-family:system-ui,-apple-system,sans-serif;">
            <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:8px;">需要先登录音乐平台</div>
            <div style="font-size:14px;color:#444;line-height:1.6;margin-bottom:6px;">
              搜索歌曲、抓取收藏量等依赖<b>音乐平台的登录 Cookie</b>。当前尚未配置任何平台的 Cookie，搜索可能无结果或数据不全。
            </div>
            <div style="font-size:13px;color:#666;line-height:1.6;margin-bottom:16px;">
              请先到「Cookie 设置」页，点各平台的「浏览器登录」或手动粘贴你的登录 Cookie 并保存。配置好后回来重新搜索即可。
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
              <button id="mfCookieCancel" style="padding:9px 16px;border:1px solid #ccc;background:#f5f5f5;border-radius:8px;cursor:pointer;font-size:14px;">仍要搜索</button>
              <button id="mfCookieGo" style="padding:9px 16px;border:none;background:#16a34a;color:#fff;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;">去 Cookie 设置</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        const close = (proceed) => { overlay.remove(); resolve(proceed); };
        overlay.querySelector('#mfCookieGo').addEventListener('click', () => {
            close(false);
            const tab = document.querySelector('.tab-btn[data-tab="settings"]');
            if (tab) tab.click();
        });
        overlay.querySelector('#mfCookieCancel').addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(true); });
    });
}

async function doSearch() {
    // 搜索前先确认已配置音乐平台 Cookie，否则引导去登录（不阻塞已有 Cookie 的用户）
    if (!(await _ensureSearchCookies())) return;

    if (searchMode === 'lyric') return doLyricSearch();

    const songName = songNameInput.value.trim();
    const lyricist = lyricistInput.value.trim();
    const composer = composerInput.value.trim();
    const performer = performerInput.value.trim();

    if (!songName) {
        showToast('请输入歌曲名称', 'error');
        songNameInput.focus();
        return;
    }

    // ── 进入「搜索中」状态 ──
    searchBtn.disabled = true;
    searchBtn.innerHTML = '<div class="btn-spinner"></div><span>搜索中…</span>';
    setPlatformStripSearching();
    showTableSkeleton();

    // 进度横幅：让用户知道在跑、还要等多久，避免黑盒误以为失败
    const spEl = document.getElementById('searchProgress');
    const spTimerEl = document.getElementById('searchProgressTimer');
    const spSubEl = document.getElementById('searchProgressSub');
    if (spEl) spEl.hidden = false;
    if (spSubEl) spSubEl.textContent = '正在连接各平台…（每平台 ' + perPlatformLimit + ' 条，请勿刷新页面）';
    let waited = 0;
    // v4.27.34：真实进度。搜索是一次性 POST，选 100/500 时要跑 40~90 秒，只显示「已等待 N 秒」
    // 用户分不清还在跑还是卡死。这里给本次搜索生成 search_id 随请求发出，再每秒轮询
    // /api/search_progress 读后端打点（各平台已抓到多少条 / 当前阶段），把黑盒变成可见进度。
    _searchProgressSid = 'sc' + Date.now() + Math.random().toString(36).slice(2, 8);
    const _sid = _searchProgressSid;
    let _pollBusy = false;   // 防重入：慢响应时不叠加请求
    if (_searchProgressTimer) clearInterval(_searchProgressTimer);
    _searchProgressTimer = setInterval(() => {
        waited++;
        if (spTimerEl) spTimerEl.textContent = '已等待 ' + waited + ' 秒';
        if (_pollBusy) return;
        _pollBusy = true;
        fetch('/api/search_progress?sid=' + encodeURIComponent(_sid))
            .then(r => r.json())
            .then(p => {
                _pollBusy = false;
                // 搜索已收尾 / 换了一次新搜索 → 不再覆盖文案
                if (_searchProgressSid !== _sid || !spSubEl) return;
                if (!p || !p.found) return;   // 还没进 search_all，保持「正在连接各平台…」
                spSubEl.textContent = _fmtSearchProgress(p);
            })
            .catch(() => { _pollBusy = false; });
    }, 1000);

    // AbortController：用户可主动取消
    _searchAbort = new AbortController();

    // 软超时：120 秒仍没返回才提示（比真实耗时 40s 留足余量；v4.27.31 把阈值放宽松
    // 到 120 秒，匹配后端 _fetch_qq_details 等详情补全的最坏耗时，避免某平台抽风时误报
    // 「超时失败」）。注意：超时不清理 UI（横幅继续转、按钮仍 disabled、abort 仍可用），
    // 让用户能点「取消搜索」，等真实 fetch 返回时再由 _cleanupSearchUI 统一收尾，避免竞态。
    // v4.27.33：软超时 120s → 150s，且文案去掉「减小每平台上限」的误导（用户现在就是要大数量），
    // 改为「每平台大数量搜索 + 补全详情中」，偶发抽风仍提示可取消重试。
    const searchTimeoutMs = 150000;
    let timedOut = false;
    // v4.27.34：超时不再改横幅副标题——那里现在是每秒刷新的真实进度（更有用），
    // 只弹一条 toast 提示「可取消重试」。
    const timeoutTimer = setTimeout(() => {
        timedOut = true;
        showToast('搜索较多结果（每平台 ' + perPlatformLimit + ' 条并补全详情）中，已等待 150 秒；横幅里可看到实时进度，如某平台抽风可点「取消搜索」重试', 'error', 6000);
    }, searchTimeoutMs);

    try {
        const resp = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                song_name: songName,
                lyricist: lyricist,
                composer: composer,
                performer: performer,
                limit: perPlatformLimit,
                search_id: _searchProgressSid,
                cookies: getClientCookiesForRequest(),
            }),
            signal: _searchAbort.signal,
        });
        clearTimeout(timeoutTimer);
        // v4.27.34：超时只是「提示等久了」，结果回来照常渲染。
        // 旧代码这里 `if (timedOut) return;` 直接吞掉了结果，导致一旦超过软超时，
        // 即使后端成功返回，横幅也一直转、搜索按钮永久 disabled（界面假死）。
        const data = await resp.json();

        if (data.error) {
            _cleanupSearchUI();
            showToast(data.error, 'error');
            hideResults();
            return;
        }

        flatResults = data.results || [];
        // ⚠️ 坑：后端可能返回 grouped_results: []（空数组）。空数组在 JS 里是 truthy，
        // 直接 `data.grouped_results || data.results` 会取到 []，导致 allResults 为空 → 渲染 0 行
        // → 用户看到「搜索不显示」。必须按「非空数组」判断，空了就回退到 flat results。
        const grouped = Array.isArray(data.grouped_results) && data.grouped_results.length
            ? data.grouped_results
            : (Array.isArray(data.results) ? data.results : []);
        allResults = grouped.map(r => ({ ...r, _match_source: 'song' }));
        // v4.23：保存被折叠的「无匹配」结果 + 重置展开状态
        irrelevantResults = data.filtered_irrelevant || [];
        window._filteredIrrelevantTotal = data.filtered_irrelevant_count || irrelevantResults.length;
        irrelevantExpanded = false;
        updatePlatformStrip(data.platform_stats || []);
        renderWarnings(data.warnings || []);
        renderResults();
        updateFilterCounts();
        renderIrrelevantFooter();
        _cleanupSearchUI();
        // v4.25.1：首次搜出 ≥2 首歌时弹一条提示，告诉用户「左边那个『合并』方框」是干啥的
        if (allResults.length >= 2 && !sessionStorage.getItem('merge_hint_shown')) {
            sessionStorage.setItem('merge_hint_shown', '1');
            showToast('💡 每首歌左边的「合并」方框，勾上 2 首以上 → 顶部出现「合并为同一首」按钮', 'info');
        }
    } catch (err) {
        clearTimeout(timeoutTimer);
        // v4.27.34：同上，超时后出错也要收尾 UI（旧代码 return 掉会让按钮永久 disabled）
        _cleanupSearchUI();
        console.error('Search error:', err);
        // 区分错误原因，不再一律「检查网络连接」
        if (err && err.name === 'AbortError') {
            showToast('已取消搜索', 'info');
        } else if (err instanceof TypeError) {
            // fetch 失败通常是网络层（CORS/断网/服务挂）
            showToast('搜索请求发送失败，请检查网络或服务是否在线', 'error');
        } else {
            showToast('搜索出错：' + (err && err.message ? err.message : '未知错误'), 'error');
        }
        hideResults();
    }
}

// 统一清理搜索中的 UI 状态（按钮/进度横幅/定时器）
function _cleanupSearchUI() {
    if (_searchProgressTimer) { clearInterval(_searchProgressTimer); _searchProgressTimer = null; }
    _searchProgressSid = null;   // v4.27.34：停轮询 + 让在途的轮询回调不再写 UI
    const spEl = document.getElementById('searchProgress');
    if (spEl) spEl.hidden = true;
    if (_searchAbort) { try { _searchAbort = null; } catch (_) {} }
    searchBtn.disabled = false;
    searchBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>搜索</span>`;
}

searchBtn.addEventListener('click', doSearch);

// v4.27.8：搜索中可主动取消（AbortController 中断 fetch）
const searchCancelBtn = document.getElementById('searchCancelBtn');
if (searchCancelBtn) {
    searchCancelBtn.addEventListener('click', () => {
        if (_searchAbort) {
            _searchAbort.abort();
            _searchAbort = null;
        }
        _cleanupSearchUI();
        showToast('已取消搜索', 'info');
    });
}

// ── v4.26.4b：一键重置搜索表单（清空 4 个 input + 还原 limit=100）──
function resetSearchForm() {
    if (songNameInput) songNameInput.value = '';
    if (lyricistInput)  lyricistInput.value  = '';
    if (composerInput)  composerInput.value  = '';
    if (performerInput) performerInput.value = '';
    // 重置每平台上限为默认 100
    perPlatformLimit = 100;
    document.querySelectorAll('.limit-chip').forEach(b => {
        b.classList.toggle('active', String(b.dataset.limit) === '100');
    });
    // 清空链接直查 input + 消息
    const urlInput = document.getElementById('songUrl');
    const urlMsg   = document.getElementById('lookupUrlMsg');
    if (urlInput) urlInput.value = '';
    if (urlMsg)   { urlMsg.textContent = ''; urlMsg.className = 'url-lookup-msg'; }
    // 隐藏结果区 + 回到空状态
    hideResults();
    document.getElementById('emptyState').style.display = '';
    // 聚焦歌名框
    if (songNameInput) songNameInput.focus();
    showToast('已重置搜索条件', 'success');
}
const resetBtn = document.getElementById('resetSearchBtn');
if (resetBtn) resetBtn.addEventListener('click', resetSearchForm);

// ── v4.22 歌曲手动合并（同一首歌因艺名写法不同被拆成多条时合并为一首）──
function updateMergeBar() {
    const bar = $('#mergeActionBar');
    if (!bar) return;
    const n = selectedMergeKeys.size;
    $('#mergeSelCount').textContent = '已选 ' + n + ' 首';
    bar.style.display = n >= 2 ? 'flex' : 'none';
    const btn = $('#mergeSelectedBtn');
    if (btn) btn.disabled = n < 2;
}

function onMergeChkChange(chk) {
    const k = chk.dataset.mkey;
    if (!k) return;
    if (chk.checked) selectedMergeKeys.add(k);
    else selectedMergeKeys.delete(k);
    updateMergeBar();
}

function clearMergeSel() {
    selectedMergeKeys.clear();
    document.querySelectorAll('.merge-chk:checked').forEach(c => { c.checked = false; });
    updateMergeBar();
}

function openMergeModal() {
    const items = allResults.filter(g => selectedMergeKeys.has(g.mark_key));
    if (items.length < 2) return;
    const list = $('#mergeModalList');
    list.innerHTML = items.map((g, idx) =>
        '<label class="merge-primary-opt">' +
        '<input type="radio" name="mergePrimary" value="' + escapeAttr(g.mark_key || '') + '"' + (idx === 0 ? ' checked' : '') + '>' +
        '<span class="merge-primary-name">' + escapeHtml(g.song_name || '') + ' - ' + escapeHtml(g.performer || '') + '</span>' +
        '</label>'
    ).join('');
    // v4.25.6：默认选中第一项 → 给对应 <label> 加 .is-checked 类（兼容 :has() 不支持的浏览器）
    _refreshMergeCheckedClass();
    // 选项切换时实时刷新高亮
    list.querySelectorAll('input[name="mergePrimary"]').forEach(r => {
        r.addEventListener('change', _refreshMergeCheckedClass);
    });
    $('#mergeModal').style.display = 'flex';
}

// v4.25.6：根据当前选中的 radio 给对应 .merge-primary-opt 加 .is-checked（CSS :has() 兜底）
function _refreshMergeCheckedClass() {
    const list = document.getElementById('mergeModalList');
    if (!list) return;
    list.querySelectorAll('.merge-primary-opt').forEach(opt => {
        const radio = opt.querySelector('input[type="radio"]');
        opt.classList.toggle('is-checked', !!(radio && radio.checked));
    });
}

async function confirmMerge() {
    const prim = document.querySelector('input[name="mergePrimary"]:checked');
    if (!prim) return;
    const canonical = prim.value;
    const aliases = [...selectedMergeKeys].filter(k => k !== canonical);
    if (!aliases.length) { $('#mergeModal').style.display = 'none'; return; }
    $('#mergeModal').style.display = 'none';
    try {
        const r = await fetch('/api/merge_songs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canonical_key: canonical, alias_keys: aliases }),
        });
        const j = await r.json();
        if (!j.ok) { alert('合并失败：' + (j.msg || '未知错误')); return; }
        clearMergeSel();
        // v4.25.6：本地乐观合并 —— 避免每次合并后整页重搜，瞬时完成、不闪屏、不重排
        _applyLocalMerge(canonical, aliases);
    } catch (e) {
        alert('合并请求失败：' + e);
    }
}

async function doUnmerge(key) {
    if (!key) return;
    if (!confirm('确定拆分这首合并歌？拆分后各平台恢复为独立记录（标记保留为正主）。')) return;
    showToast('正在拆分…', 'info');
    try {
        const r = await fetch('/api/unmerge_songs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ canonical_key: key }),
        });
        const j = await r.json();
        if (!j.ok) { alert('拆分失败：' + (j.msg || '未知')); return; }
        // 拆分是破坏性操作，需要从服务端拿全量 alias 列表+快照重建行 → 必须重搜
        await doSearch();
    } catch (e) {
        alert('拆分请求失败：' + e);
    }
}

// v4.25.6：合并后本地即时合并（不发请求、瞬时完成）
// 语义与后端 _do_merge 保持一致：以 canonical（正主）为准，alias 行的 platform_data 仅补 canonical 没有的平台
function _applyLocalMerge(canonical, aliases) {
    const aliasSet = new Set(aliases);
    const canonRow = allResults.find(g => g.mark_key === canonical);
    if (!canonRow) {
        // 兜底：找不到 canonical 行（极少见，例如用户在弹窗打开后搜索词被外部清空）→ 退回去重搜
        showToast('合并成功，正在重新拉取结果…', 'info');
        return doSearch();
    }
    const aliasRows = allResults.filter(g => aliasSet.has(g.mark_key));

    // 1) 把 alias 行的 platform_data 补到 canonical（仅补 canonical 没有的平台，已有则保留 canonical —— "以正主为准"）
    if (!canonRow.platform_data) canonRow.platform_data = {};
    aliasRows.forEach(ar => {
        if (!ar || !ar.platform_data) return;
        Object.keys(ar.platform_data).forEach(code => {
            if (!canonRow.platform_data[code]) {
                canonRow.platform_data[code] = ar.platform_data[code];
            }
        });
    });

    // 2) 把 alias 行从 allResults 中删掉
    allResults = allResults.filter(g => !aliasSet.has(g.mark_key));

    // 3) 给 canonical 加合并标记（renderSearchCard 会自动渲染 🔗 已合并 N 首 徽标 + 拆分按钮）
    const aliasLabels = aliasRows.map(r => {
        const name = (r.song_name || '').trim();
        const perf = (r.performer || '').trim();
        return perf ? `${name} - ${perf}` : name;
    });
    canonRow._merged = true;
    canonRow._merged_from = (canonRow._merged_from || []).concat(aliasLabels);
    canonRow._merge_canonical_key = canonical;

    // 4) 重画 + 更新统计（不发请求！）
    renderResults();
    updateFilterCounts();
    renderIrrelevantFooter();
    showToast(`✅ 已合并 ${aliasRows.length + 1} 项（本地即时刷新）`, 'success');
}

// 事件绑定（DOM 已就绪，脚本位于 body 末）
if (resultsBody) {
    resultsBody.addEventListener('change', (e) => {
        const chk = e.target.closest('.merge-chk');
        if (chk) onMergeChkChange(chk);
    });
    resultsBody.addEventListener('click', (e) => {
        const ub = e.target.closest('.unmerge-btn');
        if (ub) doUnmerge(ub.dataset.key);
    });
}
const mergeSelectedBtn = $('#mergeSelectedBtn');
if (mergeSelectedBtn) mergeSelectedBtn.addEventListener('click', openMergeModal);
const mergeClearBtn = $('#mergeClearBtn');
if (mergeClearBtn) mergeClearBtn.addEventListener('click', clearMergeSel);
const mergeCancelBtn = $('#mergeCancelBtn');
if (mergeCancelBtn) mergeCancelBtn.addEventListener('click', () => { $('#mergeModal').style.display = 'none'; });
const mergeConfirmBtn = $('#mergeConfirmBtn');
if (mergeConfirmBtn) mergeConfirmBtn.addEventListener('click', confirmMerge);


// ── 链接直查（v4.17.6）：粘贴平台歌曲链接直接收录该单曲 ──
const lookupUrlBtn = document.getElementById('lookupUrlBtn');
const songUrlInput = document.getElementById('songUrl');
const lookupUrlMsg = document.getElementById('lookupUrlMsg');

if (lookupUrlBtn) {
    lookupUrlBtn.addEventListener('click', doLookupUrl);
    if (songUrlInput) {
        songUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLookupUrl();
        });
    }
}

async function doLookupUrl() {
    const url = (songUrlInput && songUrlInput.value || '').trim();
    if (!url) { showToast('请先粘贴歌曲链接', 'error'); return; }
    lookupUrlBtn.disabled = true;
    lookupUrlBtn.textContent = '解析中…';
    lookupUrlMsg.textContent = '';
    lookupUrlMsg.className = 'url-lookup-msg';
    try {
        const resp = await fetch('/api/lookup_url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        const data = await resp.json();
        if (!resp.ok || data.error) {
            lookupUrlMsg.textContent = data.error || '解析失败';
            lookupUrlMsg.className = 'url-lookup-msg err';
            return;
        }
        const r = data.result;
        const code = data.platform_code;
        // 包装成 grouped_result，复用搜索卡片渲染
        const g = {
            song_name: r.song_name || '',
            performer: r.performer || '',
            album: r.album || '',
            lyricist: r.lyricist, composer: r.composer,
            match_label: r.match_label || '精准匹配',
            match_score: r.match_score || 100,
            platform_data: { [code]: r },
            platform_count: 1,
            _is_lookup: true,
            _lookup_partial: !!r._lookup_partial,
            _mark_key: typeof clientMarkKey === 'function' ? clientMarkKey(r.song_name || '', r.performer || '', r.album || '') : undefined,
            mark: r.mark || null,
            hearts: r.hearts || [],
        };
        allResults = [g];
        flatResults = [r];
        // v4.23：链接直查不走过滤逻辑，但清掉之前的折叠区
        irrelevantResults = [];
        window._filteredIrrelevantTotal = 0;
        irrelevantExpanded = false;
        activeFilter = 'all';
        markOnly = false; heartOnly = false; piracyFilter = 'all';
        resultsSection.style.display = 'block';
        renderResults();
        renderIrrelevantFooter();
        updateFilterCounts();
        setTimeout(() => resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
        const detail = [];
        if (r.collection_count != null) detail.push('收藏 ' + formatCount(r.collection_count));
        if (r.comment_count != null) detail.push('评论 ' + formatCount(r.comment_count));
        if (r._lookup_partial) {
            lookupUrlMsg.textContent = `已识别为「${PLATFORM_NAMES[code] || ''}」歌曲，单曲详情接口暂未完整支持，可点击上方链接打开原页，或用歌名搜索补全。`;
            lookupUrlMsg.className = 'url-lookup-msg warn';
        } else {
            const msgText = `直查成功：${r.song_name || '(歌名待补)'}${r.performer ? ' - ' + r.performer : ''}${detail.length ? '（' + detail.join(' / ') + '）' : ''}`;
            let searchBtn = '';
            if (r.song_name) {
                const label = (r.lyricist || r.composer) ? '用歌名+词曲作者搜索' : '用歌名搜索';
                searchBtn = ` <button type="button" class="search-btn sm" id="lookupSearchAgain" style="margin-left:10px">${label}</button>`;
            }
            lookupUrlMsg.innerHTML = msgText + searchBtn;
            lookupUrlMsg.className = 'url-lookup-msg ok';
            const btn = document.getElementById('lookupSearchAgain');
            if (btn) {
                btn.addEventListener('click', function () {
                    songNameInput.value = r.song_name || '';
                    lyricistInput.value = r.lyricist || '';
                    composerInput.value = r.composer || '';
                    performerInput.value = r.performer || '';
                    doSearch();
                });
            }
        }
    } catch (err) {
        console.error('lookup_url error:', err);
        lookupUrlMsg.textContent = '链接解析失败，请确认链接有效';
        lookupUrlMsg.className = 'url-lookup-msg err';
    } finally {
        lookupUrlBtn.disabled = false;
        lookupUrlBtn.textContent = '直查';
    }
}

[songNameInput, lyricistInput, composerInput, performerInput].forEach(input => {
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });
});

// ── 平台状态条 ──
function setPlatformStripSearching() {
    document.querySelectorAll('.platform-pill').forEach(pill => {
        pill.classList.remove('done', 'no-result');
        pill.classList.add('searching');
        pill.querySelector('.platform-count').textContent = '···';
    });
}

function updatePlatformStrip(stats) {
    stats.forEach(stat => {
        const pill = document.querySelector(`.platform-pill[data-code="${stat.platform_code}"]`);
        if (!pill) return;
        pill.classList.remove('searching');
        if (stat.status === 'no_result' || stat.count === 0) {
            pill.classList.add('no-result');
            pill.querySelector('.platform-count').textContent = '0';
        } else {
            pill.classList.add('done');
            pill.querySelector('.platform-count').textContent = stat.count;
        }
    });
}

// ── 表格骨架屏 ──
// v4.26.4b：按真实 14 列分布（9 公共信息 + 5 平台），平台列顶部带灰色品牌头部，
// 跟结果态视觉对齐，避免"汽水列掉队"感。
function showTableSkeleton() {
    resultsSection.style.display = 'block';
    document.getElementById('emptyState').style.display = 'none';
    resultsBody.innerHTML = '';
    const SK_ROWS = 6;
    // 表头公共列 8 个（歌曲/歌手/专辑/发行时间/词作者/曲作者/匹配来源/标记），平台列 5 个 = 13 列对齐
    const publicCells = ['80%', '70%', '60%', '55%', '65%', '75%', '90%', '40%'];
    const platCols = ['qq', 'kugou', 'kuwo', 'netease', 'qishui'];
    for (let i = 0; i < SK_ROWS; i++) {
        const tr = document.createElement('tr');
        const pubTd = publicCells.map(w =>
            `<td><div class="skeleton-bar" style="width:${w}"></div></td>`
        ).join('');
        const platTd = platCols.map(code => {
            const colors = (PLATFORM_COLORS && PLATFORM_COLORS[code]) || PLATFORM_COLORS.qq;
            return '<td class="platform-cell" data-platform="' + escapeHtml(code) + '">' +
                '<div class="platform-cell-head">' +
                    '<span class="plat-cell-dot-empty" style="background:' + (colors.accent || '#999') + '"></span>' +
                    '<span>' + escapeHtml(shortPlatformName(code)) + '</span>' +
                '</div>' +
                '<div class="skeleton-bar" style="width:72%;height:10px;margin:2px auto"></div>' +
                '<div class="skeleton-bar" style="width:55%;height:10px;margin:2px auto"></div>' +
                '</td>';
        }).join('');
        tr.innerHTML = pubTd + platTd;
        resultsBody.appendChild(tr);
    }
    setTimeout(() => resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

// ── 当前可见行（筛选 + 排序）──
// 聚合指标取值：scope 为某平台时取该平台该字段值；否则取各平台最大值（最火的平台）
function aggValue(g, field) {
    const pd = g.platform_data || {};
    if (sortScope && sortScope !== 'max' && pd[sortScope]) {
        const v = pd[sortScope][field];
        return (v == null) ? null : Number(v);
    }
    let max = null;
    PLATFORM_ORDER.forEach(code => {
        const r = pd[code];
        if (r && r[field] != null) {
            const n = Number(r[field]);
            if (max == null || n > max) max = n;
        }
    });
    return max;
}

function getVisibleRows() {
    let rows = activeFilter === 'all'
        ? allResults
        : allResults.filter(g => g.platform_data && g.platform_data[activeFilter]);
    if (markOnly) rows = rows.filter(g => g.mark);
    if (heartOnly) rows = rows.filter(g => g.hearts && g.hearts.length > 0);
    if (piracyFilter === 'suspect') rows = rows.filter(g => g.suspect_tags && g.suspect_tags.length);
    else if (piracyFilter === 'unprocessed') rows = rows.filter(g => {
        const mk = g.mark ? g.mark.mark_type : '';
        const cand = (g.suspect_tags && g.suspect_tags.length) || mk === '未打盗版' || mk === '疑似盗版';
        return cand && mk !== '已打盗版';
    });
    else if (piracyFilter === 'processed') rows = rows.filter(g => g.mark && g.mark.mark_type === '已打盗版');
    if (currentSort.key && SORTABLE[currentSort.key]) {
        const meta = SORTABLE[currentSort.key];
        const dir = currentSort.dir === 'asc' ? 1 : -1;
        rows = rows.slice(); // 不污染 allResults 原顺序
        rows.sort((a, b) => {
            // 主优先级：精准匹配的歌曲始终排在最前（符合"精准匹配前置"诉求）
            const aExact = (a.match_label === '精准匹配') ? 1 : 0;
            const bExact = (b.match_label === '精准匹配') ? 1 : 0;
            if (aExact !== bExact) return bExact - aExact;
            // 次优先级：当前排序指标
            let av, bv;
            if (meta.agg) {
                av = aggValue(a, currentSort.key);
                bv = aggValue(b, currentSort.key);
            } else {
                av = a[currentSort.key];
                bv = b[currentSort.key];
            }
            const aNull = av == null || av === '';
            const bNull = bv == null || bv === '';
            if (aNull && bNull) {
                // 两者主指标都为空时，按平台覆盖度排序（信息全的优先）
            } else if (aNull) {
                return 1;   // 空值始终排最后
            } else if (bNull) {
                return -1;
            } else {
                const cmp = meta.type === 'num' ? (Number(av) - Number(bv)) * dir
                    : String(av).localeCompare(String(bv), 'zh-Hans-CN') * dir;
                if (cmp !== 0) return cmp;
            }
            // 三级优先级：平台覆盖度（有 song_name 的平台数量），信息全的优先
            const aCount = Object.values(a.platform_data || {}).filter(p => p && p.song_name).length;
            const bCount = Object.values(b.platform_data || {}).filter(p => p && p.song_name).length;
            if (aCount !== bCount) return bCount - aCount;
            return 0;
        });
    }
    return rows;
}

function updateSortIndicators() {
    document.querySelectorAll('#resultsTable th[data-sort]').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.getAttribute('data-sort') === currentSort.key) {
            th.classList.add(currentSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

function updateFilterCounts() {
    PLATFORM_ORDER.forEach(code => {
        const el = document.getElementById('filter-count-' + code);
        if (!el) return;
        const count = allResults.filter(g => g.platform_data && g.platform_data[code]).length;
        el.textContent = count > 0 ? count : '';
    });
    const pc = {
        suspect: allResults.filter(g => g.suspect_tags && g.suspect_tags.length).length,
        unprocessed: allResults.filter(g => {
            const mk = g.mark ? g.mark.mark_type : '';
            const cand = (g.suspect_tags && g.suspect_tags.length) || mk === '未打盗版' || mk === '疑似盗版';
            return cand && mk !== '已打盗版';
        }).length,
        processed: allResults.filter(g => g.mark && g.mark.mark_type === '已打盗版').length,
    };
    const cntMap = { suspect: 'suspectCount', unprocessed: 'unprocessedCount', processed: 'processedCount' };
    for (const k in cntMap) {
        const el = document.getElementById(cntMap[k]);
        if (el) el.textContent = pc[k] > 0 ? pc[k] : '';
    }
    ['suspect', 'unprocessed', 'processed'].forEach(k => {
        const b = document.getElementById(k + 'Toggle');
        if (b) b.classList.toggle('active', piracyFilter === k);
    });
}

// 详情字段按抓取状态渲染：error→红色「抓取失败」；missing→灰色「平台无数据」；ok→正常值
function statusTextCell(obj, field) {
    const st = (obj._detail_status && obj._detail_status[field]) || 'ok';
    if (st === 'error') return '<span class="cell-error" title="数据抓取失败（程序问题，可重试搜索）">抓取失败</span>';
    if (st === 'missing') return '<span class="cell-nodata" title="该平台未提供此数据">平台无数据</span>';
    const v = obj[field];
    if (!v) return '<span class="cell-empty">—</span>';
    // ── 5 平台各自抓到的明细（用于差异提示）──
    const pp = (obj._per_platform && obj._per_platform[field]) || {};
    const vals = Object.values(pp);
    // 唯一值只有 1 个（或 0 个）→ 无差异，简洁显示
    const uniqueVals = Array.from(new Set(vals));
    if (uniqueVals.length <= 1) {
        return escapeHtml(v);
    }
    // 多平台数据不一致：主值 + ⚠ + tooltip 展开各家具体值
    const tip = Object.entries(pp)
        .map(([code, val]) => (PLATFORM_NAMES[code] || code) + '：' + val)
        .join('\n');
    return `<span class="cell-diff">${escapeHtml(v)}<span class="cell-diff-mark" title="${escapeHtml(tip)}">⚠</span></span>`;
}
function statusNumCell(obj, field) {
    const st = (obj._detail_status && obj._detail_status[field]) || 'ok';
    if (st === 'error') return '<span class="cell-error" title="数据抓取失败（程序问题，可重试搜索）">抓取失败</span>';
    if (st === 'missing') return '<span class="cell-nodata" title="该平台未提供此数据">平台无数据</span>';
    const v = obj[field];
    return v != null ? formatCount(v) : '<span class="cell-empty">—</span>';
}
function statusLabelCell(obj, field) {
    const st = (obj._detail_status && obj._detail_status[field]) || 'ok';
    if (st === 'error') return '<span class="cell-error" title="数据抓取失败（程序问题，可重试搜索）">抓取失败</span>';
    if (st === 'missing') return '<span class="cell-nodata" title="该平台未提供此数据">平台无数据</span>';
    const v = obj[field];
    return v ? `<span class="platform-cell-label" title="${escapeHtml(v)}">${escapeHtml(v)}</span>` : '<span class="cell-empty">—</span>';
}

// ── 渲染结果卡片（v4.16：歌单页同款 pl-card / pl-version 横排卡片）──
// 信息全保留：5 平台数据/词曲/统计/状态/标记/📌/红心；仅展示形式改为卡片
function renderResults() {
    resultsBody.innerHTML = '';

    const filtered = getVisibleRows();

    if (filtered.length === 0) {
        document.getElementById('tableWrap').style.display = 'none';
        document.getElementById('emptyState').style.display = 'block';
        document.getElementById('resultsTotal').innerHTML = '';
        document.getElementById('exportBtn').style.display = 'none';
        updateSortIndicators();
        return;
    }

    document.getElementById('tableWrap').style.display = 'block';
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('exportBtn').style.display = 'flex';

    const totalEl = document.getElementById('resultsTotal');
    if (activeFilter === 'all') {
        totalEl.innerHTML = `共 <b>${filtered.length}</b> 首歌 <span class="total-muted">（${flatResults.length} 个平台版本）</span>`;
    } else {
        const name = PLATFORM_NAMES[activeFilter] || activeFilter;
        totalEl.innerHTML = `含 <b>${name}</b> 的版本：${filtered.length} 首歌`;
    }

    filtered.forEach((g, i) => {
        const wrap = document.createElement('tbody');
        wrap.innerHTML = renderSearchCard(g, i);
        const card = wrap.firstElementChild;
        if (card) card.style.animationDelay = `${Math.min(i * 0.02, 0.4)}s`;
        resultsBody.appendChild(card || wrap);
    });

    // v4.23：如果有「无匹配」结果被折叠，在主结果下方渲染展开按钮 + 展开后的卡片
    renderIrrelevantInline();

    updateSortIndicators();
    updateMarkUI();
}

// ── v4.23：「完全无匹配」结果折叠区 ──
// 平台搜索接口会带兜底推荐（搜「回家」返回「有爱就不怕 · 庄心妍」之类），评分已判 0 分
// 但仍占列表。默认折叠在主结果下方，点开才看，避免污染主结果流。
function renderIrrelevantFooter() {
    const footer = document.getElementById('irrelevantFooter');
    if (!footer) return;
    if (!irrelevantResults || irrelevantResults.length === 0) {
        footer.innerHTML = '';
        footer.style.display = 'none';
        return;
    }
    const cnt = irrelevantResults.length;
    const totalFiltered = (window._filteredIrrelevantTotal || cnt);
    const tipText = '这些是平台搜索接口顺带返回的兜底推荐结果，评分系统判定与你的搜索词无关联（四维全不命中、歌名也不沾边），默认折叠避免干扰。点开可查看，不保证有用。';
    footer.style.display = 'block';
    footer.innerHTML = '<button type="button" class="irrelevant-toggle" id="irrelevantToggleBtn" title="' + escapeHtml(tipText) + '">' +
        '<span class="irrelevant-arrow">' + (irrelevantExpanded ? '▲' : '▼') + '</span>' +
        '<span class="irrelevant-label">还有 <b>' + cnt + '</b> 条与搜索无关的结果</span>' +
        '<span class="irrelevant-hint">' + (totalFiltered > cnt ? '（共 ' + totalFiltered + ' 条，仅展示前 ' + cnt + ' 条）' : '') + '</span>' +
        '</button>';
    const btn = document.getElementById('irrelevantToggleBtn');
    if (btn) btn.addEventListener('click', toggleIrrelevantSection);
}

function renderIrrelevantInline() {
    const wrap = document.getElementById('irrelevantInlineWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!irrelevantExpanded || !irrelevantResults || irrelevantResults.length === 0) return;
    wrap.style.display = 'block';
    // 加一个分区标题
    const banner = document.createElement('div');
    banner.className = 'irrelevant-banner';
    banner.innerHTML = '<span class="irrelevant-banner-icon">⚠</span>' +
        '<span class="irrelevant-banner-text">以下为平台返回的无关推荐结果（四维全不命中），仅供参考：</span>';
    wrap.appendChild(banner);
    // 无关结果也放进表格，与主结果区版式一致
    const tbl = document.createElement('table');
    tbl.className = 'results-table grouped irrelevant-table';
    const tb = document.createElement('tbody');
    irrelevantResults.forEach((g, i) => {
        const card = document.createElement('tbody');
        card.innerHTML = renderSearchCard(g, allResults.length + i);
        const tr = card.firstElementChild;
        if (tr) {
            tr.classList.add('pl-card--irrelevant');
            tr.style.animationDelay = `${Math.min(i * 0.02, 0.3)}s`;
            tb.appendChild(tr);
        }
    });
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
}

function toggleIrrelevantSection() {
    irrelevantExpanded = !irrelevantExpanded;
    renderIrrelevantFooter();
    renderIrrelevantInline();
}

// ── 单平台卡片（仿 playlist.js renderPlat，适配搜索页 platform_data 字段）──
// v4.17：每平台卡加 复制/打开 + 正版/盗版/无关 + 重抓 三组按钮（与歌单页一字不差）
function renderSearchPlat(code, r, g) {
    const name = PLATFORM_NAMES[code] || code;
    const colors = PLATFORM_COLORS[code] || PLATFORM_COLORS.qq;
    const has = !!(r && r.song_name);
    // v4.26.4：每个平台单元格顶部统一带品牌头部（彩色圆点+简称），保证 5 个平台视觉对齐
    const platHeadHtml = '<div class="platform-cell-head">' +
        '<span class="plat-cell-dot" style="background:' + (colors.accent || '#999') + '"></span>' +
        '<span>' + escapeHtml(shortPlatformName(code)) + '</span>' +
        '</div>';
    if (!has) {
        return '<td class="platform-cell" data-platform="' + escapeHtml(code) + '" title="' + escapeHtml(name) + ' 未收录这首歌">' +
            '<div class="platform-cell-rows">' +
            platHeadHtml +
            '<span class="platform-cell-empty"><span class="plat-cell-dot-empty"></span>未收录</span>' +
            '</div></td>';
    }
    const d = r;
    const link = d.song_url || '';
    const st = d._detail_status || {};

    // 从整首歌的 mark_type 推导该平台卡初始"已标"高亮
    let platMarkCls = '';
    let platMarkTitle = '';
    if (g && g.mark && g.mark.mark_type) {
        const mt = g.mark.mark_type;
        if (mt === '无关歌曲') {
            platMarkCls = 'is-marked-unrelated';
            platMarkTitle = '已标为「无关歌曲」（整首）';
        } else if (mt === '已打盗版') {
            platMarkCls = 'is-marked-bad';
            platMarkTitle = '已标「已打盗版」（整首）';
        } else if (mt.indexOf('@') > 0) {
            const platName = mt.split('@')[1] || '';
            if (platName === name) {
                if (mt.indexOf('正版') === 0) { platMarkCls = 'is-marked-pos'; platMarkTitle = '已标正版（' + name + '）'; }
                else if (mt.indexOf('盗版') === 0) { platMarkCls = 'is-marked-pir'; platMarkTitle = '已标盗版（' + name + '）'; }
            }
        }
    }

    const numCell = (field) => {
        const stt = st[field];
        if (stt === 'error') return '<span class="count-value count-empty" title="数据抓取失败">×</span>';
        if (stt === 'missing') return '<span class="count-value count-empty" title="平台无数据">—</span>';
        const v = d[field];
        if (v == null) return '<span class="count-value count-empty">—</span>';
        const n = Number(v);
        if (!n || isNaN(n)) return '<span class="count-value count-empty">—</span>';
        // v4.26.4：按量级分级 → 不同色彩与字重
        let cls = 'count-small';
        if (n >= 100000) cls = 'count-huge';
        else if (n >= 10000) cls = 'count-large';
        else if (n >= 1000) cls = 'count-mid';
        return '<span class="count-value ' + cls + '">' + n.toLocaleString('en-US') + '</span>';
    };
    // 收藏/在听/评论 三行（label + value）—— v4.26.4 加 data-kind 区分主/次指标
    const metricRow = (label, field, tip, kind) =>
        '<div class="platform-cell-row metric" data-kind="' + (kind || 'metric') + '" title="' + tip + '">' +
        '<span class="pc-label">' + label + '</span>' +
        '<span class="pc-value">' + numCell(field) + '</span></div>';

    // 上架状态
    const avail = d.availability || '在架';
    let availText = avail;
    let availCls = 'none';
    if (avail === '在架') availCls = 'ok';
    else if (avail === '在架(VIP)') availCls = 'vip';
    else if (avail === '已下架' || avail === '下架') availCls = 'down';
    else if (avail === '限流') availCls = 'warn';
    const availHtml = '<div class="platform-cell-row">' +
        '<span class="pl-plat-avail ' + availCls + '">' + escapeHtml(availText) + '</span></div>';

    // 发行公司（平台级厂牌）
    const brand = d.record_label
        ? '<span class="platform-cell-label" title="发行公司：' + escapeHtml(d.record_label) + '">' + escapeHtml(d.record_label) + '</span>'
        : '<span class="cell-nodata">—</span>';
    const brandHtml = '<div class="platform-cell-row platform-cell-record">' + brand + '</div>';

    // 操作按钮：复制/打开 + 重抓（正版/盗版/无关 已按用户要求移除）
    let btnHtml = '<div class="platform-cell-row platform-cell-actions">';
    if (link) {
        btnHtml += '<button type="button" class="pl-plat-btn pl-copy" data-link="' + escapeHtml(link) + '" title="复制链接">复制</button>' +
            '<a class="pl-plat-btn pl-open" href="' + escapeHtml(link) + '" target="_blank" rel="noopener" title="新窗口打开">↗</a>';
    }
    btnHtml +=
        '<button type="button" class="pl-plat-btn pl-refetch" data-platform="' + escapeHtml(code) +
        '" title="重新抓取该平台的词曲作者/详情（平台接口偶发漏抓时手动补）">↻ 重抓</button>';
    btnHtml += '</div>';

    return '<td class="platform-cell' + (platMarkCls ? ' ' + platMarkCls : '') + '" data-platform="' + escapeHtml(code) + '"' +
        (platMarkTitle ? ' title="' + escapeHtml(platMarkTitle) + '"' : '') + '>' +
        '<div class="platform-cell-rows">' +
        platHeadHtml +
        metricRow('收藏', 'collection_count', '收藏量', 'collection') +
        metricRow('在听', 'listening_count', '在听人数', 'listening') +
        metricRow('评论', 'comment_count', '评论数', 'comment') +
        availHtml + brandHtml + btnHtml +
        '</div></td>';
}


// ── 整首歌卡片（歌单页 pl-card 同款样式 + 搜索页特有：📌/红心/精准匹配/状态汇总）──
function renderSearchCard(g, i) {
    const mc = window.markClass || function () { return 'def'; };
    const cellVal = (val) => val ? escapeHtml(val) : '<span class="cell-empty">—</span>';
    const pd = g.platform_data || {};
    const availCodes = ['qq', 'kugou', 'kuwo', 'netease', 'qishui'];
    const hasCount = availCodes.filter(c => pd[c] && pd[c].song_name).length;

    // 📌 已固定
    const pinInfo = (g._pinned && typeof g._pinned === 'object') ? g._pinned : null;
    const pinBadge = pinInfo ? `<span class="pin-badge" title="已加入固定清单（${escapeHtml(pinInfo.pinned_at || '')}）；5 平台 ID 已存档，可一键刷新">🔖 已固定</span>` : '';
    const pinBtnHtml = `<button class="pin-btn${pinInfo ? ' is-pinned' : ''}" data-idx="${i}" type="button" title="${pinInfo ? '已固定（点此取消）' : '固定这行：存 5 平台 ID'}">📌</button>`;

    // v4.22：已合并歌曲徽章 + 拆分按钮
    let mergedBadge = '';
    if (g._merged) {
        const cnt = (g._merged_from ? g._merged_from.length : 0) + 1;
        const fromTxt = (g._merged_from || []).join('；');
        mergedBadge = `<span class="merge-badge" title="已合并为同一首：${escapeHtml(fromTxt)}">🔗 已合并 ${cnt} 首</span>` +
            `<button class="unmerge-btn" data-key="${escapeAttr(g._merge_canonical_key || '')}" type="button" title="拆分回独立记录">拆分</button>`;
    }

    // 精准匹配 / 近似匹配徽章（v4.21：四维命中数显式标出）
    let exactBadge = '';
    const auxHits = g._aux_hits || 0;
    const auxTotal = g._aux_total || 0;
    if (g.match_label === '精准匹配') {
        if (g._complete_match && auxTotal >= 3) {
            exactBadge = '<span class="match-badge exact-strong" title="歌名+表演者+词作者+曲作者 四维全命中">✓ 四维全中</span>';
        } else {
            exactBadge = '<span class="match-badge exact" title="歌名与输入完全匹配">精准匹配</span>';
        }
    } else if (g.match_label && g.match_label.indexOf('高近似') === 0) {
        exactBadge = `<span class="match-badge high-similar" title="命中 ${auxHits}/${auxTotal} 维（接近精准）">${g.match_label}</span>`;
    } else if (g.match_label && /近似匹配\(\d+\/\d+维\)/.test(g.match_label)) {
        exactBadge = `<span class="match-badge similar" title="命中 ${auxHits}/${auxTotal} 维">${g.match_label}</span>`;
    } else if (g.match_label === '近似匹配') {
        exactBadge = '<span class="match-badge similar" title="近似匹配">近似匹配</span>';
    } else if (g.match_label && g.match_label.indexOf('相关结果') === 0) {
        exactBadge = '<span class="match-badge low" title="歌名仅部分相关">相关结果</span>';
    } else if (g.match_label === '低相关') {
        exactBadge = '<span class="match-badge low" title="低相关">低相关</span>';
    }
    if (g._fragment_hits && g._fragment_total) {
        const full = g._fragment_hits >= g._fragment_total;
        exactBadge += `<span class="match-badge ${full ? 'exact' : 'similar'}" title="你输入的 ${g._fragment_total} 段歌词里，有 ${g._fragment_hits} 段命中了这个版本">命中 ${g._fragment_hits}/${g._fragment_total} 段</span>`;
    }

    // 红心
    const heartBadges = (g.hearts && g.hearts.length)
        ? '<div class="heart-row">' + g.hearts.map(p => {
              const meta = HEART_META[p] || { name: '该平台', badge: '红心', cls: 'qq' };
              return `<span class="heart-badge heart-${meta.cls}" title="你在${meta.name}「我喜欢」里收藏过这首歌">♥ ${escapeHtml(meta.badge)}</span>`;
          }).join('') + '</div>'
        : '';

    // 标记 pill（与歌单页/已标记页同款 mark-type-pill）
    const hasMark = !!g.mark;
    const markType = hasMark ? (g.mark.mark_type || '') : '';
    const markTags = (hasMark && Array.isArray(g.mark.tags)) ? g.mark.tags : [];
    let markCell;
    if (hasMark) {
        const mainPill = markType
            ? `<span class="mark-type-pill mark-${mc(markType)}" title="主标签&#10;更新：${escapeHtml(g.mark.updated_at || '')}&#10;备注：${escapeHtml(g.mark.note || '无')}">${escapeHtml(markType)}</span>`
            : '<span class="mark-type-pill mark-def">未标记</span>';
        const tagPills = markTags.map(t => `<span class="mark-tag-pill mark-${mc(t)}">${escapeHtml(t)}</span>`).join('');
        markCell = `<div class="mark-cell-row">${mainPill}${tagPills}</div>`;
    } else {
        markCell = '<span class="mark-type-pill mark-def">未标记</span>';
    }
    const markBtn = `<button class="mark-btn" data-idx="${i}" type="button" title="标记 / 编辑这首歌">${hasMark ? '编辑' : '标记'}</button>`;

    // 匹配来源 + 补数据按钮
    const sourceCell = renderMatchSource(g) + (g._needs_enrich && !g._enriched
        ? `<button class="enrich-btn" type="button" title="补全五平台收藏量/发行公司数据（用于盗版研判）">补数据</button>`
        : (g._enrichFail ? `<button class="enrich-btn" type="button" title="${escapeHtml(g._enrichFail)}">重试</button>` : ''));

    // 状态 tag（data-status 供筛选用）
    let stTag, stCls, stTip;
    if (g.match_label === '精准匹配' && g._complete_match && (g._aux_total || 0) >= 3) {
        stTag = '✓ 四维全中'; stCls = 'green'; stTip = '歌名+演唱者+词作者+曲作者 全命中';
    } else if (g.match_label === '精准匹配') {
        stTag = '精准匹配'; stCls = 'green'; stTip = '歌名精准匹配';
    } else if (g.match_label && g.match_label.indexOf('高近似') === 0) {
        stTag = g.match_label; stCls = 'green'; stTip = '接近四维精准';
    } else if (g.match_label && /近似匹配\(\d+\/\d+维\)/.test(g.match_label)) {
        stTag = g.match_label; stCls = 'yellow'; stTip = '命中部分辅助字段';
    } else if (g.match_label === '近似匹配') {
        stTag = '疑似原版'; stCls = 'yellow'; stTip = '近似匹配';
    } else {
        stTag = '已收录'; stCls = 'gray'; stTip = '已搜到该版本';
    }

    // 备注（手动/自定义 note 直接可见）
    const noteRaw = (hasMark && g.mark.note) ? String(g.mark.note).trim() : '';
    const noteHtml = noteRaw
        ? '<div class="pl-card-note" title="' + escapeHtml(noteRaw) + '">' +
              '<span class="pl-card-note-icon">📝</span>' +
              '<span class="pl-card-note-text">' + escapeHtml(noteRaw) + '</span>' +
          '</div>'
        : '';

    // 合并 checkbox
    const mergeChk = '<label class="merge-chk-wrap" title="勾选这首参与「合并」▼"><input type="checkbox" class="merge-chk" data-mkey="' + escapeAttr(g.mark_key || '') + '"' + (selectedMergeKeys.has(g.mark_key) ? ' checked' : '') + '><span class="merge-chk-tag">合并</span></label>';

    // 5 平台 td
    let platCells = '';
    availCodes.forEach(code => { platCells += renderSearchPlat(code, pd[code], g); });

    return '<tr class="search-row" data-idx="' + i + '" data-search-text="' +
        escapeHtml((g.song_name || '') + ' ' + (g.performer || '')) + '" data-status="' + stTag + '">' +
        '<td class="td-song" title="' + escapeHtml(g.song_name || '') + '">' +
            '<div class="song-cell">' +
                '<div class="song-name-row">' + cellVal(g.song_name) + exactBadge + pinBadge + mergedBadge + '</div>' +
                '<div class="song-ops-row">' + mergeChk + pinBtnHtml + '</div>' +
                heartBadges +
            '</div>' +
        '</td>' +
        '<td class="td-artist">' + cellVal(g.performer) + '</td>' +
        '<td class="td-album">' + cellVal(g.album) + '</td>' +
        '<td class="td-release">' + cellVal(g.release_date) + '</td>' +
        '<td class="td-lyricist">' + cellVal(g.lyricist) + '</td>' +
        '<td class="td-composer">' + cellVal(g.composer) + '</td>' +
        '<td class="td-source">' + sourceCell + '</td>' +
        // v4.27：标记列 = 标记管理单元（状态 pill + 备注 + 编辑按钮），把 markBtn 从歌名列挪到此处集中
        '<td class="td-mark">' +
            '<div class="mark-cell-stack">' +
                '<div class="mark-cell-row">' + markCell + '</div>' +
                noteHtml +
                markBtn +
            '</div>' +
        '</td>' +
        platCells +
        '</tr>';
}


// 更新标记计数与「只看标记」开关状态
function updateMarkUI() {
    const totalMarked = allResults.filter(g => g.mark).length;
    const mc = document.getElementById('markCount');
    if (mc) mc.textContent = totalMarked;
    const mt = document.getElementById('markToggle');
    if (mt) mt.classList.toggle('active', markOnly);
    // 红心计数（任一平台命中即计）
    const totalHearts = allResults.filter(g => g.hearts && g.hearts.length > 0).length;
    const hc = document.getElementById('heartCount');
    if (hc) hc.textContent = totalHearts;
    const ht = document.getElementById('heartToggle');
    if (ht) ht.classList.toggle('active', heartOnly);
}

// 标记类型 -> 配色 class
function markClass(type) {
    if (!type) return 'def';
    if (type === '已打盗版') return 'processed';
    if (type === '未打盗版') return 'unprocessed';
    if (type === '疑似盗版') return 'suspect';
    if (type === '正版确认') return 'genuine';
    if (type === '已确认') return 'ok';
    if (type === '待核实') return 'warn';
    if (type === '我的精选') return 'fav';
    if (type === '已排除') return 'excl';
    // v4.17 新增主类型
    if (type === '无关歌曲') return 'unrelated';
    // 正版@平台名 / 盗版@平台名（按主关键字染色）
    if (type.indexOf('正版') === 0) return 'genuine';
    if (type.indexOf('盗版') === 0) return 'excl';
    return 'def';
}

// ── 筛选 ──
document.getElementById('platformFilter').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    document.querySelectorAll('#platformFilter .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.getAttribute('data-filter');
    renderResults();
});

    // 盗版筛选按钮（疑似盗版 / 未打盗版 / 已打盗版）
    ['suspect', 'unprocessed', 'processed'].forEach(k => {
        const b = document.getElementById(k + 'Toggle');
        if (!b) return;
        b.addEventListener('click', () => {
            piracyFilter = (piracyFilter === k) ? 'all' : k;
            renderResults();
            updateFilterCounts();
        });
    });

// ── 标记功能（手动标记 + 跨打开/跨版本保留）──
let markTarget = null;       // 当前正在编辑的聚合行对象
let markSelectedType = '';
let markSelectedTags = new Set();  // 附加标签（多选）
let markRerender = null;     // 保存/删除后的重绘函数（第一页表格 or 歌词识别列表）

const markPopover = document.getElementById('markPopover');
const markPopTitle = document.getElementById('markPopTitle');
const markPopSub = document.getElementById('markPopSub');
const markPopNote = document.getElementById('markPopNote');
const markPopSave = document.getElementById('markPopSave');
const markPopDelete = document.getElementById('markPopDelete');
const markPopCancel = document.getElementById('markPopCancel');

function openMarkPopover(g, btnEl, rerender) {
    markTarget = g;
    markRerender = (typeof rerender === 'function') ? rerender : renderResults;
    markSelectedType = g.mark ? g.mark.mark_type : '已确认';
    // 附加标签：从 g.mark.tags[] 初始化
    const existingTags = (g.mark && Array.isArray(g.mark.tags)) ? g.mark.tags : [];
    markSelectedTags = new Set(existingTags);
    markPopTitle.textContent = g.song_name || '(未知歌名)';
    markPopSub.textContent = [g.performer, g.album].filter(Boolean).join(' · ') || '';
    markPopNote.value = g.mark ? (g.mark.note || '') : '';
    // 主标签 chip 高亮
    document.querySelectorAll('#markPopTypes .mark-type-chip').forEach(c => {
        c.classList.toggle('active', c.getAttribute('data-type') === markSelectedType);
    });
    // 附加标签 chip 高亮（多选）
    document.querySelectorAll('#markPopTags .mark-tag-chip').forEach(c => {
        c.classList.toggle('active', markSelectedTags.has(c.getAttribute('data-type')));
    });
    markPopover.style.display = 'block';
    const rect = btnEl.getBoundingClientRect();
    const pw = markPopover.offsetWidth, ph = markPopover.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
    if (top + ph > vh - 8) top = Math.max(8, rect.top - ph - 6);
    markPopover.style.left = left + 'px';
    markPopover.style.top = top + 'px';
}

function closeMarkPopover() {
    markPopover.style.display = 'none';
    markTarget = null;
}

document.querySelectorAll('#markPopTypes .mark-type-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        markSelectedType = chip.getAttribute('data-type');
        document.querySelectorAll('#markPopTypes .mark-type-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
    });
});

// 附加标签多选：点选 toggle，限制不能选主标签（避免重复）
document.querySelectorAll('#markPopTags .mark-tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const t = chip.getAttribute('data-type');
        if (t === markSelectedType) {
            // 主标签已选这个值，附加里取消（避免同一值双显）
            markSelectedTags.delete(t);
            chip.classList.remove('active');
            return;
        }
        if (markSelectedTags.has(t)) {
            markSelectedTags.delete(t);
            chip.classList.remove('active');
        } else {
            markSelectedTags.add(t);
            chip.classList.add('active');
        }
    });
});

// 行内「标记 / 编辑」按钮（事件委托，兼容重渲染）
resultsBody.addEventListener('click', (e) => {
    const mb = e.target.closest('.mark-btn');
    if (!mb) return;
    const idx = Number(mb.getAttribute('data-idx'));
    const g = getVisibleRows()[idx];
    if (g) openMarkPopover(g, mb);
});

// 平台卡片内「复制链接」按钮（v4.16 卡片模式）
resultsBody.addEventListener('click', (e) => {
    const cb = e.target.closest('.pl-copy');
    if (!cb) return;
    const link = cb.getAttribute('data-link') || '';
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
        showToast('已复制链接');
        cb.textContent = '✓';
        setTimeout(() => { cb.textContent = '复制'; }, 1200);
    }).catch(() => { showToast('复制失败'); });
});

// v4.17：搜索页每平台卡「正版 / 盗版 / 无关」按钮（与歌单页语义一致）
//   正版 → 整首 mark_type = '正版@<平台名>'，高亮该平台卡
//   盗版 → 整首 mark_type = '盗版@<平台名>'，高亮该平台卡
//   无关 → 整首 mark_type = '无关歌曲'，所有平台卡灰底 + 斜杠
resultsBody.addEventListener('click', (e) => {
    const markBtn = e.target.closest('.pl-mark-pos, .pl-mark-pir, .pl-unrelated');
    if (!markBtn) return;
    e.stopPropagation();
    const platBox = markBtn.closest('.pl-plat');
    const card = markBtn.closest('.pl-card');
    if (!card || !platBox) return;
    const idx = Number(card.getAttribute('data-idx'));
    const g = getVisibleRows()[idx] || allResults[idx];
    if (!g) { showToast('找不到该歌曲数据', 'err'); return; }
    const platformCode = platBox.getAttribute('data-platform') || markBtn.getAttribute('data-platform') || '';
    const platformName = markBtn.getAttribute('data-platform-name') || PLATFORM_NAMES[platformCode] || platformCode;

    let markType;
    if (markBtn.classList.contains('pl-mark-pos')) markType = '正版@' + platformName;
    else if (markBtn.classList.contains('pl-mark-pir')) markType = '盗版@' + platformName;
    else markType = '无关歌曲';

    // 乐观更新：先把所有平台卡的旧高亮清掉，按新 mark 重新挂上
    card.querySelectorAll('.pl-plat').forEach(p => p.classList.remove('is-marked-pos', 'is-marked-pir', 'is-marked-unrelated', 'is-marked-bad'));
    const applyHighlight = () => {
        const plats = card.querySelectorAll('.pl-plat');
        if (markType === '无关歌曲') plats.forEach(p => p.classList.add('is-marked-unrelated'));
        else if (markType === '已打盗版') plats.forEach(p => p.classList.add('is-marked-bad'));
        else {
            const platName = markType.split('@')[1] || '';
            plats.forEach(p => {
                const code = p.getAttribute('data-platform');
                const name = PLATFORM_NAMES[code] || code;
                if (name === platName) {
                    p.classList.add(markType.indexOf('正版') === 0 ? 'is-marked-pos' : 'is-marked-pir');
                }
            });
        }
    };
    applyHighlight();
    flashButton(markBtn, '✓ ' + markType);

    // 同步更新本地数据 + 重新渲染该卡的头部 pill / 底部 foot（让一级页面状态一致）
    g.mark = Object.assign({}, g.mark || {}, {
        song_name: g.song_name || '',
        performer: g.performer || '',
        album: g.album || '',
        mark_type: markType,
        tags: (g.mark && g.mark.tags) || [],
        note: '在搜索页标记于 ' + new Date().toLocaleString('zh-CN'),
        updated_at: new Date().toLocaleString('zh-CN', { hour12: false }),
    });

    fetch('/api/marks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            song_name: g.song_name || '',
            performer: g.performer || '',
            album: g.album || '',
            mark_type: markType,
            note: '在搜索页标记于 ' + new Date().toLocaleString('zh-CN'),
        })
    }).then(r => r.json()).then(j => {
        if (!j.ok) {
            showToast('标记保存失败：' + (j.error || ''), 'err');
            // 回滚：调一次 renderResults 重画卡片（从后端 fresh 数据拉，但当前我们不重搜）
            // 简化：撤销高亮让用户能再点
            card.querySelectorAll('.pl-plat').forEach(p => p.classList.remove('is-marked-pos', 'is-marked-pir', 'is-marked-unrelated', 'is-marked-bad'));
            flashButton(markBtn, '失败');
        } else {
            renderResults(); // 重新画卡片，让 pill/foot/note 与 g.mark 同步
        }
    }).catch(err => {
        showToast('标记保存失败：' + err.message, 'err');
        card.querySelectorAll('.pl-plat').forEach(p => p.classList.remove('is-marked-pos', 'is-marked-pir', 'is-marked-unrelated', 'is-marked-bad'));
        flashButton(markBtn, '失败');
    });
});

// v4.17：搜索页每平台卡「↻ 重抓」按钮（复用 /api/refetch）
resultsBody.addEventListener('click', (e) => {
    const refetchBtn = e.target.closest('.pl-refetch');
    if (!refetchBtn) return;
    e.stopPropagation();
    const platBox = refetchBtn.closest('.pl-plat');
    const card = refetchBtn.closest('.pl-card');
    if (!card || !platBox) return;
    const code = platBox.getAttribute('data-platform') || '';
    const idx = Number(card.getAttribute('data-idx'));
    const g = getVisibleRows()[idx] || allResults[idx];
    const row = (g && g.platform_data && g.platform_data[code]);
    if (!row) { showToast('该平台无数据可重抓', 'err'); return; }
    const oldText = refetchBtn.textContent;
    refetchBtn.disabled = true;
    refetchBtn.textContent = '重抓中…';
    fetch('/api/refetch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform_code: code, row: row })
    }).then(r => r.json()).then(j => {
        if (!j.row) throw new Error(j.error || '重抓失败');
        // 写回数据模型并就地重绘这张平台卡
        if (g && g.platform_data) g.platform_data[code] = j.row;
        const meta = PLATFORM_COLORS[code] || PLATFORM_COLORS.qq;
        const tmp = document.createElement('div');
        tmp.innerHTML = renderSearchPlat(code, j.row, g);
        const newBox = tmp.firstElementChild;
        if (newBox && platBox.parentNode) {
            // 保留"已标"高亮（避免重抓后丢失）
            ['is-marked-pos', 'is-marked-pir', 'is-marked-unrelated', 'is-marked-bad'].forEach(c => {
                if (platBox.classList.contains(c)) newBox.classList.add(c);
            });
            platBox.replaceWith(newBox);
        }
        showToast('已重抓 ' + (PLATFORM_NAMES[code] || code) + ' 数据', '');
    }).catch(err => {
        showToast('重抓失败：' + err.message, 'err');
        refetchBtn.disabled = false;
        refetchBtn.textContent = oldText;
    });
});

// 闪一下按钮文案（绿/红/灰）
function flashButton(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(() => {
        btn.textContent = old;
        btn.disabled = false;
    }, 1200);
}

markPopSave.addEventListener('click', async () => {
    // 快照当前目标：防止 await 期间 closeMarkPopover 把 markTarget 清空导致崩
    const target = markTarget;
    if (!target) return;
    const payload = {
        song_name: target.song_name || '',
        performer: target.performer || '',
        album: target.album || '',
        mark_type: markSelectedType,
        tags: Array.from(markSelectedTags),  // 附加标签（多选）
        note: markPopNote.value.trim(),
    };
    try {
        const resp = await fetch('/api/marks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error('保存失败');
        const data = await resp.json();
        // 用户可能在 await 期间取消了弹窗 → 弹窗状态已变，跳过本地回填
        if (target !== markTarget) {
            showToast('已保存标记：' + markSelectedType);
            return;
        }
        target.mark = data.mark;
        const rr = markRerender || renderResults;
        closeMarkPopover();
        rr();
        showToast('已保存标记：' + markSelectedType);
    } catch (err) {
        showToast('标记保存失败：' + err.message, true);
    }
});

markPopDelete.addEventListener('click', async () => {
    const target = markTarget;
    if (!target) return;
    const payload = {
        song_name: target.song_name || '',
        performer: target.performer || '',
        album: target.album || '',
    };
    try {
        const resp = await fetch('/api/marks', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error('删除失败');
        if (target !== markTarget) {
            showToast('已删除标记');
            return;
        }
        delete target.mark;
        const rr = markRerender || renderResults;
        closeMarkPopover();
        rr();
        showToast('已删除标记');
    } catch (err) {
        showToast('删除失败：' + err.message, true);
    }
});

markPopCancel.addEventListener('click', closeMarkPopover);

document.addEventListener('click', (e) => {
    // 第一页表格的 .mark-btn 与歌词识别页的 [data-act="mark"] 都是弹窗触发器，不算「点了外面」
    if (markPopover.style.display === 'block'
        && !markPopover.contains(e.target)
        && !e.target.closest('.mark-btn')
        && !e.target.closest('[data-act="mark"]')) {
        closeMarkPopover();
    }
});

document.getElementById('markToggle').addEventListener('click', () => {
    markOnly = !markOnly;
    document.getElementById('markToggle').classList.toggle('active', markOnly);
    renderResults();
});

// ── 红心管理页（识别各平台「我喜欢 / 收藏」的歌；红心 Cookie 与搜索 Cookie 分储）──
const HEART_PLAT_COLORS = {
    qq: '#31c27c', kugou: '#2ca2f9', kuwo: '#ff9a00', netease: '#e60026', qishui: '#00d4d4'
};

async function renderHeartsPage() {
    const list = document.getElementById('heartsList');
    if (!list) return;
    if (!APP_ENV._loaded) {
        await loadAppEnv();
    }
    const showBrowser = APP_ENV.show_browser_login && APP_ENV.playwright_available;
    list.innerHTML = PLATFORM_ORDER.map(code => {
        const meta = HEART_META[code] || { name: code, badge: '红心' };
        const color = HEART_PLAT_COLORS[code] || '#888';
        const isQishui = code === 'qishui';
        const hasBrowser = showBrowser && !isQishui;

        // 各平台方法编号（汽水没有浏览器登录，自动少一项）
        let n = 1;
        const browserNum = hasBrowser ? String(n++) : '';
        const cookieNum = isQishui ? '' : String(n++);
        const pasteNum = String(n++);
        const linkNum = String(n++);

        const browserRow = isQishui ? '' : (showBrowser ? `
            <div class="hearts-method recommended">
                <div class="hearts-method-title">
                    <span class="hearts-method-badge">${browserNum}</span>
                    浏览器登录自动抓取
                </div>
                <div class="hearts-method-desc">推荐：弹出窗口登录后自动保存 Cookie 并抓取红心</div>
                <div class="hearts-actions">
                    <button type="button" class="btn-primary" data-act="browserlogin" data-plat="${code}">弹出登录页自动抓 Cookie</button>
                </div>
                <div class="hearts-login-result" id="hlogin-result-${code}"></div>
            </div>` : '');

        const cookieRow = isQishui ? `
            <div class="hearts-method">
                <div class="hearts-method-title">
                    <span class="hearts-method-badge">${cookieNum || '1'}</span>
                    汽水音乐 Cookie 抓取
                </div>
                <div class="hearts-method-desc">抖音系接口有签名保护，不支持 Cookie 自动抓取，请用下方「歌单链接」方式</div>
            </div>` : `
            <div class="hearts-method">
                <div class="hearts-method-title">
                    <span class="hearts-method-badge">${cookieNum}</span>
                    手动粘贴 Cookie 并抓取
                </div>
                <div class="hearts-method-desc">粘贴登录 Cookie 后保存，再点「登录并抓取红心」（与搜索 Cookie 分开保存）</div>
                <textarea id="hcookie-${code}" class="mark-pop-note hcookie" placeholder="粘贴 ${escapeHtml(meta.name)} 登录 Cookie（整行）"></textarea>
                <div class="hearts-actions">
                    <button type="button" class="btn-primary" data-act="save" data-plat="${code}">保存 Cookie</button>
                    <button type="button" class="btn-primary" data-act="fetch" data-plat="${code}">登录并抓取红心</button>
                    <button type="button" class="btn-ghost" data-act="refresh" data-plat="${code}">刷新</button>
                    <button type="button" class="btn-ghost" data-act="clearcookie" data-plat="${code}">清除凭证</button>
                </div>
            </div>`;

        return `
        <div class="hearts-card glass" data-plat="${code}">
            <div class="hearts-card-head">
                <span class="platform-dot" style="background:${color}"></span>
                <span class="hearts-card-name">${meta.name}</span>
                <span class="hearts-status" id="hstat-${code}">加载中…</span>
            </div>
            ${browserRow}
            ${cookieRow}
            <div class="hearts-method">
                <div class="hearts-method-title">
                    <span class="hearts-method-badge">${pasteNum}</span>
                    手动粘贴歌单
                </div>
                <div class="hearts-method-desc">兜底方式：每行一首「歌名 - 歌手」，也支持纯歌名</div>
                <textarea id="hpaste-${code}" class="mark-pop-note hpaste" placeholder="例如：&#10;晴天 - 周杰伦&#10;稻香 - 周杰伦"></textarea>
                <div class="hearts-actions">
                    <button type="button" class="btn-primary" data-act="paste" data-plat="${code}">粘贴识别</button>
                    <button type="button" class="btn-danger" data-act="clearsongs" data-plat="${code}">清空红心</button>
                </div>
            </div>
            <div class="hearts-method">
                <div class="hearts-method-title">
                    <span class="hearts-method-badge">${linkNum}</span>
                    歌单链接自动抓取
                </div>
                <div class="hearts-method-desc">粘贴公开歌单/收藏歌单的分享链接（全平台通用，最稳${isQishui ? '，汽水推荐用此方式' : ''}）</div>
                <textarea id="hlink-${code}" class="mark-pop-note hlink" placeholder="把该平台「我喜欢」歌单设为公开，复制分享链接粘贴到这里"></textarea>
                <div class="hearts-actions">
                    <button type="button" class="btn-primary" data-act="fetchlink" data-plat="${code}">用链接抓取</button>
                </div>
            </div>
            <div class="hearts-sample" id="hsample-${code}"></div>
        </div>`;
    }).join('');
    refreshHeartsStatus();
}

async function refreshHeartsStatus() {
    try {
        const resp = await fetch('/api/hearts?platform=all');
        const d = await resp.json();
        const plats = (d.platforms) || {};
        PLATFORM_ORDER.forEach(code => {
            const p = plats[code] || {};
            const statEl = document.getElementById('hstat-' + code);
            const sampEl = document.getElementById('hsample-' + code);
            const src = p.source === 'cookie' ? 'Cookie 自动抓取' : (p.source === 'manual' ? '手动粘贴' : '未设置');
            const when = p.updated_at ? ('，更新于 ' + p.updated_at) : '';
            const cFlag = p.has_cookie ? ' · 已存凭证' : '';
            if (statEl) statEl.textContent = (p.count > 0 ? `已识别 ${p.count} 首${when}（${src}${cFlag}）` : `尚未识别${cFlag}`);
            if (sampEl) {
                if (p.count > 0) {
                    sampEl.innerHTML = '<span class="hsample-title">样本：</span>' + (p.sample || []).map(s => escapeHtml(s.song + (s.artist ? ' - ' + s.artist : ''))).join('、');
                } else {
                    sampEl.textContent = '';
                }
            }
        });
    } catch (e) {
        PLATFORM_ORDER.forEach(code => {
            const el = document.getElementById('hstat-' + code);
            if (el) el.textContent = '读取状态失败';
        });
    }
}

// 事件委托：红心管理页所有按钮（卡片由 JS 动态生成，用委托绑定一次即可）
const _heartsListEl = document.getElementById('heartsList');
if (_heartsListEl) {
    _heartsListEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const code = btn.getAttribute('data-plat');
        const meta = HEART_META[code] || { name: code };
        try {
            if (act === 'browserlogin') {
                const resultEl = document.getElementById('hlogin-result-' + code);
                btn.disabled = true;
                if (resultEl) resultEl.innerHTML = '<span class="cookie-testing">正在打开浏览器，请在弹出的窗口中登录…</span>';
                try {
                    const resp = await fetch(`/api/hearts/login/${code}`, { method: 'POST' });
                    const data = await resp.json();
                    if (!data.started) {
                        if (resultEl) resultEl.innerHTML = `<span class="cookie-test-fail">✗ ${data.message || '启动失败'}</span>`;
                        btn.disabled = false;
                        return;
                    }
                } catch (err) {
                    if (resultEl) resultEl.innerHTML = '<span class="cookie-test-fail">✗ 无法连接服务器（可改用「手动粘贴 Cookie」方式）</span>';
                    btn.disabled = false;
                    return;
                }
                // 轮询登录+抓取状态
                const poll = async () => {
                    try {
                        const s = await (await fetch(`/api/hearts/login/status/${code}`)).json();
                        if (s.running) {
                            if (resultEl) resultEl.innerHTML = `<span class="cookie-testing">${s.message || '登录中…'}</span>`;
                            setTimeout(poll, 2000);
                        } else {
                            if (s.success) {
                                if (resultEl) resultEl.innerHTML = `<span class="cookie-test-ok">✓ ${s.message}</span>`;
                                showToast(s.message, 'success');
                                refreshHeartsStatus();
                                renderResults();
                            } else {
                                if (resultEl) resultEl.innerHTML = `<span class="cookie-test-fail">✗ ${s.message}（可改用「手动粘贴 Cookie」或「歌单链接」方式）</span>`;
                            }
                            btn.disabled = false;
                        }
                    } catch (e) {
                        if (resultEl) resultEl.innerHTML = '<span class="cookie-test-fail">✗ 状态获取失败（可改用「手动粘贴 Cookie」方式）</span>';
                        btn.disabled = false;
                    }
                };
                setTimeout(poll, 1500);
            } else if (act === 'save') {
                const cookie = (document.getElementById('hcookie-' + code).value || '').trim();
                if (!cookie) { showToast('请先粘贴 Cookie 再保存', 'error'); return; }
                const resp = await fetch('/api/hearts/cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: code, cookie }) });
                const d = await resp.json();
                if (!resp.ok || !d.ok) throw new Error(d.error || ('HTTP ' + resp.status));
                showToast(`${meta.name} 红心 Cookie 已保存（与搜索 Cookie 分开）`, 'success');
                refreshHeartsStatus();
            } else if (act === 'fetch') {
                const cookie = (document.getElementById('hcookie-' + code).value || '').trim();
                showToast(`正在登录并抓取 ${meta.name} 红心歌单…`, '');
                const body = { platform: code };
                if (cookie) body.cookie = cookie;  // 有填则用填入的；否则用已保存的
                const resp = await fetch('/api/hearts/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const d = await resp.json();
                if (!resp.ok || !d.ok) throw new Error(d.error || ('HTTP ' + resp.status));
                showToast(`已识别 ${d.count} 首 ${meta.name} 红心歌曲`, 'success');
                refreshHeartsStatus();
                renderResults();
            } else if (act === 'refresh') {
                showToast(`正在刷新 ${meta.name} 红心歌单…`, '');
                const resp = await fetch('/api/hearts/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: code }) });
                const d = await resp.json();
                if (!resp.ok || !d.ok) throw new Error(d.error || ('HTTP ' + resp.status));
                showToast(`已刷新 ${d.count} 首 ${meta.name} 红心歌曲`, 'success');
                refreshHeartsStatus();
                renderResults();
            } else if (act === 'fetchlink') {
                const linkEl = document.getElementById('hlink-' + code);
                const link = (linkEl.value || '').trim();
                if (!link) { showToast('请先粘贴歌单分享链接', 'error'); return; }
                showToast(`正在用链接抓取 ${meta.name} 红心歌单…`, '');
                const resp = await fetch('/api/hearts/fetch_link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: code, link }) });
                const d = await resp.json();
                if (!resp.ok || !d.ok) throw new Error(d.error || ('HTTP ' + resp.status));
                showToast(`已识别 ${d.count} 首 ${meta.name} 红心歌曲（歌单链接）`, 'success');
                refreshHeartsStatus();
                renderResults();
            } else if (act === 'clearcookie') {
                const resp = await fetch('/api/hearts/cookie', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: code }) });
                const d = await resp.json();
                if (!resp.ok || !d.ok) throw new Error(d.error || ('HTTP ' + resp.status));
                showToast(`已清除 ${meta.name} 红心凭证`, 'success');
                refreshHeartsStatus();
            } else if (act === 'paste') {
                const text = document.getElementById('hpaste-' + code).value || '';
                if (!text.trim()) { showToast('请先粘贴歌单', 'error'); return; }
                showToast(`正在识别粘贴的 ${meta.name} 歌单…`, '');
                const resp = await fetch('/api/hearts/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: code, text }) });
                const d = await resp.json();
                if (!resp.ok || !d.ok) throw new Error(d.error || ('HTTP ' + resp.status));
                showToast(`已新增 ${d.added} 首，共 ${d.total} 首`, 'success');
                refreshHeartsStatus();
                renderResults();
            } else if (act === 'clearsongs') {
                const resp = await fetch('/api/hearts/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: code }) });
                const d = await resp.json();
                if (!resp.ok || !d.ok) throw new Error(d.error || ('HTTP ' + resp.status));
                showToast(`已清空 ${meta.name} 红心歌曲`, 'success');
                refreshHeartsStatus();
                renderResults();
            }
        } catch (err) {
            const verb = { fetch: '抓取', fetchlink: '链接抓取', refresh: '刷新', paste: '识别', clearsongs: '清空', clearcookie: '清除凭证', save: '保存', browserlogin: '浏览器登录' }[act] || '操作';
            showToast(`${verb}失败：${err.message}`, 'error');
        }
    });
}

document.getElementById('heartToggle').addEventListener('click', () => {
    heartOnly = !heartOnly;
    document.getElementById('heartToggle').classList.toggle('active', heartOnly);
    renderResults();
});

// ── 标记导出 / 导入（跨设备、跨版本迁移）──

// 与服务端 _mark_key / _normalize_exact 保持一致，用于导入后把服务器标记重新挂回当前结果。
// 两条铁律：
// 1) 必须【保留括号及其内容】。剥掉括号会把「笑柄 / 笑柄(伴奏) / 笑柄(DJ阿卓版)」
//    塌缩成同一个 key，多个版本的标记互相覆盖，做不到一对一确权。
// 2) 字符白名单必须与后端 _normalize_exact 完全一致：ASCII + CJK 完整 + 平/片假名
//    + Hangul + 括号本身。否则韩文/日文歌曲的 key 会被剥成空串，跟后端对不上
//    → applyServerMarks 失效，导入成功但界面不显示徽章。
function clientMarkKey(song, performer, album) {
    const norm = (t) => (t || '')
        .replace(/[（\[【〔｛]/g, '(')
        .replace(/[）\]】〕｝]/g, ')')
        .replace(/[·•\s\u3000]/g, '')
        .replace(/[^\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7afa-zA-Z0-9()]/g, '')
        .toLowerCase().trim();
    const splitArt = (n) => {
        if (!n) return [];
        return n.split(/[,，/&、\\;；\s]+/)
            .map(p => p.trim().toLowerCase())
            .filter(p => p && !/^and$/i.test(p))
            .sort();
    };
    return JSON.stringify({
        song: norm(song),
        artist: splitArt(performer),
        album: norm(album),
    });
}

// 把服务器返回的 marks 字典挂回当前 allResults
function applyServerMarks(marks) {
    for (const g of allResults) {
        const key = clientMarkKey(g.song_name, g.performer, g.album);
        g.mark = marks[key] || null;
    }
    renderResults();
    updateMarkUI();
}

// 导出标记
document.getElementById('exportMarksBtn').addEventListener('click', async () => {
    try {
        showToast('正在导出标记…', '');
        const resp = await fetch('/api/marks/export');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'musicfinder_marks_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('已导出标记备份', 'success');
    } catch (err) {
        showToast('导出失败：' + err.message, 'error');
    }
});

// 导入标记
document.getElementById('importMarksBtn').addEventListener('click', () => {
    document.getElementById('importMarksFile').click();
});
document.getElementById('importMarksFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';  // 允许再次选择同一文件
    if (!file) return;
    try {
        showToast('正在导入标记…', '');
        const text = await file.text();
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (_) {
            throw new Error('文件不是合法的 JSON');
        }
        const resp = await fetch('/api/marks/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.error || ('HTTP ' + resp.status));
        // 导入成功后，拉取最新标记并重新挂回当前结果
        const mr = await fetch('/api/marks');
        const md = await mr.json();
        applyServerMarks(md.marks || {});
        showToast(`导入完成：新增 ${data.added} 条，覆盖 ${data.updated} 条，共 ${data.total} 条`, 'success');
    } catch (err) {
        showToast('导入失败：' + err.message, 'error');
    }
});

// ── 表头排序 ──
const _sortHeadEl = document.querySelector('#resultsTable thead');
if (_sortHeadEl) {
_sortHeadEl.addEventListener('click', (e) => {
    if (_suppressSort) { _suppressSort = false; return; }
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.getAttribute('data-sort');
    if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.key = key;
        currentSort.dir = SORTABLE[key].type === 'num' ? 'desc' : 'asc';
    }
    // 同步排序工具栏（表头点击的是单值字段，平台范围不适用）
    const sk = document.getElementById('sortKey');
    const ss = document.getElementById('sortScope');
    if (sk) sk.value = key;
    if (ss) { ss.disabled = true; ss.classList.add('disabled'); }
    const sd = document.getElementById('sortDir');
    if (sd) sd.textContent = currentSort.dir === 'asc' ? '▲' : '▼';
    renderResults();
});
}

// ── 排序工具栏（支持「收藏量 / 在听 / 评论」等多平台计数排序）──
const sortKeySel = document.getElementById('sortKey');
const sortScopeSel = document.getElementById('sortScope');
const sortDirBtn = document.getElementById('sortDir');

function updateSortDirBtn() {
    if (sortDirBtn) sortDirBtn.textContent = currentSort.dir === 'asc' ? '▲' : '▼';
}
function syncSortControls() {
    if (sortKeySel) sortKeySel.value = currentSort.key;
    if (sortScopeSel) sortScopeSel.value = sortScope;
    const isAgg = !!(SORTABLE[currentSort.key] && SORTABLE[currentSort.key].agg);
    if (sortScopeSel) {
        sortScopeSel.disabled = !isAgg;
        sortScopeSel.classList.toggle('disabled', !isAgg);
    }
    updateSortDirBtn();
}
if (sortKeySel) {
    sortKeySel.addEventListener('change', () => {
        currentSort.key = sortKeySel.value;
        currentSort.dir = (SORTABLE[currentSort.key].type === 'num') ? 'desc' : 'asc';
        syncSortControls();
        renderResults();
    });
}
if (sortScopeSel) {
    sortScopeSel.addEventListener('change', () => {
        sortScope = sortScopeSel.value;
        renderResults();
    });
}
if (sortDirBtn) {
    sortDirBtn.addEventListener('click', () => {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        updateSortDirBtn();
        renderResults();
    });
}
// 初始化工具栏状态
syncSortControls();

// ── 复制链接 ──
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-link-btn');
    if (!btn) return;
    const url = btn.getAttribute('data-url');
    if (!url) return;
    try {
        await navigator.clipboard.writeText(url);
        const old = btn.textContent;
        btn.textContent = '已复制';
        btn.classList.add('copied');
        showToast('链接已复制到剪贴板', 'success');
        setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1500);
    } catch (err) {
        // 降级方案：临时输入框 + execCommand
        try {
            const ta = document.createElement('textarea');
            ta.value = url;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showToast('链接已复制到剪贴板', 'success');
        } catch (e2) {
            showToast('复制失败，请手动复制', 'error');
        }
    }
});

// ── 单平台重抓 ──
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.refetch-btn');
    if (!btn) return;
    const code = btn.getAttribute('data-code');
    const url = btn.getAttribute('data-url');
    if (!code || !url) return;

    // 从当前结果中找到对应的平台行
    let targetRow = null;
    for (const g of allResults) {
        const r = g.platform_data && g.platform_data[code];
        if (r && r.song_url === url) {
            targetRow = r;
            break;
        }
    }
    if (!targetRow) {
        showToast('未找到对应记录，请重新搜索后再试', 'error');
        return;
    }

    btn.disabled = true;
    btn.classList.add('spinning');
    try {
        const resp = await fetch('/api/refetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform_code: code, row: targetRow }),
        });
        const data = await resp.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
        // 更新本地数据并重新渲染
        const updated = data.row;
        for (const g of allResults) {
            const r = g.platform_data && g.platform_data[code];
            if (r && r.song_url === url) {
                g.platform_data[code] = { ...r, ...updated };
                break;
            }
        }
        renderResults();
        showToast(`${PLATFORM_NAMES[code]} 数据已重新抓取`, 'success');
    } catch (err) {
        console.error('Refetch error:', err);
        showToast('重抓失败，请检查网络', 'error');
    } finally {
        btn.disabled = false;
        btn.classList.remove('spinning');
    }
});

// ── 平台告警横幅 ──
function renderWarnings(warnings) {
    const box = document.getElementById('warningBox');
    if (!box) return;
    if (!warnings || warnings.length === 0) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }
    box.style.display = 'block';
    box.innerHTML = warnings.map(w => {
        const name = PLATFORM_NAMES[w.platform_code] || w.platform_code;
        return `<div class="warning-item"><span class="warning-icon">⚠</span><span><b>${name}</b>：${escapeHtml(w.message)}</span></div>`;
    }).join('');
}

// ── CSV 导出（聚合视图：每首歌一行，各平台数据横向展开）──
document.getElementById('exportBtn').addEventListener('click', () => {
    if (allResults.length === 0) return;
    const filtered = getVisibleRows();
    const headers = ['歌曲名', '歌手', '专辑', '发行时间', '词作者', '曲作者', '唱片公司'];
    PLATFORM_ORDER.forEach(code => {
        const name = PLATFORM_NAMES[code];
        headers.push(name + '-收藏', name + '-在听', name + '-评论', name + '-唱片公司', name + '-链接');
    });
    const rows = filtered.map(g => {
        const base = [
            g.song_name, g.performer, g.album, g.release_date || '',
            g.lyricist || '', g.composer || '', g.record_label || ''
        ];
        PLATFORM_ORDER.forEach(code => {
            const r = g.platform_data && g.platform_data[code];
            if (!r) {
                base.push('', '', '', '', '');
                return;
            }
            base.push(
                r.collection_count != null ? r.collection_count : '平台无数据',
                r.listening_count != null ? r.listening_count : '平台无数据',
                r.comment_count != null ? r.comment_count : '平台无数据',
                r.record_label || '平台无数据',
                r.song_url || ''
            );
        });
        return base;
    });
    const csv = [headers, ...rows].map(row =>
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `music_search_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出 CSV', 'success');
});

// ═══════════════════════════════════════════════
//  Cookie 设置
// ═══════════════════════════════════════════════

async function loadCookies() {
    await loadAppEnv();
    // 后端文件（~/.musicfinder/cookies.json）为权威来源；请求失败才回退到 localStorage
    let cookies = {};
    try {
        const resp = await fetch('/api/cookies');
        if (resp.ok) {
            const data = await resp.json();
            const cookiesMap = (data && data.cookies) || {};
            // 结构：{ cookies: { code: { platform, platform_code, cookie, has_cookie }, ... } }
            // 抽取成扁平的 { code: cookie }
            Object.keys(cookiesMap).forEach(code => {
                const entry = cookiesMap[code];
                if (entry && entry.cookie) {
                    cookies[code] = entry.cookie;
                }
            });
        } else {
            cookies = loadClientCookies();
        }
    } catch (e) {
        console.error('load server cookies error', e);
        cookies = loadClientCookies();
    }
    renderSettings(cookies);
}

function cookieManualHint(code) {
    const home = APP_ENV.login_home?.[code] || '#';
    const domain = PLATFORM_COOKIE_HELP[code].replace('从 ', '').replace(' 获取', '');
    // v4.25.8 重写小白版教程：用 Network 面板的 Cookie 字段一次拿到完整字符串，
    // 不再让用户逐条 Name=Value 复制拼接。
    return `
        <ol class="cookie-manual-steps">
            <li>点<a href="${home}" target="_blank" rel="noopener">打开登录页</a>，在新标签页里完成登录（密码 / 微信 / 手机号都行）</li>
            <li>登录成功后，<strong>先按一下 F5 / 刷新一下</strong>，让浏览器把登录信息完整记录下来</li>
            <li>按 <kbd>F12</kbd> 打开开发者工具，顶部切到 <strong>网络 / Network</strong> 标签</li>
            <li>左侧请求列表里<strong>随便点一条</strong>（第一条即可），右边出现的面板往下拉，在 <strong>Request Headers</strong> 区域里找一行 <code>Cookie:</code></li>
            <li><strong>双击</strong><code>Cookie:</code> 后面的整串字符让它全选，按 <kbd>Ctrl</kbd>+<kbd>C</kbd>（Mac 是 <kbd>⌘</kbd>+<kbd>C</kbd>）复制</li>
            <li>回到这一页，<strong>粘贴到上方文本框</strong>里，点「保存 Cookie」即可</li>
        </ol>
        <div class="cookie-manual-tip">
            <strong>一句话解释你要复制的东西：</strong>Cookie 是浏览器记住"你是谁"的小纸条，每次请求都会附给服务器。<code>Cookie:</code> 后面那串字符就是这些小纸条的合集，长得像
            <code>qqmusic_key=abc123; uin=12345; skey=xyz789; ...</code> —— 整段复制就行，不用管里面有什么。
            <br><br>
            <strong>怎么看自己复制对了？</strong>复制回来的文本应该<strong>很长</strong>（几百到几千字符），里头<strong>一定有</strong><code>;</code>（分号+空格）把一串串小段拼起来。如果只有几十个字符，说明你可能复制错了。
            <br><br>
            <strong>复制后到期了？</strong>Cookie 不是永久的，几天到几周会过期，到时候再按上面步骤重新复制一次即可。
            <br><br>
            <strong>更省事的办法（推荐）：</strong>如果你点的是卡片上的「浏览器登录」按钮（会弹出系统 Chrome 让你登录），登录成功后那个窗口<strong>顶部会出现一条红色横幅 + 一个白色按钮「✅ 我已登录，保存 Cookie」</strong>。看到自己头像出现了，<strong>直接点那个按钮</strong>就能一键存好，完全不用手动复制。密码 / 微信 / 手机号三种登录方式都认这个按钮。
        </div>
    `;
}

function renderSettings(cookies) {
    const list = $('#settingsList');
    list.innerHTML = '';

    const showBrowser = APP_ENV.show_browser_login && APP_ENV.playwright_available;
    PLATFORM_ORDER.forEach(code => {
        const cookie = cookies[code] || '';
        const has = Boolean(cookie);
        const card = document.createElement('div');
        card.className = 'cookie-card glass';
        card.innerHTML = `
            <div class="cookie-card-header">
                <span class="platform-dot" style="background:${PLATFORM_COLORS[code].accent}"></span>
                <span class="cookie-platform-name">${PLATFORM_NAMES[code]}</span>
                <span class="cookie-status ${has ? 'cookie-status-on' : 'cookie-status-off'}">
                    ${has ? '已配置' : '未配置'}
                </span>
            </div>
            <div class="cookie-card-body">
                <textarea class="cookie-input" id="cookie-${code}" placeholder="粘贴 ${PLATFORM_COOKIE_HELP[code]} 的 Cookie 值...">${escapeHtml(cookie)}</textarea>
                <div class="cookie-actions">
                    <span class="cookie-help">${PLATFORM_COOKIE_HELP[code]}</span>
                    <div class="cookie-btns">
                        ${showBrowser ? `<button class="cookie-login-btn" data-code="${code}">浏览器登录</button>` : ''}
                        <a class="cookie-login-link" href="${APP_ENV.login_home?.[code] || '#'}" target="_blank" rel="noopener">打开登录页</a>
                        <button class="cookie-test-btn" data-code="${code}">测试</button>
                        <button class="cookie-clear-btn" data-code="${code}">🗑 清空</button>
                        <button class="cookie-save-btn" data-code="${code}">保存</button>
                    </div>
                </div>
                <div class="cookie-unlock">登录后解锁：${PLATFORM_COOKIE_UNLOCKS[code]}</div>
                <div class="cookie-manual-hint" id="cookie-hint-${code}">${cookieManualHint(code)}</div>
                <div class="cookie-test-result" id="cookie-test-${code}"></div>
            </div>
        `;
        list.appendChild(card);
    });

    // 保存：写入后端本地文件（~/.musicfinder/cookies.json），并镜像到 localStorage
    list.querySelectorAll('.cookie-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.getAttribute('data-code');
            const value = $(`#cookie-${code}`).value.trim();
            try {
                const resp = await fetch('/api/cookies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform_code: code, cookie: value })
                });
                if (!resp.ok) {
                    const errData = await resp.json().catch(() => ({}));
                    throw new Error(errData.message || `HTTP ${resp.status}`);
                }
                // 成功后镜像到 localStorage，保持 UI 一致
                setClientCookie(code, value);
                const statusEl = btn.closest('.cookie-card').querySelector('.cookie-status');
                statusEl.className = `cookie-status ${value ? 'cookie-status-on' : 'cookie-status-off'}`;
                statusEl.textContent = value ? '已配置' : '未配置';
                showToast(`${PLATFORM_NAMES[code]} Cookie 已写入软件本地文件`, 'success');
            } catch (err) {
                console.error('save cookie error', err);
                showToast(`${PLATFORM_NAMES[code]} Cookie 保存失败：${err.message || '未知错误'}`, 'error');
            }
        });
    });

    // 清空：一键清除本平台 Cookie（v4.25.10 新增）
    list.querySelectorAll('.cookie-clear-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.getAttribute('data-code');
            const card = btn.closest('.cookie-card');
            const statusEl = card.querySelector('.cookie-status');
            const currentHas = statusEl.classList.contains('cookie-status-on');
            const confirmMsg = currentHas
                ? `确定清空 ${PLATFORM_NAMES[code]} 的 Cookie 吗？\n（清空后需要重新登录才能用相关功能）`
                : `${PLATFORM_NAMES[code]} 暂无 Cookie，无需清空`;
            if (!currentHas) {
                showToast(`${PLATFORM_NAMES[code]} 暂无 Cookie，无需清空`, 'info');
                return;
            }
            if (!confirm(confirmMsg)) return;
            btn.disabled = true;
            try {
                const resp = await fetch('/api/cookies/clear', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform_code: code })
                });
                const data = await resp.json();
                if (!resp.ok || !data.success) {
                    throw new Error(data.message || data.error || `HTTP ${resp.status}`);
                }
                // 同步 UI：清空 textarea、本地缓存、状态徽章
                $(`#cookie-${code}`).value = '';
                setClientCookie(code, '');
                statusEl.className = 'cookie-status cookie-status-off';
                statusEl.textContent = '未配置';
                showToast(data.message || `${PLATFORM_NAMES[code]} Cookie 已清空`, 'success');
            } catch (err) {
                console.error('clear cookie error', err);
                showToast(`清空失败：${err.message || '未知错误'}`, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    });

    // 浏览器登录：后台启动浏览器，前端轮询状态（避免长连接被切断）
    if (showBrowser) {
        list.querySelectorAll('.cookie-login-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const code = btn.getAttribute('data-code');
                const resultEl = $(`#cookie-test-${code}`);
                btn.disabled = true;
                resultEl.innerHTML = '<span class="cookie-testing">正在打开浏览器，请在弹出的窗口中登录…</span>';
                try {
                    const resp = await fetch(`/api/login/${code}`, { method: 'POST' });
                    const data = await resp.json();
                    if (!data.started) {
                        resultEl.innerHTML = `<span class="cookie-test-fail">✗ ${data.message || '启动失败'}</span>`;
                        btn.disabled = false;
                        return;
                    }
                } catch (err) {
                    resultEl.innerHTML = '<span class="cookie-test-fail">✗ 无法连接服务器（可改用「打开登录页」手动获取）</span>';
                    btn.disabled = false;
                    return;
                }
                // 轮询登录状态
                const poll = async () => {
                    try {
                        const s = await (await fetch(`/api/login/status/${code}`)).json();
                        if (s.running) {
                            resultEl.innerHTML = `<span class="cookie-testing">${s.message || '登录中…'}</span>`;
                            setTimeout(poll, 2000);
                        } else {
                            if (s.success) {
                                resultEl.innerHTML = `<span class="cookie-test-ok">✓ ${s.message}</span>`;
                                showToast(s.message, 'success');
                                if (s.cookie) {
                                    setClientCookie(code, s.cookie);
                                    $(`#cookie-${code}`).value = s.cookie;
                                }
                                const statusEl = btn.closest('.cookie-card').querySelector('.cookie-status');
                                statusEl.className = 'cookie-status cookie-status-on';
                                statusEl.textContent = '已配置';
                            } else {
                                resultEl.innerHTML = `<span class="cookie-test-fail">✗ ${s.message}（可改用「打开登录页」手动获取）</span>`;
                            }
                            btn.disabled = false;
                        }
                    } catch (e) {
                        resultEl.innerHTML = '<span class="cookie-test-fail">✗ 状态获取失败（可改用「打开登录页」手动获取）</span>';
                        btn.disabled = false;
                    }
                };
                setTimeout(poll, 1500);
            });
        });
    }

    // 测试：使用当前文本框里的 Cookie，发送给后端测试
    list.querySelectorAll('.cookie-test-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.getAttribute('data-code');
            btn.disabled = true;
            btn.textContent = '测试中...';
            const resultEl = $(`#cookie-test-${code}`);
            resultEl.innerHTML = '<span class="cookie-testing">正在测试...</span>';
            const value = $(`#cookie-${code}`).value.trim();
            try {
                const resp = await fetch('/api/cookies/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platform_code: code,
                        cookies: value ? { [code]: value } : {},
                    }),
                });
                const data = await resp.json();
                if (data.valid) {
                    resultEl.innerHTML = `<span class="cookie-test-ok">✓ ${data.message}</span>`;
                } else {
                    resultEl.innerHTML = `<span class="cookie-test-fail">✗ ${data.message}</span>`;
                }
            } catch (err) {
                resultEl.innerHTML = '<span class="cookie-test-fail">✗ 测试失败</span>';
            } finally {
                btn.disabled = false;
                btn.textContent = '测试';
            }
        });
    });
}

// ── 工具函数 ──
function hideResults() {
    resultsSection.style.display = 'none';
}

function showToast(msg, type = '') {
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.className = 'toast';
    }, 2800);
}

function formatCount(n) {
    // 完整数字展示 + 千分位逗号，数值精确、便于比对
    if (n === null || n === undefined || n === '') return '—';
    return Number(n).toLocaleString('en-US');
}

function formatCompactCount(n) {
    // 紧凑展示：平台单元格空间极小，用中文单位缩写
    if (n === null || n === undefined || n === '') return '—';
    const num = Number(n);
    if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return num.toLocaleString('en-US');
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// v4.25.1：attribute 上下文安全的转义 —— escapeHtml 不转 "，放在 data-mkey="..." 会提前关闭引号
function escapeAttr(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── spinner 样式 ──
const style = document.createElement('style');
style.textContent = `
.btn-spinner {
    width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 表头排序 */
th.sortable { cursor: pointer; user-select: none; white-space: nowrap; transition: color 0.15s; }
th.sortable:hover { color: #7c9cff; }
th.sortable::after {
    content: ''; display: inline-block; margin-left: 5px;
    font-size: 9px; line-height: 1; opacity: 0.3; transition: opacity 0.15s;
}
th.sortable.sort-asc::after { content: '▲'; opacity: 1; }
th.sortable.sort-desc::after { content: '▼'; opacity: 1; }
`;
document.head.appendChild(style);

// ═══════════════════════════════════════════════════════════════════════
//  歌词段落识别 & 音频识别（都放在第一页，结果统一进表格）
// ═══════════════════════════════════════════════════════════════════════
const lyricInput = document.getElementById('lyricInput');
const lyricSameSound = document.getElementById('lyricSameSound');
const lyricIdentifyBtn = document.getElementById('lyricIdentifyBtn');
const lyricClearBtn = document.getElementById('lyricClearBtn');
const lyricStatus = document.getElementById('lyricStatus');

function lyricPlatColor(code) {
    const c = (typeof PLATFORM_COLORS !== 'undefined' && PLATFORM_COLORS[code]) || null;
    return c ? c.accent : '#888';
}

function lyricTypeClass(mtype) {
    return mtype === 'precise' ? 'lyric-tag precise'
        : mtype === 'same' ? 'lyric-tag same'
        : 'lyric-tag fragment';
}

function lyricFmtNum(n) {
    if (n == null || n === '') return '—';
    const v = Number(n);
    return isNaN(v) ? String(n) : v.toLocaleString('zh-CN');
}

function lyricPickLabel(row) {
    if (!row) return '';
    if (row.record_label) return row.record_label;
    const pd = row.platform_data || {};
    for (const code of PLATFORM_ORDER) {
        if (pd[code] && pd[code].record_label) return pd[code].record_label;
    }
    return '';
}

function lyricMaxCollection(row) {
    const pd = (row && row.platform_data) || {};
    let max = null, at = '';
    PLATFORM_ORDER.forEach(code => {
        const r = pd[code];
        if (r && r.collection_count != null) {
            const n = Number(r.collection_count);
            if (max == null || n > max) { max = n; at = PLATFORM_NAMES[code] || code; }
        }
    });
    return { max, at };
}

// 把歌词/音频识别候选转换成第一页表格用的「聚合行」格式
function candidateToRow(cand, inputExcerpt, source) {
    const code = cand.platform_code;
    const platformData = {};
    if (code) {
        platformData[code] = {
            collection_count: null,
            listening_count: null,
            comment_count: null,
            record_label: '',
            release_date: '',
            song_url: cand.song_url || '',
        };
    }
    return {
        song_name: cand.song_name || '未知',
        performer: cand.performer || '',
        album: '',
        release_date: '',
        lyricist: '',
        composer: '',
        record_label: '',
        platform_data: platformData,
        match_score: source === 'lyric' ? 999 : (cand.match_score || 900),
        match_label: cand.match_label || '歌词匹配',
        hearts: [],
        mark: cand.mark || null,
        suspect_tags: cand.suspect_tags || [],
        _match_source: source,
        _input_excerpt: inputExcerpt || '',
        _snippet: cand.snippet || '',
        _needs_enrich: true,
        _enriched: false,
    };
}

function renderSuspectTags(tags) {
    if (!tags || !tags.length) return '<span class="cell-empty">—</span>';
    return '<div class="suspect-tags">' + tags.map(t => {
        let cls = '';
        if (t.includes('疑似') || t.includes('异常')) cls = '';
        else if (t.includes('低') || t.includes('无') || t.includes('单一')) cls = 'warn';
        else cls = 'info';
        return '<span class="suspect-tag ' + cls + '">' + escapeHtml(t) + '</span>';
    }).join('') + '</div>';
}

function renderMatchSource(row) {
    const src = row._match_source || 'song';
    const labels = { song: '歌名搜索', lyric: '歌词识别' };
    return '<span class="match-source-badge ' + src + '">' + escapeHtml(labels[src] || src) + '</span>';
}

// 歌词识别：调用新版多候选接口，结果统一进表格
async function doLyricSearch() {
    const text = lyricInput.value.trim();
    if (!text) {
        showToast('请先粘贴歌词文本', 'error');
        lyricInput.focus();
        return;
    }
    const paras = text.split(/\n\s*\n/).filter(p => p.trim());
    if (!paras.length) {
        showToast('未检测到歌词段落', 'error');
        return;
    }

    lyricIdentifyBtn.disabled = true;
    lyricIdentifyBtn.innerHTML = '<div class="btn-spinner"></div><span>识别中…（共 ' + paras.length + ' 段）</span>';
    lyricStatus.textContent = '正在按同一首歌反查全部版本，并自动补全五平台数据…';
    setPlatformStripSearching();
    showTableSkeleton();

    try {
        const resp = await fetch('/api/lyric-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                options: { same_sound: lyricSameSound.checked, per_platform: 15, max_candidates: 15 },
            }),
        });
        const data = await resp.json();
        if (data.error) {
            showToast(data.error, 'error');
            hideResults();
            return;
        }

        const rows = [];
        (data.results || []).forEach(row => {
            // 后端已按歌曲聚合并自动补全五平台数据
            row._match_source = 'lyric';
            row._needs_enrich = false;
            row._enriched = true;
            if (!row.platform_data) row.platform_data = {};
            if (!row.hearts) row.hearts = [];
            rows.push(row);
        });

        flatResults = [];
        allResults = rows;
        // 平台状态条：按候选里的平台简单统计
        const counts = { qq:0, kugou:0, kuwo:0, netease:0, qishui:0 };
        rows.forEach(r => Object.keys(r.platform_data || {}).forEach(c => counts[c]++));
        updatePlatformStrip([
            { platform_code:'qq', count:counts.qq, status:counts.qq?'success':'no_result' },
            { platform_code:'kugou', count:counts.kugou, status:counts.kugou?'success':'no_result' },
            { platform_code:'kuwo', count:counts.kuwo, status:counts.kuwo?'success':'no_result' },
            { platform_code:'netease', count:counts.netease, status:counts.netease?'success':'no_result' },
            { platform_code:'qishui', count:counts.qishui, status:counts.qishui?'success':'no_result' },
        ]);
        renderWarnings([]);
        renderResults();
        updateFilterCounts();
        const topSong = rows.length ? (rows[0].song_name || '') : '';
        lyricStatus.textContent = rows.length
            ? '识别为《' + topSong + '》，共找到 ' + rows.length + ' 个版本（已自动补全平台数据）'
            : '五平台均未匹配到这段歌词';
    } catch (err) {
        console.error('Lyric search error:', err);
        if (err && (err.name === 'AbortError' || err instanceof TypeError)) {
            showToast('识别请求失败，请检查网络后重试', 'error');
        } else {
            showToast('识别出错：' + (err && err.message ? err.message : '未知错误'), 'error');
        }
        hideResults();
    } finally {
        lyricIdentifyBtn.disabled = false;
        lyricIdentifyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>识别歌曲版本</span>';
    }
}

lyricIdentifyBtn.addEventListener('click', doLyricSearch);

lyricClearBtn.addEventListener('click', () => {
    lyricInput.value = '';
    lyricStatus.textContent = '';
    lyricInput.focus();
});

// 表格内「查平台数据」：对歌词/音频识别的候选做补全
async function enrichCandidate(rowEl) {
    const idx = Number(rowEl.getAttribute('data-idx'));
    const g = getVisibleRows()[idx];
    if (!g || !g._needs_enrich || g._enriching) return;
    g._enriching = true;
    const btn = rowEl.querySelector('.enrich-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="btn-spinner" style="width:14px;height:14px;border-width:2px"></div> 取数'; }

    try {
        const resp = await fetch('/api/enrich', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                song_name: g.song_name,
                performer: g.performer,
                limit: 20,
                cookies: getClientCookiesForRequest(),
            }),
        });
        const data = await resp.json();
        g._enriching = false;
        if (data && data.ok && data.row) {
            const enriched = data.row;
            // 保留匹配来源和输入片段
            enriched._match_source = g._match_source;
            enriched._input_excerpt = g._input_excerpt;
            enriched._snippet = g._snippet;
            enriched._needs_enrich = false;
            enriched._enriched = true;
            // 替换当前行数据（保持对象引用，让 allResults 同步）
            Object.assign(g, enriched);
            renderResults();
            showToast('已取到五平台数据');
        } else {
            g._enrichFail = (data && (data.reason || data.error)) || '未获取到平台数据';
            if (btn) { btn.disabled = false; btn.textContent = '重试取数'; }
        }
    } catch (e) {
        g._enriching = false;
        g._enrichFail = '网络错误';
        if (btn) { btn.disabled = false; btn.textContent = '重试取数'; }
    }
}

// 表格内点击「查平台数据」
resultsBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.enrich-btn');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (tr) enrichCandidate(tr);
});

// v4.15：搜索结果行内📌按钮 → 固定 / 取消固定这行（复用歌单页 pin API）
resultsBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.pin-btn');
    if (!btn) return;
    e.stopPropagation();
    const tr = btn.closest('.pl-card') || btn.closest('tr');
    if (!tr) return;
    const idx = parseInt(btn.getAttribute('data-idx') || '-1', 10);
    const g = allResults[idx];
    if (!g) return;
    const willPin = !btn.classList.contains('is-pinned');
    // 乐观更新（按钮态 + 徽章态 + grp._pinned 状态）
    btn.classList.toggle('is-pinned', willPin);
    const newTitle = willPin
        ? '已固定（点此取消固定）'
        : '固定这行：把 5 平台 ID 一起存档';
    btn.title = newTitle;
    // v4.16：卡片模式下徽章挂在 .pl-card-head；表格模式下挂在 .song-name-row
    const snr = tr.querySelector('.song-name-row');
    const badgeHost = snr || tr.querySelector('.pl-card-head');
    if (willPin) {
        if (badgeHost && !badgeHost.querySelector('.pin-badge')) {
            const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
            const badge = document.createElement('span');
            badge.className = 'pin-badge';
            badge.title = `已加入固定清单（${nowStr}）；5 平台 ID 已存档，可一键刷新`;
            badge.textContent = '🔖 已固定';
            badgeHost.appendChild(badge);
        }
    } else {
        const badge = tr.querySelector('.pin-badge');
        if (badge) badge.remove();
    }
    g._pinned = willPin
        ? { pin_id: '', pinned_at: new Date().toLocaleString('zh-CN', { hour12: false }), version_key: '' }
        : false;
    const url = '/api/playlist/' + (willPin ? 'pin' : 'unpin');
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry: g }),
    }).then(r => r.json()).then(j => {
        if (!j.ok && !j.already) throw new Error(j.error || '失败');
        // 成功后回填 version_key，方便 unpin/去重
        if (willPin && g._pinned && typeof g._pinned === 'object') {
            // 后端会算真实 version_key → 通过 GET /api/playlist/pins 拉一次成本太高，
            // 简单回填：直接用 grp._pinned 在 _group_results 下次跑时会被刷新
            g._pinned.version_key = j.pin && j.pin.version_key ? j.pin.version_key : '';
        }
        if (typeof showToast === 'function') showToast(willPin ? '已固定（可在我的歌单页查看）' : '已取消固定', '');
    }).catch(err => {
        // 回滚
        btn.classList.toggle('is-pinned', !willPin);
        btn.title = newTitle;
        if (willPin) {
            const badge = tr.querySelector('.pin-badge');
            if (badge) badge.remove();
        } else {
            if (badgeHost) {
                const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
                badgeHost.insertAdjacentHTML('beforeend', `<span class="pin-badge" title="已加入固定清单（${nowStr}）">🔖 已固定</span>`);
            }
        }
        g._pinned = willPin ? false : { pin_id: '', pinned_at: '', version_key: '' };
        if (typeof showToast === 'function') showToast('固定操作失败：' + err.message, 'err');
    });
});


// 全局批量任务进度条已移除（v4.25.20）：进度请到「批量歌单」页查看
