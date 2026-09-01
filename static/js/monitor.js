/* ═══════════════════════════════════════════════
   MusicFinder — 数据监控 / 运营报告 页签
   导入曲库 → 建档匹配 → 每日采集 → 人工复核 → 档案浏览 → 运营报告
   ═══════════════════════════════════════════════ */
(function () {
'use strict';

const API = '/api/monitor';
const PLAT_NAME = { qq: 'QQ音乐', kugou: '酷狗', netease: '网易云' };

// 大白话标签：机器术语 → 人话
const CONF_NAME = { high: '正版', mid: '待确认', low: '存疑', none: '没找到' };
const CONF_TITLE = {
    high: '机器确认是官方原版（歌名+歌手都对得上）',
    mid: '机器有八成把握，建议你点开看看是不是原版',
    low: '机器拿不准，疑似相似歌/翻唱',
    none: '这个平台搜不到这首歌',
};

let pvTempPath = '';
let reviewPage = 1, reviewTotal = 0, reviewSize = parseInt(localStorage.getItem('monReviewSize')) || 10;
let archivePage = 1, archiveTotal = 0, archiveSize = parseInt(localStorage.getItem('monArchiveSize')) || 30;
let matchTimer = null, dailyTimer = null, dailyTimerAfter = null;
let reportPeriod = 'day';

// 名单管理（v4.25.20）：增删改 + 平台解锁/重搜 + 历史曲线 + 删除确认
let archiveCache = {};            // id → 档案行（编辑时免二次拉取）
let pendingDeletePayload = null;   // 待确认删除的请求体（archive_ids 或 select_all+lock_filter）
let pendingReviewDeletePayload = null;  // 步骤4 待确认删除的请求体（sp_ids 或 select_all+review_filter）
let songEditId = null;            // 编辑中的档案 id（null=新增）
let histAid = null, histDays = 90, histMetric = 'collection';
let rematchTimer = null;

// 「机器拿不准」三态选择（仿 archSelectScope）：
//   null    → 当前页未选；'page' → 当前页全勾；'filtered' → 跨页全选匹配筛选项
let reviewSelectScope = null;
let reviewSelectFilteredCount = 0;  // scope='filtered' 时后端返回的总数

// ── 小工具 ──────────────────────────────────────
const $ = id => document.getElementById(id);

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtCount(n) {
    if (n == null) return '—';
    n = Number(n);
    if (!isFinite(n)) return '—';
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(n);
}

function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'mon-toast ' + (kind || 'ok');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; }, 2400);
    setTimeout(() => el.remove(), 2800);
}

async function api(path, opts) {
    const r = await fetch(API + path, opts);
    const j = await r.json().catch(() => ({ ok: false, error: '响应解析失败' }));
    if (!j.ok) throw new Error(j.error || '请求失败');
    return j.data;
}

function apiJson(path, body) {
    return api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
}

// ── 概览 ────────────────────────────────────────
async function loadStats() {
    let s;
    try { s = await api('/stats'); } catch (e) { return; }

    const arch = s.archive_total || 0;
    const locked = s.platform_locked || 0;
    const pending = s.platform_pending || 0;

    $('statArchive').textContent = arch.toLocaleString();
    $('statArchiveSub').textContent = arch ? `名单里共 ${arch} 首歌` : '名单里还没歌';
    $('statLocked').textContent = locked.toLocaleString();
    $('statLockedSub').textContent = arch
        ? `平均每首在 ${(locked / arch).toFixed(1)} 个平台找到正版` : '机器已找到官方原版';
    $('statPending').textContent = pending.toLocaleString();
    $('statPendingSub').textContent = pending ? '机器拿不准，需你点一下' : '都搞定了 🎉';
    $('statToday').textContent = (s.metrics_today || 0).toLocaleString();
    $('statTodaySub').textContent = s.metrics_today
        ? `已采集于 ${s.last_metric_date || '今天'}` : '等第一次采集';

    // 红牌提醒
    const bar = $('monAlertBar');
    const alerts = [];
    if (pending > 0) alerts.push(`有 ${pending} 条匹配需要你确认`);
    if ((s.archive_status || {}).partial) alerts.push(`${s.archive_status.partial} 首因平台限流没跑完，可点「重试被限流的」`);
    if ((s.metrics_days || 0) === 0) alerts.push('还没采集过数据，点「立即采集今日数据」让报告有内容');
    if (alerts.length) {
        bar.innerHTML = '<span class="mon-alert-dot"></span>' + esc(alerts.join('　·　'));
        bar.hidden = false;
    } else {
        bar.hidden = true;
    }

    // 匹配状态汇总条（✅正版 / ⏳待确认 / ❌平台无，可点击筛选）
    renderLockSummary(s.lock_summary || {});

    // 运行记录（建档）
    const runs = (s.recent_runs || []).filter(r => r.run_type === 'archive_match');
    $('monRuns').innerHTML = runs.length ? runs.map(r => runItem(r)).join('') : '';

    // 每日采集运行记录
    const druns = (s.recent_runs || []).filter(r => r.run_type === 'daily_metrics');
    $('monDailyRuns').innerHTML = druns.length ? druns.map(r => runItem(r)).join('') : '';

    // 运营报告进度指示
    const st = [$('soonStep1'), $('soonStep2'), $('soonStep3'), $('soonStep4')];
    if (st[0]) {
        st[0].classList.toggle('done', arch > 0);
        st[1].classList.toggle('done', locked > 0 && pending === 0);
        st[2].classList.toggle('done', (s.metrics_today || 0) > 0);
        st[3].classList.toggle('done', (s.metrics_days || 0) > 0);
    }

    if (s.jobs && s.jobs.match && s.jobs.match.running) startMatchPoll();
    if (s.jobs && s.jobs.daily && s.jobs.daily.running) startDailyPoll();
    return s;
}

function runItem(r) {
    const cls = r.status === 'success' ? 'mon-run-ok' : (r.status === 'running' ? '' : 'mon-run-fail');
    const dur = r.duration_s ? `${r.duration_s}s` : '进行中';
    const label = r.run_type === 'daily_metrics' ? '每日采集' : '建档匹配';
    return `<div class="mon-run-item">
        <span class="mon-run-type">${esc(label)}</span>
        <span>${esc(r.started_at || '')}</span>
        <span class="${cls}">${esc(r.status)}</span>
        <span>成功 ${r.done || 0} / 失败 ${r.failed || 0}</span>
        <span>${dur}</span></div>`;
}

// ── 导入：拖拽 / 选择 ────────────────────────────
function bindUpload() {
    const drop = $('monDrop'), input = $('monFile');
    if (!drop) return;
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files[0]) doPreview(input.files[0]); });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); drop.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
        e.preventDefault(); drop.classList.remove('dragover');
    }));
    drop.addEventListener('drop', e => {
        const f = e.dataTransfer.files[0];
        if (f) doPreview(f);
    });
}

async function doPreview(file) {
    $('monDropSub').textContent = '正在读取…';
    const fd = new FormData();
    fd.append('file', file);
    try {
        const r = await fetch(API + '/import/preview', { method: 'POST', body: fd });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
        pvTempPath = j.temp_path;
        renderPreview(j.data, file.name);
    } catch (e) {
        toast('读取失败：' + e.message, 'err');
        $('monDropSub').textContent = '导入前会先给你看一眼识别结果，确认无误再入库';
    }
}

