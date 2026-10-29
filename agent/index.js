/**
 * MusicFinder 抖音取证 · 本地 Agent（Node.js + Puppeteer）
 * 自起本机 Chrome → 连云端网关 → 收任务 → 搜抖音 → 采证据(含截图/HTML) → 回传
 *
 * 运行：
 *   GATEWAY_WS=wss://<云端>/ws/agent  GATEWAY_HTTP=https://<云端>  \
 *   AGENT_TOKEN=<每设备token>  AGENT_ID=mac-home  node index.js
 *
 * 可选环境变量：CHROME_PATH(覆盖浏览器路径) / CHROME_USER_DATA(覆盖用户目录)
 * Mac/Windows 下二者均可省略，Agent 自动探测常见安装位置。
 */
const WebSocket = require('ws');
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const GATEWAY_WS = process.env.GATEWAY_WS || 'ws://127.0.0.1:8765/ws/agent';
const GATEWAY_HTTP = (process.env.GATEWAY_HTTP || 'http://127.0.0.1:8765').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN || 'demo-token-mac';
const AGENT_ID = process.env.AGENT_ID || 'mac-home';
const DEFAULT_LIMIT = parseInt(process.env.LIMIT || '20', 10);

const TASK_TIMEOUT_MS = 720000;     // 单任务纯执行预算 12 分钟（人工等待时间另行扣除，不计入）
const SLIDER_WAIT_MS = 300000;      // 等人工过滑块最长 5 分钟
const LOGIN_WAIT_MS = 300000;       // 等人工扫码最长 5 分钟
const RETRY = 3;

// —— 平台自适应：Chrome 路径 & 用户目录 ——
function detectChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') {
    const cands = [
      process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA,
    ].filter(Boolean).map((p) => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const c of cands) if (fs.existsSync(c)) return c;
    return 'chrome'; // 依赖 PATH
  }
  return undefined; // 让 puppeteer 用自带 Chromium
}
function detectUserDataDir() {
  // 专用 profile：不与用户日常 Chrome 冲突（日常 Chrome 开着时默认目录会锁死）。
  // 抖音登录态持久保存在这里，扫码一次长期有效。CHROME_USER_DATA 仍可覆盖。
  if (process.env.CHROME_USER_DATA) return process.env.CHROME_USER_DATA;
  return path.join(os.homedir(), '.musicfinder', 'chrome-agent-profile');
}

let ws = null;
let heartbeat = null;
const taskQueue = [];      // 多任务本地队列
let busy = false;
const localResults = new Map(); // v4.30.73：本地派单任务的状态/结果（控制口 GET /task/<id> 查询）
let currentLocalTaskId = null;  // 当前正在执行的本地派单任务（waitIfSlider/ensureLoggedIn 里同步等待状态）

// 本地任务的人工等待状态同步（engine 收到 waiting_human 会顺延执行预算）
function setLocalStatus(status, reason) {
  const tid = currentLocalTaskId;
  if (!tid) return;
  const rec = localResults.get(tid);
  if (rec) localResults.set(tid, { ...rec, status, reason: reason || rec.reason, ts: Date.now() });
}
let lastLoginState = null; // 最近一次真实登录态探测结果（null=还没探测过）

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 连接网关 ——
// v4.30.72：指数退避重连。云端网关 503 隔离期间，原来每 5s 硬撞一次门
// （TLS 握手×N 天不停），改为 10s→30s→1min→…→10min 封顶，连上后复位。
let reconnectDelay = 10000;
function connect() {
  ws = new WebSocket(`${GATEWAY_WS}?token=${encodeURIComponent(TOKEN)}&agent_id=${encodeURIComponent(AGENT_ID)}`);
  ws.on('open', () => {
    console.log('[Agent] 已连接网关', GATEWAY_WS);
    reconnectDelay = 10000;
    send({ type: 'agent_hello', task_id: null, ts: Date.now(),
      payload: { os: process.platform, chrome_path: detectChromePath(), douyin_logged_in: lastLoginState } });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send({ type: 'agent_status', task_id: null, ts: Date.now(),
      payload: { online: true, chrome_connected: busy, douyin_logged_in: lastLoginState } }), 30000);
    loginProbe();                                  // 连上即探测一次真实登录态
  });
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'task_assign') {
      taskQueue.push(msg);
      console.log(`[Agent] 任务入队 #${msg.task_id}（队列${taskQueue.length}）`);
      pumpQueue();
    } else if (msg.type === 'task_cancel') {
      console.log('[Agent] 收到取消', msg.task_id);
    }
  });
  ws.on('close', () => {
    console.log(`[Agent] 断开，${Math.round(reconnectDelay / 1000)}s 后重连`);
    clearInterval(heartbeat);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 3, 600000);   // 10s→30s→90s→…→10min 封顶
  });
  ws.on('error', (e) => console.error('[Agent] 错误', e.message));
}

