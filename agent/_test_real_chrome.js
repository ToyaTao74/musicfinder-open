/**
 * P1 真实 Chrome 链路验证（沙箱版，headless=true）
 * 复用 index.js 的网关连接 + 回传逻辑，但用公开页(百度)验证"自起Chrome→采集→回传"。
 * 真机 Mac 跑 index.js（headless:false）连抖音即可。
 */
const WebSocket = require('ws');
const puppeteer = require('puppeteer');

const GATEWAY = process.env.GATEWAY_WS || 'ws://127.0.0.1:8765/ws/agent';
const TOKEN = process.env.AGENT_TOKEN || 'demo-token-mac';
const AGENT_ID = process.env.AGENT_ID || 'mac-home';

let ws = null, busy = false;
function send(o){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(o)); }

async function connect(){
  ws = new WebSocket(`${GATEWAY}?token=${encodeURIComponent(TOKEN)}&agent_id=${encodeURIComponent(AGENT_ID)}`);
  ws.on('open', ()=>{ console.log('[TestAgent] 已连接', GATEWAY);
    send({type:'agent_hello',task_id:null,ts:Date.now(),payload:{os:process.platform,chrome_version:'待检测',douyin_logged_in:null}}); });
  ws.on('message', async (raw)=>{
    let m; try{m=JSON.parse(raw);}catch{return;}
    if(m.type==='task_assign' && !busy){ await handle(m); }
  });
  ws.on('close', ()=>{ console.log('[TestAgent] 断开'); });
  ws.on('error', e=>console.error('[TestAgent]', e.message));
}
async function handle(msg){
  const {song_name, limit} = msg.payload; const task_id = msg.task_id;
  busy = true; console.log(`[TestAgent] 任务 #${task_id} 搜"${song_name}"`);
  let browser;
  try{
    send({type:'task_progress',task_id,ts:Date.now(),payload:{phase:'启动Chrome',progress:5,message:'headless'}});
    browser = await puppeteer.launch({ headless:true,
      executablePath: process.env.CHROME_PATH || undefined,
      args:['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`https://www.baidu.com/s?wd=${encodeURIComponent(song_name)}`, {waitUntil:'networkidle2',timeout:30000});
    const items = await page.evaluate((lim)=>{
      const out=[]; document.querySelectorAll('div.result, .c-container').forEach(el=>{
        const t=el.querySelector('h3')?.innerText||el.innerText.slice(0,40);
        const l=el.querySelector('a')?.href||'';
        if(t) out.push({title:t.trim(),link:l}); });
      return out.slice(0,lim);
    }, limit||5);
    const evidence = items.map(it=>({ url:it.link, title:it.title, author:'',
      collect_count:0, like_count:0, comment_count:0, share_count:0,
      screenshot:'', html_snapshot:'', captured_at:new Date().toISOString(),
      env:{browser:'Chrome(headless-test)', ip_type:'sandbox', login_state:'n/a', note:'P1管道验证'} }));
    send({type:'task_result',task_id,ts:Date.now(),payload:{evidence}});
    console.log(`[TestAgent] 完成 #${task_id}，采集 ${evidence.length} 条`);
  }catch(e){
    send({type:'task_failed',task_id,ts:Date.now(),payload:{reason:String(e),log:String(e.stack||e)}});
    console.error('[TestAgent] 失败', e);
  }finally{ if(browser) await browser.close(); busy=false; }
}
connect();
