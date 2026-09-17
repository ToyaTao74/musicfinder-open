// ═══ 后台：轮询云端领单 → 开抖音页 → 收数据 → 回传云端 ═══
const DEFAULT_CLOUD = 'https://musicfinder-292238-8-1463776169.sh.run.tcloudbase.com';
const DEFAULT_KEY = 'mf_yy_2026_969346bee4c77fa83d4ecfcfc3a6d67dcae3c3e0E';

let current = null;   // {task_id, tabId, target_count, sentBodies}

async function cfg() {
  const s = await chrome.storage.local.get(['cloudUrl', 'key', 'worker']);
  return {
    cloudUrl: (s.cloudUrl || DEFAULT_CLOUD).replace(/\/+$/, ''),
    key: s.key || DEFAULT_KEY,
    worker: s.worker || 'win-ext',
  };
}

async function api(path, opt = {}) {
  const c = await cfg();
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(c.cloudUrl + path + sep + 'key=' + encodeURIComponent(c.key)
    + '&worker=' + encodeURIComponent(c.worker), opt);
  return res.json();
}

async function pollOnce() {
  if (current) return; // 手头有任务不重复领
  let data;
  try {
    const j = await api('/api/evidence/ext/poll');
    data = j && j.data;
  } catch (e) { return; }
  if (!data || !data.task_id) return;

  const tab = await chrome.tabs.create({ url: data.search_url, active: true });
  current = { task_id: data.task_id, tabId: tab.id, target_count: data.target_count, sentBodies: 0 };
  await setBadge('ON', '#16a34a');
  // 兜底超时：5 分钟没结束就放弃（云端也会超时回退）
  setTimeout(() => {
    if (current && current.task_id === data.task_id) {
      finishTask('扩展抓取超时');
    }
  }, 4.6 * 60 * 1000);
}

async function report(payload) {
  try {
    await api('/api/evidence/ext/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ task_id: current ? current.task_id : payload.task_id }, payload)),
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function finishTask(errMsg) {
  const taskId = current ? current.task_id : null;
  if (taskId == null) return;
  await report(errMsg ? { task_id: taskId, error: errMsg } : { task_id: taskId, done: true });
  if (current && current.tabId != null) {
    chrome.tabs.remove(current.tabId).catch(() => {});
  }
  current = null;
  await setBadge('', '');
  pollOnce(); // 立刻看有没有下一单
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) { /* 忽略 */ }
}

// ── content.js 消息路由 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'page-ready' && current && sender.tab && sender.tab.id === current.tabId) {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'start-task',
      task_id: current.task_id,
      target_count: current.target_count,
    }).catch(() => {});
    sendResponse({ ok: true });
  } else if (msg.type === 'body' && current) {
    current.sentBodies++;
    report({ bodies: [msg.body] });
    sendResponse({ ok: true });
  } else if (msg.type === 'page-done' && current) {
    finishTask(null);
    sendResponse({ ok: true });
  } else if (msg.type === 'get-state') {
    sendResponse({ current: current ? { task_id: current.task_id, sentBodies: current.sentBodies } : null });
  }
  return false;
});

// 用户手动关掉任务页 → 视为放弃，云端会回退服务端抓取
chrome.tabs.onRemoved.addListener((tabId) => {
  if (current && current.tabId === tabId) {
    report({ error: '用户关闭了抖音标签页' });
    current = null;
    setBadge('', '');
    pollOnce();
  }
});

// 轮询：30 秒一次（chrome.alarms 最小粒度）
chrome.alarms.create('mfPoll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mfPoll') pollOnce(); });
chrome.runtime.onStartup.addListener(pollOnce);
chrome.runtime.onInstalled.addListener(pollOnce);
pollOnce();
