/* ═══ 艺名管理（v4.30.19 重构）：
 * - 事件委托统一分发（修复：白名单行「主页」按钮因选择器遗漏永不触发——点不动的根因）
 * - 按钮全套 UI 设计（平台色点 / 绿色确认 / 灰描边忽略 / 红色删除）
 * 后端：/api/admin/performer_aliases（GET/POST/DELETE）
 *       /api/admin/performer_alias_suggestions/dismiss（POST）
 */
(function () {
    'use strict';

    const API = '/api/admin/performer_aliases';
    const DISMISS = '/api/admin/performer_alias_suggestions/dismiss';

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* ── 样式（组件加载即注入，与页面状态无关）── */
    function ensureStyle() {
        if (document.getElementById('aliasBtnStyle')) return;
        const st = document.createElement('style');
        st.id = 'aliasBtnStyle';
        st.textContent = `
        .alias-btn{border:none;border-radius:8px;padding:4px 12px;font-size:12.5px;font-weight:500;
          cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px;
          transition:all .15s;vertical-align:middle;}
        .alias-btn:active{transform:scale(.96);}
        .alias-btn-ok{background:#e8f7ee;color:#16a34a;}
        .alias-btn-ok:hover{background:#16a34a;color:#fff;}
        .alias-btn-skip{background:#f1f3f7;color:#6b7280;}
        .alias-btn-skip:hover{background:#6b7280;color:#fff;}
        .alias-btn-del{background:#fdecec;color:#ef4444;padding:4px 8px;}
        .alias-btn-del:hover{background:#ef4444;color:#fff;}
        .alias-btn-home{background:#eef1fe;color:#4f6ef7;}
        .alias-btn-home:hover{background:#4f6ef7;color:#fff;}
        .alias-btn-home .plat-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85;}
        .alias-tag{display:inline-flex;align-items:center;gap:6px;background:#f4f6ff;border:1px solid #e4e9fb;
          border-radius:999px;padding:3px 6px 3px 12px;margin:3px 4px 3px 0;font-size:12.5px;color:#3b4252;}
        `;
        document.head.appendChild(st);
    }

    /* ── API ── */
    async function apiGet() {
        const r = await fetch(API);
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.error || ('请求失败 ' + r.status));
        }
        return r.json();
    }
    async function apiSend(method, body) {
        const r = await fetch(API, {
            method, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.error || ('请求失败 ' + r.status));
        }
        return r.json();
    }
    async function apiDismiss(body) {
        const r = await fetch(DISMISS, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.error || ('请求失败 ' + r.status));
        }
        return r.json();
    }

    /* ── 歌手主页 ── */
    const HOME_PLATS = [['qq', 'Q音', '#31c27c'], ['kugou', '酷狗', '#2ca6e0'],
                        ['kuwo', '酷我', '#f5a623'], ['netease', '网易云', '#e85454'],
                        ['qishui', '汽水', '#8b5cf6']];
    async function openArtistHome(name, platform) {
        if (platform === 'qishui') { alert('汽水音乐暂无公开的歌手主页接口，敬请期待'); return; }
        try {
            const r = await fetch('/api/artist_home?platform=' + platform + '&name=' + encodeURIComponent(name));
            const d = await r.json();
            if (d.ok && d.url) { window.open(d.url, '_blank'); }
            else { alert(d.error || '未找到该歌手的主页'); }
        } catch (e) { alert('查询失败：' + e.message); }
    }
    function homeButtons(name) {
        return '<span style="display:inline-flex;gap:4px;flex-wrap:wrap;">' +
            HOME_PLATS.map(([pf, label, color]) =>
                '<button type="button" class="alias-btn alias-btn-home" data-act="home" data-name="' + escapeHtml(name) + '" data-platform="' + pf + '" title="在' + label + '打开歌手主页">' +
                '<span class="plat-dot" style="background:' + color + '"></span>' + label + '</button>'
            ).join('') + '</span>';
    }

    /* ── 渲染：已生效白名单 ── */
    function renderAliases(aliases) {
        const tb = document.getElementById('aliasListTable');
        if (!tb) return;
        const bases = Object.keys(aliases || {}).sort();
        if (!bases.length) {
            tb.innerHTML = '<tr><td class="alias-empty">暂无配置——系统遇到候选时会提示你确认</td></tr>';
            return;
        }
        tb.innerHTML = '<tr><th>基名（曲库/常用名）</th><th>变体（平台写法 / 改名后）</th><th>歌手主页</th></tr>' +
            bases.map(base => {
                const list = aliases[base] || [];
                return '<tr><td><b>' + escapeHtml(base) + '</b></td><td>' +
                    (list.length
                        ? list.map(a =>
                            '<span class="alias-tag">' + escapeHtml(a) +
                            '<button type="button" class="alias-btn alias-btn-del" data-act="del" data-base="' + escapeHtml(base) + '" data-alias="' + escapeHtml(a) + '" title="删除该变体">✕</button></span>'
                          ).join('')
                        : '<span class="alias-empty">（无）</span>') +
                    '</td><td>' + homeButtons(base) + '</td></tr>';
            }).join('');
    }

    /* ── 渲染：待确认候选 ── */
    function renderSuggestions(suggestions) {
        const tb = document.getElementById('aliasSugTable');
        if (!tb) return;
        const list = Array.isArray(suggestions) ? suggestions : Object.values(suggestions || {});
        if (!list.length) {
            tb.innerHTML = '<tr><td class="alias-empty">暂无待确认候选——批量搜索发现「疑似改名」时会自动出现在这里</td></tr>';
            return;
        }
        tb.innerHTML = '<tr><th>基名（曲库/任务里写的）</th><th>疑似变体（平台上搜到的）</th><th>证据（命中的歌）</th><th>操作</th></tr>' +
            list.map(s => {
                const base = s.base || '', alias = s.alias || '';
                return '<tr><td><b>' + escapeHtml(base) + '</b></td><td>' + escapeHtml(alias) + '</td>' +
                    '<td class="alias-evid">' + escapeHtml(s.song_name || '') + (s.ns ? '（匹配度 ' + s.ns + '%）' : '') + '</td>' +
                    '<td><span style="display:inline-flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
                    '<button type="button" class="alias-btn alias-btn-ok" data-act="approve" data-base="' + escapeHtml(base) + '" data-alias="' + escapeHtml(alias) + '">✓ 加入白名单</button>' +
                    '<button type="button" class="alias-btn alias-btn-skip" data-act="dismiss" data-base="' + escapeHtml(base) + '" data-alias="' + escapeHtml(alias) + '">✕ 忽略</button>' +
                    homeButtons(alias) +
                    '</span></td></tr>';
            }).join('');
    }

    /* ── 事件委托：一个监听管所有表格按钮（approve/dismiss/home/del）── */
    function bindDelegation() {
        ['aliasListTable', 'aliasSugTable'].forEach(tid => {
            const tb = document.getElementById(tid);
            if (!tb) return;
            tb.addEventListener('click', async (ev) => {
                const btn = ev.target.closest('button[data-act]');
                if (!btn || !tb.contains(btn)) return;
                const act = btn.dataset.act;
                const base = btn.dataset.base || '', alias = btn.dataset.alias || '';
                try {
                    if (act === 'approve') {
                        btn.disabled = true; btn.textContent = '提交中…';
                        const d = await apiSend('POST', { base, alias });
                        renderAll(d);
                    } else if (act === 'dismiss') {
                        if (!confirm('忽略该候选？（忽略后不再提示）')) return;
                        const d = await apiDismiss({ base, alias });
                        renderAll(d);
                    } else if (act === 'del') {
                        if (!confirm('删除别名：' + base + ' ↔ ' + alias + ' ？')) return;
                        const d = await apiSend('DELETE', { base, alias });
                        renderAll(d);
                    } else if (act === 'home') {
                        openArtistHome(btn.dataset.name, btn.dataset.platform);
                    }
                } catch (e) { alert(e.message); btn.disabled = false; }
            });
        });
    }

    function renderAll(d) {
        renderAliases(d.aliases);
        renderSuggestions(d.suggestions);
    }

    async function load() {
        try {
            const d = await apiGet();
            renderAll(d);
        } catch (e) {
            const t1 = document.getElementById('aliasListTable');
            const t2 = document.getElementById('aliasSugTable');
            const msg = '<tr><td class="alias-empty">' + escapeHtml(e.message) + '</td></tr>';
            if (t1) t1.innerHTML = msg;
            if (t2) t2.innerHTML = msg;
        }
    }

    function initAdd() {
        const base = document.getElementById('aliasBase');
        const alias = document.getElementById('aliasAlias');
        const btn = document.getElementById('aliasAddBtn');
        if (!base || !alias || !btn) return;
        const apply = async () => {
            if (!base.value.trim() || !alias.value.trim()) { alert('基名与变体都要填'); return; }
            try {
                const d = await apiSend('POST', { base: base.value.trim(), alias: alias.value.trim() });
                base.value = ''; alias.value = '';
                renderAll(d);
            } catch (e) { alert(e.message); }
        };
        btn.addEventListener('click', apply);
        [base, alias].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); }));
    }

    function init() {
        if (!document.getElementById('tab-alias')) return;
        ensureStyle();
        initAdd();
        bindDelegation();
        const tabBtn = document.querySelector('.tab-btn[data-tab="alias"]');
        if (tabBtn) {
            tabBtn.addEventListener('click', () => { setTimeout(load, 50); });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
