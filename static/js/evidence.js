/* MusicFinder — 证据监测页签前端逻辑 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const PLAT = { netease: '网易云', qishui: '汽水音乐', douyin: '抖音' };
  const state = { taskId: null, tasks: [], evidence: [], selected: new Set(), polling: null, catalogTotal: 0 };

  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v) { return v == null ? '—' : Number(v).toLocaleString('zh-CN'); }

  async function api(url, opt) {
    const r = await fetch(url, opt);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `请求失败(${r.status})`);
    return j;
  }

  async function loadStats() {
    const { data } = await api('/api/evidence/stats');
    const grid = $('#evStats');
    grid.innerHTML = [
      ['授权曲库', num(data.catalog_total), ''],
      ['任务数', num(data.task_total), ''],
      ['证据条数', num(data.evidence_total), ''],
      ['合格证据', num(data.qualified_total), 'accent'],
      ['待复核', num(data.review_pending), 'warn'],
      ['判定盗版', num(data.piracy_yes), 'accent'],
    ].map(([l, v, c]) => `<div class="ev-stat"><div class="ev-stat-label">${l}</div><div class="ev-stat-value ${c}">${v}</div></div>`).join('');
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
    sel.innerHTML = state.tasks.map(t => `<option value="${t.id}">#${t.id} ${esc(t.song_name)}${t.artist ? ' · ' + esc(t.artist) : ''}</option>`).join('');
    if (!state.taskId && state.tasks.length) state.taskId = state.tasks[0].id;
    if (state.taskId) sel.value = String(state.taskId);
    await loadDashboard();
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
    $('#evTaskStatus').innerHTML = t
      ? `任务 #${t.id} <b>${esc(t.song_name)}</b>：${statusLabel(t.status)}（发现 ${t.discovered} / 合格 ${t.qualified}）${t.message ? ' — ' + esc(t.message) : ''}`
      : '';
    renderRows();
  }

  function filtered() {
    const p = $('#evPlatformFilter').value, th = $('#evThresholdFilter').value,
      pi = $('#evPiracyFilter').value, rv = $('#evReviewFilter').value;
    return state.evidence.filter(e =>
      (p === 'all' || e.platform === p) &&
      (th === 'all' || (th === 'qualified' ? e.qualified === 1 : e.qualified !== 1)) &&
      (pi === 'all' || e.piracy_status === pi) &&
      (rv === 'all' || e.review_status === rv));
  }

  function renderRows() {
    const rows = filtered();
    state.visible = rows;
    const tb = $('#evRows');
    if (!rows.length) { tb.innerHTML = ''; $('#evEmpty').hidden = false; return; }
    $('#evEmpty').hidden = true;
    tb.innerHTML = rows.map(e => {
      const inter = e.interactions || {};
      const interS = Object.entries(inter).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join(' / ');
      const pirCls = e.piracy_status === '是' ? 'pir-yes' : e.piracy_status === '否' ? 'pir-no' : 'pir-pend';
      const qCls = e.qualified === 1 ? 'q' : 'u';
      const link = e.video_url || e.official_url;
      return `<tr>
        <td><input type="checkbox" class="ev-check-row" value="${e.id}" ${state.selected.has(e.id) ? 'checked' : ''}></td>
        <td><b>${esc(e.song_name)}</b><br><span class="ev-sub">${esc(e.artist)}${e.version ? ' · ' + esc(e.version) : ''}</span></td>
        <td>${PLAT[e.platform] || e.platform}</td>
        <td>${link ? `<a href="${esc(link)}" target="_blank" rel="noreferrer">打开</a>` : '—'}${e.soda_link ? `<br><span class="ev-sub">汽水挂链</span>` : ''}</td>
        <td>${interS ? esc(interS) : '—'}</td>
        <td>${esc(e.match_basis)}</td>
        <td><span class="ev-pill ${pirCls}">${esc(e.piracy_status)}</span>${e.piracy_suggest ? `<br><span class="ev-sub">提示:${esc(e.piracy_suggest)}</span>` : ''}</td>
        <td><span class="ev-pill ${qCls}">${esc(e.review_status)}</span></td>
      </tr>`;
    }).join('');
    tb.querySelectorAll('.ev-check-row').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(Number(cb.value)); else state.selected.delete(Number(cb.value));
      updateSelBtns();
    }));
    updateSelBtns();
  }

  function updateSelBtns() {
    const n = state.selected.size;
    $('#evBatchConfirm').disabled = n === 0;
    $('#evBatchIgnore').disabled = n === 0;
    $('#evBatchConfirm').textContent = n ? `确认所选(${n})` : '确认所选';
    $('#evBatchIgnore').textContent = n ? `忽略所选(${n})` : '忽略所选';
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
    ['evPlatformFilter', 'evThresholdFilter', 'evPiracyFilter', 'evReviewFilter'].forEach(id =>
      $('#' + id).addEventListener('change', renderRows));
    $('#evSelectAll').addEventListener('change', e => {
      state.selected = new Set(e.target.checked ? state.visible.map(r => r.id) : []);
      renderRows();
    });
    $('#evBatchConfirm').addEventListener('click', () => setReview('已确认'));
    $('#evBatchIgnore').addEventListener('click', () => setReview('已忽略'));
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
      await api('/api/evidence/task/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song, artist, version: $('#evVersion').value.trim(),
          platforms, douyinTarget: Number($('#evDouyinTarget').value) })
      });
      msg.textContent = '已开始，后台抓取中…'; msg.className = 'ev-msg ok';
      await loadTasks();
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
      // 反查成功：回填表单
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

  async function setReview(status) {
    const ids = [...state.selected];
    if (!ids.length) return;
    try {
      await api('/api/evidence/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, status })
      });
      state.selected.clear();
      loadStats(); loadDashboard();
    } catch (e) { alert('复核失败：' + e.message); }
  }

  function onExport() {
    const p = new URLSearchParams();
    if (state.taskId) p.set('task_id', state.taskId);
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
  // 服务以 root LaunchDaemon 启动，没有 GUI 会话，无法直接弹出浏览器给用户看。
  // 解决方案：让用户在自己 Terminal 里跑一行命令（浏览器会弹到他自己桌面）。
  // 弹窗给出复制即用的一行命令 + 跑完后回页面点"刷新状态"。
  const DOUYIN_LOGIN_CMD =
    `cd ${location.host.includes(':') ? '/Users/toya/WorkBuddy/2026-07-30-11-09-35' : '~'}/musicfinder 2>/dev/null || cd ~/MusicFinder; ./venv/bin/python3 -m evidence.platforms.douyin login`;

  async function openDouyinLoginModal() {
    const m = $('#evDouyinModal');
    if (!m) return;
    m.hidden = false;
    document.body.classList.add('ev-modal-open');
    // 检查 patchright 是否已装，未装时给出补救提示
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
      // 退路：选中文本
      const ta = $('#evDouyinCmd'); ta.select(); document.execCommand('copy');
    }
  }

  async function checkDouyinAfterLogin() {
    const r = await api('/api/evidence/douyin/check');
    if (r.data && r.data.logged_in) {
      $('#evDouyinStatus').innerHTML = '✅ <b style="color:#15803d">抖音登录成功！</b> 可以关闭弹窗去「开始监测」了。';
      // 自动刷新顶部横幅和统计
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
