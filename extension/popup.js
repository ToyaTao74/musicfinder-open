const $ = (id) => document.getElementById(id);
const DEFAULT_CLOUD = 'https://musicfinder-292238-8-1463776169.sh.run.tcloudbase.com';
const DEFAULT_KEY = 'mf_yy_2026_969346bee4c77fa83d4ecfcfc3a6d67dcae3c3e0E';

async function load() {
  const s = await chrome.storage.local.get(['cloudUrl', 'key', 'worker']);
  $('cloudUrl').value = s.cloudUrl || DEFAULT_CLOUD;
  $('key').value = s.key || DEFAULT_KEY;
  $('worker').value = s.worker || 'win-ext';
  refreshState();
}

async function save() {
  await chrome.storage.local.set({
    cloudUrl: $('cloudUrl').value.trim().replace(/\/+$/, ''),
    key: $('key').value.trim(),
    worker: $('worker').value.trim() || 'win-ext',
  });
}

async function refreshState() {
  const el = $('state');
  const st = await chrome.runtime.sendMessage({ type: 'get-state' }).catch(() => null);
  let line = st && st.current
    ? `📋 当前任务 #${st.current.task_id}，已回传 ${st.current.sentBodies} 包数据`
    : '💤 待命中，有新监测任务会自动打开抖音页抓取';
  // 连通性测试
  try {
    const s = await chrome.storage.local.get(['cloudUrl', 'key', 'worker']);
    const url = (s.cloudUrl || DEFAULT_CLOUD).replace(/\/+$/, '');
    const res = await fetch(url + '/api/evidence/ext/status?key=' + encodeURIComponent(s.key || DEFAULT_KEY)
      + '&worker=' + encodeURIComponent(s.worker || 'win-ext'));
    const j = await res.json();
    if (j.ok) {
      const n = (j.data.workers_online || []).length;
      line += `<br><span class="ok">✅ 云端连接正常</span>（在线扩展 ${n} 台）`;
    } else {
      line += `<br><span class="bad">❌ 密钥被云端拒绝</span>`;
    }
  } catch (e) {
    line += `<br><span class="bad">❌ 连不上云端</span>`;
  }
  el.innerHTML = line;
}

$('save').addEventListener('click', async () => { await save(); refreshState(); });
$('saveSec').addEventListener('click', async () => { await save(); $('state').textContent = '已保存'; });
load();