// —— 任务队列驱动 ——
async function pumpQueue() {
  if (busy) return;
  const msg = taskQueue.shift();
  if (!msg) return;
  busy = true;
  send({ type: 'agent_status', task_id: null, ts: Date.now(),
    payload: { online: true, chrome_connected: true, douyin_logged_in: null } });
  try {
    await handleTask(msg);
  } catch (e) {
    console.error('[Agent] 队列异常', e);
  } finally {
    busy = false;
    pumpQueue();
  }
}

async function handleTask(msg) {
  const { song_name, platform, limit } = msg.payload;
  const task_id = msg.task_id;
  const n = limit || DEFAULT_LIMIT;
  const isLocal = msg.source === 'local';
  if (isLocal) {
    localResults.set(String(task_id), { status: 'running', ts: Date.now() });
    currentLocalTaskId = String(task_id);
  }
  console.log(`[Agent] 开始任务 #${task_id} 搜"${song_name}" limit=${n}${isLocal ? '（本地派单）' : ''}`);
  send({ type: 'task_progress', task_id, ts: Date.now(),
    payload: { phase: '启动Chrome', progress: 5, message: '准备浏览器' } });

  const taskDir = path.join(os.tmpdir(), 'mf_evidence', String(task_id));
  fs.mkdirSync(taskDir, { recursive: true });

  let browser;
  let evidence = null;
  const startedAt = Date.now();
  try {
    if (platform === 'douyin') {
      // v4.30.78：抖音改走 Python patchright 链路（反检测 + 专用 profile + cookie 注入）。
      // 普通 puppeteer 控制 Chrome 会被抖音风控必弹滑块（实测 #2/#3/#4 连续 slider 0 条），
      // 而 evidence/platforms/douyin.py 的 patchright 方式已验证可绕滑块。
      send({ type: 'task_progress', task_id, ts: Date.now(),
        payload: { phase: '搜索', progress: 30, message: 'Patchright 抓取中（弹出真实浏览器）' } });
      // 心跳：Python 子进程期间持续报进度，防网关把静默任务判超时
      const hb = setInterval(() => {
        send({ type: 'task_progress', task_id, ts: Date.now(),
          payload: { phase: '搜索', progress: 50, message: '抓取进行中…' } });
      }, 20000);
      try {
        evidence = await collectDouyinPython(song_name, n, task_id);
      } finally { clearInterval(hb); }
      // 结果必须本函数内上报（旧 collectDouyin 的 task_result 在其函数尾发送，
      // 新链路没有 page 循环，必须显式补发，否则网关等不到结果判 timeout）
      send({ type: 'task_result', task_id, ts: Date.now(), payload: { evidence } });
      console.log(`[Agent] 任务 #${task_id} 完成，采集 ${evidence.length} 条`);
    } else {
      browser = await puppeteer.launch({
        headless: false,                 // 真浏览器，绕过抖音机器人检测
        executablePath: detectChromePath(),
        userDataDir: detectUserDataDir(),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      const chromeVer = await browser.version();
      send({ type: 'agent_status', task_id, ts: Date.now(),
        payload: { online: true, chrome_connected: true, douyin_logged_in: null } });

      // 登录态校验（P2）
      await ensureLoggedIn(page);

      send({ type: 'task_progress', task_id, ts: Date.now(),
        payload: { phase: '搜索', progress: 30, message: '打开搜索' } });
      evidence = await collectGeneric(page, song_name, n, task_id, taskDir, chromeVer);
    }
  } catch (e) {
    if (Date.now() - startedAt > TASK_TIMEOUT_MS) {
      send({ type: 'task_failed', task_id, ts: Date.now(),
        payload: { reason: 'timeout', log: String(e) } });
    } else {
      send({ type: 'task_failed', task_id, ts: Date.now(),
        payload: { reason: String(e), log: String(e.stack || e) } });
    }
    console.error('[Agent] 任务失败', e);
    if (isLocal) localResults.set(String(task_id), { status: 'failed', reason: String((e && e.message) || e), ts: Date.now() });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (isLocal) currentLocalTaskId = null;
    send({ type: 'agent_status', task_id: null, ts: Date.now(),
      payload: { online: true, chrome_connected: false, douyin_logged_in: null } });
  }
  if (isLocal) {
    const prev = localResults.get(String(task_id));
    if (!prev || prev.status === 'running' || prev.status === 'queued') {
      localResults.set(String(task_id), { status: 'done', evidence: evidence || [], ts: Date.now() });
    }
  }
}

// —— v4.30.78：抖音采集走 Python patchright 链路（绕滑块已验证）——
// 调 evidence/platforms/douyin.py 的 search()：patchright 反检测 +
// 「音乐证据监测台」真实 profile + douyin_state.json 登录 cookie 注入 + 前端签名接口拦截。
// 抓取会弹出真实 Chrome 窗口（headful），抓完自动关闭。
function collectDouyinPython(song_name, n, task_id) {
  // 异步 spawn（绝不能用 spawnSync——会阻塞事件循环，WebSocket 心跳断连被判掉线）
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const root = path.join(__dirname, '..');
    const py = path.join(root, 'venv', 'bin', 'python');
    if (!fs.existsSync(py)) { reject(new Error('未找到 venv python: ' + py)); return; }
    const code = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(root)})`,
      'from evidence.platforms.douyin import search',
      `res = search(${JSON.stringify(song_name)}, '', target_count=${n})`,
      'print(json.dumps(res, ensure_ascii=False))',
    ].join('\n');
    console.log(`[Agent] 任务 #${task_id} 走 patchright 抓取「${song_name}」目标 ${n} 条…`);
    const proc = spawn(py, ['-c', code], { cwd: root });
    let out = '', errout = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { errout += d; });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Python patchright 抓取超时（8 分钟）'));
    }, 480000);
    proc.on('close', c => {
      clearTimeout(timer);
      try {
        if (c !== 0) { reject(new Error('Python 退出码 ' + c + ': ' + errout.slice(-400))); return; }
        const line = out.trim().split('\n').filter(Boolean).pop() || '';
        const cands = JSON.parse(line);
        if (!Array.isArray(cands) || !cands.length) { reject(new Error('抖音未返回结果')); return; }
        if (cands[0].needs_login) { reject(new Error('抖音登录态失效（douyin_state.json 无有效 cookie），请先扫码登录')); return; }
        if (cands[0].error) { reject(new Error('抖音抓取失败: ' + cands[0].error)); return; }
        const evs = cands.filter(x => x && (x.video_url || x.official_url)).map(x => ({
          url: x.video_url || x.official_url,
          author: x.video_blogger || '',
          uploaded_at: x.uploaded_at || '',
          like_count: (x.interactions || {}).likes || 0,
          collect_count: (x.interactions || {}).collect || 0,
          comment_count: (x.interactions || {}).comments || 0,
          share_count: (x.interactions || {}).shares || 0,
          play_count: (x.interactions || {}).plays || 0,
        }));
        console.log(`[Agent] patchright 抓到 ${evs.length} 条`);
        resolve(evs);
      } catch (e) { reject(new Error('Python 输出解析失败: ' + (out.slice(-300) || e.message))); }
    });
    proc.on('error', e => { clearTimeout(timer); reject(new Error('Python 调用失败: ' + e.message)); });
  });
}