function renderPreview(d, filename) {
    $('monDropSub').textContent = '导入前会先给你看一眼识别结果，确认无误再入库';
    $('monPvFile').textContent = filename + '　·　表头：' + (d.headers || []).join(' / ');
    $('monPvCount').textContent = `识别到 ${d.total_rows || 0} 行`;

    const LABEL = { song_name: '歌曲名', artist: '歌手', lyricist: '作词', composer: '作曲', album: '专辑' };
    const m = d.mapping || {};
    $('monPvMap').innerHTML = Object.keys(LABEL).map(k => {
        const col = m[k];
        return col
            ? `<span class="mon-map-chip">${LABEL[k]} ← <b>${esc(col)}</b></span>`
            : `<span class="mon-map-chip miss">${LABEL[k]} 未识别</span>`;
    }).join('');

    const tb = $('monPvTable').querySelector('tbody');
    tb.innerHTML = (d.samples || []).map(s => `<tr>
        <td>${esc(s.song_name)}</td><td>${esc(s.artist)}</td>
        <td>${esc(s.lyricist)}</td><td>${esc(s.composer)}</td><td>${esc(s.album)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="mon-empty-cell">没有解析到数据行</td></tr>';

    $('monPreview').hidden = false;
    $('monImportBtn').disabled = !m.song_name;
    if (!m.song_name) toast('没找到「歌曲名」这一列，无法导入', 'err');
}

async function doImport() {
    if (!pvTempPath) return;
    const btn = $('monImportBtn');
    btn.disabled = true; btn.textContent = '导入中…';
    try {
        const d = await apiJson('/import/commit', { temp_path: pvTempPath });
        let msg = `导入完成：新增 ${d.inserted} 首，更新 ${d.updated} 首`;
        if (d.auto_split) msg += `，自动拆分 ${d.auto_split} 首「歌名-歌手」`;
        toast(msg, 'ok');
        $('monPreview').hidden = true;
        pvTempPath = '';
        await loadStats();
        loadArchive(1);
    } catch (e) {
        toast('导入失败：' + e.message, 'err');
    } finally {
        btn.disabled = false; btn.textContent = '确认导入';
    }
}

// ── 建档匹配 ────────────────────────────────────
async function startMatch(mode) {
    const workers = parseInt($('monWorkers').value, 10) || 2;
    try {
        await apiJson('/match/start', { mode, workers });
        toast('建档已开始，可以离开这个页面，后台继续跑', 'ok');
        $('monProgress').hidden = false;
        startMatchPoll();
    } catch (e) {
        toast(e.message, 'err');
    }
}

function startMatchPoll() {
    if (matchTimer) return;
    $('monProgress').hidden = false;
    matchTimer = setInterval(pollMatch, 1800);
    pollMatch();
}

async function pollMatch() {
    let d;
    try { d = await api('/match/progress'); } catch (e) { return; }
    const run = d.run, job = d.job || {};
    const fill = $('monProgressFill'), txt = $('monProgressText');

    if (run) {
        const total = run.total || 0, done = (run.done || 0) + (run.failed || 0);
        const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
        fill.style.width = pct + '%';
        const spd = run.duration_s && done ? ` · 约 ${(run.duration_s / done).toFixed(1)}s/首` : '';
        const eta = (total && done && job.running)
            ? ` · 剩余约 ${fmtDur((total - done) * (elapsed(run) / Math.max(done, 1)))}` : '';
        txt.textContent = `${done} / ${total}（${pct}%）　成功 ${run.done || 0}　失败 ${run.failed || 0}${spd}${eta}`;
    }

    if (!job.running) {
        clearInterval(matchTimer); matchTimer = null;
        fill.style.width = '100%';
        if (job.error) {
            txt.textContent = '任务异常：' + job.error.split('\n')[0];
            toast('建档中断，详见进度栏', 'err');
        } else if (run && run.status === 'success') {
            txt.textContent += '　✓ 已完成';
            toast('建档完成', 'ok');
        }
        loadStats();
        loadReview(1);
        loadArchive(archivePage);
    }
}

// ── 每日采集 ────────────────────────────────────
async function triggerDaily(after) {
    try {
        await apiJson('/daily/start', {});
        toast('每日采集已开始，后台抓取中…', 'ok');
        $('monDailyProgress').hidden = false;
        startDailyPoll(after);
    } catch (e) {
        toast(e.message, 'err');
    }
}

function startDailyPoll(after) {
    // 注意：浏览器里 setInterval 返回的是数字（定时器 id），不能往它上面挂属性——
    // 此前 dailyTimer._after = after 直接抛
    // "Cannot create property '_after' on number '22'"，且 _after 从未被读取过（死代码）。
    // 回调参数改用独立变量保存，重入时更新。
    if (dailyTimer) { dailyTimerAfter = after || dailyTimerAfter; return; }
    dailyTimerAfter = after;
    dailyTimer = setInterval(() => pollDaily(dailyTimerAfter), 1800);
    $('monDailyProgress').hidden = false;
    pollDaily(dailyTimerAfter);
}

async function pollDaily(after) {
    let d;
    try { d = await api('/daily/progress'); } catch (e) { return; }
    const run = d.run, job = d.job || {};
    const fill = $('monDailyProgressFill'), txt = $('monDailyProgressText');

    if (run) {
        const total = run.total || 0, done = (run.done || 0) + (run.failed || 0);
        const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
        fill.style.width = pct + '%';
        txt.textContent = job.running
            ? `${done} / ${total}（${pct}%）　成功 ${run.done || 0}　失败 ${run.failed || 0}`
            : '采集完成，整理数据中…';
    }

    if (!job.running) {
        clearInterval(dailyTimer); dailyTimer = null;
        fill.style.width = '100%';
        if (job.error) {
            txt.textContent = '采集异常：' + job.error.split('\n')[0];
            toast('采集中断', 'err');
        } else {
            txt.textContent = '✓ 今日数据采集完成';
            toast('今日数据采集完成', 'ok');
        }
        loadStats();
        if (typeof after === 'function') after();
    }
}

// ── 人工复核 ────────────────────────────────────
async function loadReview(page) {
    reviewPage = page || 1;
    const q = new URLSearchParams({
        page: reviewPage, size: reviewSize,
        q: $('monReviewQ').value.trim(),
        platform: $('monReviewPlatform').value,
        confidence: $('monReviewConf').value
    });
    let d;
    try { d = await api('/review/list?' + q); } catch (e) { return; }
    reviewTotal = d.total;
    const box = $('monReviewList');

    if (!d.items.length) {
        box.innerHTML = '<div class="mon-empty">' +
            (reviewTotal === 0 ? '全部确认完了 —— 没有待复核的条目 🎉' : '这一页没有数据') + '</div>';
        $('monReviewPager').hidden = true;
        syncBatchBtns();
        return;
    }

    box.innerHTML = d.items.map(renderReviewItem).join('');
    box.querySelectorAll('.mon-ri-check').forEach(c => c.addEventListener('change', syncBatchBtns));
    box.querySelectorAll('.mon-cand').forEach(el => el.addEventListener('click', () => confirmChoice(el.dataset.sp, el.dataset.idx)));
    renderPager('monReviewPager', reviewPage, reviewSize, reviewTotal, loadReview);
    syncBatchBtns();
}

function renderReviewItem(it) {
    const cands = it.candidates || [];
    const wj = [it.lyricist, it.composer].filter(Boolean).join(' / ');
    const cardsHtml = cands.length ? cands.slice(0, 6).map((c, i) => {
        const url = c.url || '';
        const link = url ? `<a class="mon-cand-link" href="${esc(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="在新页打开试听">▶ 试听</a>` : '';
        const cwj = [c.lyricist, c.composer].filter(Boolean).join(' / ');
        const wjLine = cwj ? `<div class="mon-cand-line mon-cand-wj">词曲：${esc(cwj)}</div>` : '';
        let badge;
        if (c.hikoon_label) badge = '<span class="mon-cand-badge hikoon" title="发行方为 HikoonMusic / 海葵音乐（自家厂牌），直接判正版">海葵正版</span>';
        else if (c.artist_exact) badge = '<span class="mon-cand-badge ok">歌手完全匹配</span>';
        else if (c.artist_subset) badge = '<span class="mon-cand-badge ok">歌手匹配</span>';
        else if (c.artist_close) badge = '<span class="mon-cand-badge mid">歌手相似</span>';
        else if (c.artist_hit) badge = '<span class="mon-cand-badge mid">歌手包含</span>';
        else badge = '<span class="mon-cand-badge warn">歌手不同</span>';
        const labelLine = c.record_label ? `<div class="mon-cand-line mon-cand-label">发行方：${esc(c.record_label)}</div>` : '';
        // v4.27.30：收藏量字段（QQ/酷狗/网易云详情填充；酷我/部分冷门可能为 null → 显示 —）
        const hasCC = c.collection_count !== undefined && c.collection_count !== null;
        const ccLine = `<div class="mon-cand-line mon-cand-cc${hasCC ? '' : ' mon-cand-cc-none'}">收藏量：${hasCC ? fmtCount(c.collection_count) : '—'}</div>`;
        return `
        <div class="mon-cand" data-sp="${it.sp_id}" data-idx="${i}">
            <div class="mon-cand-head">
                <div class="mon-cand-name">${esc(c.name || '（无名）')}</div>
                ${link}
            </div>
            <div class="mon-cand-line">${esc(c.artist || '—')}</div>
            ${wjLine}
            <div class="mon-cand-line">${esc(c.album || '')}</div>
            ${labelLine}
            ${ccLine}
            <div class="mon-cand-tags">${badge}<span class="mon-cand-score">匹配分 ${Math.round(c.score || 0)}</span></div>
        </div>`;
    }).join('')
        : '<div class="mon-cand-empty">这个平台一条都没搜到 —— 大概率平台确实没有这首，可以直接标「平台无」。</div>';

    return `<div class="mon-review-item" data-sp="${it.sp_id}">
        <div class="mon-ri-head">
            <input type="checkbox" class="mon-ri-check" value="${it.sp_id}">
            <div>
                <div class="mon-ri-song">${esc(it.song_name)}</div>
                <div class="mon-ri-meta">${esc(it.artist || '未标歌手')}${wj ? '　词曲：' + esc(wj) : ''}</div>
            </div>
            <div class="mon-ri-tags">
                <span class="mon-plat-tag mon-plat-${it.platform}">${PLAT_NAME[it.platform] || it.platform}</span>
                <span class="mon-conf-tag mon-conf-${it.confidence}" title="${esc(CONF_TITLE[it.confidence] || '')}">${CONF_NAME[it.confidence] || it.confidence}</span>
            </div>
        </div>
        <div class="mon-cands">${cardsHtml}</div>
        <div class="mon-ri-foot">
            <span class="mon-hint">点上面那张对的卡片即可锁定为正版</span>
            <button class="btn-danger mon-ri-reject" data-sp="${it.sp_id}" type="button">平台没有这首</button>
        </div>
    </div>`;
}

async function confirmChoice(spId, idx) {
    try {
        await apiJson('/review/confirm', { sp_id: +spId, choice_index: +idx });
        markResolved(spId, '已锁定为正版');
    } catch (e) { toast(e.message, 'err'); }
}

async function rejectOne(spId) {
    try {
        await apiJson('/review/reject', { sp_id: +spId });
        markResolved(spId, '已标记为「平台没有」');
    } catch (e) { toast(e.message, 'err'); }
}

function markResolved(spId, msg) {
    const el = document.querySelector(`.mon-review-item[data-sp="${spId}"]`);
    if (el) {
        el.classList.add('resolved');
        setTimeout(() => {
            el.remove();
            if (!document.querySelectorAll('.mon-review-item').length) loadReview(reviewPage);
        }, 320);
    }
    toast(msg, 'ok');
    loadStats();
}

