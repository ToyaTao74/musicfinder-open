#!/usr/bin/env python3
"""抖音抓取（复用真实登录态 + 拦截前端签名接口）

照搬用户已安装的「音乐证据监测台」小程序的做法：抖音对 headless 自动化必弹滑块，
手写 X-Bogus 签名又极脆弱，所以本模块走两条关键路径：

  1. 登录态 = profile 指纹 + 注入登录 cookie（双保险）：
     - 复用「音乐证据监测台」的真实 Chrome profile（仅作稳定浏览器指纹）：
       ~/Library/Application Support/音乐证据监测台/douyin-profile
     - 真正让抖音识别为已登录用户的，是 ~/.musicfinder/douyin_state.json 里的
       登录 cookie（sessionid_ss / sid_tt / sid_guard 等，有效至 2026-10-11）。
       用 context.add_cookies() 注入 —— 这正是别人程序绕过滑块的核心。
       （login_flow() 扫码流程仍能生成该 state 文件，作为兜底登录手段。）

  2. 抓取：用 launch_persistent_context(headless=False) 打开该 profile 的真实 Chrome，
     在 search 页上用 page.on('response') 拦截抖音前端「自动签名」的搜索接口
     （aweme/v1/web/search/item/ 或 general/search/single），直接 json.loads(body)
     拿 aweme_list，彻底绕开手写签名。DOM 选择器方案已弃用（被滑块挡住）。

调用方式：
  - 网页任务（run_task → run_platform('douyin')）会 headful 触发（LaunchAgent 在 GUI 会话内可弹窗）。
  - 本地最稳路径：python -m evidence.platforms.douyin scan "歌名" "歌手"
    复用同一 profile + cookie 抓取并直接落库到 ~/.musicfinder/evidence.db，网页照常展示。

依赖 patchright（playwright 反爬分支），未安装时本模块优雅降级，不拖垮其它平台。
"""

import json
import os

from . import register
from .. import db

STATE_PATH = os.path.join(db.DATA_DIR, 'douyin_state.json')

# 别人程序（「音乐证据监测台」）的真实登录态 Chrome profile：抖音识别为已登录真实
# 用户、不发滑块。抖音对 headless 自动化必发滑块，故抖音抓取须复用此 profile + headful。
COMMON_UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
             '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
DOUYIN_PROFILE = os.path.expanduser(
    '~/Library/Application Support/音乐证据监测台/douyin-profile')


def _load_state():
    if os.path.exists(STATE_PATH):
        try:
            return json.load(open(STATE_PATH, encoding='utf-8'))
        except Exception:
            return None
    return None


def _load_cookies():
    """从 douyin_state.json（playwright storage_state 格式）取登录 cookie。

    这些 cookie 含 sessionid_ss/sid_tt 等真实登录态，有效至 2026-10-11。
    是「照搬别人程序」的关键：profile 只提供浏览器指纹，真正登录靠注入这些 cookie。
    过滤掉缺 name/value/domain 的脏条目（storage_state 偶尔含空 name）。
    """
    state = _load_state()
    if not state:
        return []
    raw = state.get('cookies', []) or []
    out = []
    for c in raw:
        if not c.get('name') or not c.get('value') or not c.get('domain'):
            continue
        out.append(c)
    return out


def _is_logged_in(page):
    """抖音登录成功标志：cookies 里出现 sessionid_ss / sid_tt / sid_guard 任一。"""
    try:
        for c in page.context.cookies():
            if c.get('name') in ('sessionid_ss', 'sid_tt', 'sid_guard', 'sid_ucp_v1'):
                return True
    except Exception:
        pass
    return False


def login_flow(headless=False, timeout_sec=300):
    """交互式登录：打开抖音，等你扫码，自动检测登录成功后保存 storage_state。

    不再用 input() 阻塞（后台服务跑不了），改为轮询检测登录 cookie。
    返回 True/False。
    """
    try:
        from patchright.sync_api import sync_playwright
    except Exception:
        raise RuntimeError('未安装 patchright：pip install patchright 后再登录')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, channel='chrome')
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto('https://www.douyin.com/', wait_until='domcontentloaded')
        print('[抖音] 浏览器已打开，请用手机抖音 App 扫码登录...')
        import time
        waited = 0
        while waited < timeout_sec:
            if _is_logged_in(page):
                print('[抖音] 检测到登录成功，保存登录态...')
                ctx.storage_state(path=STATE_PATH)
                browser.close()
                return True
            time.sleep(3)
            waited += 3
            if waited % 15 == 0:
                print(f'[抖音] 已等待 {waited}s，仍未登录，请扫码...')
        print('[抖音] 超时未登录，登录态未保存。')
        browser.close()
        return False


