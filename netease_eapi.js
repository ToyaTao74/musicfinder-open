// 网易云 eapi 收藏量(红心数)批量获取脚本
// 用法: node netease_eapi.js '["songId1","songId2"]'
// 输出: JSON map { "songId": {count, countDesc} }
// 注: 该接口免登录，使用伪造的 iOS 客户端 header 即可。
const crypto = require('crypto');

function eapiParams(uri, data) {
  const json = JSON.stringify(data);
  const digest = crypto.createHash('md5').update(`nobody${uri}use${json}md5forencrypt`).digest('hex');
  const payload = `${uri}-36cd479b6b5-${json}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

async function redCount(songId) {
  const uri = '/api/song/red/count';
  const header = {
    osver: '16.2', deviceId: '', os: 'iPhone OS', appver: '9.0.90',
    versioncode: '140', mobilename: '', buildver: String(Math.floor(Date.now() / 1000)),
    resolution: '1170x2532', __csrf: '', channel: 'distribution',
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
  };
  const body = { songId: Number(songId), header };
  const params = eapiParams(uri, body);
  const cookie = Object.entries(header).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('; ');
  const resp = await fetch('https://interface.music.163.com/eapi/song/red/count', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
      'Cookie': cookie,
    },
    body: `params=${params}`,
  });
  const data = await resp.json();
  return { count: data?.data?.count, countDesc: data?.data?.countDesc };
}

(async () => {
  const ids = JSON.parse(process.argv[2] || '[]');
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      out[String(id)] = await redCount(id);
    } catch (e) {
      out[String(id)] = null;
    }
  }));
  console.log(JSON.stringify(out));
})();