function syncBatchBtns() {
    const checks = document.querySelectorAll('.mon-ri-check');
    const checked = document.querySelectorAll('.mon-ri-check:checked');
    const n = checked.length;
    const nDisplay = reviewSelectScope === 'filtered'
        ? reviewSelectFilteredCount
        : n;
    const disabled = nDisplay === 0;
    $('monBatchConfirm').disabled = disabled;
    $('monBatchReject').disabled = disabled;
    $('monBatchDeleteReview').disabled = disabled;
    $('monBatchConfirm').textContent = nDisplay ? `批量确认为正版（${nDisplay}）` : '批量确认为正版';
    $('monBatchReject').textContent = nDisplay ? `批量标为平台无（${nDisplay}）` : '批量标为平台无';
    $('monBatchDeleteReview').textContent = nDisplay ? `🗑 移出名单（${nDisplay}）` : '🗑 移出名单';
    const btn = $('monSelectAll');
    if (btn) {
        const allChecked = checks.length > 0 && checked.length === checks.length;
        btn.textContent = reviewSelectScope === 'filtered'
            ? '☐ 取消跨页全选'
            : (allChecked ? '☐ 取消全选当前页' : '☑ 全选当前页');
    }
}

function toggleSelectAll() {
    if (reviewSelectScope === 'filtered') {
        // 从跨页全选退回当前页未选
        reviewSelectScope = null;
        reviewSelectFilteredCount = 0;
        document.querySelectorAll('.mon-ri-check').forEach(c => { c.checked = false; });
        syncBatchBtns();
        toast('已退出跨页全选模式', 'ok', 2200);
        return;
    }
    const checks = document.querySelectorAll('.mon-ri-check');
    if (!checks.length) { toast('当前页没有可勾选的条目', 'err'); return; }
    const checked = document.querySelectorAll('.mon-ri-check:checked');
    const allChecked = checks.length > 0 && checked.length === checks.length;
    checks.forEach(c => { c.checked = !allChecked; });
    syncBatchBtns();
}

function _reviewFilter() {
    return {
        q: ($('monReviewQ') || {}).value || '',
        platform: ($('monReviewPlatform') || {}).value || '',
        confidence: ($('monReviewConf') || {}).value || ''
    };
}

async function selectReviewFiltered() {
    if (reviewTotal <= 0) { toast('当前筛选下没有可勾选条目', 'err'); return; }
    const msg = reviewTotal > 50
        ? `确定一次性处理所有 ${reviewTotal.toLocaleString()} 条「机器拿不准」的卡片吗？\n提示：操作会立即执行（确认 / 标平台无 / 移出名单），无法撤回。`
        : `确定一次性处理 ${reviewTotal} 条吗？`;
    if (!confirm(msg)) return;
    reviewSelectScope = 'filtered';
    reviewSelectFilteredCount = reviewTotal;
    document.querySelectorAll('.mon-ri-check').forEach(c => { c.checked = true; });
    syncBatchBtns();
    toast(`已切换到「跨页全选」模式（${reviewTotal.toLocaleString()} 条）。现在可点批量按钮`, 'ok', 6000);
}

async function batchAction(action) {
    let payload, scopeLabel;
    if (reviewSelectScope === 'filtered') {
        payload = { action, select_all: true, review_filter: _reviewFilter() };
        scopeLabel = `跨页 ${reviewSelectFilteredCount.toLocaleString()} 条`;
    } else {
        const ids = [...document.querySelectorAll('.mon-ri-check:checked')].map(c => +c.value);
        if (!ids.length) return;
        payload = { action, sp_ids: ids };
        scopeLabel = `${ids.length} 条`;
    }
    const confirmMap = {
        reject: `确定把${scopeLabel}都标记为「平台没有这首歌」？`,
        confirm_top: `确定把${scopeLabel}都标记为「✅正版」？`,
    };
    if (confirmMap[action] && !confirm(confirmMap[action])) return;
    try {
        const d = await apiJson('/review/batch', payload);
        toast(`已处理 ${d.affected} 条（${d.scope || '常规'}）`, 'ok');
        if (reviewSelectScope === 'filtered') {
            reviewSelectScope = null;
            reviewSelectFilteredCount = 0;
        }
        loadReview(reviewPage); loadStats();
    } catch (e) { toast(e.message, 'err'); }
}

// ── 匹配状态汇总条（✅正版 / ⏳待确认 / ❌平台无，可点筛选）──
function renderLockSummary(sum) {
    const box = $('monLockSummary');
    if (!box) return;
    const total = (sum.official || 0) + (sum.pending || 0) + (sum.none || 0) + (sum.unmatched || 0);
    const chips = [
        { key: '', cls: '', label: `全部 ${total}` },
        { key: 'official', cls: 'on', label: `✅ 正版 ${sum.official || 0}` },
        { key: 'pending', cls: 'mid', label: `⏳ 待确认 ${sum.pending || 0}` },
        { key: 'none', cls: 'off', label: `❌ 平台无 ${sum.none || 0}` },
    ];
    const cur = ($('monArchiveLock') || {}).value || '';
    box.innerHTML = chips.map(c =>
        `<span class="mon-lock-chip ${c.cls} ${cur === c.key ? 'active' : ''}" data-lock="${c.key}">`
        + (c.key ? '<span class="dot"></span>' : '') + esc(c.label) + '</span>').join('');
    box.querySelectorAll('.mon-lock-chip').forEach(ch => ch.addEventListener('click', () => {
        if ($('monArchiveLock')) $('monArchiveLock').value = ch.dataset.lock;
        loadArchive(1);
    }));
}

// ── 档案浏览 + 批量锁定 ──────────────────────────
async function loadArchive(page) {
    archivePage = page || 1;
    const q = new URLSearchParams({
        page: archivePage, size: archiveSize, q: $('monArchiveQ').value.trim(),
        lock: ($('monArchiveLock') || {}).value || ''
    });
    let d;
    try { d = await api('/archive/list?' + q); } catch (e) { return; }
    archiveTotal = d.total;
    const tb = $('monArchiveTable').querySelector('tbody');
    archiveCache = {};
    d.items.forEach(r => archiveCache[r.id] = r);

    if (!d.items.length) {
        tb.innerHTML = '<tr><td colspan="10" class="mon-empty-cell">暂无数据 —— 先导入曲库，或点「＋ 新增歌曲」</td></tr>';
        $('monArchivePager').hidden = true;
        return;
    }

    tb.innerHTML = d.items.map(r => {
        const p = r.platforms || {};
        const platCell = k => {
            const x = p[k];
            const hasId = x && x.song_id;
            const rejected = x && x.review_status === 'rejected';
            let badge;
            if (!hasId) {
                badge = `<span class="mon-lock off" title="${rejected ? '已确认该平台搜不到这首' : '还没匹配到'}">${rejected ? '❌ 平台无' : '⏳ 未匹配'}</span>`;
            } else {
                const isOfficial = x.confidence === 'high' &&
                    (x.review_status === 'auto_locked' || x.review_status === 'confirmed');
                if (isOfficial) {
                    const t = esc(`✅ 正版：${x.matched_name || ''} — ${x.matched_artist || ''}`);
                    badge = `<span class="mon-lock on" title="${t}">✅ 正版</span>`;
                } else {
                    badge = `<span class="mon-lock mid" title="机器不确定，建议点开核对">⚠️ 待确认</span>`;
                }
            }
            // 悬停出现：🔓 解锁 / 🔄 重搜
            const acts = `<span class="mon-plat-acts">
                <button class="mon-plat-btn" data-act="unlock" data-aid="${r.id}" data-plat="${k}" title="撤掉这个平台的锁定（之后可重搜）">🔓</button>
                <button class="mon-plat-btn" data-act="rematch" data-aid="${r.id}" data-plat="${k}" title="重新去这个平台找一次">🔄</button>
            </span>`;
            return `<td class="mon-plat-cell" data-aid="${r.id}" data-plat="${k}">${badge}${acts}</td>`;
        };
        const wj = [r.lyricist, r.composer].filter(Boolean).join(' / ');
        // v4.27.11：scope='filtered' 时所有行都渲染为已勾选
        const preChecked = archSelectScope === 'filtered' ? 'checked' : '';
        return `<tr>
            <td><input type="checkbox" class="mon-arch-check" value="${r.id}" ${preChecked}></td>
            <td>${r.id}</td>
            <td>${esc(r.song_name)}</td>
            <td>${esc(r.artist || '—')}</td>
            <td>${esc(wj || '—')}</td>
            ${platCell('qq')}${platCell('kugou')}${platCell('netease')}
            <td><label class="mon-switch">
                <input type="checkbox" class="mon-arch-toggle" data-id="${r.id}" ${r.enabled ? 'checked' : ''}>
                <span class="mon-slider"></span></label></td>
            <td class="mon-row-acts">
                <button class="mon-row-btn" data-act="edit" data-id="${r.id}" title="编辑信息">✏️</button>
                <button class="mon-row-btn" data-act="hist" data-id="${r.id}" title="看历史走势">📈</button>
                <button class="mon-row-btn mon-danger" data-act="del" data-id="${r.id}" title="从名单移除">🗑</button>
            </td>
        </tr>`;
    }).join('');

    tb.querySelectorAll('.mon-arch-toggle').forEach(c => c.addEventListener('change', async () => {
        try {
            await apiJson('/archive/toggle', { archive_id: +c.dataset.id, enabled: c.checked });
            toast(c.checked ? '已恢复监控' : '已暂停监控', 'ok');
            loadStats();
        } catch (e) { toast(e.message, 'err'); c.checked = !c.checked; }
    }));
    tb.querySelectorAll('.mon-arch-check').forEach(c => c.addEventListener('change', syncArchBatch));

    renderPager('monArchivePager', archivePage, archiveSize, archiveTotal, loadArchive);
    syncArchBatch();
}