def _parse_count(text):
    if not text:
        return 0
    text = str(text).strip()
    try:
        if '万' in text:
            return int(float(text.replace('万', '')) * 10000)
        return int(''.join(filter(lambda c: c.isdigit(), text)) or 0)
    except Exception:
        return 0


def _parse_aweme_bodies(bodies, song_name, monitor_artist, target_count=300):
    """把若干次被拦截的签名接口响应体合并解析成候选视频列表。

    抖音搜索接口返回结构有两代：
      - 旧：{status_code, aweme_list:[...]}
      - 新：{status_code, data:[{aweme_info:{...}, aweme_list:[...], ...}, ...]}
    这里两种都兼容。按 aweme_id 去重。
    """
    import time
    seen = set()
    out = []
    for body in bodies:
        try:
            data = json.loads(body)
        except Exception:
            continue
        if data.get('status_code') not in (0, None):
            # 登录墙 / 风控码：跳过（会触发上层降级提示）
            continue
        awemes = []
        d = data.get('data')
        if isinstance(d, list):              # 新版：data 是卡片列表
            for card in d:
                if not isinstance(card, dict):
                    continue
                a = card.get('aweme_info') or (card.get('aweme_list') or [None])[0]
                if isinstance(a, dict) and a.get('aweme_id'):
                    awemes.append(a)
        elif isinstance(d, dict):            # 部分结构 data 里再嵌 aweme_list
            awemes = d.get('aweme_list') or []
        if not awemes:                      # 旧版兜底
            awemes = data.get('aweme_list') or []
        for a in awemes:
            aid = a.get('aweme_id') or a.get('aweme_id_str')
            if not aid or aid in seen:
                continue
            seen.add(aid)
            if len(out) >= target_count:
                break
            author = a.get('author') or {}
            uploader = (author.get('nickname') or '').strip()
            stats = a.get('statistics') or {}
            likes = _safe_int(stats.get('digg_count'))
            comments = _safe_int(stats.get('comment_count'))
            shares = _safe_int(stats.get('share_count'))
            plays = _safe_int(stats.get('play_count'))
            collects = _safe_int(stats.get('collect_count') or stats.get('collect_cnt'))
            music = a.get('music') or {}
            music_title = (music.get('title') or '').strip()
            original_author = (music.get('author') or '').strip()
            ct = a.get('create_time') or 0
            uploaded_at = ''
            if ct:
                try:
                    uploaded_at = time.strftime('%Y-%m-%d', time.localtime(int(ct)))
                except Exception:
                    pass
            video_url = a.get('share_url') or f'https://www.douyin.com/video/{aid}'
            soda_mid = music.get('id') or music.get('mid')
            soda_link = (f'https://music.douyin.com/qishui/share/track?track_id={soda_mid}'
                         if soda_mid else '')
            out.append({
                'song_name': song_name,
                'artist': monitor_artist,
                'version': '',
                'official_url': video_url,
                'video_url': video_url,
                'soda_link': soda_link,
                'interactions': {'likes': likes, 'collect': collects, 'comments': comments,
                                 'shares': shares, 'plays': plays},
                'match_basis': '抖音搜索相关视频',
                # v2.3.2 三分类：监测歌手 / 原声账号 / 视频博主 分开
                'monitor_artist': monitor_artist,
                'original_author': original_author,
                'video_blogger': uploader,
                'uploaded_at': uploaded_at,
                'extra': {'source': 'douyin-profile-intercept',
                          'music_title': music_title},
            })
    return out


def _safe_int(v):
    if v is None:
        return 0
    try:
        if isinstance(v, str):
            s = v.strip().replace('+', '').replace(',', '')
            if not s:
                return 0
            if '亿' in s:
                return int(float(s.replace('亿', '')) * 100000000)
            if '万' in s:
                return int(float(s.replace('万', '')) * 10000)
            return int(float(s))
        return int(float(v))
    except Exception:
        return 0


