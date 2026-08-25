#!/usr/bin/env python3
"""抖音抓取（需真人登录 + 浏览器自动化）

抖音风控强，必须登录态。流程：
  1. 首次：login_flow() 打开浏览器，你手动扫码登录，状态存到
     ~/.musicfinder/douyin_state.json。
  2. 之后：search() 加载登录态，搜歌名/歌手，滚动采集视频（点赞/链接/上传者）。
  3. 无登录态时返回 [{'needs_login': True}]，任务标 needs_login。

依赖 patchright（playwright 反爬分支）。打包时已按主程序约定把它列为可选，
未安装时本模块优雅降级，不拖垮其它平台。
"""

import json
import os

from . import register
from .. import db

STATE_PATH = os.path.join(db.DATA_DIR, 'douyin_state.json')


def _load_state():
    if os.path.exists(STATE_PATH):
        try:
            return json.load(open(STATE_PATH, encoding='utf-8'))
        except Exception:
            return None
    return None


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


@register('douyin')
def search(song_name, artist='', version='', target_count=300,
           source='chrome', recheck=False, headless=False, **_):
    state = _load_state()
    if not state:
        return [{'needs_login': True}]

    try:
        from patchright.sync_api import sync_playwright
    except Exception:
        return [{'error': '未安装 patchright'}]

    # v2.2.0：抖音搜索词自动加入"歌曲"，减少无关视频
    query = f'{song_name} {artist} 歌曲'.strip()
    monitor_artist = (artist or '').strip()  # 监测歌手（我们的目标歌手）
    candidates = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless, channel='chrome')
            ctx = browser.new_context(storage_state=STATE_PATH)
            page = ctx.new_page()
            page.goto('https://www.douyin.com/search/' + _urlencode(query),
                      wait_until='domcontentloaded')
            # 滚动采集（抖音为无限流）
            collected = 0
            scrolls = 0
            while collected < target_count and scrolls < 60:
                page.mouse.wheel(0, 3000)
                page.wait_for_timeout(1200)
                scrolls += 1
                items = page.query_selector_all('li[data-e2e="search-video-card"]')
                for it in items:
                    if collected >= target_count:
                        break
                    try:
                        a = it.query_selector('a')
                        href = a.get_attribute('href') if a else ''
                        link = 'https://www.douyin.com' + href if href and href.startswith('/') else (href or '')
                        like_el = it.query_selector('[data-e2e="like-count"]')
                        like_txt = like_el.inner_text() if like_el else ''
                        up_el = it.query_selector('[data-e2e="video-author"]')
                        video_blogger = up_el.inner_text() if up_el else ''  # 视频博主（上传者）
                        soda_el = it.query_selector('a[data-e2e="music-name"]')
                        soda_link = soda_el.get_attribute('href') if soda_el else ''
                        soda_link = ('https://www.qishui.com' + soda_link) if soda_link and soda_link.startswith('/') else (soda_link or '')
                        # 原声账号：从汽水音乐链接推断作者昵称（music-name 文本）
                        original_author = soda_el.inner_text().strip() if soda_el else ''
                        candidates.append({
                            'song_name': song_name, 'artist': monitor_artist, 'version': '',
                            'official_url': link, 'video_url': link,
                            'soda_link': soda_link,
                            'interactions': {'likes': _parse_count(like_txt),
                                            'uploaded_at': ''},
                            'match_basis': '抖音搜索相关视频',
                            # v2.3.2 三分类：监测歌手 / 原声账号 / 视频博主 分开
                            'monitor_artist': monitor_artist,
                            'original_author': original_author,
                            'video_blogger': video_blogger,
                            'uploaded_at': '',
                            'extra': {'source': source},
                        })
                        collected += 1
                    except Exception:
                        continue
            browser.close()
    except Exception as e:
        return [{'error': f'抖音抓取失败: {e}'}]
    return candidates


def _urlencode(s):
    import urllib.parse
    return urllib.parse.quote(s)


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
    else:
        print('usage: python -m evidence.platforms.douyin login')