// ── 平台格 / 行内操作：事件委托 ────────────────
async function onArchTableClick(e) {
    // 点平台徽章（✅正版 / ⏳待确认 / ❌平台无）→ 看机器具体匹配到了哪首歌
    const lock = e.target.closest('.mon-lock');
    if (lock) {
        const cell = e.target.closest('.mon-plat-cell');
        if (cell) return openMatchDetail(+cell.dataset.aid, cell.dataset.plat);
    }
    const btn = e.target.closest('.mon-plat-btn, .mon-row-btn');
    if (!btn) return;
    // 平台格按钮用 data-aid，行内按钮用 data-id —— 两者都兼容
    const aid = +(btn.dataset.aid ?? btn.dataset.id);
    const act = btn.dataset.act;
    if (act === 'edit') return openEditSong(aid);
    if (act === 'hist') return openHist(aid);
    if (act === 'del') return askDelete({ archive_ids: [aid] }, `确认把《${esc((archiveCache[aid] || {}).song_name || '这首歌')}》从名单移除？`);
    if (act === 'unlock') {
        try {
            await apiJson('/platform/unlock', { archive_id: aid, platform: btn.dataset.plat });
            toast(`已解锁 ${PLAT_NAME[btn.dataset.plat] || btn.dataset.plat} 平台，可点 🔄 重搜`, 'ok');
            loadArchive(archivePage); loadStats();
        } catch (er) { toast(er.message, 'err'); }
    } else if (act === 'rematch') {
        try {
            await apiJson('/platform/rematch', { archive_id: aid, platform: btn.dataset.plat });
            toast('已开始重新搜索该平台…', 'ok');
            startRematchPoll();
        } catch (er) { toast(er.message, 'err'); }
    }
}

// v4.27.11：三态选择（替代旧的「只勾当前页」逻辑）
// null         → 当前没有任何选中（包括换页后）
// 'page'       → 只勾当前页 30 条
// 'filtered'   → 一次性锁定「按当前筛选条件匹配」的全部（如 2277 条中所有 "待确认"）
let archSelectScope = null;
let archSelectFilteredCount = 0;  // scope='filtered' 时后端返回的总数

function _archLockFilter() {
    // 把当前 archive 列表筛选条件打包发给后端
    return {
        q: ($('monArchiveQ') || {}).value || '',
        lock: ($('monArchiveLock') || {}).value || ''
    };
}

function syncArchBatch() {
    const checks = document.querySelectorAll('.mon-arch-check');
    const checked = document.querySelectorAll('.mon-arch-check:checked');
    const n = checked.length;
    const bar = $('monArchBatchBar');
    bar.hidden = n === 0;
    $('monArchBatchCount').textContent = archSelectScope === 'filtered'
        ? `已选 ${archSelectFilteredCount.toLocaleString()} 首 (跨所有页)`
        : `已选 ${n} 首`;
    const allChecked = checks.length > 0 && checked.length === checks.length;
    $('monArchCheckAll').checked = allChecked;
    // 三态文案
    const label = $('monArchCheckAllLabel');
    if (label) {
        label.textContent = archSelectScope === 'filtered'
            ? '☑ 取消所有匹配项'
            : (allChecked ? '☐ 取消全选当前页' : '☑ 全选当前页');
    }
    // "全选匹配筛选项"按钮的可见性：只在从未勾过（避免视觉拥挤）
    const selBtn = $('monArchSelectFiltered');
    if (selBtn) {
        if (archSelectScope === null) {
            selBtn.hidden = false;
            selBtn.textContent = archiveTotal > 30
                ? `☑ 全选所有 ${archiveTotal.toLocaleString()} 条 (跨页)`
                : `☑ 全选所有 ${archiveTotal} 条`;
        } else {
            selBtn.hidden = true;
        }
    }
}

function toggleArchAll() {
    const checks = document.querySelectorAll('.mon-arch-check');
    if (!checks.length) { return; }
    const checked = document.querySelectorAll('.mon-arch-check:checked');
    const allChecked = checks.length > 0 && checked.length === checks.length;
    if (allChecked) {
        // 当前页全取消：清掉所有 scope，回到 null（让"全选匹配筛选 N 条"按钮可点）
        checks.forEach(c => { c.checked = false; });
        archSelectScope = null;
    } else {
        // 当前页全勾上：scope = 'page'
        checks.forEach(c => { c.checked = true; });
        archSelectScope = 'page';
    }
    syncArchBatch();
}

// v4.27.11：点 "全选匹配筛选 N 条" → 一次性勾「所有页、所有匹配当前 lock/q 的存档」
async function selectArchFiltered() {
    if (archiveTotal <= 0) { toast('当前筛选下没有可勾选条目', 'err'); return; }
    const filt = _archLockFilter();
    const msg = archiveTotal > 50
        ? `确定一次性锁定所有 ${archiveTotal.toLocaleString()} 条（当前筛选条件下）吗？\n提示：操作会立即执行，无法撤回。`
        : `确定一次性锁定 ${archiveTotal} 条吗？`;
    if (!confirm(msg)) return;
    archSelectScope = 'filtered';
    archSelectFilteredCount = archiveTotal;
    // 当前页所有 checkbox 都勾上（视觉一致）
    document.querySelectorAll('.mon-arch-check').forEach(c => { c.checked = true; });
    syncArchBatch();
    // 立即调一次后台接口体验，验证 OK 再让用户点批量按钮
    toast(`已切换到「跨页全选」模式（${archiveTotal.toLocaleString()} 条）。现在可点「批量锁定为正版」/「暂停监控」/「恢复监控」/「重新匹配」/「移出名单」`, 'ok', 6000);
    return archiveTotal;
}

async function archBatch(action) {
    let payload;
    let scopeLabel = '';
    if (archSelectScope === 'filtered') {
        // 跨页全选：把筛选条件原样发给后端
        payload = { action, select_all: true, lock_filter: _archLockFilter() };
        scopeLabel = `跨页 ${archSelectFilteredCount.toLocaleString()} 条`;
    } else {
        const ids = [...document.querySelectorAll('.mon-arch-check:checked')].map(c => +c.value);
        if (!ids.length) return;
        payload = { action, archive_ids: ids };
        scopeLabel = `${ids.length} 条`;
    }
    if (action === 'pause' && !confirm(`确定暂停${scopeLabel}的监控？`)) return;
    if (action === 'lock' && !confirm(`确定把${scopeLabel}在各平台「有 ID 的锁定」全部标为✅正版？`)) return;
    if (action === 'delete') {
        // batchDelete 本来可能另调接口，先不阻止
    }
    try {
        const d = await apiJson('/archive/batch_lock', payload);
        toast(`已处理 ${d.affected} 首（${d.scope || '常规'}）`, 'ok');
        if (archSelectScope === 'filtered') archSelectScope = null;  // 一次操作完回到 null
        loadArchive(archivePage); loadStats();
    } catch (e) { toast(e.message, 'err'); }
}

function renderPager(elId, page, size, total, fn) {
    const el = $(elId);
    const pages = Math.max(1, Math.ceil(total / size));
    el.hidden = false;
    el.innerHTML = `
        <button ${page <= 1 ? 'disabled' : ''} data-go="${page - 1}">上一页</button>
        <span>第 ${page} / ${pages} 页　共 ${total} 条</span>
        <button ${page >= pages ? 'disabled' : ''} data-go="${page + 1}">下一页</button>`;
    el.querySelectorAll('button[data-go]').forEach(b =>
        b.addEventListener('click', () => fn(+b.dataset.go)));
}

// ── 运营报告 ────────────────────────────────────
async function loadReport(period) {
    period = period || reportPeriod;
    reportPeriod = period;
    const el = $('repOverview');
    try {
        const d = await api('/report?period=' + period);
        renderReport(d);
    } catch (e) {
        el.innerHTML = `<div class="mon-empty">报告加载失败：${esc(e.message)}</div>`;
    }
}