@register('douyin')
def search(song_name, artist='', version='', target_count=300,
           source='chrome', recheck=False, headless=False, **_):
    """抖音搜索视频（复用真实登录态 profile + 注入登录 cookie + 拦截前端签名接口）。

    返回候选列表；无登录 cookie 时返回 [{'needs_login': True}]；异常返回 [{'error': ...}]。
    headless=False 时弹真实 Chrome 窗口（配合已注入 cookie，抖音不弹滑块）；
    headless=True 抖音可能仍弹滑块，故 GUI 会话内（网页任务 / 本地 scan）走 headful。
    """
    monitor_artist = (artist or '').strip()
    query = f'{song_name} {artist}'.strip()

    cookies = _load_cookies()
    if not cookies:
        return [{'needs_login': True,
                 'message': '未找到抖音登录态（~/.musicfinder/douyin_state.json 无 cookie），请先登录'}]

    try:
        from patchright.sync_api import sync_playwright
    except Exception:
        return [{'error': '未安装 patchright'}]

    captured_bodies = []

    def _on_response(response):
        url = response.url
        if 'aweme/v1/web/search/item/' in url or 'general/search/single' in url:
            try:
                body = response.body()
                if body:
                    captured_bodies.append(body)
            except Exception:
                pass

    candidates = []
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=DOUYIN_PROFILE,
                headless=headless,
                channel='chrome',
                user_agent=COMMON_UA,
                viewport={'width': 1280, 'height': 900},
                locale='zh-CN',
                args=['--disable-blink-features=AutomationControlled'],
            )
            # 关键：注入真实登录 cookie（sessionid_ss 等），让抖音识别为已登录用户
            try:
                ctx.add_cookies(cookies)
            except Exception as e:
                print(f'[抖音] 注入 cookie 失败（继续尝试）: {e}')
            page = ctx.new_page()
            page.on('response', _on_response)
            # 拦截图片/音视频/字体，加速加载（不拦截 JSON 接口）
            page.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,mp4,webm,mp3}',
                       lambda route: route.abort())
            try:
                page.goto('https://www.douyin.com/search/' + _urlencode(query),
                          wait_until='domcontentloaded', timeout=30000)
            except Exception as e:
                print(f'[抖音] 导航异常（继续尝试拦截响应）: {e}')

            # 等首屏签名响应
            waited = 0
            while waited < 15000 and not captured_bodies:
                page.wait_for_timeout(300)
                waited += 300

            # 滚动触发更多分页，累计拦截响应
            pages = min(40, (target_count // 5) + 5)
            for _ in range(pages):
                page.mouse.wheel(0, 3000)
                page.wait_for_timeout(1200)

            candidates = _parse_aweme_bodies(
                captured_bodies, song_name, monitor_artist, target_count)
            ctx.close()
    except Exception as e:
        msg = str(e)
        if 'user data directory' in msg.lower() or 'already in use' in msg.lower():
            return [{'error': '抖音 profile 被其它 Chrome 占用（请先关闭「音乐证据监测台」或正在运行的抖音抓取）'}]
        return [{'error': f'抖音抓取失败: {e}'}]

    if not candidates:
        return [{'error': '抖音未返回结果（可能登录态失效，或需手动完成滑块验证）'}]
    return candidates


def _urlencode(s):
    import urllib.parse
    return urllib.parse.quote(s)


def parse_video_url(url, headless=True, timeout_ms=20000):
    """给定一个抖音视频链接（短链/长链均可），用登录态加载页面，提取：
        music_name    原曲/原声名称
        music_author  原声账号（汽水音乐上的演唱者）
        video_blogger 视频上传者昵称
        video_title   视频描述（前 200 字）
        video_url     解析后的长链（短链已展开）
    未登录返回 {'needs_login': True}，异常返回 {'error': '...'}。
    """
    state = _load_state()
    if not state:
        return {'needs_login': True}
    try:
        from patchright.sync_api import sync_playwright
    except Exception as e:
        return {'error': f'未安装 patchright: {e}'}

    info = {'music_name': '', 'music_author': '', 'video_blogger': '',
            'video_title': '', 'video_url': ''}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless, channel='chrome')
            ctx = browser.new_context(storage_state=STATE_PATH)
            page = ctx.new_page()
            page.goto(url, wait_until='domcontentloaded', timeout=timeout_ms)
            page.wait_for_timeout(2500)  # 等 BGM 区渲染

            # 视频上传者：左下角昵称
            for sel in ['[data-e2e="video-author-name"]',
                        '[data-e2e="video-author"] span',
                        'div[data-e2e="user-info"] a span']:
                el = page.query_selector(sel)
                if el:
                    t = el.inner_text().strip()
                    if t:
                        info['video_blogger'] = t
                        break

            # 音乐信息（核心）：title 属性通常是歌名，inner_text 是作者
            for sel in ['[data-e2e="video-music-info"] a[title]',
                        'div[class*="video-music"] a',
                        'a[data-e2e="music-name"]']:
                el = page.query_selector(sel)
                if el:
                    title = (el.get_attribute('title') or '').strip()
                    if title:
                        info['music_name'] = title
                        info['music_author'] = (el.inner_text() or '').strip()
                        break

            # 兜底：从 music-info 整体文本里尝试 "♫ 原声 - 歌名 - 作者"
            if not info['music_name']:
                import re
                for sel in ['[data-e2e="video-music-info"]',
                            'div[class*="video-music"]']:
                    el = page.query_selector(sel)
                    if el:
                        t = (el.inner_text() or '').strip()
                        m = re.search(r'原声\s*[-–—]\s*([^-\n]+?)\s*[-–—]\s*(\S+)', t)
                        if m:
                            info['music_name'] = m.group(1).strip()
                            info['music_author'] = m.group(2).strip()
                            break

            # 视频描述（发布者写的文案）
            for sel in ['[data-e2e="video-desc"]',
                        'div[class*="video-info-detail"] h1',
                        'h1']:
                el = page.query_selector(sel)
                if el:
                    t = el.inner_text().strip()
                    if t and len(t) > 1:
                        info['video_title'] = t[:200]
                        break

            info['video_url'] = page.url  # 短链解析后的长链
            browser.close()
    except Exception as e:
        return {'error': f'抖音链接解析失败: {e}'}

    return info


if __name__ == '__main__':
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'login':
        ok = login_flow()
        if ok:
            print('[抖音] 登录态已保存，可正常抓取。')
        else:
            print('[抖音] 登录未完成，请重试。')
            sys.exit(1)
    elif cmd == 'scan':
        # 本地最稳路径：复用「音乐证据监测台」真实登录态 profile，headful 抓取并落库。
        # 用法：python -m evidence.platforms.douyin scan "歌名" ["歌手"] [数量]
        if len(sys.argv) < 3:
            print('usage: python -m evidence.platforms.douyin scan "歌名" ["歌手"] [数量]')
            sys.exit(1)
        sname = sys.argv[2]
        art = sys.argv[3] if len(sys.argv) > 3 else ''
        try:
            target = int(sys.argv[4]) if len(sys.argv) > 4 else 50
        except ValueError:
            target = 50
        from .. import db, engine
        db.init_db()
        tid = db.create_task(sname, artist=art, version='', platforms=['douyin'])
        print(f'[抖音] 已建任务 #{tid}，启动 headful Chrome（复用真实登录态 profile）...')
        print(f'[抖音] 搜索词：{sname} {art}　目标 {target} 条')
        engine.run_task(tid, sname, artist=art, version='', platforms=['douyin'],
                        opts={'headless': False, 'target_count': target,
                              'source': 'douyin-profile'})
        t = db.get_task(tid) or {}
        evs = db.list_evidence(task_id=tid, platform='douyin')
        print(f'[抖音] 任务 #{tid} 完成：状态={t.get("status")}，发现 {len(evs)} 条抖音证据')
        for e in evs[:15]:
            inter = e.get('interactions') or {}
            likes = inter.get('likes', 0) if isinstance(inter, dict) else 0
            print(f'   - {e.get("uploaded_at","")} | {e.get("uploader","")} | 赞{likes} | {e.get("video_url","")}')
        print('[抖音] 结果已写入 ~/.musicfinder/evidence.db，网页刷新即可查看。')
    else:
        print('usage: python -m evidence.platforms.douyin [login|scan]')
