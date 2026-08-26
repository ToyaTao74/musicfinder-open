// ═══════════════════════════════════════════════════
//  批量歌单工具页交互逻辑
// ═══════════════════════════════════════════════════
(function () {
    'use strict';

    // ── 主题切换（与首页一致） ──
    const THEME_KEY = 'theme';
    const html = document.documentElement;
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) html.setAttribute('data-theme', saved);
    const themeToggle = document.getElementById('themeToggle');
    // 仅独立 /batch 页自行处理主题；首页由 app.js 统一接管，避免重复绑定导致切换失效
    if (themeToggle && window.location.pathname === '/batch') {
        themeToggle.addEventListener('click', function () {
            const cur = html.getAttribute('data-theme');
            const next = cur === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', next);
            localStorage.setItem(THEME_KEY, next);
        });
    }

    const PLATFORMS = [
        { code: 'qq', name: 'QQ音乐' },
        { code: 'kugou', name: '酷狗' },
        { code: 'kuwo', name: '酷我' },
        { code: 'netease', name: '网易云' },
        { code: 'qishui', name: '汽水' },
    ];

    const songInput = document.getElementById('songInput');
    const songCount = document.getElementById('songCount');
    const runBtn = document.getElementById('runBtn');
    const loadDemoBtn = document.getElementById('loadDemoBtn');
    const concurrencySel = document.getElementById('concurrency');
    const concurrencyWrap = document.getElementById('concurrencyWrap');
    const progressWrap = document.getElementById('progressWrap');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const resultSection = document.getElementById('resultSection');
    const resultHead = document.getElementById('resultHead');
    const resultBody = document.getElementById('resultBody');
    const downloadBtn = document.getElementById('downloadBtn');

    // v2 批量任务模式
    const v2Toggle = document.getElementById('v2Toggle');
    const v2Dashboard = document.getElementById('v2Dashboard');
    const v2TaskName = document.getElementById('v2TaskName');
    const v2TaskId = document.getElementById('v2TaskId');
    const v2BarFill = document.getElementById('v2BarFill');
    const v2Done = document.getElementById('v2Done');
    const v2Failed = document.getElementById('v2Failed');
    const v2Total = document.getElementById('v2Total');
    const v2Pct = document.getElementById('v2Pct');
    const v2Speed = document.getElementById('v2Speed');
    const v2Eta = document.getElementById('v2Eta');
    const v2StatusDot = document.getElementById('v2StatusDot');
    const v2StatusText = document.getElementById('v2StatusText');
    const v2Errors = document.getElementById('v2Errors');
    const v2ErrorsBody = document.getElementById('v2ErrorsBody');
    const v2ExportBtn = document.getElementById('v2ExportBtn');
    const v2CancelBtn = document.getElementById('v2CancelBtn');
    // v4.27.7 新增：实时追加区 + 下一首歌
    const v2Nowline = document.getElementById('v2Nowline');
    const v2NextSong = document.getElementById('v2NextSong');
    const v2OngoingCount = document.getElementById('v2OngoingCount');
    const v2RecentCount = document.getElementById('v2RecentCount');
    const v2RecentFoot = document.getElementById('v2RecentFoot');
    const v2RecentScroll = document.getElementById('v2RecentScroll');
    const v2RecentFootText = document.getElementById('v2RecentFootText');
    const v2ExportBtn2 = document.getElementById('v2ExportBtn2');

    // 文件上传相关
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const uploadInner = document.getElementById('uploadInner');
    const uploadMeta = document.getElementById('uploadMeta');
    const upFileName = document.getElementById('upFileName');
    const upCount = document.getElementById('upCount');
    const upClear = document.getElementById('upClear');

    let lastResults = null; // 用于下载

    // ── 解析输入为歌单数组 ──
    function parseSongs(text) {
        const lines = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const songs = [];
        for (const line of lines) {
            // 优先按逗号/制表符/中文逗号/顿号分割
            let parts = line.split(/[,，\t、]/).map(s => s.trim()).filter(Boolean);
            // 若只有一个片段，尝试按多个空白分割
            if (parts.length <= 1) {
                parts = line.split(/\s+/).map(s => s.trim()).filter(Boolean);
            }
            if (!parts.length) continue;
            const song_name = parts[0];
            if (!song_name) continue;
            songs.push({
                song_name: song_name,
                performer: parts[1] || '',
                lyricist: parts[2] || '',
                composer: parts[3] || '',
            });
        }
        return songs;
    }

    function updateCount() {
        const n = parseSongs(songInput.value).length;
        songCount.textContent = n;
        // ≥500 首自动切到 v2（同步模式跑不动；v2 后台 worker + SQLite 持久化）
        if (n >= 500 && v2Toggle && !v2Toggle.checked) {
            v2Toggle.checked = true;
            v2Toggle.disabled = true;  // 锁住，不让切回同步
            v2Toggle.parentElement.classList.add('v2-locked');
            v2Toggle.parentElement.title = '≥500 首已自动启用 v2 模式（断点续跑），不可切回同步';
        } else if (n < 500 && v2Toggle && v2Toggle.disabled) {
            v2Toggle.disabled = false;
            v2Toggle.parentElement.classList.remove('v2-locked');
            v2Toggle.parentElement.title = '≥500 首建议开启：上传即返回，关闭浏览器/电脑也不丢，进度可实时查';
        }
        syncV2ModeUi();
    }

    function syncV2ModeUi() {
        const v2 = v2Toggle && v2Toggle.checked;
        // v2 模式下隐藏并发选择（v2 由服务端池大小控制，不可调）
        if (concurrencyWrap) concurrencyWrap.style.display = v2 ? 'none' : '';
        // v2 模式下隐藏旧的同步进度条（v2 用自己的 dashboard）。
        // 否则会出现"顶部卡在『准备查询 2283 首…』+ 下面 v2 dashboard 一起显示"的双 UI 鬼影。
        if (v2 && progressWrap) {
            progressWrap.hidden = true;
            // 顺手把 progressText 复位，下次切回 v1 时不会显示"准备查询 …首"
            if (progressText) progressText.textContent = '准备查询…';
        }
    }

    if (v2Toggle) {
        v2Toggle.addEventListener('change', syncV2ModeUi);
    }

    songInput.addEventListener('input', updateCount);

    if (loadDemoBtn) {
        loadDemoBtn.addEventListener('click', function () {
            songInput.value = [
                '因为有你,张蔷',
                '秋天的玫瑰,张蔷',
                '空白,张蔷',
                '潇洒地走,张蔷',
                '尽情飞扬,张蔷',
            ].join('\n');
            updateCount();
        });
    }

    // ── 文件上传：解析 Excel / Word 为歌单并填充输入框 ──
    function songsToText(songs) {
        return songs.map(s => {
            const parts = [s.song_name, s.performer || '', s.lyricist || '', s.composer || ''];
            while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
            return parts.join(',');
        }).join('\n');
    }

    async function handleFile(file) {
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        uploadInner.style.opacity = '0.5';
        try {
            const resp = await fetch('/api/batch_upload', { method: 'POST', body: fd });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '解析失败');
            songInput.value = songsToText(data.songs);
            updateCount();
            uploadInner.style.display = 'none';
            uploadMeta.hidden = false;
            upFileName.textContent = data.file_name;
            // v4.27.4：已识别数从「textContent」改为「innerHTML」，大文件下加粗 + 显式提示 v2 后台模式
            const n = data.total;
            const huge = n > 500;
            upCount.innerHTML = huge
                ? '已识别 <b>' + n + '</b> 首 · 直接点「开始查询」即可<br>' +
                  '<span style="font-size:11px;opacity:.7">≥500 首自动启用 v2 后台 worker：关浏览器/电脑也能继续，进度实时显示在下方</span>'
                : '已识别 <b>' + n + '</b> 首 · 可直接点「开始查询」';
        } catch (e) {
            alert('文件解析失败：' + e.message);
        } finally {
            uploadInner.style.opacity = '1';
        }
    }

    if (uploadInner) {
        uploadInner.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
            if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
        });
        uploadZone.addEventListener('dragover', function (e) { e.preventDefault(); uploadZone.classList.add('drag'); });
        uploadZone.addEventListener('dragleave', function () { uploadZone.classList.remove('drag'); });
        uploadZone.addEventListener('drop', function (e) {
            e.preventDefault();
            uploadZone.classList.remove('drag');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
        });
        upClear.addEventListener('click', function () {
            fileInput.value = '';
            songInput.value = '';
            updateCount();
            uploadMeta.hidden = true;
            uploadInner.style.display = '';
        });
    }

    // ── 渲染表头 ──
    function renderHead() {
        let th = '<th class="col-song">歌名 / 表演者</th>';
        for (const p of PLATFORMS) {
            th += `<th>${p.name}<br><span style="opacity:.55;font-weight:400;font-size:10px">收藏/在听/评论/发行公司</span></th>`;
        }
        resultHead.innerHTML = `<tr>${th}</tr>`;
    }

    function fmt(v) {
        if (v === null || v === undefined || v === '') return '<span class="empty-cell">—</span>';
        return Number(v).toLocaleString('en-US');
    }

    function tagHtml(label) {
        if (!label) return '<span class="tag-none">—</span>';
        if (label.indexOf('精准匹配') !== -1) return `<span class="tag-exact">${label}</span>`;
        if (label.indexOf('其他') !== -1) return `<span class="tag-other">${label}</span>`;
        if (label === '无结果' || label.indexOf('低相关') !== -1 || label.indexOf('失败') !== -1)
            return `<span class="tag-none">${label}</span>`;
        return `<span class="tag-other">${label}</span>`;
    }

    function renderBody(results) {
        let rows = '';
        for (const r of results) {
            const plats = r.platforms || {};
            const songCell = `<td class="col-song">${r.song_name}<br><span style="opacity:.55;font-size:11px">${r.performer || ''}</span></td>`;
            let cells = '';
            for (const p of PLATFORMS) {
                const d = plats[p.code] || {};
                const cc = d.collection_count, lc = d.listening_count, cm = d.comment_count;
                const brand = d.record_label || '';
                const counts = [fmt(cc), fmt(lc), fmt(cm)].join(' / ');
                cells += `<td>
                    <div>${counts}</div>
                    <div class="col-brand" style="font-size:11px;opacity:.8;margin-top:3px">${brand ? escapeHtml(brand) : '<span class="empty-cell">—</span>'}</div>
                    <div style="margin-top:3px">${tagHtml(d.match_label)}</div>
                </td>`;
            }
            rows += `<tr>${songCell}${cells}</tr>`;
        }
        resultBody.innerHTML = rows;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ── 开始查询 ──
    runBtn.addEventListener('click', async function () {
        const songs = parseSongs(songInput.value);
        if (!songs.length) {
            alert('请至少输入一首歌（含歌名）');
            return;
        }
        // 搜索前确认已配置音乐平台 Cookie（空白则引导去登录）；不阻塞已有 Cookie 的用户
        if (typeof _ensureSearchCookies === 'function' && !(await _ensureSearchCookies())) return;
        let v2Mode = v2Toggle && v2Toggle.checked;
        // 双保险：≥500 首强制走 v2（同步模式一次性 fetch 会卡死在"准备查询"，且无取消能力）
        if (songs.length >= 500 && v2Toggle) {
            v2Toggle.checked = true;
            v2Toggle.disabled = true;
            v2Mode = true;
        }

        if (v2Mode) {
            await runV2Batch(songs);
        } else {
            await runSyncBatch(songs);
        }
    });

    // ── 同步模式（小批量，即时返回） ──
    let syncAbort = null;
    async function runSyncBatch(songs) {
        runBtn.disabled = true;
        progressWrap.hidden = false;
        resultSection.hidden = true;
        progressFill.style.width = '8%';
        progressText.textContent = `准备查询 ${songs.length} 首…`;

        syncAbort = new AbortController();
        try {
            const resp = await fetch('/api/batch_search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    songs: songs,
                    concurrency: parseInt(concurrencySel.value, 10) || 6,
                }),
                signal: syncAbort.signal,
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || ('请求失败 ' + resp.status));
            }
            progressFill.style.width = '100%';
            progressText.textContent = `完成，共 ${songs.length} 首`;

            const data = await resp.json();
            lastResults = data.results;
            renderHead();
            renderBody(data.results);
            resultSection.hidden = false;
        } catch (e) {
            if (e.name === 'AbortError') {
                progressText.textContent = '已取消查询';
            } else {
                progressText.textContent = '查询出错：' + e.message;
                alert('查询失败：' + e.message);
            }
        } finally {
            syncAbort = null;
            runBtn.disabled = false;
            setTimeout(() => { progressWrap.hidden = true; }, 1500);
        }
    }

    const syncCancelBtn = document.getElementById('syncCancelBtn');
    if (syncCancelBtn) {
        syncCancelBtn.addEventListener('click', function () {
            if (syncAbort) {
                syncAbort.abort();
                syncCancelBtn.textContent = '取消中…';
                setTimeout(() => { syncCancelBtn.textContent = '✕ 取消'; }, 1000);
            }
        });
    }

    // ── v2 批量任务模式（异步、SQLite 持久化、断点续跑） ──
    let v2PollTimer = null;
    let v2CurrentTaskId = null;
    let v2CurrentStatus = null;
    // v4.27.7 实时追加：上次拉到的最大 idx（增量拉取用）+ 已渲染行数（性能控制）
    let v2LastMaxIdx = -1;
    let v2TotalRendered = 0;
    const V2_MAX_RENDER_ROWS = 500;  // 表格最多渲染 500 行防卡；超了提示去 Excel

    async function runV2Batch(songs) {
        runBtn.disabled = true;
        runBtn.querySelector('span').textContent = '提交中…';
        // 兜底：v2 启动时再次清掉 v1 引擎的旧进度条，防止"准备查询…"鬼影
        if (progressWrap) progressWrap.hidden = true;

        try {
            const fd = new FormData();
            // 文件模式下走 server-side 文件解析；这里没文件直接走 json
            const resp = await fetch('/api/batch_v2_submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ songs: songs, name: '批量任务' }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || ('提交失败 ' + resp.status));
            }
            const data = await resp.json();
            v2CurrentTaskId = data.task_id;
            showV2Dashboard(data);
            startV2Polling();
        } catch (e) {
            alert('提交失败：' + e.message);
        } finally {
            runBtn.disabled = false;
            runBtn.querySelector('span').textContent = '开始查询';
        }
    }

    function showV2Dashboard(data) {
        v2Dashboard.hidden = false;
        v2TaskName.textContent = data.name || '—';
        v2TaskId.textContent = data.task_id;
        v2Total.textContent = data.total;
        v2Done.textContent = 0;
        v2Failed.textContent = 0;
        v2Pct.textContent = '0%';
        v2BarFill.style.width = '0%';
        v2Speed.textContent = '—';
        v2Eta.textContent = '—';
        v2StatusDot.className = 'v2-status-dot pending';
        v2StatusText.textContent = '正在启动…';
        v2Errors.hidden = true;
        v2ErrorsBody.innerHTML = '';
        v2ExportBtn.disabled = true;
        v2CancelBtn.disabled = false;
        // v4.27.7：实时结果表格重置
        v2LastMaxIdx = -1;
        v2TotalRendered = 0;
        if (v2RecentBody) {
            v2RecentBody.innerHTML = '<tr><td colspan="7" class="v2-recent-empty">worker 一首歌搞定后会自动追加到这里…</td></tr>';
        }
        if (v2RecentCount) v2RecentCount.textContent = '0';
        if (v2RecentFoot) v2RecentFoot.hidden = true;
        if (v2NextSong) v2NextSong.textContent = '—';
        if (v2OngoingCount) v2OngoingCount.textContent = '';
        if (v2Nowline) v2Nowline.classList.remove('done');
        v2Dashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function startV2Polling() {
        stopV2Polling();
        // 状态轮询 3s，结果增量 2s（结果追加要更灵敏）
        v2PollTimer = setInterval(pollV2Tick, 2000);
        pollV2Tick();  // 立刻拉一次
    }

    function stopV2Polling() {
        if (v2PollTimer) { clearInterval(v2PollTimer); v2PollTimer = null; }
    }

    /** 同时拉 status + 增量 results（合并成一次 fetch 链） */
    async function pollV2Tick() {
        if (!v2CurrentTaskId) return;
        try {
            const resp = await fetch('/api/batch_v2_status/' + v2CurrentTaskId);
            if (!resp.ok) return;
            const s = await resp.json();
            renderV2Status(s);
            // 同一 tick 拉一次增量结果
            pollV2Results(s).catch(() => {});
        } catch (e) { /* 静默 */ }
    }

    /** 增量拉取已完成结果，追加到 v2RecentBody 末尾 */
    async function pollV2Results(curStatus) {
        if (!v2CurrentTaskId) return;
        // 已超过渲染上限就不再追加（避免 2283 行的 DOM 节点让浏览器卡）
        if (v2TotalRendered >= V2_MAX_RENDER_ROWS) return;
        const limit = V2_MAX_RENDER_ROWS - v2TotalRendered;
        try {
            const resp = await fetch('/api/batch_v2_results/' + v2CurrentTaskId + '?since_idx=' + v2LastMaxIdx + '&limit=' + limit);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.rows && data.rows.length) {
                appendResultRows(data.rows);
                if (data.max_idx > v2LastMaxIdx) v2LastMaxIdx = data.max_idx;
            }
            // 全量计数（无视表格只显示 500 行）：让用户知道总共查到了多少首
            const done = data.done || 0;
            if (v2RecentCount) v2RecentCount.textContent = String(done);
            // 已到上限 + 还有剩余：显示底部提示
            if (v2RecentFoot) {
                const hitCap = v2TotalRendered >= V2_MAX_RENDER_ROWS;
                const hasMore = done > v2TotalRendered;
                if (hitCap && hasMore) {
                    v2RecentFoot.hidden = false;
                    if (v2RecentFootText) v2RecentFootText.textContent = `表格已显示前 ${V2_MAX_RENDER_ROWS} 首（共 ${done} 首），其余请下载 Excel 查看`;
                } else if (hasMore === false && done > 0) {
                    v2RecentFoot.hidden = false;
                    if (v2RecentFootText) v2RecentFootText.textContent = `✅ 共 ${done} 首已全部显示在表格里`;
                } else {
                    v2RecentFoot.hidden = true;
                }
            }
        } catch (e) { /* 静默 */ }
    }

    function renderV2Status(s) {
        v2CurrentStatus = s.status;
        const total = s.total || 0;
        const done = Math.min(s.done || 0, total);
        v2Done.textContent = done;
        v2Failed.textContent = s.failed || 0;
        v2Total.textContent = total;
        const pct = Math.min(100, s.progress_pct || 0);
        v2Pct.textContent = pct + '%';
        v2BarFill.style.width = pct + '%';
        v2Speed.textContent = (s.speed_per_min && s.speed_per_min > 0) ? s.speed_per_min : '—';
        v2Eta.textContent = formatEta(s.eta_sec);
        // 「下一首」区域 —— 这是用户视角上 v2 dashboard 的灵魂
        renderNextSong(s);
        // 状态
        v2StatusDot.className = 'v2-status-dot ' + (s.status || 'pending');
        const STATUS_TEXT = {
            pending:   '排队中…',
            running:   `运行中 · 速度 ${(s.speed_per_min||0).toFixed(1)} 首/分钟`,
            completed: '已完成',
            cancelled: '已取消',
            failed:    '失败',
        };
        // 网易云是独立的第二阶段（匿名慢速池），QQ/酷狗 跑完后它还在后台补。
        // 这时候不能显示「已完成」也不能停轮询，否则用户会下到网易云列全空的表。
        const neTotal = s.netease_total || 0;
        const neDone = s.netease_done || 0;
        const nePending = s.status === 'completed' && neTotal > 0 && neDone < neTotal;
        if (nePending) {
            v2StatusDot.className = 'v2-status-dot running';
            v2StatusText.textContent = `QQ/酷狗已完成 · 网易云补齐中 ${neDone}/${neTotal}`;
        } else if (s.status === 'completed' && s.finalized) {
            // 收尾完成：未收录的歌按实事求是留空（NULL），绝不填 0
            v2StatusDot.className = 'v2-status-dot completed';
            v2StatusText.textContent = '✅ 已完成（未收录的歌留空 NULL，已 2 次确认，未填 0）';
        } else if (s.status === 'running' || s.status === 'pending') {
            v2StatusText.textContent = `${STATUS_TEXT[s.status]} · 已识别 ${done}/${total}（${pct}%）`;
        } else {
            v2StatusText.textContent = STATUS_TEXT[s.status] || s.status;
        }
        // 收尾/进度提示：明确告诉用户「空格=未收录=NULL」，区分已确认 vs 可能限流
        const fnEl = document.getElementById('v2FinalizeNote');
        if (fnEl) {
            const cov = s.coverage || {};
            const totFn = (cov.qq?.favnull||0) + (cov.kugou?.favnull||0) + (cov.netease?.favnull||0);
            const totCn = (cov.qq?.confirmed_null||0) + (cov.kugou?.confirmed_null||0) + (cov.netease?.confirmed_null||0);
            const totUn = (cov.qq?.unknown_null||0) + (cov.kugou?.unknown_null||0) + (cov.netease?.unknown_null||0);
            if (s.status === 'completed' && s.finalized) {
                fnEl.hidden = false;
                fnEl.className = 'v2-finalize-note done';
                fnEl.textContent = `ℹ️ 共 ${totFn} 处未收录（已 2 次确认 ${totCn} 首 / 可能限流未确认 ${totUn} 首）：平台确实搜不到，按实事求是留空（NULL），导出表格不会有 0、也不会有空格歧义。`;
            } else if (s.status === 'running' && totFn > 0) {
                fnEl.hidden = false;
                fnEl.className = 'v2-finalize-note running';
                fnEl.textContent = `⏳ 还在补：还有 ${totFn} 首未收录待确认（已确认 ${totCn} / 待第 2 次确认或可能限流 ${totUn}），系统在平台恢复后会自动重试到干净。`;
            } else {
                fnEl.hidden = true;
            }
        }

        // 三平台实收率 + 限速
        renderCoverage(s.coverage);
        renderThrottle(s.throttled);

        // 错误列表
        if (s.recent_errors && s.recent_errors.length) {
            v2Errors.hidden = false;
            v2ErrorsBody.innerHTML = s.recent_errors.map(e =>
                `<div class="v2-err-row"><span class="v2-err-idx">#${e.idx + 1}</span><span class="v2-err-song">${escapeHtml(e.song_name || '')}${e.performer ? ' · ' + escapeHtml(e.performer) : ''}</span><span class="v2-err-msg">${escapeHtml(e.error || '')}</span></div>`
            ).join('');
        } else {
            v2Errors.hidden = true;
        }

        // 中途导出：运行中只要有已完成数据就启用导出按钮
        if ((s.status === 'running' || s.status === 'pending') && s.done > 0) {
            v2ExportBtn.disabled = false;
        }

        // 终止条件：网易云也补完了才算真的结束
        if (s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed') {
            v2ExportBtn.disabled = false;   // 允许提前导出（网易云列可能还没满）
            // 终态：隐藏取消按钮（而非置灰禁用 —— 用户视角：禁用按钮"点不动"体验极差）
            v2CancelBtn.style.display = 'none';
            v2CancelBtn.disabled = false;
            if (v2RetryEmptyBtn) { v2RetryEmptyBtn.style.display = ''; v2RetryEmptyBtn.disabled = false; }  // 终态可补跑
            if (v2ExportBtn2) v2ExportBtn2.style.display = '';  // 显示底部导出按钮
            if (!nePending) stopV2Polling();
        } else if (s.status === 'running') {
            // 运行中按需禁用「重试未收录」（会让 worker 误入新歌抢线程）
            if (v2RetryEmptyBtn) v2RetryEmptyBtn.disabled = true;
        }
    }

    /** 把新完成的歌曲行 append 到 v2RecentBody 末尾 */
    function appendResultRows(rows) {
        if (!v2RecentBody || !rows || !rows.length) return;
        // 清掉首行占位（如果还在）
        const empty = v2RecentBody.querySelector('.v2-recent-empty');
        if (empty) v2RecentBody.innerHTML = '';
        const f = (v) => v == null
            ? '<span class="rf none">—</span>'
            : (v > 0 ? '<span class="rf">' + v + '</span>' : '<span class="rf zero">0</span>');
        const m = (v) => {
            const tag = String(v || '').toLowerCase();
            if (!tag || tag === 'none') return '<span class="match none">—</span>';
            if (tag === 'good' || tag === 'exact') return '<span class="match good">✓</span>';
            if (tag === 'maybe' || tag === 'partial') return '<span class="match maybe">?</span>';
            return '<span class="match bad">!</span>';
        };
        const html = rows.map(r =>
            '<tr data-idx="' + r.idx + '">'
            + '<td class="idx">' + (r.idx + 1) + '</td>'
            + '<td>' + escapeHtml(r.song_name || '') + '</td>'
            + '<td>' + escapeHtml(r.performer || '') + '</td>'
            + '<td>' + f(r.qq_favorites) + '</td>'
            + '<td>' + f(r.kugou_favorites) + '</td>'
            + '<td>' + f(r.netease_favorites) + '</td>'
            + '<td>' + m(r.qq_match || r.kugou_match || r.netease_match) + '</td>'
            + '</tr>'
        ).join('');
        v2RecentBody.insertAdjacentHTML('beforeend', html);
        v2TotalRendered += rows.length;
        // 用户视角：表格保持滚动到最新行（除非用户主动向上滚查看历史）
        // 简化处理：始终滚到底部，让用户看到最新结果
        try {
            if (v2RecentScroll) v2RecentScroll.scrollTop = v2RecentScroll.scrollHeight;
        } catch (e) {}
    }

    /** 「下一首」区域渲染 —— 让用户看到 worker 准备查什么 */
    function renderNextSong(s) {
        if (!v2Nowline || !v2NextSong) return;
        const processing = s && s.processing;
        const ongoing = s && s.ongoing;
        // 终态：变绿色「全部完成」（用 finalized 而不是看 DOM hidden，因为 fnEl
        // 要在本函数返回后才被设 hidden=false，顺序敏感容易踩坑）
        if (s && s.status === 'completed' && s.finalized) {
            v2Nowline.classList.add('done');
            v2NextSong.textContent = '所有歌已识别完';
            if (v2OngoingCount) v2OngoingCount.textContent = '';
            return;
        }
        v2Nowline.classList.remove('done');
        if (processing && processing.song_name) {
            const who = processing.song_name + (processing.performer ? ' · ' + processing.performer : '');
            v2NextSong.textContent = who;
        } else {
            v2NextSong.textContent = '队列已空';
        }
        if (v2OngoingCount) {
            const n = (ongoing && ongoing.length) || 0;
            v2OngoingCount.textContent = n > 1 ? `(+${n - 1} 首并发)` : '';
        }
    }

    // ── 三平台实收率渲染 ──
    function renderCoverage(cov) {
        if (!cov) return;
        const tot = cov.total || 0;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('cov_qq_tot', tot); set('cov_kugou_tot', tot); set('cov_netease_tot', tot);
        for (const p of ['qq', 'kugou', 'netease']) {
            const x = cov[p] || {};
            const fav = x.fav || 0, url = x.url || 0, pend = x.pending || 0;
            const fn = x.favnull || 0, cn = x.confirmed_null || 0, un = x.unknown_null || 0;
            set('cov_' + p + '_fav', fav);
            set('cov_' + p + '_url', url);
            set('cov_' + p + '_pending', pend);
            set('cov_' + p + '_favnull', fn);
            const fnEl = document.getElementById('cov_' + p + '_favnull');
            if (fnEl) fnEl.title = `未收录(留空NULL) ${fn} 首：已2次确认 ${cn} / 可能限流未确认 ${un}`;
            const bar = document.getElementById('cov_' + p + '_bar');
            if (bar) bar.style.width = (tot ? Math.round(fav / tot * 100) : 0) + '%';
        }
    }

    function renderThrottle(th) {
        const el = document.getElementById('v2Throttle');
        if (!el) return;
        if (th && Object.keys(th).length) {
            const parts = Object.entries(th).map(([k, v]) => k + ': ' + JSON.stringify(v)).join(' · ');
            el.className = 'v2-throttle on';
            el.textContent = '⚠️ 限速触发：' + parts;
        } else {
            el.className = 'v2-throttle';
            el.textContent = '限速状态：正常';
        }
    }

    function relTime(ts) {
        if (ts == null || isNaN(ts)) return '<span class="none">—</span>';
        const diff = Math.floor(Date.now() / 1000 - ts);
        if (diff < 0) return '<span class="none">—</span>';
        if (diff < 60) return '刚刚';
        if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
        if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
        return Math.floor(diff / 86400) + ' 天前';
    }
    // renderRecent 已被 appendResultRows 替代（v4.27.7 实时追加模式）：
    // 每 2 秒拉一次增量结果 append 到表格末尾，不再每 3 秒覆盖一次只显示 15 条。
    // 用户能直接在前台看到自己 2283 首歌的完整结果。

    // ── 页面打开自动认出正在跑的任务（后台启动的也认得出）──
    async function autoLoadRunningTask() {
        if (!v2Dashboard) return;
        try {
            const resp = await fetch('/api/batch_v2_list');
            const payload = await resp.json();
            // 接口返回 {tasks: [...]}，但历史版本可能直接是数组
            const list = Array.isArray(payload) ? payload : (payload.tasks || []);
            // 1) 没有任务就不展开面板（避免显示带禁用按钮的面板让用户困惑）
            if (!list.length) {
                v2Dashboard.hidden = true;
                v2CurrentTaskId = null;
                v2ExportBtn.disabled = true;
                v2CancelBtn.disabled = true;
                v2StatusText.textContent = '当前没有运行中的批量任务';
                return;
            }
            // 2) 找到「用户最关心」的任务：优先选大批量+进行中（同首页 batchTaskBar 一样的优先级打分）。
            //    /api/batch_v2_list 把状态都标 'running'（sweep 阶段），所以 list.find(running) 不可靠，
            //    必须按总分排序：bulk+running > small+running > 其他历史。
            //    v4.25.14a 修复：completed 的大批量（如 task26）也至少 1 分 > 单首小任务（如 task28）的 0 分，
            //    避免用户打开批量页被最新一条小任务的 ID 倒序抢走视野。
            //    v4.27.7 修复：彻底不再因 done=total 收起面板 —— 用户跑完 2283 首歌后来
            //    批量页最想看的就是自己 2283 首歌的完整结果。已完成的面板也要展开。
            const pickBestTask = (tasks) => {
                const overrideId = (() => {
                    try { return new URLSearchParams(location.search).get('task_id'); } catch (e) { return null; }
                })();
                const scored = tasks.map(t => {
                    const isRun = t.status === 'running' || t.status === 'pending';
                    const isBulk = (t.total || 0) >= 100;
                    const unfinished = (t.done || 0) < (t.total || 0);
                    // cancelled/failed 不主动展开 —— 用户已经主动取消，没必要再霸占面板。
                    // v4.27.7 修复：之前 isBulk && unfinished 把 cancelled 也算上（done=0 算 unfinished），
                    // 导致 4000 首已取消任务把已完成 19590 首挤掉。
                    if (t.status === 'cancelled' || t.status === 'failed') return { t, pri: -1 };
                    let pri = 0;
                    if (overrideId && String(t.id) === String(overrideId)) pri = 999;  // URL 手动钉死，最高
                    else if (isRun && isBulk && unfinished) pri = 5;
                    else if (isRun && isBulk) pri = 4;        // 大批量已 done=total 但 sweep 网易云补齐中
                    else if (isRun) pri = 3;                  // 小任务运行中
                    else if (isBulk && unfinished) pri = 2;   // 大批量 pending
                    else if (isBulk) pri = 1;                 // 大批量已完成（用户复盘自己 19590 首歌结果）
                    return { t, pri };
                });
                scored.sort((a, b) => (b.pri - a.pri) || (b.t.id - a.t.id));
                return scored[0].t;
            };
            const target = pickBestTask(list);
            // v4.27.7：始终展开面板（用户在批量页能看到自己所有任务的结果），
            // 不再因 done=total 收起 —— 那正是用户最想看的东西。
            v2Dashboard.hidden = false;
            v2CurrentTaskId = target.id;
            v2TaskName.textContent = target.name || '—';
            v2TaskId.textContent = target.id;
            v2Total.textContent = target.total || 0;
            v2Done.textContent = target.done || 0;
            v2Failed.textContent = target.failed || 0;
            v2Pct.textContent = (target.progress_pct || 0) + '%';
            v2BarFill.style.width = (target.progress_pct || 0) + '%';
            v2Speed.textContent = '—'; v2Eta.textContent = '—';
            v2StatusDot.className = 'v2-status-dot ' + (target.status || 'pending');
            v2StatusText.textContent = '正在加载任务详情…';
            v2Errors.hidden = true; v2ErrorsBody.innerHTML = '';
            v2ExportBtn.disabled = (target.done || 0) > 0 ? false : true;
            // 重置实时表格（确保切到新任务时不会残留旧任务的行）
            v2LastMaxIdx = -1;
            v2TotalRendered = 0;
            if (v2RecentBody) {
                v2RecentBody.innerHTML = '<tr><td colspan="7" class="v2-recent-empty">加载中…</td></tr>';
            }
            // 取消按钮只在运行中显示
            const isRun = target.status === 'running' || target.status === 'pending';
            if (isRun) {
                v2CancelBtn.disabled = false;
                v2CancelBtn.style.display = '';
            } else {
                v2CancelBtn.style.display = 'none';
            }
            // 始终轮询（让 completed 任务也能加载全部结果）
            startV2Polling();
        } catch (e) { /* 静默：v2-dashboard 占位已展开，不会让页面"什么都没有" */ }
    }

    if (v2ExportBtn2) {
        v2ExportBtn2.addEventListener('click', () => {
            // 复用同一个下载按钮的逻辑
            if (v2ExportBtn && !v2ExportBtn.disabled) v2ExportBtn.click();
        });
    }

    function formatEta(sec) {
        if (sec == null) return '—';
        if (sec < 60) return sec + '秒';
        const m = Math.floor(sec / 60);
        if (m < 60) return m + '分' + (sec % 60 ? (sec % 60) + '秒' : '');
        const h = Math.floor(m / 60);
        return h + '小时' + (m % 60) + '分';
    }

    if (v2CancelBtn) {
        v2CancelBtn.addEventListener('click', async function () {
            if (!v2CurrentTaskId) {
                alert('当前没有选中任务');
                return;
            }
            // 防御：任务已终态时（按钮因样式隐藏一般点不到，但若可见）给出明确反馈而非静默无反应
            if (v2CurrentStatus && v2CurrentStatus !== 'running' && v2CurrentStatus !== 'pending') {
                const label = { completed: '已完成', cancelled: '已取消', failed: '已失败' }[v2CurrentStatus] || v2CurrentStatus;
                alert('该任务已' + label + '，无需取消。\n如需重新查询，可重新提交文件或点「🔁 重试未收录」。');
                return;
            }
            if (!confirm('确定取消这个任务？已完成的歌曲不会回退。')) return;
            // 立即给 UI 反馈（不再让用户感觉"点不动"）
            const oldText = v2CancelBtn.textContent;
            v2CancelBtn.disabled = true;
            v2CancelBtn.textContent = '取消中…';
            try {
                const resp = await fetch('/api/batch_v2_cancel/' + v2CurrentTaskId, { method: 'POST' });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.error || ('HTTP ' + resp.status));
                }
                v2StatusText.textContent = '已请求取消…';
            } catch (e) {
                alert('取消失败：' + e.message);
                v2CancelBtn.disabled = false;
                v2CancelBtn.textContent = oldText;
                return;
            }
            pollV2Tick();  // 立即拉一次
        });
    }

    // 「🔁 重试未收录」——把上次没搜到的歌重新跑一次。
    // 仅对「已 done 但指定平台链接为空」的行有效，比 retry_failed 温和很多。
    const v2RetryEmptyBtn = document.getElementById('v2RetryEmptyBtn');
    if (v2RetryEmptyBtn) {
        v2RetryEmptyBtn.addEventListener('click', async function () {
            if (!v2CurrentTaskId) {
                alert('请先选中一个任务');
                return;
            }
            const choice = prompt(
                '重试哪个平台的「未收录」？\n' +
                '输入 q=QQ音乐 / k=酷狗 / n=网易云 / qk=QQ+酷狗 / qkn=全部\n' +
                '平台字母前加 f = 强制全量重捞(仅在你已更换平台 Cookie 后使用，会重搜所有未收录含已确认)\n' +
                '直接回车默认重试全部三平台(安全模式：仅限流/未确认，已确认未收录不重试)',
                'qkn'
            );
            if (choice === null) return;
            let platforms = 'qq,kugou,netease';
            const c = choice.trim().toLowerCase();
            let force = false;
            if (c.includes('f')) force = true;
            if (c) {
                const sel = [];
                if (c.includes('q')) sel.push('qq');
                if (c.includes('k')) sel.push('kugou');
                if (c.includes('n')) sel.push('netease');
                if (!sel.length) sel.push('qq', 'kugou', 'netease');  // 只填 f 没平台 → 全平台强制
                platforms = sel.join(',');
            }
            const modeTxt = force
                ? '【强制全量重捞】仅在你已更换平台 Cookie 后使用！会重搜所有未收录(含已确认)，烧大量配额'
                : '【安全模式】仅重试限流/未确认的空结果，已确认未收录不重试';
            if (!confirm(modeTxt + '\n开始补跑 ' + platforms + '？')) return;
            v2RetryEmptyBtn.disabled = true;
            const oldText = v2RetryEmptyBtn.textContent;
            v2RetryEmptyBtn.textContent = '补跑中…';
            try {
                const fd = new FormData();
                fd.append('platforms', platforms);
                fd.append('force', force ? '1' : '0');
                const resp = await fetch('/api/batch_v2_retry_empty/' + v2CurrentTaskId,
                    { method: 'POST', body: fd });
                const j = await resp.json();
                if (!resp.ok || !j.ok) {
                    alert('补跑失败：' + (j.error || resp.status));
                    return;
                }
                alert('✅ 已重新入队 ' + (j.requeued || 0) + ' 首'
                      + (j.mode === 'force' ? '（强制全量）' : '（安全模式·仅限流/未确认）') + '\n\n' +
                      '剩余空：' + Object.entries(j.remaining_empty || {})
                        .map(([k,v]) => k + '=' + v).join(' / '));
                pollV2Tick();
            } catch (e) {
                alert('请求失败：' + e.message);
            } finally {
                v2RetryEmptyBtn.disabled = false;
                v2RetryEmptyBtn.textContent = oldText;
            }
        });
    }

    if (v2ExportBtn) {
        v2ExportBtn.addEventListener('click', async function () {
            if (!v2CurrentTaskId) return;
            const oldText = v2ExportBtn.innerHTML;
            v2ExportBtn.disabled = true;
            v2ExportBtn.innerHTML = '生成中…（可能需数秒）';
            try {
                const resp = await fetch('/api/batch_v2_export/' + v2CurrentTaskId + '.xlsx');
                if (!resp.ok) {
                    let msg = '导出失败 (' + resp.status + ')';
                    try { const j = await resp.json(); if (j.error) msg = j.error; } catch (_) {}
                    alert(msg);
                    return;
                }
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = '批量歌单_' + v2CurrentTaskId + '.xlsx';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (e) {
                alert('导出失败：' + e.message);
            } finally {
                v2ExportBtn.disabled = false;
                v2ExportBtn.innerHTML = oldText;
            }
        });
    }

    // ── 下载 Excel ──
    downloadBtn.addEventListener('click', async function () {
        if (!lastResults) return;
        downloadBtn.disabled = true;
        const oldText = downloadBtn.innerHTML;
        downloadBtn.innerHTML = '生成中…';
        try {
            const resp = await fetch('/api/batch_export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ results: lastResults }),
            });
            if (!resp.ok) throw new Error('导出失败 ' + resp.status);
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '歌单各平台数据导出.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('导出失败：' + e.message);
        } finally {
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = oldText;
        }
    });

    // 初始化计数
    updateCount();

    // 打开页面自动认出正在跑的批量任务（task26 等后台任务也能实时追踪）
    autoLoadRunningTask();

    // 通过 /batch 重定向到首页并带 #batch 时，自动切换到批量标签页
    if (window.location.hash === '#batch') {
        const bt = document.querySelector('.tab-btn[data-tab="batch"]');
        if (bt) bt.click();
    }
})();