function renderReport(d) {
    // 顶部提示
    const note = $('repNote');
    if (d.empty_reason === 'no_metrics') {
        note.hidden = false;
        note.className = 'rep-note warn';
        note.textContent = '还没有采集到任何数据。先去「数据监控」点「立即采集今日数据」，这里就有内容了。';
    } else if (!d.has_growth) {
        note.hidden = false;
        note.className = 'rep-note info';
        note.textContent = `目前只有 ${d.days_covered} 天数据（${d.start_date} ~ ${d.end_date}）。多积累几天，涨幅榜才会显示涨跌。`;
    } else {
        note.hidden = true;
    }
    $('repSub').textContent = `统计区间：${d.start_date} ~ ${d.end_date}（${d.period_label}）`;

    // 概览卡片
    const t = d.totals || {};
    const cards = [
        { label: '监控歌曲', value: (d.songs_monitored || 0).toLocaleString(), sub: '在监控名单里' },
        { label: '总收藏量', value: fmtCount(t.collection), sub: '三平台合计' },
        { label: '总在听', value: fmtCount(t.listening), sub: 'QQ/酷狗实时' },
        { label: '总评论', value: fmtCount(t.comment), sub: '三平台合计' },
    ];
    $('repOverview').innerHTML = cards.map(c => `
        <div class="rep-card glass">
            <div class="rep-card-label">${c.label}</div>
            <div class="rep-card-value">${c.value}</div>
            <div class="rep-card-sub">${c.sub}</div>
        </div>`).join('');

    // 涨幅榜
    $('repGainersSub').textContent = d.has_growth ? `期内收藏增长最多` : '需多天数据';
    const g = $('repGainers');
    if (!d.top_gainers || !d.top_gainers.length) {
        g.innerHTML = `<div class="mon-empty">${d.has_growth ? '这段区间没有上涨的歌' : '多积累几天数据后，这里会显示涨得最快的歌'}</div>`;
    } else {
        g.innerHTML = d.top_gainers.map(x => `
            <div class="rep-row">
                <div class="rep-row-main">
                    <div class="rep-row-title">${esc(x.song_name)}</div>
                    <div class="rep-row-sub">${esc(x.artist || '—')} · ${esc(x.platform_name)}</div>
                </div>
                <div class="rep-row-metric up">▲ +${fmtCount(x.delta)}</div>
                <div class="rep-row-meta">现 ${fmtCount(x.cur_collection)}</div>
            </div>`).join('');
    }

    // 最热歌曲
    const h = $('repHot');
    if (!d.top_songs || !d.top_songs.length) {
        h.innerHTML = '<div class="mon-empty">还没有可展示的歌曲</div>';
    } else {
        h.innerHTML = d.top_songs.map(x => {
            const byp = x.collection_by_platform || {};
            const chips = Object.entries(byp).map(([k, v]) =>
                `<span class="rep-chip">${esc(k)} ${fmtCount(v)}</span>`).join('');
            return `<div class="rep-row">
                <div class="rep-row-main">
                    <div class="rep-row-title">${esc(x.song_name)}</div>
                    <div class="rep-row-sub">${esc(x.artist || '—')}</div>
                    <div class="rep-chips">${chips}</div>
                </div>
                <div class="rep-row-metric">${fmtCount(x.collection)}</div>
                <div class="rep-row-meta">总收藏</div>
            </div>`;
        }).join('');
    }

    // 演唱者维度（点击歌手下钻看具体歌单）
    const a = $('repArtists');
    if (!d.top_artists || !d.top_artists.length) {
        a.innerHTML = '<div class="mon-empty">名单里还没标歌手，导入时带上歌手列即可</div>';
    } else {
        a.innerHTML = d.top_artists.map(x => `
            <div class="rep-row" data-artist="${esc(x.artist)}" style="cursor:pointer" title="点开看 ${esc(x.artist)} 监控了哪些歌">
                <div class="rep-row-main">
                    <div class="rep-row-title">${esc(x.artist)}</div>
                    <div class="rep-row-sub">被监控 ${x.songs} 首 · 点开看歌单</div>
                </div>
                <div class="rep-row-metric">${fmtCount(x.collection)}</div>
                <div class="rep-row-meta">总收藏</div>
            </div>`).join('');
    }

    // 跨平台覆盖
    const cov = d.platform_coverage || {};
    const covTotal = (cov.three || 0) + (cov.two || 0) + (cov.one || 0) + (cov.zero || 0) || 1;
    const covBox = $('repCoverage');
    if (!covTotal) {
        covBox.innerHTML = '<div class="mon-empty">还没有监控歌曲</div>';
    } else {
        const seg = [
            ['rep-coverage-3', cov.three || 0, '3 平台全覆盖'],
            ['rep-coverage-2', cov.two || 0, '覆盖 2 平台'],
            ['rep-coverage-1', cov.one || 0, '仅 1 平台'],
            ['rep-coverage-0', cov.zero || 0, '0 平台（没找到）'],
        ];
        covBox.innerHTML =
            `<div class="rep-coverage-bar">`
            + seg.map(([c, n]) => n ? `<i class="${c}" style="width:${Math.round(n / covTotal * 100)}%"></i>` : '').join('')
            + `</div>`
            + `<div class="rep-cov-legend">`
            + seg.map(([, n, t]) => `<span><b>${n}</b> 首 ${t}</span>`).join('')
            + `</div>`;
    }

    // 状态预警
    const al = d.alerts || {};
    const alBox = $('repAlerts');
    const items = [];
    if (al.pending) items.push(['warn', al.pending, '条匹配机器拿不准，需你点开确认（监控名单里筛选「⏳待确认」）']);
    if (al.paused) items.push(['warn', al.paused, '首被暂停监控，每日采集会跳过它们']);
    if (al.stale) items.push(['bad', al.stale, '首 7 天内没采到数据（可能平台接口异常，建议重抓）']);
    if (!items.length) {
        alBox.innerHTML = '<div class="rep-alert-item ok"><span class="rep-alert-num">✓</span>'
            + '<span class="rep-alert-txt">一切正常，没有需要留意的事项</span></div>';
    } else {
        alBox.innerHTML = items.map(([cls, n, txt]) =>
            `<div class="rep-alert-item ${cls}"><span class="rep-alert-num">${n}</span>`
            + `<span class="rep-alert-txt">${esc(txt)}</span></div>`).join('');
    }

    // 榜单上榜
    renderChartHits(d.chart_hits_recent || [], d.chart_hits_by_chart || [], d.last_chart_run || null);
}

// ── 榜单上榜渲染 ──────────────────────────────────────
function renderChartHits(recent, byChart, lastRun) {
    // 榜单来源清单（透明展示「抓的是什么榜」+ 实际抓取是否成功）
    const m = (lastRun && lastRun.message) || '';
    const qqN = parseInt((m.match(/qq=(\d+)/) || [])[1] || '0', 10);
    const kgN = parseInt((m.match(/kg=(\d+)/) || [])[1] || '0', 10);
    const neN = parseInt((m.match(/ne=(\d+)/) || [])[1] || '0', 10);
    const srcs = [
        { p: 'QQ音乐', n: '热歌榜 / 新歌榜 / 飙升榜', ok: qqN > 0 },
        { p: '酷狗音乐', n: 'TOP500 / 飙升榜', ok: kgN > 0 },
        { p: '网易云', n: '热歌 / 新歌 / 飙升榜', ok: neN > 0 },
    ];
    const srcBox = $('repChartSources');
    if (srcBox) {
        srcBox.innerHTML = srcs.map(s =>
            `<span class="rep-chart-src ${s.ok ? 'ok' : 'fail'}" title="${esc(s.n)}">`
            + `${esc(s.p)}：${esc(s.n)}</span>`).join('');
    }

    const empty = $('repChartEmpty'), content = $('repChartContent');
    if (!recent.length && !byChart.length) {
        empty.hidden = false; content.hidden = true;
        if (lastRun && /hits=0/.test(lastRun.message || '')) {
            empty.innerHTML = `已抓取过榜单（${esc(lastRun.finished_at || '')}）。<b>你监控的歌今天没有冲进这些榜</b>`
                + `—— 这是正常情况，大多数歌不会上热歌/新歌/飙升榜。命中后会自动出现在这里。`;
        } else if (lastRun) {
            empty.innerHTML = `最近一次抓榜状态：${esc(lastRun.message || lastRun.status || '未知')}。`
                + `若一直为空，点右上「🔄 立即抓今日榜」重新比对。`;
        } else {
            empty.innerHTML = `还没抓过榜单。<b>这是「智能比对」不是「堆榜单」</b>：点右上「🔄 立即抓今日榜」，`
                + `几秒后系统会把 QQ音乐 / 酷狗 / 网易云 的公开榜单和你监控的歌对照，只有你监控的歌真的上榜了才会出现。`;
        }
        return;
    }
    empty.hidden = true; content.hidden = false;
    const hits = $('repChartHits');
    if (!recent.length) {
        hits.innerHTML = '<div class="mon-empty">期间内暂无监控歌曲上榜</div>';
    } else {
        hits.innerHTML = recent.map(x => {
            const delta = (x.prev_rank == null) ? ''
                : (x.prev_rank > x.rank
                    ? `<span class="delta up">▲ ${x.prev_rank - x.rank}</span>`
                    : (x.prev_rank < x.rank
                        ? `<span class="delta down">▼ ${x.rank - x.prev_rank}</span>`
                        : '<span class="delta">—</span>'));
            const platform = x.platform || '—';
            return `<div class="rep-chart-row">
                <div class="rep-chart-date">${esc(x.stat_date || '')}</div>
                <div>
                    <div class="rep-chart-title">${esc(x.song_name || '')}</div>
                    <div class="rep-chart-artist">${esc(x.artist || '—')} · ${esc(x.chart_name || '')}${x.platform_locked ? '' : ' <span class="rep-chart-nolock" title="曲库在该平台未锁定原版——榜单这条可能是翻唱/下架/歌手错标，并非真正原版上榜">⚠ 平台无原版</span>'}</div>
                </div>
                <div class="rep-chart-platform ${platform}">${esc(platform)}</div>
                <div class="rep-chart-rank">#${x.rank}${delta}</div>
            </div>`;
        }).join('');
    }
    const bc = $('repChartByChart');
    if (!byChart.length) {
        bc.innerHTML = '<div class="mon-empty">暂无榜单汇总</div>';
    } else {
        bc.innerHTML = byChart.map(x => `
            <div class="rep-chart-row">
                <div></div>
                <div>
                    <div class="rep-chart-title">${esc(x.chart_name || x.chart_id)}</div>
                    <div class="rep-chart-artist">${esc(x.platform || '')} · 最佳 #${x.best_rank} / 最差 #${x.worst_rank}</div>
                </div>
                <div></div>
                <div class="rep-chart-rank">${x.c}</div>
            </div>`).join('');
    }
}

// ── 时间工具 ────────────────────────────────────
function elapsed(run) {
    if (run.duration_s) return run.duration_s;
    const t0 = Date.parse((run.started_at || '').replace(' ', 'T'));
    return isNaN(t0) ? 0 : (Date.now() - t0) / 1000;
}
function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.round(s / 60) + ' 分钟';
    return (s / 3600).toFixed(1) + ' 小时';
}

// ── 新增 / 编辑歌曲 ──────────────────────────────
function openAddSong() {
    songEditId = null;
    $('monSongTitle').textContent = '新增歌曲';
    $('monSongDesc').textContent = '歌名 + 歌手 决定这首歌的身份。保存后可以让机器立刻去三平台找官方原版。';
    $('monSongName').value = '';
    $('monSongArtist').value = '';
    $('monSongLyricist').value = '';
    $('monSongComposer').value = '';
    $('monSongAlbum').value = '';
    $('monSongNote').value = '';
    $('monSongAutoMatch').checked = true;
    $('monSongWarn').hidden = true;
    $('monSongOverlay').hidden = false;
    $('monSongName').focus();
}

