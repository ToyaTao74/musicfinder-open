/* MusicFinder — 证据监测页签前端逻辑 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const PLAT = { netease: '网易云', qishui: '汽水音乐', douyin: '抖音' };
  const state = { taskId: null, tasks: [], evidence: [], selected: new Set(), polling: null, catalogTotal: 0 };

  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v) { return v == null ? '—' : Number(v).toLocaleString('zh-CN'); }

  // 主互动指标：抖音取点赞，网易云/汽水取收藏；用于「互动量排序」与「优先级分」
  function mainMetric(e) {
    const it = e.interactions || {};
    if (e.platform === 'douyin') {
      const v = it.likes;
      return (v != null && v !== '' && Number(v) > 0) ? Number(v) : 0;
    }
    const fav = (it.favorites != null && it.favorites !== '' && it.favorites !== 0) ? Number(it.favorites)
      : ((it.collect != null && it.collect !== '' && it.collect !== 0) ? Number(it.collect) : 0);
    return fav || 0;
  }

  // 发布时间（毫秒时间戳）；无发布时间视为最旧（排末尾）
  function publishTs(e) {
    const s = e.uploaded_at || '';
    if (!s) return 0;
    const t = Date.parse(String(s).replace(/-/g, '/'));
    return isNaN(t) ? 0 : t;
  }

  // 优先级分（0~100）：发布越新 + 互动越高 → 越该先处理（下架止损 / 认领趁早）
  //   时效：指数衰减，半衰期 ~30 天；互动：对数归一（1万≈0.5，100万≈1.0）
  function priorityScore(e) {
    const now = Date.now(), day = 86400000;
    const pub = publishTs(e);
    const days = pub ? (now - pub) / day : 9999;
    const recency = pub ? Math.exp(-days / 30) : 0.05;
    const m = mainMetric(e);
    const engage = m > 0 ? Math.log10(1 + m) / Math.log10(1 + 1e6) : 0;
    return Math.round((0.6 * recency + 0.4 * engage) * 100);
  }

  // 从平台链接里提取可识别 ID（抖音视频/汽水 track），用于精简展示
  function linkId(url) {
    if (!url) return '';
    let m = url.match(/video\/(\d+)/); if (m) return m[1];
    m = url.match(/track_id=(\d+)/); if (m) return m[1];
    m = url.match(/[?&]id=(\d+)/); if (m) return m[1];
    m = url.match(/(\d{8,})/); if (m) return m[1];
    return url;
  }

  // 把当前行的 review/piracy 状态反推成下拉框默认项（与 4 个批量按钮语义一致）
  function reviewDefault(e) {
    if (e.review_status === '已忽略') return '已忽略';
    if (e.review_status === '已认领') return '已认领';
    if (e.review_status === '已确认') return e.piracy_status === '是' ? '盗版' : '确认正版';
    return '待复核';
  }

  // 命中依据：拼接实际互动值 + 阈值判定（如「近半年点赞≥10,000（实际 35,605）」）
  function basisText(e) {
    const it = e.interactions || {};
    const fav = (it.favorites != null && it.favorites !== '' && it.favorites !== 0) ? Number(it.favorites)
      : ((it.collect != null && it.collect !== '' && it.collect !== 0) ? Number(it.collect) : null);
    const likes = (it.likes != null && it.likes !== '' && it.likes !== 0) ? Number(it.likes) : null;
    const main = [];
    const sub = [];
    if (e.platform === 'douyin') {
      if (likes != null) {
        if (e.qualified === 1 && likes >= 30000) main.push(`长尾点赞≥30,000（实际 ${num(likes)}）`);
        else if (e.qualified === 1) main.push(`近半年点赞≥10,000（实际 ${num(likes)}）`);
        else main.push(`点赞 ${num(likes)}（未达 1万/3万）`);
      } else {
        main.push(e.qualified === 1 ? '已达标' : '未达阈值');
      }
      if (fav != null) sub.push(`收藏 ${num(fav)}`);
    } else {
      if (fav != null) main.push(`收藏 ${num(fav)}（${e.qualified === 1 ? '>1,000 达标' : '未>1,000'}）`);
      else main.push(e.qualified === 1 ? '已达标' : '未达阈值');
    }
    const meta = e.match_basis ? `<div class="ev-basis-meta"><b>匹配方式</b>${esc(e.match_basis)}</div>` : '';
    const subHtml = sub.length ? `<div class="ev-basis-sub">${sub.map(esc).join('；')}</div>` : '';
    return `<div class="ev-basis"><div class="ev-basis-main">${main.map(esc).join('；')}</div>${subHtml}${meta}</div>`;
  }

  async function api(url, opt) {
    const r = await fetch(url, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `请求失败(${r.status})`);
    return j;
  }

  async function loadStats() {
    const { data } = await api('/api/evidence/stats');
    const grid = $('#evStats');
    // 顶部 3 张行动卡：待我处理 / 已认盗版 / 已认领正版
    const cards = [
      ['待我处理', num(data.review_pending), 'warn', '待复核，等你判定'],
      ['已认盗版', num(data.piracy_yes), 'accent', '系统判定为盗版'],
      ['已认领正版', num(data.review_claimed || 0), 'ok', '已认领进正版库'],
    ];
    grid.innerHTML = cards.map(([l, v, c, sub]) =>
      `<div class="ev-stat"><div class="ev-stat-label">${l}</div><div class="ev-stat-value ${c}">${v}</div><div class="ev-stat-sub">${sub}</div></div>`
    ).join('');
    state.catalogTotal = data.catalog_total;
    renderBanner(data);
  }

  // 状态横幅：显式告知「还差什么才能跑出有意义的盗版判决」
  function renderBanner(d) {
    const b = $('#evBanner');
    if (!b) return;
    const missing = [];
    if (!d.catalog_total) {
      missing.push('① <b>上传授权曲库 Excel</b>（当前 0 首）—— 没有它，系统无法自动把上传者命中「授权曲库艺人」，盗版判定只能靠你人工复核「待复核」的条目，无法自动判盗版。');
    }
    if (!d.douyin_logged_in) {
      missing.push('② <b>登录抖音</b>（当前未登录）—— 抖音监测会停在「等待登录抖音」，需在本机扫码一次：<code>python -m evidence.platforms.douyin login</code>。');
    }
    if (!missing.length) {
      b.hidden = false;
      b.className = 'ev-banner ok';
      b.innerHTML = `<div class="ev-banner-title">✅ 证据台已就绪</div>
        <div>已上传授权曲库 <b>${num(d.catalog_total)}</b> 首，抖音已登录。现在「开始监测」可自动比对上传者是否命中授权艺人，并给出盗版建议。</div>`;
      return;
    }
    b.hidden = false;
    b.className = 'ev-banner warn';
    const douyinBtn = !d.douyin_logged_in
      ? `<button class="button primary ev-inline-btn" id="evOpenDouyinLogin" type="button">📱 立即扫码登录抖音</button>`
      : '';
    b.innerHTML = `<div class="ev-banner-title">⚠️ 证据台还差以下准备，暂不能自动判盗版</div>
      <ul>${missing.map(m => `<li>${m}</li>`).join('')}</ul>
      <div class="ev-banner-cta">补齐后点右上角「刷新」即可生效。网易云 / 汽水两条线不需要抖音登录，可先跑；只是抖音那条线会停在「等待登录抖音」。</div>
      ${douyinBtn}`;
    if (!d.douyin_logged_in) {
      $('#evOpenDouyinLogin').addEventListener('click', openDouyinLoginModal);
    }
  }

  async function loadTasks() {
    const { data } = await api('/api/evidence/tasks');
    state.tasks = data.tasks || [];
    const sel = $('#evTaskSelect');
    // 兜底：如果 state.taskId 指定的任务不在列表里（极小概率，task 刚提交还没被 list 看到），
    //       先把这条 option 临时补进去，确保 selector 一定显示得出来
    if (state.taskId && !state.tasks.find(t => t.id === state.taskId)) {
      sel.innerHTML = `<option value="${state.taskId}">#${state.taskId}（加载中…）</option>` +
        state.tasks.map(t => `<option value="${t.id}">#${t.id} ${esc(t.song_name)}${t.artist ? ' · ' + esc(t.artist) : ''}</option>`).join('');
    } else {
      sel.innerHTML = state.tasks.map(t => `<option value="${t.id}">#${t.id} ${esc(t.song_name)}${t.artist ? ' · ' + esc(t.artist) : ''}</option>`).join('');
    }
    if (!state.taskId && state.tasks.length) state.taskId = state.tasks[0].id;
    if (state.taskId) sel.value = String(state.taskId);
    await loadDashboard();
  }

  // 「自动跳转到新任务」视觉提示：selector + task card 同时闪一下 + 顶部出现气泡
  function flashTaskJump() {
    const sel = $('#evTaskSelect');
    const box = $('#evTaskStatus');
    if (sel) {
      sel.classList.remove('ev-flash'); void sel.offsetWidth;
      sel.classList.add('ev-flash');
      setTimeout(() => sel.classList.remove('ev-flash'), 1500);
    }
    if (box) {
      box.classList.remove('ev-flash'); void box.offsetWidth;
      box.classList.add('ev-flash');
      setTimeout(() => box.classList.remove('ev-flash'), 1500);
    }
    showJumpBanner();
  }

  function showJumpBanner() {
    const t = state.tasks.find(x => x.id === state.taskId);
    const label = t ? `#${t.id} ${t.song_name}` : `#${state.taskId}`;
    let b = document.getElementById('evJumpBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'evJumpBanner';
      b.className = 'ev-jump-banner';
      document.body.appendChild(b);
    }
    b.innerHTML = `已自动跳转到新任务 <b>${esc(label)}</b> ↓`;
    b.classList.remove('show'); void b.offsetWidth;
    b.classList.add('show');
    setTimeout(() => b.classList.remove('show'), 2500);
  }

  function statusLabel(s) {
    return ({ queued: '排队中', running: '执行中', completed: '已完成', partial: '部分完成',
      empty: '未找到', failed: '失败', cancelled: '已停止', needs_login: '等待登录抖音' }[s] || s);
  }

  async function loadDashboard() {
    const q = state.taskId ? `?task_id=${state.taskId}` : '';
    const { data } = await api('/api/evidence/dashboard' + q);
    state.evidence = data.evidence || [];
    const t = state.tasks.find(x => x.id === state.taskId);
    const box = $('#evTaskStatus');
    if (!t) {
      box.innerHTML = '';
    } else {
      const taskCls = ({
        running: 'task-run', queued: 'task-run', completed: 'task-done', partial: 'task-done',
        empty: 'task-warn', needs_login: 'task-warn', failed: 'task-bad', cancelled: 'task-idle'
      })[t.status] || 'task-idle';
      box.innerHTML = `<div class="ev-task-card">
        <span class="ev-task-badge">#${t.id}</span>
        <div class="ev-task-main">
          <div class="ev-task-name">${esc(t.song_name)}</div>
          <div class="ev-task-meta">
            <span class="ev-pill ${taskCls}">${statusLabel(t.status)}</span>
            <span class="ev-task-metric">发现 <b>${num(t.discovered)}</b></span>
            <span class="ev-task-metric">合格 <b>${num(t.qualified)}</b></span>
            ${t.message ? `<span class="ev-task-msg">${esc(t.message)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }
    renderRows();
  }

  function filtered() {
    const p = $('#evPlatformFilter').value, th = $('#evThresholdFilter').value,
      pi = $('#evPiracyFilter').value, rv = $('#evReviewFilter').value, tr = $('#evTimeFilter').value,
      pu = $('#evPubFilter').value;
    const now = Date.now(), day = 86400000;
    return state.evidence.filter(e => {
      if (p !== 'all' && e.platform !== p) return false;
      if (th === 'qualified' && e.qualified !== 1) return false;
      if (th === 'unqualified' && e.qualified === 1) return false;
      if (pi !== 'all' && e.piracy_status !== pi) return false;
      if (rv !== 'all' && e.review_status !== rv) return false;
      if (tr !== 'all' && e.created_at) {
        const t = Date.parse(String(e.created_at).replace(/-/g, '/'));
        const span = tr === 'week' ? 7 : 30;
        if (isNaN(t) || (now - t) > span * day) return false;
      }
      // 发布时间筛选：近 7/30 天发布；无发布时间的条目不满足（无法确认），一并隐藏
      if (pu !== 'all') {
        const t = publishTs(e);
        const span = pu === 'week' ? 7 : 30;
        if (t === 0 || (now - t) > span * day) return false;
      }
      return true;
    });
  }

  function sorted(rows) {
    const mode = $('#evSort') ? $('#evSort').value : 'crawl_desc';
    const arr = rows.slice();
    const t = s => Date.parse(String(s || '').replace(/-/g, '/'));
    const cmp = {
      crawl_desc: (a, b) => t(b.created_at) - t(a.created_at),
      pub_desc: (a, b) => publishTs(b) - publishTs(a),
      engage_desc: (a, b) => mainMetric(b) - mainMetric(a),
      priority: (a, b) => priorityScore(b) - priorityScore(a),
      pending_first: (a, b) => {
        const pa = a.review_status === '待复核' ? 0 : 1;
        const pb = b.review_status === '待复核' ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return t(b.created_at) - t(a.created_at);
      }
    };
    if (cmp[mode]) arr.sort(cmp[mode]);
    return arr;
  }

  function renderRows() {
    const rows = sorted(filtered());
    state.visible = rows;
    const tb = $('#evRows');
    if (!rows.length) { tb.innerHTML = ''; $('#evEmpty').hidden = false; return; }
    $('#evEmpty').hidden = true;
    // 同博主同歌聚合：在全量证据里统计 (uploader|原声账号|歌名) 出现次数
    const freq = {};
    for (const e of state.evidence) {
      const k = `${e.uploader || ''}|${e.original_author || ''}|${e.song_name || ''}`;
      freq[k] = (freq[k] || 0) + 1;
    }
    tb.innerHTML = rows.map(e => {
      // 互动 / 使用：参考搜索页「收藏/在听/评论」三行结构（label 左 / value 右 / 按量级配色）
      const mag = n => {
        if (n == null || n === '' || n === 0) return 'empty';
        const v = Number(n);
        if (v >= 100000) return 'huge';
        if (v >= 10000) return 'large';
        if (v >= 1000) return 'mid';
        return 'small';
      };
      const rowHtml = (label, val, kind) => {
        const m = mag(val);
        if (m === 'empty') return '';
        return `<div class="ev-metric-row kind-${kind}"><span class="ev-metric-label">${label}</span><span class="ev-metric-value mag-${m}">${num(val)}</span></div>`;
      };
      const it = e.interactions || {};
      let interRows = '';
      if (e.platform === 'douyin') {
        interRows = [rowHtml('点赞', it.likes, 'primary'), rowHtml('收藏', it.collect, 'secondary'), rowHtml('评论', it.comments, 'secondary'), rowHtml('分享', it.shares, 'secondary')].join('');
      } else {
        const fav = (it.favorites != null && it.favorites !== '' && it.favorites !== 0) ? Number(it.favorites)
          : ((it.collect != null && it.collect !== '' && it.collect !== 0) ? Number(it.collect) : null);
        interRows = [rowHtml('收藏', fav, 'primary'), rowHtml('评论', it.comments, 'secondary'), rowHtml('播放', it.plays, 'secondary'), rowHtml('分享', it.shares, 'secondary')].join('');
      }
      const interS = interRows ? `<div class="ev-metrics">${interRows}</div>` : '<span class="ev-metrics-empty">—</span>';
      const pirCls = e.piracy_status === '是' ? 'pir-yes' : e.piracy_status === '否' ? 'pir-no' : 'pir-pend';
      const qCls = e.review_status === '已确认' ? 'q'
        : e.review_status === '已忽略' ? 'u'
        : e.review_status === '已认领' ? 'claimed' : 'pend';
      // 「阈值」是系统抓取时的最低互动量门槛：抖音近半年点赞≥1万 或 长尾≥3万；网易云/汽水收藏>1千
      // 达阈值的证据才会进入监测流；未达标只是一条提示，不会出现在「待我处理」统计里
      const TH_TIP = e.platform === 'douyin'
        ? '抖音阈值：近半年点赞 ≥ 10,000 或 长尾点赞 ≥ 30,000'
        : '网易云/汽水阈值：收藏 > 1,000';
      const qTag = e.qualified === 1
        ? `<span class="ev-pill q" title="${esc(TH_TIP)}">已达标</span>`
        : `<span class="ev-pill u" title="${esc(TH_TIP)}">未达阈值</span>`;
      // 官方链接（抖音视频）：复制 + 打开
      const officialUrl = e.official_url || e.video_url || '';
      const officialHtml = officialUrl
        ? `<div class="ev-link-line"><span class="ev-link-id">${esc(linkId(officialUrl))}</span>
           <a class="ev-link" href="${esc(officialUrl)}" target="_blank" rel="noreferrer">打开</a></div>
           <button class="ev-copy" data-copy="${esc(officialUrl)}" type="button" title="复制抖音视频链接">复制</button>`
        : '—';
      // 汽水音频：复制 + 打开 + 认领
      const sodaHtml = e.soda_link
        ? `<div class="ev-link-line"><span class="ev-link-id">${esc(linkId(e.soda_link))}</span>
           <a class="ev-link" href="${esc(e.soda_link)}" target="_blank" rel="noreferrer">打开</a></div>
           <button class="ev-copy" data-copy="${esc(e.soda_link)}" type="button" title="复制汽水音频链接">复制</button>
           <button class="ev-claim" data-id="${e.id}" type="button" title="认领为正版库（review=已认领）">认领</button>`
        : '—';
      // 详情子行：监测歌手 / 原声账号 / 博主（结构化 label/value，+同博主同歌聚合）
      const aggKey = `${e.uploader || ''}|${e.original_author || ''}|${e.song_name || ''}`;
      const aggN = freq[aggKey] || 0;
      const detailRows = [
        ['监测歌手', e.artist || e.monitor_artist || '—'],
        ['原声账号', e.original_author || '—'],
        ['博主', e.uploader || e.video_blogger || '—'],
      ].map(([label, value]) =>
        `<div class="ev-song-detail-row"><span class="ev-song-detail-label">${label}</span><span class="ev-song-detail-value">${esc(value)}</span></div>`
      ).join('');
      const aggLine = aggN > 1 ? `<div style="margin-top:6px"><span class="ev-agg">同博主同歌出现 ${aggN} 次</span></div>` : '';
      const detail = `<div class="ev-song-detail">${detailRows}${aggLine}</div>`;
      const def = reviewDefault(e);
      const opt = v => `<option value="${v}"${def === v ? ' selected' : ''}>${v}</option>`;
      // 撤销按钮：仅当当前 review_status 非待复核时显示
      const myStatus = e.review_status || '待复核';
      const canUndo = myStatus !== '待复核' && myStatus !== '';
      const undoBtn = canUndo
        ? `<button class="ev-undo" data-undo="${e.id}" data-prev="${esc(myStatus)}" type="button" title="把这一行恢复到「待复核」">↶ 撤销</button>`
        : '';
      // 优先级分：仅在「优先级分」排序时显示，给排序一个直观依据
      const sortMode = $('#evSort') ? $('#evSort').value : 'crawl_desc';
      const prioBadge = sortMode === 'priority'
        ? `<span class="ev-prio" title="优先级分 = 发布越新 + 互动越高（0~100）">优先级 ${priorityScore(e)}</span>`
        : '';
      return `<tr>
        <td><input type="checkbox" class="ev-check-row" value="${e.id}" ${state.selected.has(e.id) ? 'checked' : ''}></td>
        <td><div class="ev-song">${esc(e.song_name)}</div>${prioBadge}${detail}</td>
        <td>${PLAT[e.platform] || e.platform}<br>${qTag}</td>
        <td class="ev-col-links">${officialHtml}</td>
        <td class="ev-col-links">${sodaHtml}</td>
        <td>${interS}</td>
        <td>${basisText(e)}</td>
        <td>
          <div class="ev-judge">
            <div class="ev-judge-row"><span class="ev-judge-tag">系统</span><span class="ev-pill ${pirCls}">${esc(e.piracy_status || '—')}</span></div>
            <div class="ev-judge-row"><span class="ev-judge-tag">我的</span><span class="ev-pill ${qCls}">${esc(myStatus)}</span>${undoBtn}</div>
            <select class="ev-row-status" data-id="${e.id}" title="单独设定本行状态">
              ${opt('待复核')}${opt('盗版')}${opt('确认正版')}${opt('已认领')}${opt('已忽略')}
            </select>
          </div>
        </td>
      </tr>`;
    }).join('');
    tb.querySelectorAll('.ev-check-row').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(Number(cb.value)); else state.selected.delete(Number(cb.value));
      updateSelBtns();
    }));
    tb.querySelectorAll('.ev-row-status').forEach(sel => sel.addEventListener('change', () => {
      doSetReview([Number(sel.dataset.id)], sel.value);
    }));
    tb.querySelectorAll('.ev-copy').forEach(btn => btn.addEventListener('click', () => copyText(btn.dataset.copy, btn)));
    tb.querySelectorAll('.ev-claim').forEach(btn => btn.addEventListener('click', () => doSetReview([Number(btn.dataset.id)], '已认领')));
    tb.querySelectorAll('.ev-undo').forEach(btn => btn.addEventListener('click', () => doSetReview([Number(btn.dataset.undo)], '待复核')));
    updateSelBtns();
  }

  function updateSelBtns() {
    const n = state.selected.size;
    const setBtn = (id, label) => {
      const el = $(id); if (!el) return;
      el.disabled = n === 0;
      el.textContent = n ? `${label}(${n})` : label;
    };
    setBtn('#evBatchPirate', '标记盗版');
    setBtn('#evBatchClaim', '已认领');
    setBtn('#evBatchOfficial', '确认正版');
    setBtn('#evBatchIgnore', '忽略');
    const cp = $('#evCopyLinks');
    if (cp) { cp.disabled = n === 0; cp.textContent = n ? `复制选中链接(${n})` : '复制选中链接'; }
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    }
    if (btn) { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = o; }, 1200); }
  }

  async function onCopyLinks() {
    const rows = state.evidence.filter(e => state.selected.has(e.id));
    if (!rows.length) return;
    const lines = rows.map(e => {
      const dv = e.official_url || e.video_url || '';
      const soda = e.soda_link || '';
      let s = dv ? `抖音: ${dv}` : '';
      if (soda) s += (s ? '  |  ' : '') + `汽水: ${soda}`;
      return (e.song_name || '') + (s ? '  ' + s : '');
    });
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      alert(`已复制 ${rows.length} 条链接，可直接粘贴到平台后台做下架/认领`);
    } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); alert(`已复制 ${rows.length} 条链接`); } catch (_) { alert('复制失败'); }
      document.body.removeChild(ta);
    }
  }

  // ── 交互绑定 ──
  function bind() {
    $('#evCatalogPick').addEventListener('click', () => $('#evCatalogFile').click());
    $('#evCatalogFile').addEventListener('change', onCatalog);
    $('#evFromMonitorBtn').addEventListener('click', onImportFromMonitor);
    $('#evStart').addEventListener('click', onStart);
    $('#evDouyinParseBtn').addEventListener('click', onDouyinParse);
    $('#evDouyinUrl').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); onDouyinParse(); }
    });
    $('#evRefresh').addEventListener('click', () => { loadStats(); loadTasks(); });
    $('#evTaskSelect').addEventListener('change', e => { state.taskId = Number(e.target.value); state.selected.clear(); loadDashboard(); });
    ['evPlatformFilter', 'evThresholdFilter', 'evPiracyFilter', 'evReviewFilter', 'evTimeFilter', 'evPubFilter', 'evSort'].forEach(id =>
      $('#' + id).addEventListener('change', renderRows));
    $('#evSelectAll').addEventListener('change', e => {
      state.selected = new Set(e.target.checked ? state.visible.map(r => r.id) : []);
      renderRows();
    });
    $('#evBatchPirate').addEventListener('click', () => setReview('盗版'));
    $('#evBatchClaim').addEventListener('click', () => setReview('已认领'));
    $('#evBatchOfficial').addEventListener('click', () => setReview('确认正版'));
    $('#evBatchIgnore').addEventListener('click', () => setReview('已忽略'));
    $('#evCopyLinks').addEventListener('click', onCopyLinks);
    $('#evExport').addEventListener('click', onExport);
  }

  async function onCatalog() {
    const f = $('#evCatalogFile').files[0];
    if (!f) return;
    const msg = $('#evCatalogMsg');
    msg.textContent = '解析中…'; msg.className = 'ev-msg';
    try {
      const fd = new FormData(); fd.append('file', f);
      const prev = await api('/api/evidence/import/preview', { method: 'POST', body: fd });
      const d = prev.data;
      if (d.missing_required && d.missing_required.length) {
        msg.textContent = '缺少必需列：' + d.missing_required.join(','); msg.className = 'ev-msg err'; return;
      }
      const commit = await api('/api/evidence/import/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ temp_path: prev.temp_path })
      });
      msg.textContent = `已导入 ${commit.data.inserted} 首（共 ${commit.data.catalog_total}）`; msg.className = 'ev-msg ok';
      loadStats();
    } catch (e) { msg.textContent = '导入失败：' + e.message; msg.className = 'ev-msg err'; }
  }

  async function onImportFromMonitor() {
    const onlyEnabled = $('#evFromMonitorEnabled') ? $('#evFromMonitorEnabled').checked : true;
    const msg = $('#evFromMonitorMsg');
    if (!msg) return;
    msg.textContent = '导入中…'; msg.className = 'ev-msg';
    try {
      const r = await api('/api/evidence/import/from-monitor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ only_enabled: onlyEnabled })
      });
      const d = r.data;
      msg.textContent = `已导入 ${d.imported} 首（跳过 ${d.skipped} 首空行），曲库共 ${d.catalog_total} 首`;
      msg.className = 'ev-msg ok';
      loadStats();
    } catch (e) {
      msg.textContent = '导入失败：' + e.message; msg.className = 'ev-msg err';
    }
  }

  async function onStart() {
    const song = $('#evSong').value.trim();
    const artist = $('#evArtist').value.trim();
    if (!song) { $('#evStartMsg').textContent = '请填写歌名'; $('#evStartMsg').className = 'ev-msg err'; return; }
    const platforms = [...document.querySelectorAll('input[name=evPlatform]:checked')].map(c => c.value);
    const msg = $('#evStartMsg'); msg.textContent = '提交中…'; msg.className = 'ev-msg';
    try {
      const r = await api('/api/evidence/task/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song, artist, version: $('#evVersion').value.trim(),
          platforms, douyinTarget: Number($('#evDouyinTarget').value) })
      });
      msg.textContent = '已开始，后台抓取中…'; msg.className = 'ev-msg ok';
      const newIds = (r && r.data && r.data.task_ids) || [];
      if (newIds.length) state.taskId = newIds[newIds.length - 1];
      await loadTasks();
      // 视觉提示：让用户清晰感知 selector 已自动切到新任务
      flashTaskJump();
      startPolling();
    } catch (e) { msg.textContent = '失败：' + e.message; msg.className = 'ev-msg err'; }
  }

  async function onDouyinParse() {
    const url = ($('#evDouyinUrl').value || '').trim();
    const msg = $('#evDouyinParseMsg');
    const btn = $('#evDouyinParseBtn');
    if (!url) { msg.textContent = '请粘贴抖音链接'; msg.className = 'ev-msg err'; return; }
    if (!/douyin\.com/i.test(url)) { msg.textContent = '不是抖音链接（需含 douyin.com）'; msg.className = 'ev-msg err'; return; }
    msg.textContent = '反查中…（首次需打开抖音页面，1-3 秒）'; msg.className = 'ev-msg';
    btn.disabled = true;
    try {
      const r = await api('/api/evidence/douyin/parse-link', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      if (r && r.data && r.data.needs_login) {
        msg.innerHTML = '⚠️ 还没登录抖音：<a href="#" id="evParseOpenDouyin">点此扫码登录</a>';
        msg.className = 'ev-msg err';
        $('#evParseOpenDouyin').addEventListener('click', e => { e.preventDefault(); openDouyinLoginModal(); });
        return;
      }
      const info = (r && r.data) || {};
      if (!info.music_name) {
        msg.innerHTML = '⚠️ 没识别到原曲：' + ((r && r.error) || '可能不是 BGM 视频');
        msg.className = 'ev-msg err';
        return;
      }
      $('#evSong').value = info.music_name;
      if (info.music_author) $('#evArtist').value = info.music_author;
      const dchk = document.querySelector('input[name=evPlatform][value=douyin]');
      if (dchk && !dchk.checked) dchk.checked = true;
      let summary = `✅ 已填入：${info.music_name}` + (info.music_author ? `（${info.music_author}）` : '');
      if (info.video_blogger) summary += ` · 上传者 ${info.video_blogger}`;
      msg.textContent = summary;
      msg.className = 'ev-msg ok';
    } catch (e) {
      msg.textContent = '反查失败：' + e.message;
      msg.className = 'ev-msg err';
    } finally {
      btn.disabled = false;
    }
  }

  async function doSetReview(ids, status, opts = {}) {
    if (!ids || !ids.length) return;
    // 记录每条改之前的 review_status，供 toast 撤销用
    const prevMap = {};
    for (const id of ids) {
      const e = state.evidence.find(x => x.id === id);
      if (e) prevMap[id] = e.review_status || '待复核';
    }
    try {
      await api('/api/evidence/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, status })
      });
      if (ids.length === state.selected.size) state.selected.clear();
      loadStats(); loadDashboard();
      // 仅当确有状态变化时弹撤销 toast
      if (!opts.silent) {
        const changed = ids.some(id => (prevMap[id] || '待复核') !== status);
        if (changed) {
          const LABEL = { '盗版': '盗版', '确认正版': '正版', '已认领': '已认领', '已忽略': '已忽略', '待复核': '待复核' };
          const label = LABEL[status] || status;
          const n = ids.length;
          showUndoToast(`已将 ${n} 条设为「${label}」`, () => revertReview(prevMap));
        }
      }
    } catch (e) { alert('复核失败：' + e.message); }
  }

  // 逐条恢复到改之前的状态（撤销 toast 用，不再弹新 toast）
  async function revertReview(prevMap) {
    const ids = Object.keys(prevMap).map(Number);
    for (const id of ids) {
      try {
        await api('/api/evidence/review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id], status: prevMap[id] || '待复核' })
        });
      } catch (_) { /* 单条失败忽略，继续其余 */ }
    }
    state.selected.clear();
    loadStats(); loadDashboard();
  }

  // 底部撤销浮层（仿 Gmail「撤回发送」）
  function showUndoToast(msg, undoFn) {
    let wrap = document.getElementById('evToastWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'evToastWrap';
      wrap.className = 'ev-toast-wrap';
      document.body.appendChild(wrap);
    }
    const toast = document.createElement('div');
    toast.className = 'ev-toast';
    toast.innerHTML = `<span class="ev-toast-msg"></span><button class="ev-toast-undo" type="button">撤销</button><button class="ev-toast-close" type="button" aria-label="关闭">×</button>`;
    toast.querySelector('.ev-toast-msg').textContent = msg;
    const remove = () => {
      toast.style.transition = 'opacity .2s ease, transform .2s ease';
      toast.style.opacity = '0'; toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 200);
    };
    const timer = setTimeout(remove, 6000);
    toast.querySelector('.ev-toast-undo').addEventListener('click', () => { clearTimeout(timer); undoFn(); remove(); });
    toast.querySelector('.ev-toast-close').addEventListener('click', () => { clearTimeout(timer); remove(); });
    wrap.appendChild(toast);
  }

  async function setReview(status) {
    await doSetReview([...state.selected], status);
  }

  function onExport() {
    const p = new URLSearchParams();
    if (state.taskId) p.set('task_id', state.taskId);
    p.set('platform', $('#evPlatformFilter').value);
    p.set('threshold', $('#evThresholdFilter').value);
    p.set('piracy', $('#evPiracyFilter').value);
    p.set('review_status', $('#evReviewFilter').value);
    p.set('time_range', $('#evTimeFilter').value);
    p.set('pub_range', $('#evPubFilter').value);
    window.open('/api/evidence/export.xlsx?' + p.toString(), '_blank');
  }

  function startPolling() {
    stopPolling();
    state.polling = setInterval(async () => {
      const t = state.tasks.find(x => x.id === state.taskId);
      if (!t || t.status === 'running' || t.status === 'queued') {
        await loadTasks();
      } else { stopPolling(); }
    }, 3000);
  }
  function stopPolling() { if (state.polling) clearInterval(state.polling); state.polling = null; }

  // ── 抖音扫码登录弹窗 ──
  const DOUYIN_LOGIN_CMD =
    `cd ${location.host.includes(':') ? '/Users/toya/WorkBuddy/2026-07-30-11-09-35' : '~'}/musicfinder 2>/dev/null || cd ~/MusicFinder; ./venv/bin/python3 -m evidence.platforms.douyin login`;

  async function openDouyinLoginModal() {
    const m = $('#evDouyinModal');
    if (!m) return;
    m.hidden = false;
    document.body.classList.add('ev-modal-open');
    const note = $('#evDouyinNote');
    note.textContent = '正在检查依赖…';
    try {
      const r = await api('/api/evidence/douyin/preflight');
      if (r.data && r.data.patchright_ok === false) {
        note.innerHTML = '⚠️ <b>未安装 patchright</b>，需要先在终端跑：<br><code>cd /Users/toya/WorkBuddy/2026-07-30-11-09-35/musicfinder && ./venv/bin/python3 -m pip install patchright && ./venv/bin/python3 -m patchright install chromium</code><br>装完再走下面的扫码步骤。';
        $('#evDouyinCmd').value = '# 请先安装 patchright（见上方说明）';
      } else {
        note.textContent = '✅ 依赖已就绪，按下方步骤操作：';
        $('#evDouyinCmd').value = DOUYIN_LOGIN_CMD;
      }
    } catch (e) {
      note.textContent = '预检失败：' + e.message;
    }
  }

  function closeDouyinLoginModal() {
    const m = $('#evDouyinModal');
    if (m) m.hidden = true;
    document.body.classList.remove('ev-modal-open');
  }

  async function copyDouyinCmd() {
    const t = $('#evDouyinCmd').value;
    try {
      await navigator.clipboard.writeText(t);
      const btn = $('#evDouyinCopy');
      const orig = btn.textContent;
      btn.textContent = '✅ 已复制';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch (e) {
      const ta = $('#evDouyinCmd'); ta.select(); document.execCommand('copy');
    }
  }

  async function checkDouyinAfterLogin() {
    const r = await api('/api/evidence/douyin/check');
    if (r.data && r.data.logged_in) {
      $('#evDouyinStatus').innerHTML = '✅ <b style="color:#15803d">抖音登录成功！</b> 可以关闭弹窗去「开始监测」了。';
      await loadStats();
    } else {
      $('#evDouyinStatus').innerHTML = '❌ 还没检测到登录态，请确认手机抖音 APP 已点「确认登录」，再回终端按回车保存。';
    }
  }

  function bindDouyinModal() {
    const m = $('#evDouyinModal');
    if (!m || bindDouyinModal._done) return;
    bindDouyinModal._done = true;
    $('#evDouyinClose').addEventListener('click', closeDouyinLoginModal);
    $('#evDouyinCopy').addEventListener('click', copyDouyinCmd);
    $('#evDouyinRefresh').addEventListener('click', checkDouyinAfterLogin);
    m.addEventListener('click', e => { if (e.target === m) closeDouyinLoginModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) closeDouyinLoginModal(); });
  }

  window.loadEvidencePage = async function () {
    if (!bind._done) { bind(); bind._done = true; }
    bindDouyinModal();
    try { await loadStats(); await loadTasks(); } catch (e) { console.error(e); }
  };
})();
