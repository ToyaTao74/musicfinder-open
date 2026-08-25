// ═══════════════════════════════════════════════════════════════
//  我的歌单页：导入本机专属歌单 → 搜各平台 → 区分原版/翻唱 → 缓存自动展示
//  数据存 ~/.musicfinder/（每台设备独立），不进云端；打开即跳本页并加载缓存。
//  v4.1 词曲作者精准匹配；v4.2 SSE 边搜边显示
// ═══════════════════════════════════════════════════════════════
(function () {
    'use strict';

    const PLATFORMS = [
        { code: 'qq', name: 'QQ音乐', color: '#31c27c' },
        { code: 'kugou', name: '酷狗', color: '#2ca2f9' },
        { code: 'kuwo', name: '酷我', color: '#ff9a00' },
        { code: 'netease', name: '网易云', color: '#e60026' },
        { code: 'qishui', name: '汽水', color: '#00d4d4' },
    ];

    const plSongInput = document.getElementById('plSongInput');
    const plCount = document.getElementById('plCount');
    const plLoadDemoBtn = document.getElementById('plLoadDemoBtn');
    const plUploadZone = document.getElementById('plUploadZone');
    const plFileInput = document.getElementById('plFileInput');
    const plUploadInner = document.getElementById('plUploadInner');
    const plImportBtn = document.getElementById('plImportBtn');
    const plResearchBtn = document.getElementById('plResearchBtn');
    const plClearBtn = document.getElementById('plClearBtn');
    const plProgressWrap = document.getElementById('plProgressWrap');
    const plProgressFill = document.getElementById('plProgressFill');
    const plProgressText = document.getElementById('plProgressText');
    const plResultSection = document.getElementById('plResultSection');
    const plResultCount = document.getElementById('plResultCount');
    const plSearchedAt = document.getElementById('plSearchedAt');
    const plCards = document.getElementById('plCards');
    const plEmpty = document.getElementById('plEmpty');
    const plDownloadBtn = document.getElementById('plDownloadBtn');
    const plFilterInput = document.getElementById('plFilterInput');
    const plFilterClear = document.getElementById('plFilterClear');
    const plFilterCount = document.getElementById('plFilterCount');
    const plFilterRow = document.getElementById('plFilterRow');
    const plBatchRow = document.getElementById('plBatchRow');
    const plBatchSelectAll = document.getElementById('plBatchSelectAll');
    const plBatchUnselect = document.getElementById('plBatchUnselect');
    const plBatchMarkPos = document.getElementById('plBatchMarkPos');
    const plBatchMarkPir = document.getElementById('plBatchMarkPir');
    const plOnlyPinnedBtn = document.getElementById('plOnlyPinnedBtn');
    const plRefreshPinBtn = document.getElementById('plRefreshPinBtn');
    const plPinCount = document.getElementById('plPinCount');
    const plRecycleBtn = document.getElementById('plRecycleBtn');
    const plBatchBar = document.getElementById('plBatchBar');
    const plBatchCount = document.getElementById('plBatchCount');
    const plBatchDelete = document.getElementById('plBatchDelete');
    const plBatchSelectAllBtn = document.getElementById('plBatchSelectAll');
    const plBatchClearBtn = document.getElementById('plBatchClear');

    let lastPlaylistResults = [];      // 顺序展示+缓存
    let pinnedList = [];                // 固定监测清单（来自 /api/playlist/pins）
    let onlyPinned = false;            // 顶部「仅看固定」开关
    let streaming = false;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function fmt(v) {
        if (v === null || v === undefined || v === '') return '<span class="empty-cell">—</span>';
        return Number(v).toLocaleString('en-US');
    }
    function norm(s) { return (s == null ? '' : String(s)).trim(); }

    // ── 解析输入为歌单数组 ──
    function parseSongs(text) {
        const lines = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const songs = [];
        for (const line of lines) {
            let parts = line.split(/[,，\t、]/).map(s => s.trim()).filter(Boolean);
            if (parts.length <= 1) parts = line.split(/\s+/).map(s => s.trim()).filter(Boolean);
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
    function updatePlCount() {
        if (plCount) plCount.textContent = parseSongs(plSongInput.value).length;
    }
    if (plSongInput) plSongInput.addEventListener('input', updatePlCount);

    if (plLoadDemoBtn) {
        plLoadDemoBtn.addEventListener('click', function () {
            plSongInput.value = [
                '晴天,周杰伦,方文山,周杰伦',
                '稻香,周杰伦',
                '告白气球,周杰伦',
            ].join('\n');
            updatePlCount();
        });
    }

    // ── 文件上传：复用 /api/batch_upload 解析 Excel/Word ──
    async function handleFile(file) {
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        plUploadInner.style.opacity = '0.5';
        try {
            const resp = await fetch('/api/batch_upload', { method: 'POST', body: fd });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '解析失败');
            plSongInput.value = data.songs.map(s => {
                const parts = [s.song_name, s.performer || '', s.lyricist || '', s.composer || ''];
                while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
                return parts.join(',');
            }).join('\n');
            updatePlCount();
        } catch (e) {
            alert('文件解析失败：' + e.message);
        } finally {
            plUploadInner.style.opacity = '1';
        }
    }
    if (plUploadInner) {
        plUploadInner.addEventListener('click', function () { plFileInput.click(); });
        plFileInput.addEventListener('change', function () {
            if (plFileInput.files && plFileInput.files[0]) handleFile(plFileInput.files[0]);
        });
        plUploadZone.addEventListener('dragover', function (e) { e.preventDefault(); plUploadZone.classList.add('drag'); });
        plUploadZone.addEventListener('dragleave', function () { plUploadZone.classList.remove('drag'); });
        plUploadZone.addEventListener('drop', function (e) {
            e.preventDefault();
            plUploadZone.classList.remove('drag');
            if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
        });
    }

    // ── v4.4 状态条：5 个固定 tag ──
    // 不允许写「原版候选（词作者未匹配）」这种带描述的句子。
    // 描述性信息走 title 属性（鼠标悬停看原因），不在卡片上展开。
    // 5 个 tag 含义：
    //   精准匹配：用户输入的词曲作者在该平台版本上严格命中
    //   疑似原版：表演者+歌名匹配上，但词曲作者缺失或部分不匹配
    //   非原版：纯翻唱/伴奏/改编版本
    //   平台未收录：5 平台都没有数据
    //   匹配异常：限流/接口失败/超时，需要人工重试
    function statusTagFor(item) {
        if (!item) return { tag: '平台未收录', cls: 'gray', tip: '5 个平台都没有数据' };
        const pd = item.platform_data || {};
        const availCodes = ['qq', 'kugou', 'kuwo', 'netease', 'qishui'];
        const has = availCodes.filter(c => pd[c] && pd[c].song_name).length;
        // 异常：被限流/接口失败的平台
        const limited = availCodes.filter(c => {
            const p = pd[c];
            return p && p.availability === '限流';
        }).length;
        if (limited >= 3) return { tag: '匹配异常', cls: 'orange', tip: '3+ 平台限流/接口失败，请稍后重试' };
        if (!has) return { tag: '平台未收录', cls: 'gray', tip: '5 个平台都没有收录' };
        if (item.is_cover) return { tag: '非原版', cls: 'red', tip: '翻唱/伴奏/改编版本' };
        const isOrig = item.is_original === true;
        const hasLy = !!(item.query && item.query.lyricist);
        const hasCo = !!(item.query && item.query.composer);
        if (isOrig) {
            const hitL = item.lyricist_hit;
            const hitC = item.composer_hit;
            if ((!hasLy || hitL === true) && (!hasCo || hitC === true)) {
                return { tag: '精准匹配', cls: 'green', tip: '歌名+表演者+词曲作者全部命中' };
            }
            const miss = [];
            if (hasLy && hitL === false) miss.push('词作者');
            if (hasCo && hitC === false) miss.push('曲作者');
            return { tag: '疑似原版', cls: 'yellow', tip: miss.length ? '命中' + miss.join('/') + '缺失或不匹配' : '表演者/歌名匹配但词曲数据缺失' };
        }
        return { tag: '疑似原版', cls: 'yellow', tip: '未标记原版，但搜到该版本' };
    }

    // ── 渲染一个平台单元（缺数据时收成一条"未收录"小胶囊，避免 5 个空盒子） ──
    // v4.5 按钮分组：链接组（复制+打开）｜标记组（正版+盗版），两用途不同色
    // v4.5 加词曲作者行：平台抓到的（标蓝）vs 档案的（标红差异），方便人工校对
    function renderPlat(p, itemQuery) {
        const d = p.data || {};
        const has = !!d.song_name;
        if (!has) {
            return '<div class="pl-plat pl-plat--empty"><span class="pl-plat-name">' + p.name +
                '</span><span class="pl-plat-none">未收录</span></div>';
        }
        const perf = d.performer || '';
        const link = d.link || '';
        const q = itemQuery || {};
        const qL = (q.lyricist || '').trim();
        const qC = (q.composer || '').trim();
        const dL = (d.lyricist || '').trim();
        const dC = (d.composer || '').trim();
        const diffL = qL && !samePerson(qL, dL);
        const diffC = qC && !samePerson(qC, dC);

        // ── 按钮：分两组（链接 / 标记），用途不同、颜色分开 ──
        let btnHtml = '<div class="pl-plat-actions">';
        if (link) {
            btnHtml += '<div class="pl-plat-grp pl-grp-link">' +
                '<button type="button" class="pl-plat-btn pl-copy" data-link="' + esc(link) +
                '" title="复制链接">复制</button>' +
                '<a class="pl-plat-btn pl-open" href="' + esc(link) +
                '" target="_blank" title="新窗口打开">打开</a>' +
                '</div>';
        }
        btnHtml += '<div class="pl-plat-grp pl-grp-mark">' +
            '<button type="button" class="pl-plat-btn pl-mark-pos" data-platform="' + esc(p.code) +
            '" data-platform-name="' + esc(p.name) + '" title="把该平台这首标为正版">正版</button>' +
            '<button type="button" class="pl-plat-btn pl-mark-pir" data-platform="' + esc(p.code) +
            '" data-platform-name="' + esc(p.name) + '" title="把该平台这首标为盗版/翻唱">盗版</button>' +
            '</div>';
        // 重抓按钮：5 平台都显示（后端 /api/refetch 通用化后所有平台都能补全）
        btnHtml += '<div class="pl-plat-grp pl-grp-refetch">' +
            '<button type="button" class="pl-plat-btn pl-refetch" data-platform="' + esc(p.code) +
            '" title="重新抓取该平台的词曲作者/详情（平台接口偶发漏抓时手动补）">↻ 重抓</button>' +
            '</div>';
        btnHtml += '</div>';
        const avail = d.availability || '在架';
        const availCls = avail === '在架' ? 'ok' : (avail === '限流' ? 'warn' : (avail === '下架' ? 'down' : 'none'));
        const counts = [fmt(d.collection_count), fmt(d.listening_count), fmt(d.comment_count)].join(' / ');

        // ── 词曲作者行：平台抓到（抓：xxx/xxx）+ 与档案差异高亮（红 ⚠）──
        const wjHtml = renderPlatWj(dL, dC, qL, qC, diffL, diffC);

        return '<div class="pl-plat pl-plat--has" data-platform="' + esc(p.code) + '">' +
            '<div class="pl-plat-head"><span class="pl-plat-dot" style="background:' + p.color + '"></span>' +
            '<span class="pl-plat-name">' + p.name + '</span></div>' +
            '<div class="pl-plat-artist">' + esc(d.song_name + (perf ? (' - ' + perf) : '')) + '</div>' +
            wjHtml +
            '<div class="pl-plat-counts">' + counts + '</div>' +
            '<div class="pl-plat-brand">' + esc(d.record_label ? d.record_label : '—') + '</div>' +
            '<div class="pl-plat-avail ' + availCls + '">' + esc(avail) + '</div>' +
            btnHtml +
            '</div>';
    }

    // 词曲作者对比行（平台抓 vs 档案，差异标红 ⚠ + 档案作小灰字）
    // 用户场景：边看卡片边校对自己 Excel 里的词曲作者
    //   - 没填档案（qL/qC 空） → 只显示「词 xx · 曲 xx」
    //   - 平台抓到 + 档案有 + 一致 → 「词 xx 档:yy · 曲 xx 档:yy」
    //   - 平台抓到 + 档案有 + 差异 → 「词 ⚠xx ⚠档:yy · 曲 ⚠xx ⚠档:yy」（红）
    //   - 平台没抓到 + 档案有 → 「词 — 档:yy · 曲 — 档:yy」（灰待人工）
    function renderPlatWj(dL, dC, qL, qC, diffL, diffC) {
        const cell = (v, diff, hasArch, arch) => {
            if (!v) {
                return hasArch
                    ? '<span class="pl-wj-empty" title="平台没抓到">—</span>' +
                           '<span class="pl-wj-arch">档：' + esc(arch) + '</span>'
                    : '<span class="pl-wj-empty">—</span>';
            }
            const valCls = diff ? 'diff' : 'ok';
            const valHtml = '<span class="pl-wj-val ' + valCls + '">' + esc(v) + '</span>';
            const archHtml = hasArch
                ? '<span class="pl-wj-arch' + (diff ? ' diff' : '') + '">' +
                       (diff ? '⚠档：' : '档：') + esc(arch) + '</span>'
                : '';
            return valHtml + archHtml;
        };
        return '<div class="pl-plat-wj">' +
            '<span class="pl-wj-tag">词</span>' + cell(dL, diffL, !!qL, qL) +
            '<span class="pl-wj-sep">·</span>' +
            '<span class="pl-wj-tag">曲</span>' + cell(dC, diffC, !!qC, qC) +
            '</div>';
    }

    // 轻量人名相等：剥括号 + 去空白 + 小写
    // 不引入 normalize.js，避免在主程序路径上加载 4000+ 行匹配模块
    function samePerson(a, b) {
        if (!a || !b) return true;
        const norm = s => String(s).replace(/[（(][^）)]*[）)]/g, '')
                                 .replace(/[\s·、，,]/g, '').toLowerCase();
        return norm(a) === norm(b);
    }

    // ── v4.6 固定监测：从版本块数据里提取各平台歌曲 ID（镜像后端 _platform_ids_of 的优先级）──
    function _entry_ids(entry) {
        const pd = (entry && entry.platform_data) || {};
        const order = [
            ['qq', ['_songid', '_songmid']],
            ['kugou', ['_hash', '_mixsongid']],
            ['netease', ['_song_id']],
            ['kuwo', ['_songid', '_songmid']],
            ['qishui', ['_song_id', '_hash']],
        ];
        const ids = {};
        for (const [code, fields] of order) {
            const p = pd[code];
            if (p && typeof p === 'object') {
                for (const f of fields) {
                    const v = p[f];
                    if (v) { ids[code] = String(v); break; }
                }
            }
        }
        return ids;
    }
    // 该版本是否在固定清单里（按平台 ID 对齐，无需后端算钥匙）
    function _isPinned(entry) {
        if (!pinnedList.length) return false;
        const ids = _entry_ids(entry);
        return pinnedList.some(p => {
            const pi = p.platform_ids || {};
            return Object.keys(pi).some(c => pi[c] && ids[c] && String(pi[c]) === String(ids[c]));
        });
    }
    // 给单个版本块应用固定态（按钮文案 + 高亮）
    function _applyPinnedToBlock(block) {
        if (!block) return;
        const entry = block.__entry;
        const btn = block.querySelector('.pl-ver-pin');
        if (!btn) return;
        const on = entry ? _isPinned(entry) : false;
        block.classList.toggle('is-pinned', on);
        btn.classList.toggle('is-pinned', on);
        btn.textContent = on ? '📌 已固定' : '📌 固定';
    }
    // 拉取固定清单（页面加载时调用一次）
    async function loadPins() {
        try {
            const d = await fetch('/api/playlist/pins').then(r => r.json());
            pinnedList = d.pins || [];
        } catch (e) {
            pinnedList = [];
        }
        _refreshPinUI();
        // 重新标注已渲染卡片的固定态
        if (plCards) {
            plCards.querySelectorAll('.pl-version').forEach(b => _applyPinnedToBlock(b));
        }
        applyOnlyPinned();
    }
    // 更新顶部「固定清单」计数 + 「仅看固定」按钮文案
    function _refreshPinUI() {
        if (plPinCount) plPinCount.textContent = '📌 固定清单 ' + pinnedList.length;
        if (plOnlyPinnedBtn) {
            plOnlyPinnedBtn.classList.toggle('active', onlyPinned);
            plOnlyPinnedBtn.textContent = onlyPinned ? '✓ 仅看固定' : '仅看固定';
        }
    }
    // 「仅看固定」过滤：隐藏没有固定版本的整首卡片 + 非固定的版本块（由 CSS 配合）
    function applyOnlyPinned() {
        if (!plCards) return;
        plCards.classList.toggle('only-pinned', onlyPinned);
        plCards.querySelectorAll('.pl-card').forEach(card => {
            const hasPinned = card.querySelector('.pl-version.is-pinned');
            card.classList.toggle('hidden-no-pin', onlyPinned && !hasPinned);
        });
    }
    // 按平台 ID 在已渲染卡片里找版本块
    function _findBlockByIds(ids) {
        if (!plCards || !ids) return null;
        let found = null;
        plCards.querySelectorAll('.pl-version').forEach(b => {
            if (found) return;
            const bids = _entry_ids(b.__entry);
            if (Object.keys(ids).some(c => ids[c] && bids[c] && String(ids[c]) === String(bids[c]))) found = b;
        });
        return found;
    }
    // 刷新固定清单数据：后台按平台 ID 重新查，回填最新收藏/在听/评论
    async function refreshPinnedData() {
        if (!pinnedList.length) { showToast('固定清单是空的，先点版本上的「📌固定」', ''); return; }
        plRefreshPinBtn.disabled = true;
        const old = plRefreshPinBtn.textContent;
        plRefreshPinBtn.textContent = '刷新中…';
        try {
            const resp = await fetch('/api/playlist/pins/refresh', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ concurrency: 3 })
            });
            const j = await resp.json();
            if (!j.ok) throw new Error(j.error || '失败');
            for (const pin of (j.pins || [])) {
                const block = _findBlockByIds(pin.platform_ids);
                if (block && pin.platform_data) {
                    const plats = block.querySelector('.pl-plats');
                    if (plats) {
                        const q = { lyricist: pin.lyricist, composer: pin.composer };
                        plats.innerHTML = PLATFORMS.map(p =>
                            renderPlat({ code: p.code, name: p.name, color: p.color, data: pin.platform_data[p.code] || {} }, q)
                        ).join('');
                    }
                    block.classList.toggle('refreshed-missing', !!pin.refreshed_missing);
                }
            }
            showToast('已刷新 ' + j.updated + ' 首固定歌曲'
                + (j.missing ? ('，' + j.missing + ' 首未找到（可能已下架）') : ''), '');
        } catch (e) {
            showToast('刷新失败：' + e.message, 'err');
        } finally {
            plRefreshPinBtn.disabled = false;
            plRefreshPinBtn.textContent = old;
        }
    }

    // ── v4.7 回收站：展示已删除的版本/整首，一键恢复 ──
    const recycleOverlay = document.getElementById('recycleOverlay');
    const recycleClose = document.getElementById('recycleClose');
    const recycleList = document.getElementById('recycleList');
    const recycleEmpty = document.getElementById('recycleEmpty');

    function updateRecycleBadge(n) {
        if (plRecycleBtn) plRecycleBtn.textContent = '🗑 回收站 (' + (n || 0) + ')';
    }
    async function loadRecycle() {
        try {
            const d = await fetch('/api/playlist/deleted').then(r => r.json());
            const log = d.log || [];
            window.__recycleLog = log;
            updateRecycleBadge(log.length);
            if (!log.length) {
                recycleList.innerHTML = '';
                if (recycleEmpty) recycleEmpty.style.display = '';
                return;
            }
            if (recycleEmpty) recycleEmpty.style.display = 'none';
            recycleList.innerHTML = log.map((e, i) => {
                const isSong = e.type === 'song';
                const icon = isSong ? '🎵' : '🎚';
                const meta = [
                    isSong ? '整首删除' : ('版本 · ' + (e.label || '')),
                    e.performer ? '演唱 ' + e.performer : '',
                    e.deleted_at || '',
                ].filter(Boolean).join('　·　');
                const name = esc(e.song_name || '未命名');
                return '<div class="recycle-item" data-i="' + i + '">'
                    + '<span class="ri-icon">' + icon + '</span>'
                    + '<div class="ri-main"><div class="ri-name">' + name + '</div>'
                    + '<div class="ri-meta">' + esc(meta) + '</div></div>'
                    + '<button type="button" class="ri-restore" data-restore="' + i + '">恢复</button>'
                    + '</div>';
            }).join('');
        } catch (e) {
            updateRecycleBadge(0);
        }
    }
    async function restoreItem(e) {
        const url = e.type === 'song' ? '/api/playlist/song/restore' : '/api/playlist/version/restore';
        const body = e.type === 'song'
            ? { song_name: e.song_name || '', performer: e.performer || '' }
            : { key: e.key };
        const resp = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await resp.json();
        if (!j.ok) throw new Error(j.error || '恢复失败');
    }
    function openRecycle() {
        if (recycleOverlay) recycleOverlay.hidden = false;
        loadRecycle();
    }
    function closeRecycle() {
        if (recycleOverlay) recycleOverlay.hidden = true;
    }
    if (plRecycleBtn) plRecycleBtn.addEventListener('click', openRecycle);
    if (recycleClose) recycleClose.addEventListener('click', closeRecycle);
    if (recycleOverlay) {
        recycleOverlay.addEventListener('click', function (ev) {
            if (ev.target === recycleOverlay) closeRecycle();
        });
    }
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && recycleOverlay && !recycleOverlay.hidden) closeRecycle();
    });
    if (recycleList) {
        recycleList.addEventListener('click', function (ev) {
            const btn = ev.target.closest('[data-restore]');
            if (!btn) return;
            const i = parseInt(btn.getAttribute('data-restore'), 10);
            const items = recycleList.querySelectorAll('.recycle-item');
            const itemEl = items[i];
            if (!itemEl) return;
            const log = (window.__recycleLog || []);
            const entry = log[i];
            if (!entry) return;
            btn.disabled = true;
            btn.textContent = '恢复中…';
            restoreItem(entry).then(() => {
                showToast('已恢复《' + (entry.song_name || '') + '》', '');
                // 重新加载歌单（让被删版本/歌曲重新出现）+ 刷新回收站
                loadPlaylistPage();
                loadRecycle();
            }).catch(err => {
                btn.disabled = false;
                btn.textContent = '恢复';
                showToast('恢复失败：' + err.message, 'err');
            });
        });
    }
    if (plOnlyPinnedBtn) plOnlyPinnedBtn.addEventListener('click', function () {
        onlyPinned = !onlyPinned;
        _refreshPinUI();
        applyOnlyPinned();
    });
    if (plRefreshPinBtn) plRefreshPinBtn.addEventListener('click', refreshPinnedData);


    function renderPlats(entry) {
        const pd = entry.platform_data || {};
        // 兼容两种 entry 来源：
        //   - 外层 item: {query: {song_name, performer, lyricist, composer}, original, versions}
        //   - 原版 group: {platform_data, lyricist_query, composer_query, ...}
        // 两种都有 lyricist/composer 可对照（一个叫 lyricist/composer，一个叫 lyricist_query/composer_query）
        const q = entry.query || {
            lyricist: entry.lyricist_query || '',
            composer: entry.composer_query || '',
        };
        // 始终渲染 5 列；缺数据时格子收成"未收录"——保持网格对齐、视觉清爽
        const cells = PLATFORMS.map(p => renderPlat({ code: p.code, name: p.name, color: p.color, data: pd[p.code] || {} }, q));
        return '<div class="pl-plats">' + cells.join('') + '</div>';
    }

    // ── 渲染一个版本行（原版/伴奏/翻唱等） ──
    // v4.4：状态条改 5 固定 tag，描述性信息走 title（鼠标悬停看原因）
    // v4.6：版本头加「📌固定 / ✕删除」操作（固定进监测清单 / 删掉不要的版本）
    // v4.15：追加 mark_type pill（与搜索页/已标记页共用 window.markClass 配色），
    //        让"打标"在三页视觉一致；附加 tags 走 mark-tag-pill 描边样式。
    function renderVersionRow(item, isOriginalBlock) {
        const st = statusTagFor(item);
        const cls = isOriginalBlock ? 'pl-ver--orig' : (item.is_cover ? 'pl-ver--cover' : 'pl-ver--other');
        // 别称旁注：v4.3 保留，原版/翻唱只要 alt_name 不空就在 tag 旁小字显示
        const altName = item.alt_name || '';
        const altHtml = altName
            ? '<span class="pl-ver-altname">别称：' + esc(altName) + '</span>'
            : '';
        const kindLabel = isOriginalBlock ? '原版' : '版本';
        // ── 标签区：mark_type（主标签）+ tags[]（附加标签），与搜索页/已标记页一致 ──
        const mc = window.markClass || function () { return 'def'; };
        let marksHtml = '';
        const mkObj = item.mark || null;
        if (mkObj) {
            const mt = (mkObj.mark_type || '').trim();
            if (mt) {
                marksHtml += '<span class="mark-type-pill mark-' + esc(mc(mt)) +
                    '" title="主标签&#10;更新：' + esc(mkObj.updated_at || '') +
                    '&#10;备注：' + esc(mkObj.note || '无') +
                    '">' + esc(mt) + '</span>';
            } else {
                // mark 存在但 mark_type 被清空（v4.14 清空模式）→ 显示「未标记」
                marksHtml += '<span class="mark-type-pill mark-def">未标记</span>';
            }
            const tags = mkObj.tags || [];
            for (const t of tags) {
                if (!t) continue;
                marksHtml += '<span class="mark-tag-pill mark-' + esc(mc(t)) + '">' + esc(t) + '</span>';
            }
        }
        return '<div class="pl-version ' + cls + '">' +
            '<div class="pl-ver-head">' +
            '<label class="pl-ver-check" title="勾选后可批量删除（删除这个' + kindLabel + '，可从回收站恢复）">' +
            '<input type="checkbox" class="pl-ver-checkbox" />' +
            '<span class="pl-ver-checkmark"></span></label>' +
            '<span class="pl-status-tag pl-status-' + st.cls + '" title="' + esc(st.tip) + '">' + esc(st.tag) + '</span>' +
            marksHtml +
            altHtml +
            '<span class="pl-ver-actions">' +
            '<button type="button" class="pl-ver-pin" title="固定这个' + kindLabel + '到监测清单，以后可一键刷新它的数据">📌 固定</button>' +
            '<button type="button" class="pl-ver-del" title="删除这个' + kindLabel + '（可从删除黑名单恢复）">✕</button>' +
            '</span>' +
            '</div>' +
            renderPlats(item) +
            '</div>';
    }

    function renderSongCard(item) {
        const q = item.query || {};
        const versions = item.versions || [];
        // 卡片顶层 status tag（用 orig 的 status，没有就看 versions[0]）
        const statusItem = item.original || versions[0] || null;
        const st = statusTagFor(statusItem);
        let html = '<div class="pl-card" data-search-text="' + esc(_searchableText(item)) +
            '" data-status="' + esc(st.tag) + '">';
        html += '<div class="pl-card-head">';
        html += '<label class="pl-card-check"><input type="checkbox" class="pl-card-checkbox" />' +
            '<span class="pl-card-checkmark"></span></label>';
        html += '<span class="pl-song">' + esc(q.song_name || '(未知歌名)') + '</span>';
        if (q.performer) html += '<span class="pl-performer">- ' + esc(q.performer) + '</span>';
        if (q.lyricist) html += '<span class="pl-performer">· 词 ' + esc(q.lyricist) + '</span>';
        if (q.composer) html += '<span class="pl-performer">· 曲 ' + esc(q.composer) + '</span>';
        html += '<span class="pl-status-tag pl-status-' + st.cls + '" title="' + esc(st.tip) + '">' + esc(st.tag) + '</span>';
        html += '<button type="button" class="pl-song-del" title="删除整首《' + esc(q.song_name || '') + '》（从歌单移除，可从删除黑名单恢复）">删除整首</button>';
        const totalVersions = (item.original ? 1 : 0) + versions.length;
        html += '<span class="pl-versions">' +
            '翻唱 × ' + versions.length +
            ' <span class="pl-total">共 ' + totalVersions + ' 个版本</span></span>';
        html += '</div>';

        // 默认只展示「原版」数据；翻唱/其它版本折叠，点击「查看版本」再展开
        if (item.original) {
            html += renderVersionRow(item.original, true);
        } else if (versions.length) {
            html += '<div class="pl-no-result">未找到该歌曲原版，但搜到其它 ' + versions.length + ' 个版本，点下方按钮查看</div>';
        } else {
            html += '<div class="pl-no-result">未搜到该歌曲（可能歌名/平台未收录，或更换 Cookie 后点「重新查询」）</div>';
        }

        if (versions.length) {
            html += '<button type="button" class="pl-expand-btn" aria-expanded="false">' +
                '<span class="pl-expand-label">查看 ' + versions.length + ' 个翻唱 / 版本</span>' +
                '<svg class="pl-expand-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
                '</button>';
            html += '<div class="pl-versions-collapsed" hidden>';
            for (const v of versions) html += renderVersionRow(v, false, item.original);
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    // ── 渐进式渲染：每拿到一首结果立刻追加 ──
    function _searchableText(item) {
        const q = item.query || {};
        const fields = [
            q.song_name, q.performer, q.lyricist, q.composer,
            (item.original && item.original.song_name) || '',
            (item.original && item.original.performer) || '',
        ];
        return fields.filter(Boolean).join('  ');
    }

    // ── 顶部过滤栏：实时按"歌名/歌手/词/曲"过滤卡片 ──
    function applyFilter() {
        if (!plFilterInput || !plCards) return;
        const kw = (plFilterInput.value || '').trim().toLowerCase();
        const cards = plCards.querySelectorAll('.pl-card');
        let shown = 0;
        for (const card of cards) {
            const text = (card.dataset.searchText || '').toLowerCase();
            const visible = !kw || text.includes(kw);
            if (visible) shown++;
            card.classList.toggle('hidden-by-filter', !visible);
        }
        if (plFilterCount) {
            plFilterCount.textContent = kw ? `显示 ${shown} / ${cards.length}` : '';
        }
        if (plFilterClear) {
            plFilterClear.classList.toggle('visible', !!kw);
        }
    }
    if (plFilterInput) {
        plFilterInput.addEventListener('input', applyFilter);
        plFilterInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                plFilterInput.value = '';
                applyFilter();
                plFilterInput.blur();
            }
        });
    }
    if (plFilterClear) {
        plFilterClear.addEventListener('click', function () {
            if (!plFilterInput) return;
            plFilterInput.value = '';
            applyFilter();
            plFilterInput.focus();
        });
    }
    function _syncFilterRowVisibility() {
        if (!plFilterRow) return;
        const n = plCards ? plCards.children.length : 0;
        const show = n > 0;
        plFilterRow.hidden = !show;
        if (plBatchRow) plBatchRow.hidden = !show;
        if (plPinRow) plPinRow.hidden = !show;
        if (show) applyFilter();
    }

    function appendCard(item) {
        // 维护 lastPlaylistResults：让结果按后端推送顺序累积（不再二次排序）
        lastPlaylistResults.push(item);
        if (plEmpty.style.display !== 'none') plEmpty.style.display = 'none';
        plResultSection.hidden = false;
        plResultCount.textContent = lastPlaylistResults.length;
        // 把 HTML 拼到末尾（不进 innerHTML=join 全量重绘，避免抖动）
        const tmp = document.createElement('div');
        tmp.innerHTML = renderSongCard(item);
        const card = tmp.firstElementChild;
        if (card) {
            card.__item = item;
            // 把每个版本块对应的数据对象挂到 DOM，点击时直接拿来发给后端（避免 JS 重复算钥匙）
            const origBlock = card.querySelector('.pl-version.pl-ver--orig');
            if (origBlock) origBlock.__entry = item.original;
            const coverBlocks = card.querySelectorAll('.pl-version.pl-ver--cover, .pl-version.pl-ver--other');
            (item.versions || []).forEach((v, i) => { if (coverBlocks[i]) coverBlocks[i].__entry = v; });
            // 标注固定状态（页面加载时已拉取 pin 清单）
            if (origBlock) _applyPinnedToBlock(origBlock);
            coverBlocks.forEach(b => _applyPinnedToBlock(b));
            plCards.appendChild(card);
        }
        _syncFilterRowVisibility();
    }
    function clearCards() {
        lastPlaylistResults = [];
        plCards.innerHTML = '';
        plResultCount.textContent = '0';
        plEmpty.style.display = '';
        if (plFilterInput) plFilterInput.value = '';
        _syncFilterRowVisibility();
    }

    // ── 展开/收起 翻唱版本 + 平台卡按钮（事件委托，兼容 SSE 渐进追加的卡片）──
    if (plCards) {
        plCards.addEventListener('click', async function (e) {
            // 1) 展开翻唱
            const expandBtn = e.target.closest('.pl-expand-btn');
            if (expandBtn) {
                const card = expandBtn.closest('.pl-card');
                const panel = card && card.querySelector('.pl-versions-collapsed');
                if (!panel) return;
                const expanded = expandBtn.getAttribute('aria-expanded') === 'true';
                if (expanded) {
                    panel.hidden = true;
                    expandBtn.setAttribute('aria-expanded', 'false');
                    const n = panel.children.length;
                    expandBtn.querySelector('.pl-expand-label').textContent = '查看 ' + n + ' 个翻唱 / 版本';
                } else {
                    panel.hidden = false;
                    expandBtn.setAttribute('aria-expanded', 'true');
                    expandBtn.querySelector('.pl-expand-label').textContent = '收起翻唱 / 版本';
                }
                return;
            }
            // 2) 复制链接
            const copyBtn = e.target.closest('.pl-copy');
            if (copyBtn) {
                const link = copyBtn.getAttribute('data-link') || '';
                if (!link) return;
                try {
                    await navigator.clipboard.writeText(link);
                    flashButton(copyBtn, '已复制');
                } catch (err) {
                    // 回退：选中文本
                    const ta = document.createElement('textarea');
                    ta.value = link;
                    document.body.appendChild(ta); ta.select();
                    try { document.execCommand('copy'); flashButton(copyBtn, '已复制'); }
                    catch (_) { flashButton(copyBtn, '失败'); }
                    document.body.removeChild(ta);
                }
                return;
            }
            // 3) 标为正版 / 盗版（覆盖到全局 song_marks）
            const markBtn = e.target.closest('.pl-mark-pos, .pl-mark-pir');
            if (markBtn) {
                const card = markBtn.closest('.pl-card');
                const platBox = markBtn.closest('.pl-plat');
                if (!card || !platBox) return;
                const platformCode = platBox.getAttribute('data-platform') || markBtn.getAttribute('data-platform') || '';
                const platformName = markBtn.getAttribute('data-platform-name') || platformCode;
                const isPos = markBtn.classList.contains('pl-mark-pos');
                const markType = (isPos ? '正版' : '盗版') + '@' + platformName;
                const item = findItemByCard(card);
                if (!item) { showToast('找不到该歌曲数据', 'err'); return; }
                // 乐观更新：立刻变色，不等后端（后端已本地优先，毫秒级落盘）
                platBox.classList.add(isPos ? 'is-marked-pos' : 'is-marked-pir');
                platBox.classList.remove(isPos ? 'is-marked-pir' : 'is-marked-pos');
                flashButton(markBtn, '✓ ' + markType);
                // 后台推送（仅失败时回滚）
                fetch('/api/marks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        song_name: (item.query && item.query.song_name) || '',
                        performer: (item.query && item.query.performer) || '',
                        album: (item.original && item.original.album) || '',
                        mark_type: markType,
                        note: '在歌单页标记于 ' + new Date().toLocaleString('zh-CN'),
                    })
                }).then(r => r.json()).then(j => {
                    if (!j.ok) {
                        platBox.classList.remove('is-marked-pos', 'is-marked-pir');
                        flashButton(markBtn, '失败');
                        showToast('标记保存失败', 'err');
                    }
                }).catch(() => {
                    platBox.classList.remove('is-marked-pos', 'is-marked-pir');
                    flashButton(markBtn, '失败');
                    showToast('标记保存失败', 'err');
                });
                return;
            }
            // 4) 固定 / 取消固定 版本（📌）
            const pinBtn = e.target.closest('.pl-ver-pin');
            if (pinBtn) {
                const block = pinBtn.closest('.pl-version');
                const entry = block && block.__entry;
                if (!entry) { showToast('找不到该版本数据', 'err'); return; }
                const willPin = !pinBtn.classList.contains('is-pinned');
                // 乐观更新
                pinBtn.classList.toggle('is-pinned', willPin);
                block.classList.toggle('is-pinned', willPin);
                pinBtn.textContent = willPin ? '📌 已固定' : '📌 固定';
                const url = '/api/playlist/' + (willPin ? 'pin' : 'unpin');
                fetch(url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entry: entry })
                }).then(r => r.json()).then(j => {
                    if (!j.ok && !j.already) throw new Error(j.error || '失败');
                    loadPins();
                }).catch(err => {
                    // 回滚
                    pinBtn.classList.toggle('is-pinned', !willPin);
                    block.classList.toggle('is-pinned', !willPin);
                    pinBtn.textContent = (!willPin) ? '📌 已固定' : '📌 固定';
                    showToast('固定操作失败：' + err.message, 'err');
                });
                return;
            }
            // 5) 删除单个版本（✕）
            const delBtn = e.target.closest('.pl-ver-del');
            if (delBtn) {
                const block = delBtn.closest('.pl-version');
                const entry = block && block.__entry;
                if (!entry) { showToast('找不到该版本数据', 'err'); return; }
                if (!confirm('删除这个版本？（已加入删除黑名单，重载/重搜都不会再出现；如需恢复可在删除黑名单里移除）')) return;
                fetch('/api/playlist/version/delete', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entry: entry })
                }).then(r => r.json()).then(j => {
                    if (j.ok) { block.remove(); showToast('已删除该版本', ''); }
                    else showToast('删除失败：' + (j.error || ''), 'err');
                }).catch(err => showToast('删除失败：' + err.message, 'err'));
                return;
            }
            // 6) 删除整首歌
            const songDelBtn = e.target.closest('.pl-song-del');
            if (songDelBtn) {
                const card = songDelBtn.closest('.pl-card');
                const item = card && card.__item;
                if (!item) { showToast('找不到该歌曲数据', 'err'); return; }
                const q = item.query || {};
                if (!confirm('删除整首《' + (q.song_name || '') + '》？（从本机歌单移除；如需恢复可在删除黑名单里移除）')) return;
                fetch('/api/playlist/song/delete', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ song_name: q.song_name || '', performer: q.performer || '' })
                }).then(r => r.json()).then(j => {
                    if (j.ok) { card.remove(); showToast('已删除该歌曲', ''); }
                    else showToast('删除失败：' + (j.error || ''), 'err');
                }).catch(err => showToast('删除失败：' + err.message, 'err'));
                return;
            }
            // 7) 重抓单条平台数据（qq / kuwo）：补抓词曲作者/详情
            const refetchBtn = e.target.closest('.pl-refetch');
            if (refetchBtn) {
                const platBox = refetchBtn.closest('.pl-plat');
                const block = platBox && platBox.closest('.pl-version');
                const entry = block && block.__entry;
                if (!platBox || !entry) { showToast('找不到该平台数据', 'err'); return; }
                const code = platBox.getAttribute('data-platform') || '';
                const row = entry.platform_data && entry.platform_data[code];
                if (!row) { showToast('该平台无数据可重抓', 'err'); return; }
                refetchBtn.disabled = true;
                refetchBtn.textContent = '重抓中…';
                fetch('/api/refetch', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform_code: code, row: row })
                }).then(r => r.json()).then(j => {
                    if (!j.row) throw new Error(j.error || '重抓失败');
                    // 写回数据模型并就地重绘这张平台卡
                    entry.platform_data[code] = j.row;
                    const meta = (PLATFORMS.find(x => x.code === code)) || { code: code, name: code, color: '#888' };
                    const q = entry.query || { lyricist: entry.lyricist_query || '', composer: entry.composer_query || '' };
                    const tmp = document.createElement('div');
                    tmp.innerHTML = renderPlat({ code: code, name: meta.name, color: meta.color, data: j.row }, q);
                    const newBox = tmp.firstElementChild;
                    if (newBox && platBox.parentNode) {
                        // 保留手动标记高亮（正版/盗版），避免重抓后丢失
                        if (platBox.classList.contains('is-marked-pos')) newBox.classList.add('is-marked-pos');
                        if (platBox.classList.contains('is-marked-pir')) newBox.classList.add('is-marked-pir');
                        platBox.replaceWith(newBox);
                    }
                    showToast('已重抓 ' + meta.name + ' 数据', '');
                }).catch(err => {
                    flashButton(refetchBtn, '失败');
                    showToast('重抓失败：' + err.message, 'err');
                });
                return;
            }
        });
    }

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

    // ── v4.7 批量删除（可恢复）：勾选版本行前面的 ☐ 即加入批量，点底部按钮一次性踢掉 ──
    const _selectedVersions = new Map();  // key -> {entry, song_name, performer, label, block}

    function _updateBatchBar() {
        if (!plBatchBar) return;
        const n = _selectedVersions.size;
        plBatchCount.textContent = '已选 ' + n + ' 个版本';
        plBatchBar.hidden = n === 0;
    }
    function _toggleVersionSelected(block, checked) {
        if (!block) return;
        const entry = block.__entry;
        if (!entry) return;
        // 算稳定 key（必须和后端 _version_key 一致；后端会兜底算，但前端先算减少错误）
        const key = _clientVersionKey(entry);
        if (checked) {
            block.classList.add('pl-version--selected');
            _selectedVersions.set(key, {
                key, entry,
                song_name: entry.song_name || '',
                performer: entry.performer || '',
                label: entry.label || (entry.is_cover ? '翻唱' : '版本'),
                block,
            });
        } else {
            block.classList.remove('pl-version--selected');
            _selectedVersions.delete(key);
        }
        _updateBatchBar();
    }
    function _clientVersionKey(entry) {
        // 镜像后端 _version_key：优先 platform_data[*]._xxx 都有的 ID，都没再用 歌名|歌手|别称
        const pd = (entry && entry.platform_data) || {};
        const ID_FIELDS = {
            qq: ['_songid', '_songmid'], kugou: ['_hash', '_mixsongid'],
            netease: ['_song_id'], kuwo: ['_songid', '_songmid'],
            qishui: ['_song_id', '_hash'],
        };
        for (const code of ['qq', 'kugou', 'netease', 'kuwo', 'qishui']) {
            const p = pd[code] || {};
            for (const fld of (ID_FIELDS[code] || [])) {
                if (p[fld]) return code + ':' + p[fld];
            }
        }
        const name = (entry && entry.song_name || '').trim();
        const perf = (entry && entry.performer || '').trim();
        const alt = (entry && entry.alt_name || '').trim();
        return 'name:' + name + '|' + perf + '|' + alt;
    }

    // 监听 plCards 里所有 checkbox 变化（事件冒泡，省得逐个绑）
    if (plCards) {
        plCards.addEventListener('change', function (e) {
            const cb = e.target.closest('.pl-ver-checkbox');
            if (!cb) return;
            const block = cb.closest('.pl-version');
            _toggleVersionSelected(block, cb.checked);
        });
    }
    if (plBatchClearBtn) {
        plBatchClearBtn.addEventListener('click', function () {
            for (const { block } of _selectedVersions.values()) {
                if (!block) continue;
                const cb = block.querySelector('.pl-ver-checkbox');
                if (cb) cb.checked = false;
                block.classList.remove('pl-version--selected');
            }
            _selectedVersions.clear();
            _updateBatchBar();
        });
    }
    if (plBatchSelectAllBtn) {
        plBatchSelectAllBtn.addEventListener('click', function () {
            // 只勾选当前可见的（被过滤隐藏的不勾）
            const blocks = plCards.querySelectorAll('.pl-version');
            for (const block of blocks) {
                if (block.classList.contains('hidden-by-filter')) continue;
                const cb = block.querySelector('.pl-ver-checkbox');
                if (cb && !cb.checked) { cb.checked = true; _toggleVersionSelected(block, true); }
            }
        });
    }
    if (plBatchDelete) {
        plBatchDelete.addEventListener('click', async function () {
            if (_selectedVersions.size === 0) return;
            if (!confirm('确认批量删除 ' + _selectedVersions.size + ' 个版本？\n（加入删除黑名单，重载/重搜都不会再出现；可从「🗑 回收站」一键恢复）')) return;
            const items = Array.from(_selectedVersions.values()).map(v => ({
                key: v.key, entry: v.entry, song_name: v.song_name, performer: v.performer, label: v.label,
            }));
            plBatchDelete.disabled = true;
            const oldText = plBatchDelete.textContent;
            plBatchDelete.textContent = '处理中…';
            try {
                const r = await fetch('/api/playlist/version/batch_delete', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: items })
                });
                const j = await r.json();
                if (!j.ok) { showToast('批量删除失败：' + (j.error || ''), 'err'); return; }
                // 从 DOM 移除（一次选完立即消失，视觉清爽）
                for (const v of _selectedVersions.values()) {
                    if (v.block && v.block.parentNode) v.block.remove();
                }
                _selectedVersions.clear();
                _updateBatchBar();
                showToast('已批量删除 ' + (j.inserted || 0) + ' 个版本（可从回收站恢复）', '');
            } catch (err) {
                showToast('批量删除失败：' + err.message, 'err');
            } finally {
                plBatchDelete.disabled = false;
                plBatchDelete.textContent = oldText;
            }
        });
    }
    // 删除单个版本时也要把它从批量集合里清掉（避免幽灵 key 残留）
    if (plCards) {
        plCards.addEventListener('click', function (e) {
            const delBtn = e.target.closest('.pl-ver-del');
            if (!delBtn) return;
            const block = delBtn.closest('.pl-version');
            if (block && block.__entry) {
                const k = _clientVersionKey(block.__entry);
                if (_selectedVersions.has(k)) {
                    _selectedVersions.delete(k);
                    setTimeout(_updateBatchBar, 0);
                }
            }
        }, true);  // 用捕获阶段先清掉，避免与原 click handler 互相等待
    }

    // 通过 pl-card 的 data-search-text 反查 lastPlaylistResults 里的 item
    function findItemByCard(card) {
        const key = card.getAttribute('data-search-text') || '';
        for (const it of (lastPlaylistResults || [])) {
            if (_searchableText(it) === key) return it;
        }
        return null;
    }

    function showToast(msg, type) {
        // 极简 toast：直接 alert 替代，避免再加 toast 组件
        if (type === 'err') console.error('[MusicFinder]', msg);
        try { window.alert(msg); } catch (_) {}
    }

    // ── 批量操作 ──
    // 勾选状态变化 → 更新「已选标为正版/盗版」按钮的禁用态
    if (plCards) {
        plCards.addEventListener('change', function (e) {
            if (e.target && e.target.classList && e.target.classList.contains('pl-card-checkbox')) {
                _refreshBatchButtons();
            }
        });
    }
    function _refreshBatchButtons() {
        if (!plBatchMarkPos || !plBatchMarkPir) return;
        const checked = plCards.querySelectorAll('.pl-card-checkbox:checked').length;
        plBatchMarkPos.disabled = checked === 0;
        plBatchMarkPir.disabled = checked === 0;
        plBatchMarkPos.textContent = '已选标为正版' + (checked ? '（' + checked + '）' : '');
        plBatchMarkPir.textContent = '已选标为盗版' + (checked ? '（' + checked + '）' : '');
    }
    if (plBatchSelectAll) {
        plBatchSelectAll.addEventListener('click', function () {
            // 全选当前过滤下可见的卡片
            plCards.querySelectorAll('.pl-card').forEach(card => {
                if (card.style.display !== 'none' && !card.classList.contains('hidden-by-filter')) {
                    const cb = card.querySelector('.pl-card-checkbox');
                    if (cb) cb.checked = true;
                }
            });
            _refreshBatchButtons();
        });
    }
    if (plBatchUnselect) {
        plBatchUnselect.addEventListener('click', function () {
            plCards.querySelectorAll('.pl-card-checkbox:checked').forEach(cb => { cb.checked = false; });
            _refreshBatchButtons();
        });
    }
    // 「已选标为正版/盗版」 = 取每张勾选卡片的首个有数据平台打标
    function _firstPlatCode(item) {
        const pd = (item && item.original && item.original.platform_data) || (item && item.versions && item.versions[0] && item.versions[0].platform_data) || {};
        for (const c of ['qq', 'kugou', 'kuwo', 'netease', 'qishui']) {
            if (pd[c] && pd[c].song_name) return c;
        }
        return 'qq'; // 兜底
    }
    function _platName(code) {
        const map = { qq: 'QQ音乐', kugou: '酷狗', kuwo: '酷我', netease: '网易云', qishui: '汽水' };
        return map[code] || code;
    }
    async function _batchMark(markTypeLabel) {
        const checked = Array.from(plCards.querySelectorAll('.pl-card-checkbox:checked'));
        if (!checked.length) return;
        const items = checked.map(cb => findItemByCard(cb.closest('.pl-card'))).filter(Boolean);
        if (!items.length) { showToast('找不到这些歌曲的数据', 'err'); return; }
        if (!confirm('将给 ' + items.length + ' 首歌打「' + markTypeLabel + '」标记（写入全局 marks，可同步到云端），确定？')) return;
        let ok = 0, fail = 0;
        for (const it of items) {
            const code = _firstPlatCode(it);
            const mt = markTypeLabel + '@' + _platName(code);
            try {
                const r = await fetch('/api/marks', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        song_name: (it.query && it.query.song_name) || '',
                        performer: (it.query && it.query.performer) || '',
                        album: (it.original && it.original.album) || '',
                        mark_type: mt,
                        note: '在歌单页批量标记于 ' + new Date().toLocaleString('zh-CN'),
                    })
                });
                const j = await r.json();
                if (j.ok) ok++; else fail++;
            } catch (_) { fail++; }
        }
        showToast('完成：' + ok + ' 成功，' + fail + ' 失败', fail ? 'err' : '');
    }
    if (plBatchMarkPos) plBatchMarkPos.addEventListener('click', () => _batchMark('正版'));
    if (plBatchMarkPir) plBatchMarkPir.addEventListener('click', () => _batchMark('盗版'));
    // 按状态批量
    document.querySelectorAll('[data-status-filter]').forEach(btn => {
        btn.addEventListener('click', function () {
            const statusFilter = btn.getAttribute('data-status-filter');
            const matched = Array.from(plCards.querySelectorAll('.pl-card')).filter(card => {
                return card.getAttribute('data-status') === statusFilter
                    && card.style.display !== 'none'
                    && !card.classList.contains('hidden-by-filter');
            });
            if (!matched.length) { showToast('当前没有「' + statusFilter + '」的歌曲', 'err'); return; }
            matched.forEach(card => { const cb = card.querySelector('.pl-card-checkbox'); if (cb) cb.checked = true; });
            _refreshBatchButtons();
        });
    });

    function setProgress(done, total, label) {
        const pct = total > 0 ? Math.min(100, Math.round(done * 100 / total)) : 0;
        plProgressFill.style.width = pct + '%';
        plProgressText.textContent = (label || '已搜 ') + done + ' / ' + total + ' (' + pct + '%)';
    }

    // ── SSE 流式读取 ──
    async function consumeSse(resp, onEvent) {
        if (!resp.body || !resp.body.getReader) {
            // 老浏览器兜底：一次性读 text 后解析
            const text = await resp.text();
            const chunks = text.split(/\n\n+/);
            for (const c of chunks) {
                const dataLines = c.split(/\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
                if (!dataLines.length) continue;
                try { onEvent(JSON.parse(dataLines.join('\n'))); } catch (_) {}
            }
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
                const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
                const lines = block.split('\n').filter(l => l.startsWith('data:'));
                if (!lines.length) continue;
                const data = lines.map(l => l.slice(5).trim()).join('\n');
                try { onEvent(JSON.parse(data)); } catch (e) { console.warn('SSE parse error', e, data); }
            }
        }
    }

    // ── 导入并流式查询 ──
    async function importAndSearch() {
        const songs = parseSongs(plSongInput.value);
        if (!songs.length) { alert('请至少输入一首歌（含歌名）'); return; }
        streaming = true;
        plImportBtn.disabled = true;
        plProgressWrap.hidden = false;
        plResultSection.hidden = true;
        clearCards();
        setProgress(0, songs.length, '准备中…');
        try {
            const resp = await fetch('/api/playlist/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ songs: songs, concurrency: 6 }),
            });
            if (!resp.ok) {
                const e = await resp.json().catch(() => ({}));
                throw new Error(e.error || ('请求失败 ' + resp.status));
            }
            await consumeSse(resp, ev => {
                if (ev.event === 'start') {
                    setProgress(0, ev.total, '搜索中…');
                } else if (ev.event === 'result') {
                    appendCard(ev.item);
                    setProgress(ev.done, ev.total, '已搜 ');
                } else if (ev.event === 'done') {
                    setProgress(ev.total, ev.total, '完成');
                    if (ev.searched_at) plSearchedAt.textContent = '查询于 ' + ev.searched_at;
                }
            });
        } catch (e) {
            plProgressText.textContent = '出错：' + e.message;
            alert('查询失败：' + e.message);
        } finally {
            streaming = false;
            plImportBtn.disabled = false;
            plResearchBtn.style.display = '';
            plClearBtn.style.display = '';
            setTimeout(() => { plProgressWrap.hidden = true; }, 1200);
        }
    }
    if (plImportBtn) plImportBtn.addEventListener('click', importAndSearch);

    // ── 重新查询（SSE 流式）──
    if (plResearchBtn) {
        plResearchBtn.addEventListener('click', async function () {
            plResearchBtn.disabled = true;
            plProgressWrap.hidden = false;
            plResultSection.hidden = true;
            clearCards();
            setProgress(0, 0, '正在加载本机歌单…');
            try {
                const resp = await fetch('/api/playlist/research', { method: 'POST' });
                if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || '失败'); }
                await consumeSse(resp, ev => {
                    if (ev.event === 'start') {
                        setProgress(0, ev.total, '重新搜索中…');
                    } else if (ev.event === 'result') {
                        appendCard(ev.item);
                        setProgress(ev.done, ev.total, '已搜 ');
                    } else if (ev.event === 'done') {
                        setProgress(ev.total, ev.total, '完成');
                        if (ev.searched_at) plSearchedAt.textContent = '查询于 ' + ev.searched_at;
                    }
                });
            } catch (e) {
                plProgressText.textContent = '出错：' + e.message;
                alert('重新查询失败：' + e.message);
            } finally {
                plResearchBtn.disabled = false;
                setTimeout(() => { plProgressWrap.hidden = true; }, 1200);
            }
        });
    }

    // ── 清除本机歌单 ──
    if (plClearBtn) {
        plClearBtn.addEventListener('click', async function () {
            if (!confirm('清除本机歌单与缓存结果？（不影响云端标记）')) return;
            await fetch('/api/playlist/clear', { method: 'POST' });
            plSongInput.value = '';
            updatePlCount();
            plResultSection.hidden = true;
            plResearchBtn.style.display = 'none';
            plClearBtn.style.display = 'none';
        });
    }

    // ── 导出 CSV ──
    if (plDownloadBtn) {
        plDownloadBtn.addEventListener('click', function () {
            if (!lastPlaylistResults || !lastPlaylistResults.length) return;
            const header = ['查询歌名', '查询表演者', '查询词', '查询曲', '版本', '原版',
                '实际歌名', '实际表演者', '命中词', '命中曲', '平台', '收藏', '在听', '评论',
                '发行公司', '状态', '链接'];
            const rows = [header];
            for (const item of lastPlaylistResults) {
                const all = [];
                if (item.original) all.push(item.original);
                (item.versions || []).forEach(v => all.push(v));
                for (const e of all) {
                    for (const p of PLATFORMS) {
                        const d = (e.platform_data || {})[p.code] || {};
                        rows.push([
                            item.query.song_name || '', item.query.performer || '',
                            item.query.lyricist || '', item.query.composer || '',
                            e.version_tag || '', e.is_original ? '原版' : '翻唱/版本',
                            d.song_name || '', d.performer || '',
                            e.lyricist_values || '', e.composer_values || '',
                            p.name,
                            d.collection_count != null ? d.collection_count : '',
                            d.listening_count != null ? d.listening_count : '',
                            d.comment_count != null ? d.comment_count : '',
                            d.record_label || '', d.availability || '', d.link || ''
                        ]);
                    }
                }
            }
            const csv = '﻿' + rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = '我的歌单数据.csv';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
        });
    }

    // ── 加载本机歌单与缓存结果（tab 点击时调用）──
    async function loadPlaylistPage() {
        try {
            await loadPins();
            const d = await fetch('/api/playlist').then(r => r.json());
            if (d.playlist && d.playlist.length) {
                plSongInput.value = d.playlist.map(s => {
                    const parts = [s.song_name, s.performer || '', s.lyricist || '', s.composer || ''];
                    while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
                    return parts.join(',');
                }).join('\n');
                updatePlCount();
                plResearchBtn.style.display = '';
                plClearBtn.style.display = '';
            }
            if (d.has_results && d.results) {
                clearCards();
                for (const it of d.results) appendCard(it);
                if (d.searched_at) plSearchedAt.textContent = '查询于 ' + d.searched_at;
            } else {
                plResultSection.hidden = true;
            }
            updateRecycleBadge(d.deleted_count || 0);
        } catch (e) {
            console.error('加载歌单失败', e);
        }
    }

    // 【2026-08-11 删除 autoLand】用户要求默认打开「音乐搜索」，不再自动跳歌单。

    window.loadPlaylistPage = loadPlaylistPage;
})();