function openEditSong(aid) {
    const r = archiveCache[aid];
    if (!r) { toast('找不到这条记录', 'err'); return; }
    songEditId = aid;
    $('monSongTitle').textContent = '编辑歌曲';
    $('monSongDesc').textContent = '编辑后按新歌名/歌手重新匹配；若歌名或歌手变了，旧平台锁定会自动作废重搜。';
    $('monSongName').value = r.song_name || '';
    $('monSongArtist').value = r.artist || '';
    $('monSongLyricist').value = r.lyricist || '';
    $('monSongComposer').value = r.composer || '';
    $('monSongAlbum').value = r.album || '';
    $('monSongNote').value = r.note || '';
    $('monSongAutoMatch').checked = true;
    $('monSongWarn').hidden = true;
    $('monSongOverlay').hidden = false;
    $('monSongName').focus();
}

function closeSong() { $('monSongOverlay').hidden = true; }

async function saveSong() {
    const payload = {
        song_name: $('monSongName').value.trim(),
        artist: $('monSongArtist').value.trim(),
        lyricist: $('monSongLyricist').value.trim(),
        composer: $('monSongComposer').value.trim(),
        album: $('monSongAlbum').value.trim(),
        note: $('monSongNote').value.trim(),
        auto_match: $('monSongAutoMatch').checked
    };
    if (!payload.song_name) { $('monSongWarn').textContent = '歌名不能为空'; $('monSongWarn').hidden = false; return; }
    const btn = $('monSongSave');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
        let d;
        if (songEditId) d = await apiJson('/archive/update', { archive_id: songEditId, ...payload });
        else d = await apiJson('/archive/add', payload);
        if (d.duplicate) {
            $('monSongWarn').textContent =
                `名单里已经有《${esc((d.existing || {}).song_name || '')} - ${esc((d.existing || {}).artist || '未知')}》了，无需重复添加。`;
            $('monSongWarn').hidden = false;
            return;
        }
        toast(songEditId ? '已更新' : '已加入名单', 'ok');
        $('monSongOverlay').hidden = true;
        loadArchive(archivePage); loadStats();
        if (d.match_started) toast('已后台开始去三平台找原版', 'ok');
    } catch (e) {
        $('monSongWarn').textContent = e.message; $('monSongWarn').hidden = false;
    } finally {
        btn.disabled = false; btn.textContent = '保存';
    }
}

// ── 导出 Excel ──────────────────────────────────
function exportExcel() {
    const q = new URLSearchParams({ q: $('monArchiveQ').value.trim() });
    const a = document.createElement('a');
    a.href = API + '/archive/export?' + q.toString();
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
    toast('正在导出 Excel…', 'ok');
}

// ── 删除（预览 → 确认）────────────────────────────
// payload 支持两种形态：
//   1) {archive_ids: [...]}          —— 明确指定若干 id
//   2) {select_all:true, lock_filter:{q,lock}} —— v4.27.12：跨页全选删除，按筛选条件解析整库
// 后端 /archive/delete 对这两种形态都支持。
function askDelete(payload, desc) {
    pendingDeletePayload = payload;
    fetch(API + '/archive/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(r => r.json()).then(j => {
        if (!j.ok) throw new Error(j.error);
        const d = j.data;
        $('monDeleteDesc').textContent = desc || `将移除 ${d.song_count} 首歌`;
        let listHtml = (d.songs || []).map(s =>
            `<div class="mon-del-item">#${s.id} ${esc(s.song_name)} - ${esc(s.artist || '未知')}</div>`).join('');
        // v4.27.12：跨页删除时弹窗只截前 30 预览，提示用户还有 N 首未列出
        if (d.preview_truncated) {
            listHtml += `<div class="mon-del-extra">… 还有 ${d.song_count - d.songs.length} 首未列出（弹窗空间有限，已按 id 升序取前 30）</div>`;
        }
        $('monDeleteList').innerHTML = listHtml || '<div class="mon-empty">没有可显示的项</div>';
        const extra = [];
        if (d.metric_rows) extra.push(`${d.metric_rows} 条每日历史指标`);
        if (d.platform_rows) extra.push(`${d.platform_rows} 条平台匹配记录`);
        if (extra.length) $('monDeleteList').insertAdjacentHTML('beforeend',
            `<div class="mon-del-extra">连带删除：${extra.join('，')}</div>`);
        $('monDeleteOverlay').hidden = false;
    }).catch(e => toast('预览失败：' + e.message, 'err'));
}

async function confirmDelete() {
    const btn = $('monDeleteConfirm');
    btn.disabled = true; btn.textContent = '移除中…';
    try {
        const d = await apiJson('/archive/delete', { ...pendingDeletePayload, confirm: 1 });
        toast(`已移除 ${d.deleted} 首`, 'ok');
        $('monDeleteOverlay').hidden = true;
        pendingDeletePayload = null;
        // 跨页全选删除完成后，重置 scope 与可见 checkbox 状态（避免下一轮误判）
        if (archSelectScope === 'filtered') {
            archSelectScope = null;
            archSelectFilteredCount = 0;
        }
        loadArchive(archivePage); loadStats();
    } catch (e) {
        toast(e.message, 'err');
    } finally {
        btn.disabled = false; btn.textContent = '确认移除';
    }
}

// v4.27.13：从「机器拿不准」批量移出监控名单（步骤4 的批量删除）。
// payload 两种形态：{sp_ids:[...]} 或 {select_all:true, review_filter:{q,platform,confidence}}
// 后端 /review/delete 去重为 archive_ids 后复用 archive 删除链路（CASCADE 清平台/指标）。
function askReviewDelete(payload, desc) {
    pendingReviewDeletePayload = payload;
    fetch(API + '/review/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(r => r.json()).then(j => {
        if (!j.ok) throw new Error(j.error);
        const d = j.data;
        $('monDeleteDesc').textContent = desc || `将移除 ${d.song_count} 首歌`;
        let listHtml = (d.songs || []).map(s =>
            `<div class="mon-del-item">#${s.id} ${esc(s.song_name)} - ${esc(s.artist || '未知')}</div>`).join('');
        if (d.preview_truncated) {
            listHtml += `<div class="mon-del-extra">… 还有 ${d.song_count - d.songs.length} 首未列出</div>`;
        }
        $('monDeleteList').innerHTML = listHtml || '<div class="mon-empty">没有可显示的项</div>';
        const extra = [];
        if (d.metric_rows) extra.push(`${d.metric_rows} 条每日历史指标`);
        if (d.platform_rows) extra.push(`${d.platform_rows} 条平台匹配记录`);
        if (extra.length) $('monDeleteList').insertAdjacentHTML('beforeend',
            `<div class="mon-del-extra">连带删除：${extra.join('，')}</div>`);
        $('monDeleteOverlay').hidden = false;
    }).catch(e => toast('预览失败：' + e.message, 'err'));
}

async function batchDeleteReview() {
    let payload, desc, scopeLabel;
    if (reviewSelectScope === 'filtered') {
        payload = { select_all: true, review_filter: _reviewFilter() };
        scopeLabel = `跨页 ${reviewSelectFilteredCount.toLocaleString()} 条`;
    } else {
        const sp_ids = [...document.querySelectorAll('.mon-ri-check:checked')].map(c => +c.value);
        if (!sp_ids.length) { toast('先勾选要移出名单的卡片', 'err'); return; }
        payload = { sp_ids };
        scopeLabel = `${sp_ids.length} 条卡片`;
    }
    desc = `确认从监控名单移除这${scopeLabel}（同 archive 下的其他平台记录/历史指标会一并清掉）？`;
    askReviewDelete(payload, desc);
}

async function confirmReviewDelete() {
    const btn = $('monDeleteConfirm');
    btn.disabled = true; btn.textContent = '移除中…';
    try {
        const d = await apiJson('/review/delete', { ...pendingReviewDeletePayload, confirm: 1 });
        toast(`已从名单移除 ${d.deleted} 首歌`, 'ok');
        $('monDeleteOverlay').hidden = true;
        pendingReviewDeletePayload = null;
        if (reviewSelectScope === 'filtered') {
            reviewSelectScope = null;
            reviewSelectFilteredCount = 0;
        }
        loadReview(reviewPage); loadStats(); loadArchive(archivePage);
    } catch (e) {
        toast(e.message, 'err');
    } finally {
        btn.disabled = false; btn.textContent = '确认移除';
    }
}

// ── 批量重新匹配 ────────────────────────────────
async function batchRematch() {
    const ids = [...document.querySelectorAll('.mon-arch-check:checked')].map(c => +c.value);
    if (!ids.length) return;
    try {
        await apiJson('/platform/rematch', { archive_ids: ids });
        toast(`已开始重新匹配 ${ids.length} 首…`, 'ok');
        startRematchPoll();
    } catch (e) { toast(e.message, 'err'); }
}

function startRematchPoll() {
    if (rematchTimer) return;
    $('monRematchHint').hidden = false;
    rematchTimer = setInterval(async () => {
        let d;
        try { d = await api('/platform/rematch_progress'); } catch (e) { return; }
        if (!d.job || !d.job.running) {
            clearInterval(rematchTimer); rematchTimer = null;
            $('monRematchHint').hidden = true;
            toast('重新匹配完成', 'ok');
            loadArchive(archivePage); loadStats();
        }
    }, 1800);
}

// ── 单首历史曲线 ────────────────────────────────
function openHist(aid) {
    histAid = aid; histDays = 90; histMetric = 'collection';
    $('monHistRange').querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.dataset.days === '90'));
    $('monHistMetric').querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.dataset.metric === 'collection'));
    $('monHistOverlay').hidden = false;
    loadHist();
}

async function loadHist() {
    if (!histAid) return;
    const q = new URLSearchParams({ archive_id: histAid, days: histDays });
    $('monHistBody').innerHTML = '<div class="mon-empty">加载中…</div>';
    let d;
    try { d = await api('/archive/history?' + q); } catch (e) {
        $('monHistBody').innerHTML = '<div class="mon-empty">加载失败：' + esc(e.message) + '</div>';
        return;
    }
    renderHist(d);
}

