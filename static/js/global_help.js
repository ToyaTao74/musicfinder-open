/* ═══ 全站帮助与按钮可发现性（v4.30.6）═══
 * 1. 右下角常驻「❓ 帮助」按钮 → 全站功能说明模态框（按页面分区）
 * 2. 首次访问自动弹出引导
 * 3. 全局按钮可点击性统一（cursor/hover 反馈）
 */
(function () {
    'use strict';

    const SEEN_KEY = 'mf_help_seen_v1';

    const HELP_SECTIONS = [
        ['🔍 搜索', [
            '歌曲名称必填；歌手名 / 词作者 / 曲作者填了可以大幅提升匹配精准度',
            '每平台上限：控制每个平台抓取的候选数量，按相关性排序展示',
            '结果表里歌手名旁的 🔗：点开该歌手在 Q音/酷狗/酷我/网易云 的主页',
        ]],
        ['📋 批量歌单', [
            '输入框粘贴多行，每行：歌名,歌手,词作者,曲作者（后两项可选；支持带序号的表格）',
            '点「开始查询」自动创建实时任务：进度条逐首推进、可随时取消，关页面任务也继续跑',
            '任务卡片按钮：🔄 刷新（手动拉最新进度）/ 🔁 重试未收录（跑完后补漏，选平台）/ 🗑 清理历史（删已完成任务）',
            '上方下拉框可切换查看历史任务；「列顺序」可自定义你的表格列序（配一次长期生效）',
        ]],
        ['🏷️ 艺名管理', [
            '同一歌手改名或各平台写法不同时，配置「基名 ↔ 变体」（如 欧珈源 ↔ 声音玩具），搜索自动认回',
            '「待确认候选」是系统在搜索中自动发现的疑似改名，点 ✓ 加入白名单即生效',
            '每行的 Q音/酷狗/酷我/网易云 按钮可直接打开该歌手的主页',
        ]],
        ['❤️ 我喜欢 / 📃 歌单', [
            '登录对应平台账号后可同步红心歌单、导入和管理歌单内容',
        ]],
        ['🏷️ 标记', [
            '给歌曲打标记（正版/盗版/待核实等），支持备注与附加标签',
            '「仅有我 / 共享」切换：共享视图能看到所有人打的标记及操作人',
        ]],
        ['📊 监测 / 🔎 证据监测 / 📈 运营报告', [
            '监测：各平台接口与账号状态；证据监测：侵权证据的采集与留存；运营报告：汇总导出',
        ]],
        ['⚙️ 设置 / 账号', [
            '右上角用户名处可登录/退出；各平台 Cookie 在设置页用「浏览器登录」一键获取',
            '遇到「浏览器登录」没反应时，可改用「打开登录页」手动复制 Cookie',
        ]],
        ['通用技巧', [
            '灰掉的按钮 = 当前不可用（悬停可看原因，如任务运行中禁止重试）',
            '本帮助随时点右下角 ❓ 打开',
        ]],
    ];

    function ensureStyle() {
        if (document.getElementById('mfHelpStyle')) return;
        const st = document.createElement('style');
        st.id = 'mfHelpStyle';
        st.textContent = `
@keyframes mfhelpPulse{0%,100%{transform:scale(1);box-shadow:0 4px 14px rgba(124,92,247,.35);}50%{transform:scale(1.12);box-shadow:0 6px 22px rgba(124,92,247,.6);}}
            .mfhelp-pulse{animation:mfhelpPulse 1.6s ease-in-out infinite;}
            #mfHelpFab{position:fixed;right:18px;bottom:18px;z-index:99990;width:44px;height:44px;border-radius:50%;
  border:none;background:linear-gradient(135deg,#4f6ef7,#7c5cf7);color:#fff;font-size:20px;cursor:pointer;
  box-shadow:0 6px 20px rgba(79,110,247,.4);transition:transform .2s, box-shadow .2s;}
#mfHelpFab:hover{transform:scale(1.1);box-shadow:0 8px 26px rgba(79,110,247,.55);}
#mfHelpMask{position:fixed;inset:0;z-index:99995;background:rgba(15,20,35,.5);display:flex;align-items:center;justify-content:center;}
#mfHelpBox{background:#fff;border-radius:16px;max-width:760px;width:92%;max-height:82vh;overflow:auto;
  padding:26px 30px;font-family:-apple-system,"PingFang SC",sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.3);}
#mfHelpBox h2{margin:0 0 4px;font-size:20px;color:#1c2433;}
#mfHelpBox .mfhelp-sub{font-size:13px;color:#8a93a6;margin-bottom:16px;}
#mfHelpBox h3{font-size:14px;color:#4f6ef7;margin:16px 0 6px;}
#mfHelpBox li{font-size:13px;color:#374151;line-height:1.8;}
#mfHelpBox .mfhelp-close{position:sticky;float:right;top:0;border:none;background:#f0f2f8;border-radius:50%;
  width:30px;height:30px;font-size:14px;cursor:pointer;color:#6b7280;}
#mfHelpBox .mfhelp-close:hover{background:#e2e6ef;}
#mfHelpBox b{color:#1c2433;}
/* 全局按钮可点击性统一（不破坏现有配色，仅加反馈） */
button:not(:disabled){cursor:pointer;}
button:not(:disabled):hover{filter:brightness(.96);}
button:disabled{cursor:not-allowed;opacity:.5;}
`;
        document.head.appendChild(st);
    }

    function openHelp() {
        ensureStyle();
        localStorage.setItem(SEEN_KEY, '1');
        const mask = document.createElement('div');
        mask.id = 'mfHelpMask';
        mask.innerHTML = `<div id="mfHelpBox">
            <button class="mfhelp-close" type="button">✕</button>
            <h2>📖 功能使用指南</h2>
            <div class="mfhelp-sub">按页面分区列出所有可操作的功能。悬停按钮也会显示部分提示。</div>
            ${HELP_SECTIONS.map(([h, items]) =>
                `<h3>${h}</h3><ul>${items.map(i => '<li>' + i + '</li>').join('')}</ul>`
            ).join('')}
        </div>`;
        document.body.appendChild(mask);
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        mask.querySelector('.mfhelp-close').addEventListener('click', () => mask.remove());
    }

    function init() {
        if (!document.querySelector('.tab-nav')) return;   // 只在主页面生效
        ensureStyle();
        const fab = document.createElement('button');
        fab.id = 'mfHelpFab';
        fab.type = 'button';
        fab.textContent = '❓';
        fab.title = '功能使用指南（首次使用强烈建议看一遍）';
        fab.addEventListener('click', openHelp);
        document.body.appendChild(fab);
        // v4.30.14：首访不再自动弹出全屏遮罩（实测遮罩拦截了页面点击，
        // 用户点按钮毫无反应且不知原因）——改为 ❓ 按钮跳动吸引注意，点击才弹
        try {
            if (!localStorage.getItem(SEEN_KEY)) {
                fab.classList.add('mfhelp-pulse');
                const markSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {} };
                fab.addEventListener('click', markSeen, { once: true });
            }
        } catch (e) { /* 隐私模式忽略 */ }
    }

/* ═══ 页面内居中确认框（v4.30.80）═══
 * 原生 confirm() 由浏览器固定渲染在窗口顶部，页面无法控制位置，鼠标动线长。
 * mfConfirm 用页面内模态框**居中**显示，样式与全站一致：
 *   用法：if (await mfConfirm('确定？')) { ... }   ← 必须 await！
 *   ⚠️ 不能当同步布尔用：Promise 恒为真值，会把「取消」吞掉、危险操作直接执行。
 * 交互：Enter=确定 / Esc=取消 / 点遮罩=取消；防重复 resolve。
 */
window.mfConfirm = function (msg) {
    function ensureStyle() {
        if (document.getElementById('mfConfirmStyle')) return;
        const st = document.createElement('style');
        st.id = 'mfConfirmStyle';
        st.textContent = `
#mfConfirmMask{position:fixed;inset:0;z-index:99999;background:rgba(15,20,35,.45);display:flex;align-items:center;justify-content:center;}
#mfConfirmBox{background:#fff;border-radius:14px;min-width:300px;max-width:88vw;padding:22px 24px 18px;
  box-shadow:0 18px 50px rgba(0,0,0,.28);font-family:-apple-system,"PingFang SC",sans-serif;animation:mfconfirmIn .16s ease-out;}
@keyframes mfconfirmIn{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
#mfConfirmBox .mfconfirm-msg{font-size:14px;line-height:1.7;color:#1c2433;white-space:pre-wrap;word-break:break-word;margin-bottom:18px;}
#mfConfirmBox .mfconfirm-btns{display:flex;justify-content:flex-end;gap:10px;}
#mfConfirmBox .mfconfirm-btn{border:none;border-radius:999px;padding:7px 20px;font-size:13px;font-weight:600;cursor:pointer;}
#mfConfirmBox .mfconfirm-btn.cancel{background:#f0f2f8;color:#6b7280;}
#mfConfirmBox .mfconfirm-btn.cancel:hover{background:#e2e6ef;}
#mfConfirmBox .mfconfirm-btn.ok{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;}
#mfConfirmBox .mfconfirm-btn.ok:hover{filter:brightness(1.06);}
#mfConfirmBox .mfconfirm-btn.ok:focus-visible{outline:2px solid #8b5cf6;outline-offset:2px;}
`;
        document.head.appendChild(st);
    }
    // v4.30.81 防卡死加固 ①：开新框前先清掉任何残留/叠加的旧遮罩
    // （连续快速点击会叠多个 mask，旧实现要逐个点掉才能恢复点击）
    document.querySelectorAll('#mfConfirmMask').forEach(function (m) { m.remove(); });
    return new Promise(function (resolve) {
        ensureStyle();
        let done = false;
        const mask = document.createElement('div');
        mask.id = 'mfConfirmMask';
        const settle = function (v) {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            mask.remove();
            resolve(v);
        };
        const onKey = function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); settle(false); }
            else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); settle(true); }
        };
        mask.innerHTML =
            '<div id="mfConfirmBox" role="dialog" aria-modal="true">' +
            '<div class="mfconfirm-msg"></div>' +
            '<div class="mfconfirm-btns">' +
            '<button type="button" class="mfconfirm-btn cancel">取消</button>' +
            '<button type="button" class="mfconfirm-btn ok">确定</button>' +
            '</div></div>';
        // textContent 注入，天然防 XSS（消息里可能带歌名/用户输入）
        mask.querySelector('.mfconfirm-msg').textContent = String(msg || '确定？');
        mask.querySelector('.cancel').addEventListener('click', function () { settle(false); });
        mask.querySelector('.ok').addEventListener('click', function () { settle(true); });
        mask.addEventListener('mousedown', function (e) { if (e.target === mask) settle(false); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(mask);
        try { mask.querySelector('.ok').focus(); } catch (e) {}
    });
};

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* ═══ v4.30.81 防卡死加固 ②：Esc 全局清扫（逃生门）═══
     * 无论什么原因（叠加残留、异常中断、历史 bug），只要页面上还挂着
     * mfConfirmMask / mfHelpMask 全屏遮罩，按一次 Esc 立即全部移除、恢复点击。
     * 注册在捕获阶段，任何框内 Esc 逻辑之后仍会执行到（各框先 settle 自己）。
     */
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var stray = document.querySelectorAll('#mfConfirmMask, #mfHelpMask');
        if (stray.length) stray.forEach(function (m) { m.remove(); });
    }, true);
})();