// —— P2：登录态校验 + 失效等待扫码 ——
async function ensureLoggedIn(page) {
  await gotoWithRetry(page, 'https://www.douyin.com', RETRY);
  const needLogin = await page.evaluate(() =>
    /登录/.test(document.body.innerText) && /douyin\.com(\/|$|\?)/.test(location.href) && location.href.includes('login'));
  if (!needLogin) {
    send({ type: 'agent_status', task_id: null, ts: Date.now(),
      payload: { online: true, chrome_connected: true, douyin_logged_in: true } });
    return;
  }
  send({ type: 'task_waiting_human', task_id: null, ts: Date.now(), payload: { reason: 'login_expired' } });
  setLocalStatus('waiting_human', 'login');
  console.log('[Agent] 抖音未登录，等待人工扫码…');
  const t0 = Date.now();
  while (Date.now() - t0 < LOGIN_WAIT_MS) {
    await sleep(10000);
    const still = await page.evaluate(() => location.href.includes('login'));
    if (!still) break;
  }
  setLocalStatus('running');
  send({ type: 'agent_status', task_id: null, ts: Date.now(),
    payload: { online: true, chrome_connected: true, douyin_logged_in: true } });
}

// —— P2：滑块检测 + 等待人工（返回等待毫秒数，供超时判断扣除）——
async function waitIfSlider(page, task_id) {
  const has = async () => page.evaluate(() => {
    const txt = document.body.innerText || '';
    if (/请完成|滑块|拖动|验证/.test(txt)) return true;
    if (document.querySelector('iframe[src*="captcha"]')) return true;
    if (document.querySelector('[class*="secsdk"], canvas[class*="captcha"]')) return true;
    return false;
  });
  if (!(await has())) return 0;
  send({ type: 'task_waiting_human', task_id, ts: Date.now(), payload: { reason: 'slider' } });
  setLocalStatus('waiting_human', 'slider');
  console.log('[Agent] 检测到滑块，暂停等待人工…');
  const t0 = Date.now();
  while (Date.now() - t0 < SLIDER_WAIT_MS) {
    await sleep(10000);
    if (!(await has())) break;
  }
  setLocalStatus('running');
  const waited = Date.now() - t0;
  console.log(`[Agent] 滑块已处理，继续（等待 ${Math.round(waited / 1000)}s，不计入任务超时）`);
  return waited;
}

