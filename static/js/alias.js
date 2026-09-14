/* ═══ 艺人别名管理（v4.30.4）：首页独立标签页 ═══
 * 后端：/api/admin/performer_aliases（GET/POST/DELETE，管理员）
 *       /api/admin/performer_alias_suggestions/dismiss（POST）
 * 候选来源：搜索/批量匹配时自动收集「歌名强匹配但艺人写法对不上」的对。
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
            method,
            headers: { 'Content-Type': 'application/json' },
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            throw new Error(d.error || ('请求失败 ' + r.status));
        }
        return r.json();
    }

    function renderAliases(aliases) {
        const tb = document.getElementById('aliasListTable');
        if (!tb) return;
        const bases = Object.keys(aliases || {}).sort();
        if (!bases.length) {
            tb.innerHTML = '<tr><td class="alias-empty">暂无配置——系统遇到候选时会提示你确认</td></tr>';
            return;
        }
        tb.innerHTML = '<tr><th>基名（曲库/常用名）</th><th>变体（平台写法 / 改名后）</th><th>操作</th></tr>' +
            bases.map(base => {
                const list = aliases[base] || [];
                return '<tr><td><b>' + escapeHtml(base) + '</b></td><td>' +
                    (list.length
                        ? list.map(a =>
                            '<span style="display:inline-flex;align-items:center;gap:4px;background:#f4f6ff;border-radius:8px;padding:2px 8px;margin:2px;">'
                            + escapeHtml(a) +
                            '<button class="alias-op del" data-base="' + escapeHtml(base) + '" data-alias="' + escapeHtml(a) + '" title="删除该变体">✕</button></span>'
                          ).join('')
                        : '<span class="alias-empty">（无）</span>') +
                    '</td><td></td></tr>';
            }).join('');
        tb.querySelectorAll('.alias-op.del').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('删除别名：' + btn.dataset.base + ' ↔ ' + btn.dataset.alias + ' ？')) return;
                try {
                    const d = await apiSend('DELETE', { base: btn.dataset.base, alias: btn.dataset.alias });
                    renderAll(d);
                } catch (e) { alert(e.message); }
            });
        });
    }

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
                    '<td>' +
                    '<button class="alias-op" data-act="approve" data-base="' + escapeHtml(base) + '" data-alias="' + escapeHtml(alias) + '">✓ 加入白名单</button> ' +
                    '<button class="alias-op del" data-act="dismiss" data-base="' + escapeHtml(base) + '" data-alias="' + escapeHtml(alias) + '">✕ 忽略</button>' +
                    '</td></tr>';
            }).join('');
        tb.querySelectorAll('.alias-op').forEach(btn => {
            btn.addEventListener('click', async () => {
                const body = { base: btn.dataset.base, alias: btn.dataset.alias };
                try {
                    let d;
                    if (btn.dataset.act === 'approve') {
                        d = await apiSend('POST', body);
                    } else {
                        d = await apiDismiss(body);
                    }
                    renderAll(d);
                } catch (e) { alert(e.message); }
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
        initAdd();
        // 切到该 tab 时才拉数据（避免首页加载多一次请求）
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
