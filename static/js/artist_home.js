/* ═══ 歌手主页全局组件（v4.30.6）═══
 * 任何页面里给歌手名旁包一个 <span class="mf-ahome" data-name="歌手名">🔗</span>，
 * 点击即弹出五平台选择浮层（Q音/酷狗/酷我/网易云/汽水），选择后新窗口打开歌手主页。
 * 后端：GET /api/artist_home?platform=&name=（登录即可）。
 */
(function () {
    'use strict';

    const PLATS = [
        ['qq', 'Q音', '#31c27c'],
        ['kugou', '酷狗', '#2ca6e0'],
        ['kuwo', '酷我', '#f5a623'],
        ['netease', '网易云', '#e85454'],
        ['qishui', '汽水', '#8b5cf6'],
    ];

    // 样式只注入一次
    function ensureStyle() {
        if (document.getElementById('mfAhomeStyle')) return;
        const st = document.createElement('style');
        st.id = 'mfAhomeStyle';
        st.textContent = `
.mf-ahome{cursor:pointer;opacity:.55;font-size:12px;margin-left:4px;text-decoration:none;transition:opacity .2s;}
.mf-ahome:hover{opacity:1;}
.mf-ahome-name{opacity:1;color:#4f6ef7;border-bottom:1px dashed #b9c3f7;margin-left:0;}
.mf-ahome-name:hover{border-bottom-style:solid;}
.mf-ahome-btn{border:1px solid #cdd7f8;background:#f6f8ff;color:#4f6ef7;border-radius:8px;
  padding:3px 10px;font-size:12px;margin-left:6px;display:inline-block;transition:all .15s;}
.mf-ahome-btn:hover{background:#4f6ef7;color:#fff;border-color:#4f6ef7;}
#mfAhomeMenu{position:fixed;z-index:99999;background:#fff;border-radius:12px;
  box-shadow:0 8px 30px rgba(30,40,80,.22);padding:10px 12px;font-size:13px;
  color:#1c2433;min-width:120px;font-family:-apple-system,"PingFang SC",sans-serif;}
#mfAhomeMenu .mf-ahome-title{font-weight:600;margin-bottom:6px;font-size:12px;color:#6b7280;
  max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#mfAhomeMenu .mf-ahome-item{padding:5px 8px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:6px;}
#mfAhomeMenu .mf-ahome-item:hover{background:#f2f4ff;}
#mfAhomeMenu .mf-ahome-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
`;
        document.head.appendChild(st);
    }

    function closeMenu() {
        const m = document.getElementById('mfAhomeMenu');
        if (m) m.remove();
        document.removeEventListener('click', onOutside, true);
    }

    function onOutside(e) {
        const m = document.getElementById('mfAhomeMenu');
        if (m && !m.contains(e.target) && !e.target.closest('.mf-ahome')) closeMenu();
    }

    async function openHome(name, platform) {
        if (platform === 'qishui') { alert('汽水音乐暂无公开的歌手主页接口，敬请期待'); return; }
        try {
            const r = await fetch('/api/artist_home?platform=' + encodeURIComponent(platform)
                                  + '&name=' + encodeURIComponent(name));
            const d = await r.json();
            if (d.ok && d.url) {
                window.open(d.url, '_blank');
            } else {
                alert(d.error || '未找到该歌手的主页');
            }
        } catch (e) { alert('查询失败：' + e.message); }
    }

    function showMenu(name, anchor) {
        ensureStyle();
        closeMenu();
        const m = document.createElement('div');
        m.id = 'mfAhomeMenu';
        m.innerHTML = '<div class="mf-ahome-title" title="' + name.replace(/"/g, '&quot;') + '">🔗 ' + name + '</div>' +
            PLATS.map(([pf, label, color]) =>
                `<div class="mf-ahome-item" data-p="${pf}"><span class="mf-ahome-dot" style="background:${color}"></span>${label}</div>`
            ).join('');
        document.body.appendChild(m);
        const r = anchor.getBoundingClientRect();
        m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 170)) + 'px';
        m.style.top = Math.min(r.bottom + 6, window.innerHeight - 220) + 'px';
        m.querySelectorAll('.mf-ahome-item').forEach(it => {
            it.addEventListener('click', () => { closeMenu(); openHome(name, it.dataset.p); });
        });
        setTimeout(() => document.addEventListener('click', onOutside, true), 0);
    }

    // 全局事件委托：任何 .mf-ahome 点击都弹出五平台浮层
    document.addEventListener('click', function (e) {
        const t = e.target.closest('.mf-ahome');
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        const name = (t.dataset.name || '').trim();
        if (name) showMenu(name, t);
    }, false);

    // 供其他脚本生成链接使用
    // v4.30.6：多歌手支持——「胜屿/王北车」按 / & 、等分隔拆分，每个歌手名各自可点开主页
    window.mfArtistHomeHtml = function (name, opts) {
        const o = opts || {};
        const esc = t => String(t == null ? '' : t)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const raw = String(name == null ? '' : name).trim();
        if (!raw) return '';
        const mk = (n, txt) => o.text
            ? '<button type="button" class="mf-ahome mf-ahome-btn" data-name="' + esc(n) + '">' + esc(txt || '打开艺人主页') + '</button>'
            : '<span class="mf-ahome" data-name="' + esc(n) + '" title="打开歌手主页（五平台）">🔗</span>';
        const parts = raw.split(/\s*[/&,，、;；|]+\s*/).filter(Boolean);
        if (parts.length <= 1) {
            return mk(raw);
        }
        // 多歌手：每个名字各自可点（虚线下划线提示可点），分隔符保留原样展示
        let out = '', rest = raw;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            const idx = rest.indexOf(p);
            if (idx > 0) out += esc(rest.slice(0, idx));           // 分隔符原样
            out += mk(p, (o.text ? p + ' ' : '') + '主页');
            rest = rest.slice(idx + p.length);
        }
        if (rest) out += esc(rest);
        return out;
    };
})();