async function gotoWithRetry(page, url, retries) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      // domcontentloaded 即认为打开成功：抖音视频流常驻加载，networkidle 永远等不到
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[Agent] goto 重试 ${i + 1}/${retries}:`, e.message);
      await sleep(3000);
    }
  }
  throw lastErr;
}

// —— 打开抖音搜索：直接进结果页；若被重定向（登录墙/风控），退回首页用真实搜索框输入 ——
async function openDouyinSearch(page, song_name, task_id) {
  const url = `https://www.douyin.com/search/${encodeURIComponent(song_name)}?type=video`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { console.warn('[Agent] 搜索页打开超时，继续检查:', e.message); }
  await sleep(3000);
  let loc = await page.evaluate(() => location.href);
  console.log('[Agent] 搜索页 URL:', loc.slice(0, 100));

  if (!loc.includes('/search/')) {
    console.log('[Agent] 未落在搜索页，改用搜索框真实输入…');
    await gotoWithRetry(page, 'https://www.douyin.com', RETRY);
    await sleep(2500);
    const hasBox = await page.evaluate(() => {
      const input = document.querySelector('input[data-e2e="searchbar-input"], input[placeholder*="搜索"], .search-input input, input[type="search"], input');
      if (!input) return false;
      input.focus();
      return true;
    });
    if (!hasBox) {
      console.warn('[Agent] 未找到搜索框，截图留证后放弃');
      return;
    }
    await page.keyboard.type(song_name, { delay: 120 });
    await sleep(600);
    await page.keyboard.press('Enter');
    await sleep(4500);
    loc = await page.evaluate(() => location.href);
    console.log('[Agent] 搜索框回车后 URL:', loc.slice(0, 100));
  }

  // 等搜索结果卡片出现（最多 20s），出现不了也继续（后续解析尽力而为）
  try {
    await page.waitForSelector('[data-e2e="scroll-list"] li, li[class*="search"], li > div', { timeout: 20000 });
    console.log('[Agent] 搜索结果已加载');
  } catch { console.warn('[Agent] 等待搜索结果超时，继续尝试解析'); }
}

