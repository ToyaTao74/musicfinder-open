// 把 douyin_state.json（patchright storage_state）的登录 cookie 注入
// Agent 专用 Chrome profile（~/.musicfinder/chrome-agent-profile）。
// 用途：扫码登录后一次性同步，让 Agent 抓取不再被当游客弹滑块。
// 用法：node inject_douyin_cookies.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

(async () => {
  const statePath = path.join(os.homedir(), '.musicfinder', 'douyin_state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const cookies = (state.cookies || []).filter(c => c.name && c.value && c.domain);
  if (!cookies.length) { console.error('douyin_state.json 无有效 cookie'); process.exit(1); }

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: (() => {
      const cands = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
      return cands.find(p => fs.existsSync(p));
    })(),
    userDataDir: path.join(os.homedir(), '.musicfinder', 'chrome-agent-profile'),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch(e => console.warn('首页打开警告:', e.message));

  const now = Date.now() / 1000;
  let n = 0;
  for (const c of cookies) {
    const exp = typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined;
    if (exp && exp < now) continue;   // 跳过已过期的
    try {
      await page.setCookie({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        ...(exp ? { expires: exp } : { url: 'https://www.douyin.com/' }),
        httpOnly: !!c.httpOnly, secure: !!c.secure,
      });
      n++;
    } catch (e) { console.warn(`setCookie ${c.name} 失败:`, e.message); }
  }
  console.log(`已注入 ${n}/${cookies.length} 条 cookie`);

  // 验证：重载首页后查登录 cookie
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
  const jar = await page.cookies('https://www.douyin.com');
  const hasSession = jar.some(c => c.name === 'sessionid_ss' || c.name === 'sid_tt');
  console.log('profile 内登录 cookie:', hasSession ? '有效 ✓' : '未生效 ✗');
  await browser.close();
  process.exit(hasSession ? 0 : 2);
})();
