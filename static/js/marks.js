// ═══════════════════════════════════════════════════════════════
//  标记歌曲页：完整「标签管理」后台
//    - 双视线（我本账号 / 云端全网），云端下越权自动拒
//    - 按主标签筛选（多选 chip）
//    - 多选 + 批量改/加/清空/删除
//    - 点标签列直接改（<select>）
//    - 标签汇总卡片（按类计 N + 样本 3 首）
// ═══════════════════════════════════════════════════════════════
(function () {
    'use strict';

    // 8 类规范主标签（在弹窗可选）
    const STANDARD_LABELS = [
        '已确认', '正版确认', '已标记', '疑似盗版',
        '待核实', '我的精选', '已排除', '已打盗版',
    ];
    // 预留位置：未标记 + 未知规范值（仅汇总用，不在弹窗）

    // DOM 引用
    const marksBody = document.getElementById('marksBody');
    const marksEmpty = document.getElementById('marksEmpty');
    const marksCount = document.getElementById('marksCount');
    const marksHead = document.getElementById('marksTableHead');
    const marksSubtitle = document.getElementById('marksSubtitle');
    const scopeMine = document.getElementById('marksScopeMine');
    const scopeAll = document.getElementById('marksScopeAll');
    const marksStatus = document.getElementById('marksStatus');
    const marksFilterBar = document.getElementById('marksFilterBar');
    const marksFilterChips = document.getElementById('marksFilterChips');
    const marksClearFilter = document.getElementById('marksClearFilter');
    const marksBatchBar = document.getElementById('marksBatchBar');
    const marksSelectAll = document.getElementById('marksSelectAll');
    const marksBatchCount = document.getElementById('marksBatchCount');
    const marksBatchEditBtn = document.getElementById('marksBatchEditBtn');
    const marksBatchAppendBtn = document.getElementById('marksBatchAppendBtn');
    const marksBatchClearBtn = document.getElementById('marksBatchClearBtn');
    const marksBatchDelBtn = document.getElementById('marksBatchDelBtn');
    const marksBatchCancelBtn = document.getElementById('marksBatchCancelBtn');
    const marksSummaryBtn = document.getElementById('marksSummaryBtn');
    const marksSummary = document.getElementById('marksSummary');
    const marksSummaryClose = document.getElementById('marksSummaryClose');
    const marksSummaryGrid = document.getElementById('marksSummaryGrid');
    const marksSummaryMeta = document.getElementById('marksSummaryMeta');

    // 状态
    let currentScope = 'shared';   // v4.25.7 默认共享视图（全员可读其他账号的标记）
    let meCache = null;
    let meCanManage = false;        // 是否拥有 manage_marks（可改/删他人标）
    let allRows = [];          // 当前 scope 下的全部行 [{_owner, _key, song_name, ...}]
    let filteredRows = [];     // 过滤后用于渲染
    let statsCache = null;     // 标签分布统计缓存 {by_label:{...}, total, ...}
    let activeFilters = new Set(['__all__']);  // 当前激活的筛选（默认全部）

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function setStatus(text, kind) {
        if (!marksStatus) return;
        marksStatus.textContent = text || '';
        marksStatus.dataset.kind = kind || '';
    }

    function markClass(label) {
        // 复用 app.js 的色彩规则（无 app.js 时用 def）
        if (typeof window.markClass === 'function') return window.markClass(label);
        const m = {
            '已确认': 'ok', '正版确认': 'ok', '已打盗版': 'ok',
            '待核实': 'warn', '未打盗版': 'warn',
            '疑似盗版': 'warn-strong', '已排除': 'excl',
            '我的精选': 'fav', '已标记': 'def', '已打盗版@平台': 'ok',
        };
        return m[label] || 'def';
    }

    function setHeadForScope(scope) {
        if (!marksHead) return;
        const isShared = (scope === 'all' || scope === 'shared');
        if (isShared) {
            marksHead.innerHTML =
                '<tr>' +
                '<th class="col-check"><input type="checkbox" id="marksHeadCheck" title="全选可见行"></th>' +
                '<th>歌曲名</th><th>歌手</th><th>专辑</th>' +
                '<th>标记类型</th><th>附加标签</th><th>备注</th><th>更新时间</th>' +
                '<th>👤 操作人</th><th>操作</th>' +
                '</tr>';
            if (marksSubtitle) {
                marksSubtitle.textContent = '🌐 共享：所有账号的标记（默认全员可见；被授权「管理他人标记」的账号可改/删别人的标）';
            }
        } else {
            marksHead.innerHTML =
                '<tr>' +
                '<th class="col-check"><input type="checkbox" id="marksHeadCheck" title="全选可见行"></th>' +
                '<th>歌曲名</th><th>歌手</th><th>专辑</th>' +
                '<th>标记类型</th><th>附加标签</th><th>备注</th><th>更新时间</th>' +
                '<th>操作</th>' +
                '</tr>';
            if (marksSubtitle) {
                marksSubtitle.textContent = '汇总你在各平台手动标记过的歌曲（标记已通过云端全网同步）';
            }
        }
        // 重新绑定全选 checkbox
        const hcb = document.getElementById('marksHeadCheck');
        if (hcb) hcb.addEventListener('change', e => onHeadSelectChange(e.target.checked));
    }

    function setScope(scope) {
        if (scope !== 'mine' && scope !== 'shared' && scope !== 'all') scope = 'shared';
        if (scope === 'all') scope = 'shared';  // 向后兼容：原 admin 全网视图 → 共享视图（全员可读）
        currentScope = scope;
        if (scopeMine) scopeMine.classList.toggle('active', scope === 'mine');
        if (scopeAll) scopeAll.classList.toggle('active', scope === 'shared');
        setHeadForScope(scope);
        // 切视线时清掉旧的选中 + 筛选，避免越权
        activeFilters = new Set(['__all__']);
        clearSelected();
        loadMarksPage();
    }

    async function fetchMe() {
        if (meCache) return meCache;
        try {
            const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
            meCache = await r.json();
        } catch (e) {
            meCache = { logged_in: false, is_admin: false, username: null };
        }
        return meCache;
    }

    async function loadMarksPage() {
        setStatus('加载中…', 'loading');
        const me = await fetchMe();
        const meName = me.username || '';
        const isAdmin = !!me.is_admin;
        meCanManage = !!me.manage_marks;
        try {
            const [marksResp, statsResp] = await Promise.all([
                fetch('/api/marks?scope=' + currentScope, { credentials: 'same-origin' }),
                fetch('/api/marks/stats?scope=' + currentScope, { credentials: 'same-origin' }),
            ]);
            if (!marksResp.ok) {
                throw new Error('HTTP ' + marksResp.status);
            }
            const data = await marksResp.json();
            statsCache = statsResp.ok ? await statsResp.json() : { by_label: {}, total: 0 };
            normalizeRows(data, meName);
            renderFilterChips();
            applyFilter();
            setStatus('', '');
        } catch (e) {
            console.error('加载标记失败', e);
            allRows = [];
            applyFilter();
            setStatus('加载失败，请点「刷新」重试', 'error');
        }
    }

    function normalizeRows(data, meName) {
        const isAll = data && (data.scope === 'all' || data.scope === 'shared');
        const raw = data.marks || {};
        if (isAll) {
            allRows = (Array.isArray(raw) ? raw : []).map(it => ({
                _owner: it.owner || 'legacy',
                _key: it.key,
                song_name: it.song_name,
                performer: it.performer,
                album: it.album,
                mark_type: it.mark_type || '',
                tags: Array.isArray(it.tags) ? it.tags : [],
                note: it.note || '',
                updated_at: it.updated_at || '',
            }));
        } else {
            allRows = Object.values(raw).map(v => ({
                _owner: meName || '我',
                _key: null,
                song_name: v.song_name,
                performer: v.performer,
                album: v.album,
                mark_type: v.mark_type || '',
                tags: Array.isArray(v.tags) ? v.tags : [],
                note: v.note || '',
                updated_at: v.updated_at || '',
            }));
        }
    }

    // 渲染筛选 chips（按出现频次倒序，未出现的也展示 0）
    function renderFilterChips() {
        if (!marksFilterChips) return;
        const byLabel = (statsCache && statsCache.by_label) || {};
        const labels = Object.keys(byLabel).sort((a, b) => (byLabel[b] || 0) - (byLabel[a] || 0));
        // "全部" / "未标记" / "含附加标签" 固定前置
        const allChip = marksFilterBar.querySelector('[data-filter="__all__"] .chip-count');
        if (allChip) allChip.textContent = String(statsCache ? statsCache.total || 0 : 0);
        const unmarkedChip = marksFilterBar.querySelector('[data-filter="__unmarked__"] .chip-count');
        if (unmarkedChip) unmarkedChip.textContent = String(byLabel['未标记'] || 0);

        // 8 类规范 chip
        const customLabels = labels.filter(l => !['未标记'].includes(l));
        marksFilterChips.innerHTML = customLabels.map(l => {
            const cls = markClass(l);
            const active = activeFilters.has(l) ? ' active' : '';
            const isAllActive = activeFilters.has('__all__');
            const dataKey = '__label__' + l;
            return `<button type="button" class="marks-filter-chip mark-${cls}${active}" data-filter="${esc(dataKey)}" title="只看「${esc(l)}」">${esc(l)} <span class="chip-count">${byLabel[l] || 0}</span></button>`;
        }).join('');
        // 重绑点击事件
        marksFilterChips.querySelectorAll('.marks-filter-chip').forEach(chip => {
            chip.addEventListener('click', () => onFilterChipClick(chip));
        });
        marksFilterBar.querySelectorAll('.marks-filter-chip').forEach(chip => {
            chip.addEventListener('click', () => onFilterChipClick(chip));
        });
        syncAllChipState();
    }

    function syncAllChipState() {
        const allChip = marksFilterBar.querySelector('[data-filter="__all__"]');
        if (allChip) allChip.classList.toggle('active', activeFilters.has('__all__'));
    }

    function onFilterChipClick(chip) {
        const f = chip.dataset.filter;
        if (f === '__all__') {
            activeFilters = new Set(['__all__']);
        } else if (activeFilters.has('__all__')) {
            activeFilters = new Set([f]);
        } else if (activeFilters.has(f)) {
            activeFilters.delete(f);
            if (activeFilters.size === 0) activeFilters.add('__all__');
        } else {
            activeFilters.add(f);
        }
        renderFilterChips();
        applyFilter();
    }

    function applyFilter() {
        const isAllOnly = activeFilters.size === 1 && activeFilters.has('__all__');
        if (isAllOnly) {
            filteredRows = allRows.slice();
        } else {
            filteredRows = allRows.filter(r => {
                const mt = r.mark_type || '未标记';
                // __unmarked__ 是特殊 chip
                if (activeFilters.has('__unmarked__') && !r.mark_type) return true;
                const target = activeFilters.has('__unmarked__') ? '__other__' : mt;
                return activeFilters.has(target) || activeFilters.has('__label__' + mt);
            });
        }
        renderRows();
    }

    function renderRows() {
        const meName = meCache ? (meCache.username || '') : '';
        const isAllView = currentScope === 'all' || currentScope === 'shared';
        if (marksCount) marksCount.textContent = `共 ${filteredRows.length} / ${allRows.length} 首`;
        if (!filteredRows.length) {
            marksBody.innerHTML = '';
            if (marksEmpty) {
                marksEmpty.style.display = '';
                marksEmpty.querySelector('p').textContent = allRows.length ? '当前筛选下无结果' : '还没有标记任何歌曲';
            }
            updateBatchBar();
            return;
        }
        if (marksEmpty) marksEmpty.style.display = 'none';
        filteredRows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
        marksBody.innerHTML = filteredRows.map((m, i) => {
            const rowKey = m._key || (m.song_name + '||' + m.performer + '||' + m.album);
            const isMine = !isAllView || (m._owner || '') === meName;
            const canEditThis = isMine || meCanManage;
            const ownerCell = isAllView
                ? '<td><span class="mark-owner-pill">' + esc(m._owner || 'legacy') + '</span></td>'
                : '';
            const actionCell = canEditThis
                ? '<div class="marks-action-row">' +
                  '<button class="mark-del" data-song="' + esc(m.song_name) +
                  '" data-perf="' + esc(m.performer) + '" data-album="' + esc(m.album) +
                  '" data-owner="' + esc(m._owner || '') + '">删除</button>' +
                  '</div>'
                : '<span class="mark-locked" title="只有被授权（管理他人标记）的账号才能修改/删除他人的标记">🔒</span>';
            const cls = markClass(m.mark_type);
            // 标记类型改成可改的下拉（可编辑时显示下拉，否则显示文本）
            const typeCell = canEditThis
                ? renderTypeSelect(m, i)
                : '<span class="mark-type-pill mark-' + cls + '">' + esc(m.mark_type || '未标记') + '</span>';
            // 附加标签 chips
            const tagsCell = m.tags && m.tags.length
                ? '<div class="mark-cell-row">' + m.tags.map(t => {
                    const tc = markClass(t);
                    return '<span class="mark-tag-pill mark-' + tc + '">' + esc(t) + '</span>';
                  }).join('') + '</div>'
                : '<span class="mark-empty-small">—</span>';
            const checkedAttr = selectedKeys.has(rowKey) ? ' checked' : '';
            const checkCell = '<td class="col-check"><input type="checkbox" class="marks-row-check" data-rowkey="' + esc(rowKey) + '"' + checkedAttr + (canEditThis ? '' : ' disabled') + '></td>';
            return '<tr data-rowkey="' + esc(rowKey) + '">' +
                checkCell +
                '<td>' + esc(m.song_name) + '</td>' +
                '<td>' + esc(m.performer) + '</td>' +
                '<td>' + esc(m.album) + '</td>' +
                '<td class="mark-type-cell">' + typeCell + '</td>' +
                '<td class="mark-tags-cell">' + tagsCell + '</td>' +
                '<td class="mark-note">' + esc(m.note || '') + '</td>' +
                '<td class="mark-time">' + esc(m.updated_at || '') + '</td>' +
                ownerCell +
                '<td>' + actionCell + '</td>' +
                '</tr>';
        }).join('');
        // 绑定 row checkbox + type select
        marksBody.querySelectorAll('.marks-row-check').forEach(cb => {
            cb.addEventListener('change', () => onRowCheckChange(cb.dataset.rowkey, cb.checked));
        });
        marksBody.querySelectorAll('.mark-type-select').forEach(sel => {
            sel.addEventListener('change', () => onTypeChange(sel));
        });
        updateBatchBar();
    }

    // 渲染「标记类型」列为下拉（点改就发 PATCH）
    function renderTypeSelect(m, idx) {
        const cls = markClass(m.mark_type);
        const current = m.mark_type || '';
        // options: STANDARD_LABELS + 当前值（如果不是规范的）+ 清空
        const seen = new Set();
        const opts = [];
        // "未标记"/清空选项
        opts.push({ v: '', t: '— 未标记 —' });
        STANDARD_LABELS.forEach(l => {
            if (!seen.has(l)) { opts.push({ v: l, t: l }); seen.add(l); }
        });
        if (current && !seen.has(current)) {
            opts.push({ v: current, t: current });  // 与搜索页 pill 保持一致：原值显示，不附加「（自定义）」
        }
        return '<select class="mark-type-select mark-' + cls + '" data-rowkey="' + esc(m._key || (m.song_name + '||' + m.performer + '||' + m.album)) + '" data-idx="' + idx + '">' +
            opts.map(o => `<option value="${esc(o.v)}"${o.v === current ? ' selected' : ''}>${esc(o.t)}</option>`).join('') +
            '</select>';
    }

    // ═══ 选中状态管理 ═══
    const selectedKeys = new Set();  // 当前选中的 rowKey
    function clearSelected() {
        selectedKeys.clear();
        if (marksSelectAll) marksSelectAll.checked = false;
        updateBatchBar();
    }
    function onRowCheckChange(rowKey, checked) {
        if (checked) selectedKeys.add(rowKey); else selectedKeys.delete(rowKey);
        updateBatchBar();
    }
    function onHeadSelectChange(checked) {
        if (checked) {
            filteredRows.forEach(r => {
                const k = r._key || (r.song_name + '||' + r.performer + '||' + r.album);
                selectedKeys.add(k);
            });
        } else {
            selectedKeys.clear();
        }
        // 同步 row checkbox
        marksBody.querySelectorAll('.marks-row-check').forEach(cb => {
            cb.checked = selectedKeys.has(cb.dataset.rowkey);
        });
        updateBatchBar();
    }
    function updateBatchBar() {
        if (!marksBatchBar) return;
        const n = selectedKeys.size;
        marksBatchBar.style.display = n > 0 ? '' : 'none';
        if (marksBatchCount) marksBatchCount.textContent = '已选 ' + n + ' 条';
        if (marksSelectAll) marksSelectAll.checked = n > 0 && n === filteredRows.length;
    }

    // ═══ 行操作：点改 + 删除 ═══
    async function onTypeChange(sel) {
        const rowKey = sel.dataset.rowkey;
        const row = findRowByKey(rowKey);
        if (!row) return;
        const oldVal = row.mark_type || '';
        const newVal = sel.value || '';
        if (oldVal === newVal) return;
        const meName = meCache ? (meCache.username || '') : '';
        // 乐观更新
        row.mark_type = newVal;
        sel.className = 'mark-type-select mark-' + markClass(newVal);
        setStatus('保存中…', 'loading');
        try {
            const r = await fetch('/api/marks', {
                method: 'PATCH',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    song_name: row.song_name, performer: row.performer, album: row.album,
                    scope: currentScope,
                    owner: (currentScope === 'shared' && row._owner && row._owner !== meName) ? row._owner : undefined,
                    set: { mark_type: newVal, mode: 'replace' },
                }),
            });
            if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                throw new Error(err.error || ('HTTP ' + r.status));
            }
            const data = await r.json();
            row.updated_at = (data.mark && data.mark.updated_at) || row.updated_at;
            setStatus('标签已改为「' + (newVal || '未标记') + '」', 'ok');
            // 重新拉统计（不刷新整张表，避免 checkbox 状态丢失）
            reloadStats();
        } catch (e) {
            row.mark_type = oldVal;
            sel.value = oldVal;
            setStatus('改标签失败：' + (e.message || ''), 'error');
        }
    }

    async function reloadStats() {
        try {
            const r = await fetch('/api/marks/stats?scope=' + currentScope, { credentials: 'same-origin' });
            if (r.ok) {
                statsCache = await r.json();
                renderFilterChips();
            }
        } catch (e) { /* 静默失败 */ }
    }

    function findRowByKey(rowKey) {
        return allRows.find(r => (r._key || (r.song_name + '||' + r.performer + '||' + r.album)) === rowKey);
    }

    // ═══ 批量操作 ═══
    function getSelectedRows() {
        return allRows.filter(r => {
            const k = r._key || (r.song_name + '||' + r.performer + '||' + r.album);
            return selectedKeys.has(k);
        });
    }

    function openBatchEditDialog(mode) {
        // mode: 'replace' / 'append' / 'clear'
        if (selectedKeys.size === 0) return;
        const isAllView = currentScope === 'all' || currentScope === 'shared';
        const meName = meCache ? (meCache.username || '') : '';
        let rows = getSelectedRows();
        // 共享视图下：只有「自己打的标」或「拥有管理他人标记权限」的可改
        const canEdit = (r) => !isAllView || (r._owner || '') === meName || meCanManage;
        rows = rows.filter(canEdit);
        if (rows.length === 0) {
            setStatus('选中的都是别人的标，且你无「管理他人标记」权限', 'warn');
            return;
        }
        const selectedSet = new Set(rows.map(r => r._key || (r.song_name + '||' + r.performer + '||' + r.album)));
        // 弹窗：复用现有的 8 chip + 「未标记」+ 「仅附加标签」
        const html = `
            <div class="marks-batch-dialog">
                <h3>批量「${mode === 'clear' ? '清空' : (mode === 'append' ? '加附加标签' : '改标签')}」共 ${rows.length} 首</h3>
                <p class="muted">${mode === 'clear' ? '把选中行的主标签/附加标签/备注全部清空（保留歌名/歌手/专辑）' : (mode === 'append' ? '附加标签追加；主标签不动。已存在的会跳过' : '把所有选中行的主标签改为同一个值，原值不同也没关系')}</p>
                ${mode !== 'clear' ? `
                <div class="mark-pop-types" id="batchTypeChips">
                    <button type="button" class="mark-type-chip" data-val="">— 未标记 —</button>
                    ${STANDARD_LABELS.map(l => `<button type="button" class="mark-type-chip mark-${markClass(l)}" data-val="${esc(l)}">${esc(l)}</button>`).join('')}
                </div>
                ` : ''}
                <div class="marks-batch-dialog-actions">
                    <button class="search-btn sm ghost" id="batchDialogCancel">取消</button>
                    <button class="search-btn sm primary" id="batchDialogConfirm">确认${mode === 'clear' ? '清空' : (mode === 'append' ? '追加' : '改')}</button>
                </div>
            </div>`;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = html;
        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector('#batchDialogCancel').addEventListener('click', close);
        // 单选 chip
        let chosenValue = '';
        if (mode !== 'clear') {
            overlay.querySelectorAll('#batchTypeChips .mark-type-chip').forEach(c => {
                c.addEventListener('click', () => {
                    overlay.querySelectorAll('#batchTypeChips .mark-type-chip').forEach(x => x.classList.remove('active'));
                    c.classList.add('active');
                    chosenValue = c.dataset.val;
                });
            });
        }
        overlay.querySelector('#batchDialogConfirm').addEventListener('click', async () => {
            if (mode !== 'clear' && chosenValue === '' && !overlay.querySelector('#batchTypeChips .mark-type-chip.active')) {
                // 默认未标
                chosenValue = '';
            }
            close();
            await doBatchUpdate(rows, mode, chosenValue);
            // 同时清掉选中（避免后续批量操作再误操作这些行）
            selectedKeys.clear();
            marksBody.querySelectorAll('.marks-row-check').forEach(cb => cb.checked = false);
            updateBatchBar();
        });
    }

    async function doBatchUpdate(rows, mode, value) {
        const keys = rows.map(r => ({
            song_name: r.song_name, performer: r.performer, album: r.album,
            owner: r._owner || undefined,
        }));
        let set = { mode };
        if (mode === 'replace') set.mark_type = value;
        else if (mode === 'append') set.tags = value ? [value] : [];  // 单值追加，多选用 batchAppendDialog
        // clear 模式三字段都不传，由后端 mode=='clear' 清
        setStatus('批量更新 ' + rows.length + ' 条…', 'loading');
        try {
            const r = await fetch('/api/marks/batch_update', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys, set, scope: currentScope }),
            });
            const data = await r.json();
            if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
            const updated = data.updated || 0;
            const skipped = (data.skipped || []).length;
            const failed = (data.failed || []).length;
            setStatus(`批量完成：已改 ${updated} 条${skipped ? ' / 跳过 ' + skipped : ''}${failed ? ' / 失败 ' + failed : ''}`, failed ? 'warn' : 'ok');
            // 重新拉数据 + 统计
            await loadMarksPage();
        } catch (e) {
            setStatus('批量更新失败：' + (e.message || ''), 'error');
        }
    }

    // ═══ 标签汇总卡片 ═══
    async function toggleSummary() {
        if (marksSummary.style.display === 'none') {
            marksSummary.style.display = '';
            marksSummaryBtn.textContent = '📊 收起汇总';
            renderSummary();
        } else {
            marksSummary.style.display = 'none';
            marksSummaryBtn.textContent = '📊 标签汇总';
        }
    }

    function renderSummary() {
        if (!statsCache) return;
        const byLabel = statsCache.by_label || {};
        const labels = Object.keys(byLabel).sort((a, b) => (byLabel[b] || 0) - (byLabel[a] || 0));
        const total = statsCache.total || 0;
        const songCount = statsCache.unique_songs || 0;
        if (marksSummaryMeta) marksSummaryMeta.textContent = `共 ${songCount} 首标记 / 主标签分布 ${labels.length} 类`;
        marksSummaryGrid.innerHTML = labels.map(l => {
            const n = byLabel[l];
            const pct = total ? Math.round(n / total * 100) : 0;
            const cls = markClass(l);
            return `<div class="marks-summary-card mark-${cls}">
                <div class="marks-summary-card-head">
                    <span class="mark-type-pill mark-${cls}">${esc(l)}</span>
                    <span class="marks-summary-count">${n} 首 · ${pct}%</span>
                </div>
                <div class="marks-summary-sample">${renderSummarySamples(l)}</div>
            </div>`;
        }).join('') || '<div class="muted">暂无标记</div>';
    }

    function renderSummarySamples(label) {
        const samples = allRows.filter(r => (r.mark_type || '未标记') === label).slice(0, 3);
        if (!samples.length) return '<span class="muted">无</span>';
        return samples.map(s => `<span class="marks-summary-sample-item" title="${esc(s.song_name)} — ${esc(s.performer || '未知')}">${esc(s.song_name)}<span class="muted"> · ${esc(s.performer || '未知歌手')}</span></span>`).join('<br>');
    }

    // ═══ 事件绑定 ═══
    function bindEvents() {
        if (document.getElementById('marksRefreshBtn')) {
            document.getElementById('marksRefreshBtn').addEventListener('click', () => { meCache = null; loadMarksPage(); });
        }
        if (scopeMine) scopeMine.addEventListener('click', () => setScope('mine'));
        if (scopeAll) scopeAll.addEventListener('click', () => setScope('all'));
        if (marksClearFilter) marksClearFilter.addEventListener('click', () => {
            activeFilters = new Set(['__all__']);
            renderFilterChips();
            applyFilter();
        });
        const exportBtn = document.getElementById('marksExportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', function () {
                const a = document.createElement('a');
                a.href = '/api/marks/export';
                a.download = '';
                document.body.appendChild(a);
                a.click();
                a.remove();
            });
        }
        if (marksSelectAll) marksSelectAll.addEventListener('change', e => onHeadSelectChange(e.target.checked));
        if (marksBatchEditBtn) marksBatchEditBtn.addEventListener('click', () => openBatchEditDialog('replace'));
        if (marksBatchAppendBtn) marksBatchAppendBtn.addEventListener('click', () => openBatchEditDialog('append'));
        if (marksBatchClearBtn) marksBatchClearBtn.addEventListener('click', () => openBatchEditDialog('clear'));
        if (marksBatchDelBtn) marksBatchDelBtn.addEventListener('click', batchDelete);
        if (marksBatchCancelBtn) marksBatchCancelBtn.addEventListener('click', clearSelected);
        if (marksSummaryBtn) marksSummaryBtn.addEventListener('click', toggleSummary);
        if (marksSummaryClose) marksSummaryClose.addEventListener('click', () => {
            marksSummary.style.display = 'none';
            marksSummaryBtn.textContent = '📊 标签汇总';
        });

        // 行点击（删除按钮事件代理）
        if (marksBody) {
            marksBody.addEventListener('click', async function (e) {
                const btn = e.target.closest('.mark-del');
                if (!btn) return;
                if (!confirm('删除标记：' + btn.dataset.song + '？')) return;
                const body = {
                    song_name: btn.dataset.song,
                    performer: btn.dataset.perf,
                    album: btn.dataset.album,
                    scope: currentScope,
                };
                if (btn.dataset.owner) body.owner = btn.dataset.owner;
                const r = await fetch('/api/marks', {
                    method: 'DELETE',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!r.ok) {
                    const err = await r.json().catch(() => ({}));
                    setStatus('删除失败：' + (err.error || ('HTTP ' + r.status)), 'error');
                    return;
                }
                meCache = null;
                selectedKeys.clear();
                loadMarksPage();
            });
        }
    }

    async function batchDelete() {
        const rows = getSelectedRows();
        if (!rows.length) return;
        const isAllView = currentScope === 'all' || currentScope === 'shared';
        const meName = meCache ? (meCache.username || '') : '';
        const canDel = (r) => !isAllView || (r._owner || '') === meName || meCanManage;
        const delRows = rows.filter(canDel);
        const skipRows = rows.filter(r => !canDel(r));
        if (delRows.length === 0) {
            setStatus('选中的都是别人的标，且你无「管理他人标记」权限', 'warn');
            return;
        }
        let msg = '确认删除 ' + delRows.length + ' 条标记？';
        if (skipRows.length) msg += '\n（注：另有 ' + skipRows.length + ' 条无权限的标会自动跳过）';
        if (!confirm(msg)) return;
        setStatus('批量删除 ' + delRows.length + ' 条…', 'loading');
        // 逐条 DELETE（POST /api/marks batch_update 没有 delete 模式，逐条更稳）
        let ok = 0, fail = 0;
        for (const r of delRows) {
            try {
                const resp = await fetch('/api/marks', {
                    method: 'DELETE',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        song_name: r.song_name, performer: r.performer, album: r.album,
                        scope: currentScope,
                        owner: (isAllView && r._owner && r._owner !== meName) ? r._owner : undefined,
                    }),
                });
                if (resp.ok) ok++;
                else fail++;
            } catch (e) { fail++; }
        }
        setStatus(`批量删除完成：成功 ${ok} 条${fail ? ' / 失败 ' + fail : ''}`, fail ? 'warn' : 'ok');
        selectedKeys.clear();
        await loadMarksPage();
    }

    // 暴露给 app.js 的 tab 切换钩子
    bindEvents();
    window.loadMarksPage = loadMarksPage;
    window.setMarksScope = setScope;
})();