// —— P2：抖音真实采集（含滑块等待 + 证据包截图/HTML）——
async function collectDouyin(page, song_name, n, task_id, taskDir, chromeVer, startedAt) {
  let humanWaitMs = 0;   // 人工等待（滑块）累计，不计入任务超时
  humanWaitMs += await waitIfSlider(page, task_id);
  await openDouyinSearch(page, song_name, task_id);
  humanWaitMs += await waitIfSlider(page, task_id);
  // v4.30.73：滑块处理后页面常被重定向（创作者中心等），不在搜索页就重进
  const onSearch = await page.evaluate(() => location.href.includes('/search/'));
  if (!onSearch) {
    console.log('[Agent] 滑块后不在搜索页，重新进入搜索…');
    await openDouyinSearch(page, song_name, task_id);
    humanWaitMs += await waitIfSlider(page, task_id);
  }
  const elapsed = () => Date.now() - startedAt - humanWaitMs;
  // 滚动加载：连续 6 轮无新增卡片即提前收工（抖音搜索实际结果有限，不必滚满）
  let lastCount = -1; let stale = 0;
  for (let i = 0; i < Math.ceil(n / 5); i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(1500);
    if (elapsed() > TASK_TIMEOUT_MS) throw new Error('timeout');
    const cnt = await page.evaluate(() => document.querySelectorAll('li > div, .video-card, [class*="video"]').length);
    if (cnt <= lastCount) { if (++stale >= 6) { console.log(`[Agent] 连续 ${stale} 轮无新增（${cnt} 条），停止滚动`); break; } }
    else { stale = 0; lastCount = cnt; }
  }
  const harvest = (limit) => page.evaluate((limit) => {
    // "1.2万"/"8566"/"1.2w" → 整数
    const num = (s) => {
      if (!s) return 0;
      const m = String(s).match(/([\d.]+)\s*(万|w|W)?/);
      if (!m) return 0;
      let v = parseFloat(m[1]);
      if (m[2]) v *= 10000;
      return Math.round(v);
    };
    const out = [];
    document.querySelectorAll('li > div, .video-card, [class*="video"]').forEach((el) => {
      const title = el.querySelector('[class*="title"]')?.innerText || el.querySelector('a')?.innerText || '';
      const link = el.querySelector('a')?.href || '';
      // v4.30.73：只要真实视频卡片（/video/<id>），侧边栏菜单等 li 噪音一律不要
      if (!title || !/\/video\/\d+/.test(link)) return;
      const txt = el.innerText || '';
      let likes = 0;
      const likeEl = el.querySelector('[class*="like"]');
      if (likeEl) likes = num(likeEl.innerText);
      let plays = 0;
      const playM = txt.match(/([\d.]+\s*[万wW]?)\s*(次?播放|次观看|观看)/);
      if (playM) plays = num(playM[1]);
      const tm = txt.match(/(\d+\s*(秒|分钟|小时|天|周|个月|月)前)|(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})|(\d{1,2}-\d{1,2})/);
      const uploaded_at = tm ? tm[0] : '';
      // v4.30.73：作者/点赞常混在 title 文本行里（选择器不命中时），从行文本兜底提取
      const lines = title.split('\n').map((s) => s.trim()).filter(Boolean);
      let author2 = ''; let likes2 = 0;
      for (const ln of lines) {
        if (!author2 && ln.startsWith('@')) author2 = ln.slice(1).trim();
        if (!likes2 && !ln.includes(':') && /^[\d.]+\s*[万wW]?$/.test(ln)) likes2 = num(ln);
      }
      out.push({ title: title.trim(), link,
        author: el.querySelector('[class*="author"]')?.innerText || author2,
        like_count: likes || likes2, play_count: plays, uploaded_at });
    });
    return out.slice(0, limit);
  }, limit);
  let items = await harvest(n);
  if (!items.length) {
    // v4.30.73：0 条兜底 —— 留存现场 + 完整重试一轮（滑块后页面常被重载，首抓易扑空）
    try {
      fs.writeFileSync(path.join(taskDir, 'page_debug.html'), await page.content());
      await page.screenshot({ path: path.join(taskDir, 'debug.png') });
      console.log('[Agent] 首抓 0 条，已留存现场（page_debug.html / debug.png），重试一轮…');
    } catch { }
    await openDouyinSearch(page, song_name, task_id);
    humanWaitMs += await waitIfSlider(page, task_id);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await sleep(1500);
      if (elapsed() > TASK_TIMEOUT_MS) throw new Error('timeout');
    }
    items = await harvest(n);
  }

  const evidence = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const idx = String(i + 1).padStart(2, '0');
    let shot = ''; let snap = '';
    if (i < 20) {   // 只给前 20 条留截图/快照证据，避免长任务拖死
      const png = path.join(taskDir, `ev_${idx}.png`);
      const html = path.join(taskDir, `ev_${idx}.html`);
      try {
        await page.screenshot({ path: png, fullPage: false });
        shot = `ev_${idx}.png`;
        fs.writeFileSync(html, await page.content());
        snap = `ev_${idx}.html`;
        await uploadFile(task_id, shot, png);
        await uploadFile(task_id, snap, html);
      } catch (e) { console.warn('[Agent] 截图/上传失败', e.message); }
    }
    evidence.push({
      url: it.link, title: it.title, author: it.author || '',
      collect_count: 0, like_count: it.like_count || 0, comment_count: 0,
      share_count: 0, play_count: it.play_count || 0, uploaded_at: it.uploaded_at || '',
      screenshot: shot, html_snapshot: snap, captured_at: new Date().toISOString(),
      env: { browser: chromeVer, ip_type: '家庭宽带', login_state: '有效' },
    });
  }
  try {
    fs.writeFileSync(path.join(taskDir, 'page.html'), await page.content());
    await uploadFile(task_id, 'page.html', path.join(taskDir, 'page.html'));
  } catch { /* 整页快照失败不阻塞结果回传 */ }
  send({ type: 'task_result', task_id, ts: Date.now(), payload: { evidence } });
  console.log(`[Agent] 任务 #${task_id} 完成，采集 ${evidence.length} 条`);
  return evidence;
}