function renderHist(d) {
    const metric = histMetric;
    const metricName = { collection: '收藏量', listening: '在听', comment: '评论' }[metric];
    const seriesList = (d.series || []).filter(s => (s.points || []).some(p => p[metric] != null));
    $('monHistSub').textContent =
        `${esc((d.song || {}).song_name || '')} - ${esc((d.song || {}).artist || '未知')} · ${metricName}走势（近 ${d.days} 天）`;

    if (!seriesList.length) {
        $('monHistBody').innerHTML =
            '<div class="mon-empty">这首歌还没采集到「' + metricName + '」数据。先恢复监控并点一次「立即采集今日数据」。</div>';
        return;
    }

    // 实事求是：只有 1 天数据画不出走势线，明确告诉用户，不假装画图
    const dateSet = new Set();
    seriesList.forEach(s => (s.points || []).forEach(p => { if (p[metric] != null) dateSet.add(p.date); }));
    const dates = [...dateSet].sort();
    if (dates.length < 2) {
        const only = dates[0] || '';
        let latest = null;
        seriesList.forEach(s => { const v = s.points.filter(p => p[metric] != null); if (v.length) latest = v[v.length - 1][metric]; });
        $('monHistBody').innerHTML =
            '<div class="mon-empty" style="text-align:left;line-height:1.7">'
            + `目前只有 <b>${dates.length}</b> 天（${esc(only)}）的「${metricName}」数据，`
            + '<b>还画不出走势曲线</b>—— 走势至少需要 2 天才能对比涨跌。<br>'
            + (latest != null ? `最新 ${metricName}：${fmtCount(latest)}。<br>` : '')
            + '每天点一次「立即采集今日数据」（或设定时任务），攒几天后这里就会画出收藏 / 在听 / 评论的变化线。</div>';
        return;
    }

    const W = 680, H = 300, padL = 58, padR = 18, padT = 18, padB = 36;
    let ymax = 0;
    const colors = { qq: '#00A344', kugou: '#1B7FD9', netease: '#C8232D' };
    seriesList.forEach(s => (s.points || []).forEach(p => {
        dateSet.add(p.date); const v = p[metric]; if (v != null) ymax = Math.max(ymax, v);
    }));
    ymax = ymax || 1;
    const dateIdx = {}; dates.forEach((x, i) => dateIdx[x] = i);
    const xOf = i => padL + (dates.length <= 1 ? 0 : (i / (dates.length - 1)) * (W - padL - padR));
    const yOf = v => padT + (1 - v / ymax) * (H - padT - padB);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="mon-hist-svg" preserveAspectRatio="none">`;
    for (let t = 0; t <= 4; t++) {
        const v = ymax * t / 4, y = yOf(v);
        svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="mon-hist-grid"/>`;
        svg += `<text x="${padL - 8}" y="${y + 4}" class="mon-hist-ylab" text-anchor="end">${fmtCount(Math.round(v))}</text>`;
    }
    [0, Math.floor((dates.length - 1) / 2), dates.length - 1].forEach(i => {
        if (dates[i]) svg += `<text x="${xOf(i)}" y="${H - padB + 18}" class="mon-hist-xlab" text-anchor="middle">${dates[i].slice(5)}</text>`;
    });
    seriesList.forEach(s => {
        const pts = s.points.filter(p => p[metric] != null)
            .map(p => `${xOf(dateIdx[p.date]).toFixed(1)},${yOf(p[metric]).toFixed(1)}`).join(' ');
        svg += `<polyline points="${pts}" fill="none" stroke="${colors[s.platform] || '#888'}" stroke-width="2.2" stroke-linejoin="round" class="mon-hist-line"/>`;
    });
    svg += `</svg>`;

    const legend = seriesList.map(s => {
        const met = s.points.filter(p => p[metric] != null);
        const f = met.length ? met[0][metric] : null, l = met.length ? met[met.length - 1][metric] : null;
        const dv = (met.length >= 2 && f != null && l != null) ? l - f : null;
        const dvTxt = dv == null ? '' :
            ` <span class="mon-hist-delta ${dv >= 0 ? 'up' : 'down'}">${dv >= 0 ? '+' : ''}${fmtCount(dv)}</span>`;
        return `<span class="mon-hist-leg"><i style="background:${colors[s.platform] || '#888'}"></i>`
            + `${esc(s.name)}：${fmtCount(f || 0)} → ${fmtCount(l || 0)}${dvTxt}</span>`;
    }).join('');

    $('monHistBody').innerHTML = `<div class="mon-hist-chart">${svg}</div><div class="mon-hist-legend">${legend}</div>`;
}

function closeHist() { $('monHistOverlay').hidden = true; }

// ── 匹配详情弹窗（点徽章看机器匹配到哪首 + 人工确认/撤掉）──
let matchAid = null, matchPlat = null;
async function openMatchDetail(aid, plat) {
    matchAid = aid; matchPlat = plat;
    $('monMatchOverlay').hidden = false;
    $('monMatchBody').innerHTML = '<div class="mon-empty">加载中…</div>';
    let d;
    try { d = await api('/archive/history?archive_id=' + aid + '&days=1'); }
    catch (e) {
        $('monMatchBody').innerHTML = '<div class="mon-empty">加载失败：' + esc(e.message) + '</div>';
        return;
    }
    const song = d.song || {};
    const p = (d.platforms || {})[plat] || {};
    const name = song.song_name || '';
    const pname = PLAT_NAME[plat] || plat;
    $('monMatchTitle').textContent = '匹配详情 · ' + pname;
    $('monMatchDesc').textContent =
        `监控歌曲：《${name}》${song.artist ? ' - ' + song.artist : ''}　在「${pname}」匹配到的结果`;
    const isOfficial = p.song_id && p.confidence === 'high'
        && (p.review_status === 'auto_locked' || p.review_status === 'confirmed');
    const statusCls = isOfficial ? 'on' : (p.song_id ? 'mid' : 'off');
    const statusTxt = isOfficial ? '✅ 机器已锁为正版'
        : (p.song_id ? '⏳ 待你确认' : '❌ 平台无此歌');
    const matched = p.matched_name
        ? `<div class="mon-match-line"><span>匹配到：</span>${esc(p.matched_name)}${p.matched_artist ? ' - ' + esc(p.matched_artist) : ''}</div>`
        : '<div class="mon-match-line"><span>匹配到：</span>无（机器没找到，或你已标「平台没有」）</div>';
    const urlLine = p.url
        ? `<a class="mon-match-link" href="${esc(p.url)}" target="_blank" rel="noopener">🔗 在${esc(pname)}打开这首歌核对</a>`
        : '';
    $('monMatchBody').innerHTML =
        `<div class="mon-match-song">你监控的：<b>${esc(name)}</b>${song.artist ? ' - ' + esc(song.artist) : ''}</div>`
        + `<div class="mon-match-plat">
            <div class="mon-match-plat-h">
                <span class="mon-match-plat-name">${esc(pname)}</span>
                <span class="mon-match-status ${statusCls}">${statusTxt}</span>
            </div>${matched}${urlLine}</div>`;
}
function closeMatch() { $('monMatchOverlay').hidden = true; }

// ── 演唱者维度下钻 ──────────────────────────────
async function openArtistDrill(artist) {
    if (!artist) return;
    $('monArtistOverlay').hidden = false;
    $('monArtistTitle').textContent = '演唱者 · ' + artist;
    $('monArtistDesc').textContent = '以下歌曲都在你的监控名单里（点任意一首回到名单对应行）';
    $('monArtistBody').innerHTML = '<div class="mon-empty">加载中…</div>';
    let d;
    try { d = await api('/report/artist_songs?artist=' + encodeURIComponent(artist)); }
    catch (e) {
        $('monArtistBody').innerHTML = '<div class="mon-empty">加载失败：' + esc(e.message) + '</div>';
        return;
    }
    const songs = d.songs || [];
    if (!songs.length) {
        $('monArtistBody').innerHTML = '<div class="mon-empty">这个歌手名下没有监控的歌</div>';
        return;
    }
    $('monArtistBody').innerHTML = songs.map(s => {
        const plats = s.platforms || {};
        const dots = ['qq', 'kugou', 'netease'].map(p => {
            const x = plats[p];
            const on = x && x.song_id;
            return `<span class="mon-artist-dot ${on ? 'on' : 'off'}" title="${esc(PLAT_NAME[p] || p)}：${on ? '已匹配原版' : '未匹配'}"></span>`;
        }).join('');
        const coll = ['qq', 'kugou', 'netease'].map(p => s.latest && s.latest[p]).filter(v => v != null);
        const collTxt = coll.length ? '收藏 ' + fmtCount(coll.reduce((a, b) => a + b, 0)) : '暂无数据';
        return `<div class="mon-artist-item" data-aid="${s.id}">
            <div class="mon-artist-item-name">${esc(s.song_name)}</div>
            <div class="mon-artist-dots">${dots}</div>
            <div class="mon-artist-coll">${esc(collTxt)}</div></div>`;
    }).join('');
    $('monArtistBody').querySelectorAll('.mon-artist-item').forEach(el =>
        el.addEventListener('click', () => {
            $('monArtistOverlay').hidden = true;
            if ($('monArchiveQ')) $('monArchiveQ').value = '';
            if ($('monArchiveLock')) $('monArchiveLock').value = '';
            renderLockSummary({});
            loadArchive(1);
        }));
}
function closeArtist() { $('monArtistOverlay').hidden = true; }

