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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