// —— 通用公开页采集（P1 管道验证用）——
async function collectGeneric(page, song_name, n, task_id, taskDir, chromeVer) {
  await gotoWithRetry(page, `https://www.baidu.com/s?wd=${encodeURIComponent(song_name)}`, RETRY);
  const items = await page.evaluate((limit) => {
    const out = [];
    document.querySelectorAll('div.result, .c-container').forEach((el) => {
      const title = el.querySelector('h3')?.innerText || el.innerText.slice(0, 40);
      const link = el.querySelector('a')?.href || '';
      if (title) out.push({ title: title.trim(), link });
    });
    return out.slice(0, limit);
  }, n);
  const evidence = items.map((it) => ({
    url: it.link, title: it.title, author: '',
    collect_count: 0, like_count: 0, comment_count: 0, share_count: 0,
    screenshot: '', html_snapshot: '', captured_at: new Date().toISOString(),
    env: { browser: chromeVer, ip_type: '本地', login_state: 'n/a', note: 'P1管道验证(mock)' },
  }));
  send({ type: 'task_result', task_id, ts: Date.now(), payload: { evidence } });
  console.log(`[Agent] 任务(管道验证)完成，采集 ${evidence.length} 条`);
  return evidence;
}

// —— P3：上传截图/HTML 到网关 ——
function uploadFile(task_id, file_name, local_path) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(local_path)) return resolve();
    const boundary = '----mf' + Date.now();
    const body = [];
    const append = (s) => body.push(Buffer.from(s, 'utf8'));
    append(`--${boundary}\r\nContent-Disposition: form-data; name="task_id"\r\n\r\n${task_id}\r\n`);
    append(`--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${file_name}\r\n`);
    append(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file_name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const data = fs.readFileSync(local_path);
    body.push(data);
    append(`\r\n--${boundary}--\r\n`);
    const buf = Buffer.concat(body);
    const u = new URL(`${GATEWAY_HTTP}/evidence_file`);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': buf.length },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// —— 登录态探测：专用 profile 里读抖音 cookie，把真实状态上报给网关/指示灯 ——
let lastProbeAt = 0;
async function loginProbe() {
  if (busy || probing) return;
  probing = true;
  lastProbeAt = Date.now();
  console.log('[Agent] 登录态探测中…');
  // 全程 90s 兜底，防止 launch/close 卡死导致 probing 永久占用、后续探测全被跳过
  const guard = setTimeout(() => { probing = false; console.error('[Agent] 探测超时强制复位'); }, 90000);
  try {
    await probeNow();
  } catch (e) {
    console.error('[Agent] 登录态探测失败', e.message);
  } finally {
    clearTimeout(guard);
    probing = false;
  }
}

async function probeNow() {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,                  // 只读 cookie，无需可见窗口
      executablePath: detectChromePath(),
      userDataDir: detectUserDataDir(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    // v4.30.72：不再 goto 抖音首页 —— cookie jar 在 userDataDir 里，开页即可读。
    // 之前每 3 分钟完整加载一次抖音首页（几十 MB + CPU），是整台电脑变卡的元凶。
    const page = await browser.newPage();
    const cookies = await page.cookies('https://www.douyin.com');
    lastLoginState = cookies.some((c) => c.name === 'sessionid' || c.name === 'sessionid_ss');
    console.log(`[Agent] 登录态探测：${lastLoginState ? '已登录 ✓' : '未登录（跑任务/扫码登录后生效）'}`);
    send({ type: 'agent_status', task_id: null, ts: Date.now(),
      payload: { online: true, chrome_connected: busy, douyin_logged_in: lastLoginState } });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
let probing = false;

// —— 一键扫码登录模式：node index.js --login ——
async function interactiveLogin() {
  const ok = await openScanWindow();
  process.exit(ok ? 0 : 1);
}

// 打开扫码窗口等登录成功（常驻安全版：不退出进程，浏览器用完即关）
let scanBusy = false;
async function openScanWindow() {
  if (scanBusy) { console.log('[Agent] 已有扫码窗口在打开中'); return false; }
  scanBusy = true;
  let browser;
  try {
    console.log('打开抖音登录页，请用手机抖音 App 扫码（成功后窗口自动关闭）…');
    browser = await puppeteer.launch({
      headless: false,
      executablePath: detectChromePath(),
      userDataDir: detectUserDataDir(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    });
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.goto('https://www.douyin.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < LOGIN_WAIT_MS) {
      await sleep(5000);
      try {
        const cookies = await page.cookies('https://www.douyin.com');
        if (cookies.some((c) => c.name === 'sessionid' || c.name === 'sessionid_ss')) {
          console.log('✓ 抖音登录成功，已保存到本机 Agent 专用配置，以后自动复用。');
          await sleep(1500);
          return true;
        }
      } catch { /* 页面跳转中，继续等 */ }
    }
    console.log('超时未完成扫码。可重新发起。');
    return false;
  } finally {
    scanBusy = false;
    if (browser) await browser.close().catch(() => {});
  }
}

// —— 本地控制口（v4.30.64）：云端网页可直接探测状态/唤起扫码，无需终端 ——
const CTRL_PORT = parseInt(process.env.CTRL_PORT || '57080', 10);
function startControlServer() {
  require('http').createServer((req, res) => {
    // 公网 https 页面 → 本机 127.0.0.1 受 Chrome 私网访问保护(PNA)约束：
    // 预检与实际响应都必须带 Allow-Private-Network，否则浏览器静默拦截
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Access-Control-Request-Private-Network',
      'Access-Control-Allow-Private-Network': 'true',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
      return res.end(JSON.stringify({
        ok: true, agent_id: AGENT_ID, os: process.platform,
        gateway_online: !!(ws && ws.readyState === WebSocket.OPEN),
        douyin_logged_in: lastLoginState, scanning: scanBusy,
        ts: Date.now(),
      }));
    }
    if (req.url === '/scan') {
      const wantsHtml = (req.headers.accept || '').includes('text/html');
      if (wantsHtml) {
        // 顶级导航降级路径：返回友好提示页（动作照常触发）
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
        res.end('<!doctype html><meta charset="utf-8"><title>MusicFinder 助手</title>'
          + '<body style="font-family:-apple-system,sans-serif;text-align:center;padding-top:90px;color:#1c2433">'
          + '<h2>📱 扫码窗口已打开</h2>'
          + '<p>请在弹出的 Chrome 里用<b>手机抖音 App</b>扫码；<br>完成后可关闭本页，回云端页面看「抖音登录态」变绿。</p>'
          + '</body>');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
        if (scanBusy) return res.end(JSON.stringify({ ok: false, error: '已有扫码窗口在打开中' }));
        res.end(JSON.stringify({ ok: true, message: '扫码窗口已打开，请在弹出的 Chrome 里用手机抖音扫码' }));
      }
      if (!scanBusy) {
        openScanWindow().then((ok) => {
          lastLoginState = ok ? true : lastLoginState;
          send({ type: 'agent_status', task_id: null, ts: Date.now(),
            payload: { online: true, chrome_connected: busy, douyin_logged_in: lastLoginState } });
        }).catch(() => {});
      }
      return;
    }
    // v4.30.73：本地派单 —— Flask(57074) 在云端网关隔离期间直连本机 Agent 抓抖音
    if (req.method === 'POST' && req.url === '/dispatch') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let b = {}; try { b = JSON.parse(body); } catch { }
        const song_name = String(b.song_name || '').trim();
        if (!song_name) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
          return res.end(JSON.stringify({ ok: false, error: 'song_name required' }));
        }
        const tid = String(b.task_id || ('local_' + Date.now()));
        if (taskQueue.length >= 20) {
          res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
          return res.end(JSON.stringify({ ok: false, error: 'queue_full' }));
        }
        localResults.set(tid, { status: 'queued', ts: Date.now() });
        taskQueue.push({ type: 'task_assign', task_id: tid, source: 'local',
          payload: { song_name, platform: b.platform || 'douyin', limit: parseInt(b.limit, 10) || DEFAULT_LIMIT } });
        console.log(`[Agent] 本地派单 #${tid} 搜"${song_name}"（队列${taskQueue.length}）`);
        pumpQueue();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
        res.end(JSON.stringify({ ok: true, task_id: tid, queue: taskQueue.length }));
      });
      return;
    }
    const mTask = req.method === 'GET' && req.url.match(/^\/task\/([^/?]+)/);
    if (mTask) {
      const tid = decodeURIComponent(mTask[1]);
      let rec = localResults.get(tid);
      if (rec && Date.now() - (rec.ts || 0) > 2 * 3600 * 1000) { localResults.delete(tid); rec = null; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
      return res.end(JSON.stringify(rec ? { ok: true, ...rec } : { ok: false, error: 'not_found' }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  }).listen(CTRL_PORT, '127.0.0.1', () => console.log(`[Agent] 本地控制口就绪 http://127.0.0.1:${CTRL_PORT}`));
}

if (process.argv.includes('--login')) {
  interactiveLogin().catch((e) => { console.error(e); process.exit(1); });
} else {
  connect();
  startControlServer();
  // v4.30.72：探测降频 —— 每分钟 tick，已登录 30 分钟测一次、未登录 3 分钟一次
  // （扫码后仍最多 3 分钟变绿；已登录时不再每 3 分钟拉一次 Chrome 抢 CPU）。
  setInterval(() => {
    if (busy || probing) return;
    const gapMs = (lastLoginState ? 30 : 3) * 60 * 1000;
    if (Date.now() - lastProbeAt >= gapMs) loginProbe();
  }, 60 * 1000);
}