// ── 事件绑定 ────────────────────────────────────
function bindOnce() {
    if (bindOnce.done) return;
    bindOnce.done = true;

    bindUpload();
    $('monImportBtn').addEventListener('click', doImport);
    $('monPvCancel').addEventListener('click', () => { $('monPreview').hidden = true; pvTempPath = ''; });
    $('monRefreshBtn').addEventListener('click', () => { loadStats(); loadReview(reviewPage); loadArchive(archivePage); });

    $('monMatchBtn').addEventListener('click', () => startMatch('pending'));
    $('monRetryBtn').addEventListener('click', () => startMatch('retry'));
    $('monMatchAllBtn').addEventListener('click', () => {
        if (confirm('全部重跑会把已锁定的也重新搜一遍，耗时较长。确定吗？')) startMatch('all');
    });

    $('monDailyBtn').addEventListener('click', () => triggerDaily());

    $('monReviewReload').addEventListener('click', () => loadReview(1));
    $('monReviewQ').addEventListener('keydown', e => { if (e.key === 'Enter') loadReview(1); });
    $('monReviewPlatform').addEventListener('change', () => loadReview(1));
    $('monReviewConf').addEventListener('change', () => loadReview(1));
    // 每页数量选择器
    (function() {
        const sel = $('monReviewSize');
        [10, 20, 50, 100].forEach(n => {
            const o = document.createElement('option');
            o.value = n; o.textContent = n + ' 条/页';
            sel.appendChild(o);
        });
        sel.value = reviewSize;
        sel.addEventListener('change', () => {
            reviewSize = parseInt(sel.value) || 10;
            localStorage.setItem('monReviewSize', reviewSize);
            loadReview(1);
        });
    })();
    $('monBatchConfirm').addEventListener('click', () => batchAction('confirm_top'));
    $('monBatchReject').addEventListener('click', () => batchAction('reject'));
    $('monBatchDeleteReview').addEventListener('click', batchDeleteReview);
    $('monSelectAll').addEventListener('click', toggleSelectAll);
    $('monSelectAllFiltered').addEventListener('click', selectReviewFiltered);
    // 步骤4 筛选条件变化 → 清掉跨页全选 scope（避免基于旧筛选条件误操作）
    const _resetReviewScope = () => {
        reviewSelectScope = null; reviewSelectFilteredCount = 0;
        syncBatchBtns();
    };
    $('monReviewQ').addEventListener('input', _resetReviewScope);
    $('monReviewPlatform').addEventListener('change', _resetReviewScope);
    $('monReviewConf').addEventListener('change', _resetReviewScope);

    $('monArchiveReload').addEventListener('click', () => loadArchive(1));
    $('monArchiveQ').addEventListener('keydown', e => { if (e.key === 'Enter') loadArchive(1); });
    // 监控名单每页数量选择器（v4.27.23：用户自定义持久化）
    (function() {
        const sel = $('monArchiveSize');
        if (!sel) return;
        [10, 20, 50, 100, 200].forEach(n => {
            const o = document.createElement('option');
            o.value = n; o.textContent = n + ' 条/页';
            sel.appendChild(o);
        });
        sel.value = archiveSize;
        sel.addEventListener('change', () => {
            archiveSize = parseInt(sel.value) || 30;
            localStorage.setItem('monArchiveSize', archiveSize);
            loadArchive(1);
        });
    })();
    $('monArchCheckAll').addEventListener('change', toggleArchAll);
    $('monArchSelectFiltered').addEventListener('click', selectArchFiltered);
    $('monBatchLock').addEventListener('click', () => archBatch('lock'));
    $('monBatchPause').addEventListener('click', () => archBatch('pause'));
    $('monBatchResume').addEventListener('click', () => archBatch('resume'));

    // 筛选条件变化 → 清掉跨页全选 scope（避免基于旧筛选条件误操作）
    const _resetScope = () => { archSelectScope = null; };
    $('monArchiveQ').addEventListener('input', _resetScope);
    $('monArchiveLock').addEventListener('change', _resetScope);

    // ── 名单管理（v4.25.20）：增删改 / 平台解锁重搜 / 导出 / 历史 ──
    $('monArchiveTable').addEventListener('click', onArchTableClick);
    $('monArchiveLock').addEventListener('change', () => loadArchive(1));
    $('monAddSongBtn').addEventListener('click', openAddSong);
    $('monSongSave').addEventListener('click', saveSong);
    $('monSongCancel').addEventListener('click', closeSong);
    $('monExportBtn').addEventListener('click', exportExcel);
    $('monBatchDelete').addEventListener('click', () => {
        // v4.27.12：跨页全选删除（archSelectScope='filtered'）必须把 select_all
        // + lock_filter 透传给后端，否则 ids 只含当前页 ~30 条，弹窗与实际删除
        // 都会少一大截（用户截图复现：「全选 → 弹窗显示 30 首 → 实际只删 30 首」）。
        if (archSelectScope === 'filtered') {
            const n = archSelectFilteredCount || archiveTotal || 0;
            if (!n) { toast('当前筛选下没有可勾选条目', 'err'); return; }
            askDelete({ select_all: true, lock_filter: _archLockFilter() },
                      `确认把当前筛选条件下的全部 ${n.toLocaleString()} 首歌从名单移除？`);
            return;
        }
        const ids = [...document.querySelectorAll('.mon-arch-check:checked')].map(c => +c.value);
        if (!ids.length) { toast('先勾选要移除的歌', 'err'); return; }
        askDelete({ archive_ids: ids }, `确认把选中的 ${ids.length} 首歌从名单移除？`);
    });
    $('monBatchRematch').addEventListener('click', batchRematch);
    $('monDeleteConfirm').addEventListener('click', () => {
        // 步骤4（review）和步骤5（archive）共用一个弹窗按钮：根据哪个 payload 非空决定走哪条 confirm。
        if (pendingReviewDeletePayload) return confirmReviewDelete();
        return confirmDelete();
    });
    $('monDeleteCancel').addEventListener('click', () => { $('monDeleteOverlay').hidden = true; });
    $('monHistClose').addEventListener('click', closeHist);
    // 演唱者维度下钻
    $('repArtists').addEventListener('click', e => {
        const row = e.target.closest('[data-artist]');
        if (row) openArtistDrill(row.dataset.artist);
    });
    // 匹配详情弹窗
    $('monMatchClose').addEventListener('click', closeMatch);
    $('monMatchUnlock').addEventListener('click', async () => {
        if (!matchAid || !matchPlat) return;
        try {
            await apiJson('/platform/unlock', { archive_id: matchAid, platform: matchPlat });
            toast('已撤掉锁定，可重新去平台找', 'ok'); closeMatch(); loadArchive(archivePage); loadStats();
        } catch (e) { toast(e.message, 'err'); }
    });
    $('monMatchRematch').addEventListener('click', () => {
        if (!matchAid || !matchPlat) return;
        closeMatch();
        apiJson('/platform/rematch', { archive_id: matchAid, platform: matchPlat })
            .then(() => { toast('已开始重新匹配…', 'ok'); startRematchPoll(); })
            .catch(e => toast(e.message, 'err'));
    });
    $('monArtistClose').addEventListener('click', closeArtist);
    $('monHistRange').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        $('monHistRange').querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active'); histDays = +b.dataset.days; loadHist();
    }));
    $('monHistMetric').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        $('monHistMetric').querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active'); histMetric = b.dataset.metric; loadHist();
    }));
    // 弹窗点遮罩关闭
    ['monSongOverlay', 'monHistOverlay', 'monDeleteOverlay', 'monMatchOverlay', 'monArtistOverlay'].forEach(id => {
        const ov = $(id);
        ov.addEventListener('click', e => { if (e.target === ov) ov.hidden = true; });
    });

    // 报告页周期切换 / 刷新
    $('repPeriod').querySelectorAll('button').forEach(b =>
        b.addEventListener('click', () => {
            $('repPeriod').querySelectorAll('button').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            loadReport(b.dataset.period);
        }));
    $('repRefreshBtn').addEventListener('click', () => triggerDaily(() => loadReport(reportPeriod)));
    $('repChartRefresh').addEventListener('click', () => triggerChart(() => loadReport(reportPeriod)));

    // 候选卡片 / 拒绝按钮 —— 事件委托
    $('monReviewList').addEventListener('click', e => {
        const cand = e.target.closest('.mon-cand');
        if (cand) return confirmChoice(cand.dataset.sp, cand.dataset.idx);
        const rej = e.target.closest('.mon-ri-reject');
        if (rej) return rejectOne(rej.dataset.sp);
    });
}

// ── 榜监控触发 ──────────────────────────────────────
async function triggerChart(then) {
    const btn = $('repChartRefresh');
    if (btn) { btn.disabled = true; btn.textContent = '抓取中…'; }
    try {
        const resp = await fetch(API + '/chart/start', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const j = await resp.json();
        if (!resp.ok || !j.ok) {
            alert('榜监控启动失败：' + (j.error || resp.status));
            return;
        }
        // 后台线程跑（5-10 秒），轮询
        let polled = 0;
        const timer = setInterval(async () => {
            polled += 1;
            try {
                const r = await fetch(API + '/chart/progress');
                const pj = await r.json();
                const run = (pj.data || {}).run || {};
                if (run.status && run.status !== 'running') {
                    clearInterval(timer);
                    if (then) then();
                    return;
                }
            } catch (_) {}
            if (polled >= 12) clearInterval(timer);  // 至多 60 秒
        }, 5000);
        // 立即拉一次给用户看
        setTimeout(() => then && then(), 8000);
    } catch (e) {
        alert('请求失败：' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 立即抓今日榜'; }
    }
}

// ── 入口 ────────────────────────────────────────
window.loadMonitorPage = function () {
    bindOnce();
    loadStats();
    loadReview(1);
    loadArchive(1);
};

window.loadReportPage = function () {
    bindOnce();
    loadReport(reportPeriod);
    loadStats();
};

// 页面启动时静默拉一次：给页签打待办红点
fetch(API + '/stats').then(r => r.json()).then(j => {
    if (!j.ok) return;
    const n = (j.data.platform_pending || 0);
    const dot = $('monTabDot');
    if (dot && n > 0) {
        dot.hidden = false;
        dot.title = `${n} 条待复核`;
    }
}).catch(() => {});

})();
